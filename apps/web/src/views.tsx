import { useEffect, useState } from "react";
import { api, type CatalogEntry, type CatalogFilter, type Channel, type Facet, type Facets, type Grid, type Source, type Suggestion } from "./api";
import type { Strings } from "./i18n";

type Run = (fn: () => Promise<unknown>) => Promise<void>;

export function GuideView({ channels }: { channels: Channel[] }) {
  const [grid, setGrid] = useState<Grid>({});
  const [from] = useState(() => new Date(Math.floor(Date.now() / 1800_000) * 1800_000));
  useEffect(() => {
    void api.grid(from, new Date(from.getTime() + 6 * 3600_000)).then(setGrid).catch(() => setGrid({}));
  }, [from]);
  const slots = Array.from({ length: 12 }, (_, i) => new Date(from.getTime() + i * 1800_000));
  const fmt = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="guide" role="table">
      <div className="guide-row head" role="row">
        <span role="columnheader" />
        {slots.map((s) => <span key={s.toISOString()} role="columnheader">{fmt(s)}</span>)}
      </div>
      {channels.filter((c) => grid[c.id]).map((c) => (
        <div className="guide-row" role="row" key={c.id}>
          <strong role="rowheader">{c.name}</strong>
          {slots.map((s) => {
            const p = grid[c.id]!.find((x) => new Date(x.start) <= s && new Date(x.stop) > s);
            return <span key={s.toISOString()} role="cell" title={p?.title}>{p && new Date(p.start) > new Date(s.getTime() - 1800_000) ? p.title : ""}</span>;
          })}
        </div>
      ))}
    </div>
  );
}

export function CatalogView({ s, run, refresh }: { s: Strings; run: Run; refresh: () => Promise<unknown> }) {
  const [f, setF] = useState<CatalogFilter>({});
  const [facets, setFacets] = useState<Facets | null>(null);
  const [items, setItems] = useState<CatalogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [result, setResult] = useState("");
  useEffect(() => { void api.facets().then(setFacets).catch(() => setFacets(null)); }, []);
  useEffect(() => {
    const h = setTimeout(() => void api.catalog(f).then((r) => { setItems(r.items); setTotal(r.total); }).catch(() => setItems([])), 250);
    return () => clearTimeout(h);
  }, [f]);
  const sel = (key: keyof CatalogFilter, label: string, list: Facet[] | undefined) => (
    <select aria-label={label} value={f[key] ?? ""} onChange={(e) => setF({ ...f, [key]: e.target.value || undefined })}>
      <option value="">{label}</option>
      {(list ?? []).map((x) => <option key={x.value} value={x.value}>{x.value} ({x.count})</option>)}
    </select>
  );
  return (
    <div>
      <p className="hint">{s.legal}</p>
      <div className="filters">
        <input value={f.q ?? ""} onChange={(e) => setF({ ...f, q: e.target.value || undefined })} placeholder={s.search} />
        {sel("country", s.country, facets?.countries)}
        {sel("category", s.category, facets?.categories)}
        {sel("language", s.language, facets?.languages)}
      </div>
      <p>
        <strong>{total.toLocaleString()}</strong> {s.channelsFound}{" "}
        <button disabled={total === 0} onClick={() => {
          if (!window.confirm(`${s.addAll}: ${Math.min(total, 20000)}?`)) return;
          void run(async () => { const r = await api.importCatalog(f); setResult(`${r.added} ${s.added}, ${r.skipped} ${s.skipped}`); await refresh(); });
        }}>{s.addAll}</button>{" "}<span className="hint">{result}</span>
      </p>
      <ul>
        {items.map((c) => (
          <li key={c.id} className="cat">
            <span><strong>{c.name}</strong> <small>{[c.country, c.categories[0], c.languages[0]].filter(Boolean).join(" · ")}</small></span>
            <button onClick={() => void run(async () => { await api.addFromCatalog(c.id); await refresh(); })}>{s.addToMine}</button>
          </li>
        ))}
      </ul>
      {items.length < total && (
        <button onClick={() => void api.catalog(f, items.length).then((r) => setItems([...items, ...r.items])).catch(() => undefined)}>{s.more}</button>
      )}
    </div>
  );
}

export function ManageView({
  s, channels, suggestions, refresh, run, onAccountDeleted,
}: { s: Strings; channels: Channel[]; suggestions: Suggestion[]; refresh: () => Promise<unknown>; run: Run; onAccountDeleted: () => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [attested, setAttested] = useState(false);
  const [form, setForm] = useState({ name: "", type: "m3u_url" as Source["type"], url: "", username: "", password: "" });
  const [chName, setChName] = useState("");
  const [chUrl, setChUrl] = useState("");
  const load = () => api.sources().then(setSources).catch(() => setSources([]));
  useEffect(() => { void load(); }, []);
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await Promise.all([refresh(), load()]); });
  const readFile = (file: File | undefined, fn: (text: string) => Promise<unknown>) => file && act(async () => fn(await file.text()));
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="manager">
      <label className="attest"><input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} /> {s.attest}</label>

      <h3>Sources</h3>
      <form onSubmit={(e) => { e.preventDefault(); void act(() => api.addSource(form)); }}>
        <input placeholder={s.name} value={form.name} onChange={set("name")} required />
        <select value={form.type} onChange={set("type")} aria-label={s.type}>
          <option value="m3u_url">M3U URL</option><option value="xtream">Xtream</option><option value="xmltv">XMLTV guide</option>
        </select>
        <input placeholder={s.url} value={form.url} onChange={set("url")} required />
        {form.type === "xtream" && (<>
          <input placeholder={s.username} value={form.username} onChange={set("username")} required autoComplete="off" />
          <input placeholder={s.password} type="password" value={form.password} onChange={set("password")} required autoComplete="off" />
        </>)}
        <button disabled={!attested}>{s.add}</button>
      </form>
      <ul>
        {sources.map((src) => (
          <li key={src.id}>
            <span className="grow">{src.name} <small>({src.type}{src.lastSyncAt ? `, ${new Date(src.lastSyncAt).toLocaleString()}` : ""})</small></span>
            {src.type !== "m3u_file" && src.type !== "tuner" && <button onClick={() => act(() => api.syncSource(src.id))}>{s.sync}</button>}
            <button onClick={() => act(() => api.editSource(src.id, { enabled: !src.enabled }))}>{src.enabled ? s.hide : s.show}</button>
            <button onClick={() => act(() => api.deleteSource(src.id))}>{s.delete}</button>
          </li>
        ))}
      </ul>

      <label>{s.importM3U} <input type="file" accept=".m3u,.m3u8,text/plain" disabled={!attested} onChange={(e) => readFile(e.target.files?.[0], api.importM3U)} /></label>
      <label>{s.importEpg} <input type="file" accept=".xml,text/xml" onChange={(e) => readFile(e.target.files?.[0], api.importEpg)} /></label>
      <button onClick={() => run(async () => {
        const url = URL.createObjectURL(new Blob([await api.exportM3U()], { type: "audio/x-mpegurl" }));
        const a = document.createElement("a");
        a.href = url; a.download = "my-channels.m3u"; a.click(); URL.revokeObjectURL(url);
      })}>{s.exportM3U}</button>
      <button onClick={() => act(api.clearHistory)}>{s.clearHistory}</button>

      {suggestions.length > 0 && (
        <div className="suggest">
          <h4>{s.suggested}</h4>
          {suggestions.map((g) => (
            <div key={g.channelId}>
              {channels.find((c) => c.id === g.channelId)?.name} → {g.epgChannelId} ({Math.round(g.confidence * 100)}%)
              <button onClick={() => act(() => api.editChannel(g.channelId, { epgChannelId: g.epgChannelId }))}>{s.accept}</button>
            </div>
          ))}
        </div>
      )}

      <h3>Account</h3>
      <AccountPanel s={s} run={run} onDeleted={onAccountDeleted} />

      <h3>Channels</h3>
      <form onSubmit={(e) => { e.preventDefault(); void act(() => api.addChannel({ name: chName, streamUrl: chUrl })).then(() => { setChName(""); setChUrl(""); }); }}>
        <input placeholder={s.name} value={chName} onChange={(e) => setChName(e.target.value)} required />
        <input placeholder="https://…m3u8" value={chUrl} onChange={(e) => setChUrl(e.target.value)} required />
        <button>{s.add}</button>
      </form>
      <ul>
        {channels.map((c) => (
          <li key={c.id}>
            <input className="grow" defaultValue={c.name} onBlur={(e) => e.target.value && e.target.value !== c.name && void act(() => api.editChannel(c.id, { name: e.target.value }))} />
            <button onClick={() => act(() => api.editChannel(c.id, { hidden: !c.hidden }))}>{c.hidden ? s.show : s.hide}</button>
            <button onClick={() => act(() => api.deleteChannel(c.id))}>{s.delete}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AccountPanel({ s, run, onDeleted }: { s: Strings; run: Run; onDeleted: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  return (
    <div className="account">
      <input type="password" placeholder={s.confirmPassword} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      <input type="password" placeholder={s.newPassword} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      <button disabled={!current || next.length < 10} onClick={() => run(async () => { await api.changePassword(current, next); setCurrent(""); setNext(""); })}>{s.changePassword}</button>
      <button disabled={!current} onClick={() => run(async () => { await api.deleteAccount(current); onDeleted(); })}>{s.deleteAccount}</button>
    </div>
  );
}
