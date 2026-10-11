import { describe, expect, it } from "vitest";
import { alice, bob, makeApp } from "./helpers";

const XT = "https://prov.example:8080";
const xt = (action?: string) => `${XT}/player_api.php?username=u&password=p${action ? `&action=${action}` : ""}`;

describe("Xtream source", () => {
  const routes = {
    [xt()]: { user_info: { auth: 1, status: "Active" } },
    [xt("get_live_categories")]: [{ category_id: "1", category_name: "News" }],
    [xt("get_live_streams")]: [{ stream_id: 7, name: "News One", category_id: "1" }, { stream_id: 8, name: "News Two", category_id: "1" }],
  };

  it("stores credentials encrypted, never returns them, and resolves them only for the owner's stream", async () => {
    const { app, db } = await makeApp(routes);
    const created = await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "Mine", type: "xtream", url: XT, username: "u", password: "p", ownershipAttested: true } });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain("\"p\"");
    const raw = (await db.query<{ secret_enc: string }>("SELECT secret_enc FROM user_sources")).rows[0]!.secret_enc;
    expect(raw.startsWith("v1.")).toBe(true);
    expect(raw).not.toContain("prov.example");

    const sync = await app.inject({ method: "POST", url: `/v1/me/sources/${created.json().id}/sync`, headers: alice });
    expect(sync.json()).toEqual({ added: 2 });
    const channels = (await app.inject({ url: "/v1/me/channels", headers: alice })).json();
    expect(JSON.stringify(channels)).not.toContain("/live/u/p/");
    expect(channels[0].streamUrl).toContain("{username}");
    const resolved = (await app.inject({ url: `/v1/me/channels/${channels[0].id}/stream`, headers: alice })).json();
    expect(resolved.url).toBe(`${XT}/live/u/p/7.m3u8`);
    expect((await app.inject({ url: `/v1/me/channels/${channels[0].id}/stream`, headers: bob })).statusCode).toBe(404);
  });

  it("re-sync adds only new channels and keeps the user's edits", async () => {
    const { app } = await makeApp(routes);
    const id = (await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "Mine", type: "xtream", url: XT, username: "u", password: "p", ownershipAttested: true } })).json().id;
    await app.inject({ method: "POST", url: `/v1/me/sources/${id}/sync`, headers: alice });
    const first = (await app.inject({ url: "/v1/me/channels", headers: alice })).json();
    await app.inject({ method: "PATCH", url: `/v1/me/channels/${first[0].id}`, headers: alice, payload: { name: "My Name", hidden: true } });
    expect((await app.inject({ method: "POST", url: `/v1/me/sources/${id}/sync`, headers: alice })).json()).toEqual({ added: 0 });
    const after = (await app.inject({ url: "/v1/me/channels", headers: alice })).json();
    expect(after).toHaveLength(2);
    expect(after.find((c: { id: string }) => c.id === first[0].id)).toMatchObject({ name: "My Name", hidden: true });
  });

  it("reports a rejected subscription instead of trying to work around it", async () => {
    const { app } = await makeApp({ [xt()]: { user_info: { auth: 1, status: "Expired" } } });
    const id = (await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "Mine", type: "xtream", url: XT, username: "u", password: "p", ownershipAttested: true } })).json().id;
    const r = await app.inject({ method: "POST", url: `/v1/me/sources/${id}/sync`, headers: alice });
    expect(r.statusCode).toBe(502);
  });

  it("requires credentials for xtream sources", async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "x", type: "xtream", url: XT, ownershipAttested: true } });
    expect(r.statusCode).toBe(400);
  });
});

describe("M3U URL and XMLTV sources", () => {
  it("syncs a user's playlist URL additively", async () => {
    const { app } = await makeApp({ "https://example.org/p.m3u": "#EXTM3U\n#EXTINF:-1,One\nhttps://example.org/1.m3u8\n" });
    const id = (await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "P", type: "m3u_url", url: "https://example.org/p.m3u", ownershipAttested: true } })).json().id;
    expect((await app.inject({ method: "POST", url: `/v1/me/sources/${id}/sync`, headers: alice })).json()).toEqual({ added: 1 });
    expect((await app.inject({ method: "POST", url: `/v1/me/sources/${id}/sync`, headers: alice })).json()).toEqual({ added: 0 });
    await app.inject({ method: "PATCH", url: `/v1/me/sources/${id}`, headers: alice, payload: { enabled: false } });
    expect((await app.inject({ method: "POST", url: `/v1/me/sources/${id}/sync`, headers: alice })).statusCode).toBe(409);
  });

  it("syncs an XMLTV guide URL", async () => {
    const { app } = await makeApp({ "https://example.org/g.xml": `<tv><channel id="c"><display-name>C</display-name></channel><programme start="20261011180000 +0000" stop="20261011190000 +0000" channel="c"><title>T</title></programme></tv>` });
    const id = (await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "G", type: "xmltv", url: "https://example.org/g.xml", ownershipAttested: true } })).json().id;
    expect((await app.inject({ method: "POST", url: `/v1/me/sources/${id}/sync`, headers: alice })).json()).toEqual({ programmes: 1, channels: 1 });
  });
});
