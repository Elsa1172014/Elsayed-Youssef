import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/password";
import { alice, bob, makeApp, PASSWORD } from "./helpers";

const post = (app: Awaited<ReturnType<typeof makeApp>>["app"], url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: payload as object, headers });

describe("registration", () => {
  it("creates an account, returns a session and stores only a salted scrypt hash", async () => {
    const { app, db } = await makeApp();
    const r = await post(app, "/v1/auth/register", { username: "Carol", password: "a-long-enough-pass" });
    expect(r.statusCode).toBe(201);
    const { token } = r.json();
    expect((await app.inject({ url: "/v1/me", headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({ username: "Carol" });
    const row = (await db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE username='Carol'")).rows[0]!;
    expect(row.password_hash.startsWith("scrypt$")).toBe(true);
    expect(row.password_hash).not.toContain("a-long-enough-pass");
    const sess = (await db.query<{ token_hash: string }>("SELECT token_hash FROM sessions")).rows.map((x) => x.token_hash);
    expect(sess).not.toContain(token); // only a hash of the token is stored
  });

  it("enforces username and password policy and case-insensitive uniqueness", async () => {
    const { app } = await makeApp();
    expect((await post(app, "/v1/auth/register", { username: "ab", password: PASSWORD })).statusCode).toBe(400);
    expect((await post(app, "/v1/auth/register", { username: "bad name!", password: PASSWORD })).statusCode).toBe(400);
    expect((await post(app, "/v1/auth/register", { username: "dave", password: "short" })).statusCode).toBe(400);
    expect((await post(app, "/v1/auth/register", { username: "dave", password: "xxdavexxxxxxx" })).statusCode).toBe(400);
    expect((await post(app, "/v1/auth/register", { username: "dave", password: "aaaaaaaaaaaa" })).statusCode).toBe(400);
    expect((await post(app, "/v1/auth/register", { username: "ALICE", password: PASSWORD })).statusCode).toBe(409);
  });

  it("rate-limits sign-up attempts per client", async () => {
    const { app } = await makeApp();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await post(app, "/v1/auth/register", { username: `user${i}`, password: PASSWORD })).statusCode;
    expect(last).toBe(429);
  });
});

describe("login and sessions", () => {
  it("logs in with correct credentials (case-insensitive username) and rejects bad ones generically", async () => {
    const { app } = await makeApp();
    const ok = await post(app, "/v1/auth/login", { username: "ALICE", password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    const wrongPass = await post(app, "/v1/auth/login", { username: "alice", password: "nope-nope-nope" });
    const noUser = await post(app, "/v1/auth/login", { username: "ghost", password: "nope-nope-nope" });
    expect(wrongPass.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongPass.json()).toEqual(noUser.json()); // no username enumeration
  });

  it("locks out after repeated failures and unlocks after the window", async () => {
    const { app, clock } = await makeApp();
    for (let i = 0; i < 5; i++) expect((await post(app, "/v1/auth/login", { username: "alice", password: "wrong-wrong-1" })).statusCode).toBe(401);
    const blocked = await post(app, "/v1/auth/login", { username: "alice", password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    clock.now = new Date(clock.now.getTime() + 16 * 60_000);
    expect((await post(app, "/v1/auth/login", { username: "alice", password: PASSWORD })).statusCode).toBe(200);
  });

  it("requires a valid token and honours logout and expiry", async () => {
    const { app, auth, clock } = await makeApp();
    expect((await app.inject("/v1/me/channels")).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/me/channels", headers: { authorization: "Bearer not-a-real-token-value-123" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/me/channels", headers: { authorization: "Bearer dev:alice" } })).statusCode).toBe(401);

    const { token } = await auth.login("alice", PASSWORD);
    const h = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: "/v1/me/channels", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: h })).statusCode).toBe(204);
    expect((await app.inject({ url: "/v1/me/channels", headers: h })).statusCode).toBe(401);

    const fresh = { authorization: `Bearer ${(await auth.login("alice", PASSWORD)).token}` };
    clock.now = new Date(clock.now.getTime() + 31 * 24 * 3600_000);
    expect((await app.inject({ url: "/v1/me/channels", headers: fresh })).statusCode).toBe(401);
  });
});

describe("account management", () => {
  it("changing the password requires the current one and signs out other sessions", async () => {
    const { app, auth } = await makeApp();
    const other = { authorization: `Bearer ${(await auth.login("alice", PASSWORD)).token}` };
    expect((await post(app, "/v1/auth/password", { currentPassword: "wrong", newPassword: "another-long-pass" }, alice)).statusCode).toBe(403);
    expect((await post(app, "/v1/auth/password", { currentPassword: PASSWORD, newPassword: "short" }, alice)).statusCode).toBe(400);
    expect((await post(app, "/v1/auth/password", { currentPassword: PASSWORD, newPassword: "another-long-pass" }, alice)).statusCode).toBe(204);
    expect((await app.inject({ url: "/v1/me", headers: alice })).statusCode).toBe(200); // current session kept
    expect((await app.inject({ url: "/v1/me", headers: other })).statusCode).toBe(401); // others revoked
    expect((await post(app, "/v1/auth/login", { username: "alice", password: PASSWORD })).statusCode).toBe(401);
    expect((await post(app, "/v1/auth/login", { username: "alice", password: "another-long-pass" })).statusCode).toBe(200);
  });

  it("deleting the account removes all of the user's data but not others'", async () => {
    const { app, db } = await makeApp();
    await app.inject({ method: "POST", url: "/v1/me/channels", headers: alice, payload: { name: "A", streamUrl: "https://example.org/a.m3u8" } });
    await app.inject({ method: "POST", url: "/v1/me/channels", headers: bob, payload: { name: "B", streamUrl: "https://example.org/b.m3u8" } });
    await app.inject({ method: "POST", url: "/v1/me/sources", headers: alice, payload: { name: "S", type: "tuner", ownershipAttested: true } });

    const wrong = await app.inject({ method: "DELETE", url: "/v1/me", headers: alice, payload: { password: "nope" } });
    expect(wrong.statusCode).toBe(403);
    const del = await app.inject({ method: "DELETE", url: "/v1/me", headers: alice, payload: { password: PASSWORD } });
    expect(del.statusCode).toBe(204);

    expect((await app.inject({ url: "/v1/me/channels", headers: alice })).statusCode).toBe(401);
    expect((await db.query("SELECT 1 FROM user_channels WHERE name='A'")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM user_sources")).rows).toHaveLength(0);
    expect((await app.inject({ url: "/v1/me/channels", headers: bob })).json()).toHaveLength(1);
  });
});

describe("isolation", () => {
  it("users cannot read or modify each other's data", async () => {
    const { app } = await makeApp();
    const ch = (await app.inject({ method: "POST", url: "/v1/me/channels", headers: alice, payload: { name: "Mine", streamUrl: "https://example.org/a.m3u8" } })).json();
    expect((await app.inject({ url: `/v1/me/channels/${ch.id}/stream`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/v1/me/channels/${ch.id}`, headers: bob, payload: { name: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/me/channels/${ch.id}`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ url: "/v1/me/channels", headers: bob })).json()).toEqual([]);
  });
});

describe("password hashing", () => {
  it("verifies, salts, and rejects malformed hashes", async () => {
    const h1 = await hashPassword("secret-secret");
    const h2 = await hashPassword("secret-secret");
    expect(h1).not.toBe(h2);
    expect(await verifyPassword("secret-secret", h1)).toBe(true);
    expect(await verifyPassword("secret-secreT", h1)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("CORS and headers", () => {
  it("allows only configured origins and disables caching", async () => {
    const { app } = await makeApp({}, { allowedOrigins: ["https://app.example"] });
    const ok = await app.inject({ method: "OPTIONS", url: "/v1/me/channels", headers: { origin: "https://app.example" } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://app.example");
    const bad = await app.inject({ url: "/healthz", headers: { origin: "https://evil.example" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    expect(bad.headers["cache-control"]).toBe("no-store");
  });
});
