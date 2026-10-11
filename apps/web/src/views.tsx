import { useEffect, useState } from "react";
import { api, type CatalogEntry, type CatalogFilter, type Channel, type Facet, type Facets, type Grid, type PremiumEntry, type Source, type Suggestion } from "./api";
import { AiButton } from "./AiPanel";
import type { Lang, Strings } from "./i18n";

type Run = (fn: () => Promise<unknown>) => Promise<void>;

/** Name of the Live group created by "add all", from the active filters (e.g. "iptv-org · Arabic · sports"). */
const groupName = (f: CatalogFilter) => ["iptv-org", f.arabic && "Arabic", f.europe && "Europe", f.country, f.category, f.language, f.q && `“${f.q}”`].filter(Boolean).join(" · ");

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

/** Refreshes the shared channel directory on demand (hosts without a background worker). Progress survives interruptions. */
function SyncBar({ s, onDone }: { s: Strings; onDone: () => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.syncStatus>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => api.syncStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => { void load(); }, []);
  const go = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.syncNow();
      setMsg(`${s.syncDone}: ${r.channels.toLocaleString()} / ${r.streams.toLocaleString()} / ${r.premium.toLocaleString()}`);
    } catch (e) {
      const m = (e as Error).message;
      setMsg(/^Request failed \((502|503|504)\)|Failed to fetch/.test(m) ? s.syncRetry : m);
    }
    setBusy(false);
    await load();
    onDone();
  };
  return (
    <p role="status">
      {status && status.channels === 0 && !busy && <span className="hint">{s.syncEmpty} </span>}
      <button disabled={busy || status?.running} onClick={() => void go()}>{s.syncNow}</button>{" "}
      <span className="hint">
        {busy ? s.syncing : msg || (status?.lastSync ? `${s.lastSynced}: ${new Date(status.lastSync.at).toLocaleString()}` : "")}
      </span>
    </p>
  );
}

export function CatalogView({ s, run, refresh }: { s: Strings; run: Run; refresh: () => Promise<unknown> }) {
  const [f, setF] = useState<CatalogFilter>({});
  const [facets, setFacets] = useState<Facets | null>(null);
  const [items, setItems] = useState<CatalogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [result, setResult] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => { void api.facets().then(setFacets).catch(() => setFacets(null)); }, [tick]);
  useEffect(() => {
    const h = setTimeout(() => void api.catalog(f).then((r) => { setItems(r.items); setTotal(r.total); }).catch(() => setItems([])), 250);
    return () => clearTimeout(h);
  }, [f, tick]);
  const sel = (key: keyof CatalogFilter, label: string, list: Facet[] | undefined) => (
    <select aria-label={label} value={f[key] ?? ""} onChange={(e) => setF({ ...f, [key]: e.target.value || undefined })}>
      <option value="">{label}</option>
      {(list ?? []).map((x) => <option key={x.value} value={x.value}>{x.value} ({x.count})</option>)}
    </select>
  );
  return (
    <div>
      <p className="hint">{s.legal}</p>
      <SyncBar s={s} onDone={() => setTick((t) => t + 1)} />
      <div className="filters">
        <input value={f.q ?? ""} onChange={(e) => setF({ ...f, q: e.target.value || undefined })} placeholder={s.search} />
        {sel("country", s.country, facets?.countries)}
        {sel("category", s.category, facets?.categories)}
        {sel("language", s.language, facets?.languages)}
        <button aria-pressed={f.arabic === "1"} onClick={() => setF({ ...f, arabic: f.arabic === "1" ? undefined : "1" })}>{s.arabicOnly}</button>
        <button aria-pressed={f.europe === "1"} onClick={() => setF({ ...f, europe: f.europe === "1" ? undefined : "1" })}>{s.europeOnly}</button>
      </div>
      <p>
        <strong>{total.toLocaleString()}</strong> {s.channelsFound}{" "}
        <button disabled={total === 0} onClick={() => {
          if (!window.confirm(`${s.addAll}: ${Math.min(total, 20000)}?`)) return;
          void run(async () => { const r = await api.importCatalog(f, groupName(f)); setResult(`${r.added} ${s.added}, ${r.skipped} ${s.skipped}`); await refresh(); });
        }}>{s.addAll}</button>{" "}
        <button disabled={total === 0} onClick={() => void run(async () => {
          const url = URL.createObjectURL(new Blob([await api.exportCatalogM3U(f)], { type: "audio/x-mpegurl" }));
          const a = document.createElement("a");
          a.href = url; a.download = `${[f.arabic && "arabic", f.europe && "europe", f.country, f.category, f.language].filter(Boolean).join("-") || "free-channels"}.m3u`; a.click(); URL.revokeObjectURL(url);
        })}>{s.downloadM3U}</button>{" "}<span className="hint">{result}</span>
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
  const [chGroup, setChGroup] = useState("");
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState("");
  const load = () => api.sources().then(setSources).catch(() => setSources([]));
  useEffect(() => { void load(); }, []);
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await Promise.all([refresh(), load()]); });
  const readFile = (file: File | undefined, fn: (text: string) => Promise<unknown>) => file && act(async () => fn(await file.text()));
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="manager">
      <label className="attest"><input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} /> {s.attest}</label>

      <h3>Sources</h3>
      <form onSubmit={(e) => {
        e.preventDefault();
        void act(async () => {
          // Adding a source only saves it; fetch its channels right away so they appear without a second click.
          const src = await api.addSource(form);
          setNote("");
          try {
            const r = await api.syncSource(src.id);
            setNote(r.added !== undefined ? `${r.added} ${s.added}` : "");
          } catch (err) {
            setNote((err as Error).message); // source stays saved; "Sync" retries it
          }
        });
      }}>
        <input placeholder={s.name} value={form.name} onChange={set("name")} required />
        <select value={form.type} onChange={set("type")} aria-label={s.type}>
          <option value="m3u_url">M3U / M3U8 URL</option><option value="xtream">Xtream</option><option value="xmltv">XMLTV guide</option>
        </select>
        <input placeholder={s.url} value={form.url} onChange={set("url")} required />
        {form.type === "xtream" && (<>
          <input placeholder={s.username} value={form.username} onChange={set("username")} required autoComplete="off" />
          <input placeholder={s.password} type="password" value={form.password} onChange={set("password")} required autoComplete="off" />
        </>)}
        <button disabled={!attested}>{s.add}</button>{" "}<span className="hint">{attested ? note : s.attest}</span>
      </form>
      <ul>
        {sources.map((src) => (
          <li key={src.id}>
            <span className="grow">{src.name} <small>({src.type}{src.lastSyncAt ? `, ${new Date(src.lastSyncAt).toLocaleString()}` : ""})</small></span>
            {src.type !== "m3u_file" && src.type !== "tuner" && <button onClick={() => act(() => api.syncSource(src.id))}>{s.sync}</button>}
            <button onClick={() => { const n = window.prompt(s.renameSource, src.name)?.trim(); if (n && n !== src.name) void act(() => api.editSource(src.id, { name: n })); }}>{s.rename}</button>
            <button onClick={() => act(() => api.editSource(src.id, { enabled: !src.enabled }))}>{src.enabled ? s.hide : s.show}</button>
            <button onClick={() => act(() => api.deleteSource(src.id))}>{s.delete}</button>
          </li>
        ))}
      </ul>

      <label>{s.importM3U} <input type="file" accept=".m3u,.m3u8,text/plain" disabled={!attested} onChange={(e) => { const f = e.target.files?.[0]; readFile(f, (text) => api.importM3U(text, f?.name.replace(/\.[^.]+$/, ""))); }} /></label>
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

      <h3>{s.directStream}</h3>
      <p className="hint">{s.directStreamHint}</p>
      <form onSubmit={(e) => { e.preventDefault(); void act(() => api.addChannel({ name: chName.trim(), streamUrl: chUrl.trim(), groupName: chGroup.trim() || s.myStreams })).then(() => { setChName(""); setChUrl(""); setChGroup(""); }); }}>
        <input placeholder={s.name} value={chName} onChange={(e) => setChName(e.target.value)} required />
        <input type="url" dir="ltr" placeholder="https://example.com/live/stream.m3u8" value={chUrl} onChange={(e) => setChUrl(e.target.value)} required />
        <input placeholder={`${s.groupOptional} (${s.myStreams})`} value={chGroup} onChange={(e) => setChGroup(e.target.value)} />
        <button>{s.add}</button>
      </form>

      <h3>Channels</h3>
      <input placeholder={s.search} aria-label={s.search} value={filter} autoComplete="off" onChange={(e) => setFilter(e.target.value)} />
      <p className="hint">{channels.length.toLocaleString()}</p>
      <ul>
        {channels.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 200).map((c) => (
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

export function PremiumView({
  s, lang, channels, refresh, run, onPlay,
}: { s: Strings; lang: Lang; channels: Channel[]; refresh: () => Promise<unknown>; run: Run; onPlay: (c: Channel) => void }) {
  const [f, setF] = useState<CatalogFilter>({});
  const [facets, setFacets] = useState<Facets | null>(null);
  const [items, setItems] = useState<PremiumEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [matches, setMatches] = useState<Record<string, { channelId: string; confidence: number }[]>>({});
  const [xtreamIds, setXtreamIds] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    void api.premiumFacets().then(setFacets).catch(() => setFacets(null));
    void api.sources().then((src) => setXtreamIds(new Set(src.filter((x) => x.type === "xtream").map((x) => x.id)))).catch(() => undefined);
  }, [tick]);
  useEffect(() => {
    const h = setTimeout(() => void api.premium(f).then((r) => { setItems(r.items); setTotal(r.total); }).catch(() => setItems([])), 250);
    return () => clearTimeout(h);
  }, [f, tick]);
  const sel = (key: keyof CatalogFilter, label: string, list: Facet[] | undefined) => (
    <select aria-label={label} value={f[key] ?? ""} onChange={(e) => setF({ ...f, [key]: e.target.value || undefined })}>
      <option value="">{label}</option>
      {(list ?? []).map((x) => <option key={x.value} value={x.value}>{x.value} ({x.count})</option>)}
    </select>
  );
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await refresh(); });
  const mine = channels.filter((c) => c.premiumId || (c.sourceId && xtreamIds.has(c.sourceId)));
  const nameOf = (id: string) => channels.find((c) => c.id === id)?.name ?? id;

  return (
    <div>
      <p className="hint" role="note">{s.premiumNote}</p>
      <SyncBar s={s} onDone={() => setTick((t) => t + 1)} />

      <h3>{s.mySubscription} ({mine.length})</h3>
      <ul>
        {mine.slice(0, 200).map((c) => (
          <li key={c.id} className="cat">
            <span className="rowwrap">
              <button className="link" onClick={() => onPlay(c)}>{c.name}</button>
              {c.premiumId && <small> ✓ {c.premiumId}</small>}
              <AiButton s={s} lang={lang} channel={c} channels={channels} onPick={onPlay} />
            </span>
            {c.premiumId && <button onClick={() => act(() => api.premiumUnlink(c.id))}>{s.unlink}</button>}
          </li>
        ))}
      </ul>

      <h3>{s.premium}</h3>
      <div className="filters">
        <input value={f.q ?? ""} onChange={(e) => setF({ ...f, q: e.target.value || undefined })} placeholder={s.search} />
        {sel("country", s.country, facets?.countries)}
        {sel("category", s.category, facets?.categories)}
        {sel("language", s.language, facets?.languages)}
      </div>
      <p><strong>{total.toLocaleString()}</strong> {s.premium}</p>
      <ul>
        {items.map((p) => (
          <li key={p.id} className="cat">
            <span className="rowwrap">
              {p.logoUrl && <img src={p.logoUrl} alt="" width={28} height={28} loading="lazy" referrerPolicy="no-referrer" />}
              <span><strong>{p.name}</strong> <small>{[p.country, p.categories[0], p.languages[0]].filter(Boolean).join(" · ")}</small></span>
            </span>
            <span>
              <button onClick={() => void run(async () => setMatches({ ...matches, [p.id]: await api.premiumMatches(p.id) }))}>{s.findMine}</button>
              {matches[p.id] && (matches[p.id]!.length === 0
                ? <small> {s.noMatches}</small>
                : matches[p.id]!.map((m) => (
                  <button key={m.channelId} onClick={() => act(() => api.premiumLink(p.id, m.channelId))}>{s.link}: {nameOf(m.channelId)} ({Math.round(m.confidence * 100)}%)</button>
                )))}
            </span>
          </li>
        ))}
      </ul>
      {items.length < total && (
        <button onClick={() => void api.premium(f, items.length).then((r) => setItems([...items, ...r.items])).catch(() => undefined)}>{s.more}</button>
      )}
    </div>
  );
}
