import { useCallback, useEffect, useMemo, useState } from "react";
import { api, setToken, type Channel, type NowNext, type Suggestion } from "./api";
import { Player } from "./Player";

export function App() {
  const [user, setUser] = useState("");
  const [rtl, setRtl] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [nowNext, setNowNext] = useState<NowNext>({});
  const [selected, setSelected] = useState<Channel | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<string[] | null>(null);
  const [recs, setRecs] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [msg, setMsg] = useState("");
  const [signedIn, setSignedIn] = useState(false);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setMsg("");
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);

  const refresh = useCallback(
    () =>
      run(async () => {
        const [c, nn, r, s] = await Promise.all([api.channels(), api.nowNext(), api.recommendations(), api.suggestions()]);
        setChannels(c);
        setNowNext(nn);
        setRecs(r.map((x) => x.id));
        setSuggestions(s);
      }),
    [run],
  );

  useEffect(() => {
    if (signedIn) void refresh();
  }, [signedIn, refresh]);

  const visible = useMemo(() => {
    const list = channels.filter((c) => !c.hidden);
    return hits ? hits.map((id) => list.find((c) => c.id === id)).filter((c): c is Channel => !!c) : list;
  }, [channels, hits]);

  if (!signedIn) {
    return (
      <main className="login">
        <h1>Smart Receiver</h1>
        <p>Development sign-in (replaced by real accounts before release).</p>
        <input placeholder="user name" value={user} onChange={(e) => setUser(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))} />
        <button
          disabled={!user}
          onClick={() => {
            setToken(`dev:${user}`);
            setSignedIn(true);
          }}
        >
          Continue
        </button>
      </main>
    );
  }

  return (
    <div className="app" dir={rtl ? "rtl" : "ltr"}>
      <header>
        <h1>Smart Receiver</h1>
        <input
          placeholder={rtl ? "ابحث عن قناة أو برنامج" : "Search channels or what's on"}
          value={query}
          onChange={(e) => {
            const q = e.target.value;
            setQuery(q);
            if (!q.trim()) return setHits(null);
            void run(async () => setHits((await api.search(q)).map((h) => h.id)));
          }}
        />
        <button onClick={() => setRtl(!rtl)}>{rtl ? "English" : "العربية"}</button>
      </header>
      {msg && <p className="error">{msg}</p>}
      <div className="layout">
        <section className="list">
          {recs.length > 0 && !hits && (
            <p className="hint">For you: {recs.map((id) => channels.find((c) => c.id === id)?.name).filter(Boolean).slice(0, 3).join(", ")}</p>
          )}
          <ul>
            {visible.map((c) => (
              <li key={c.id} className={selected?.id === c.id ? "active" : ""}>
                <button className="row" onClick={() => setSelected(c)}>
                  <strong>{c.name}</strong>
                  <small>{nowNext[c.id]?.now?.title ?? c.group ?? ""}</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="main">
          {selected ? (
            <>
              <Player url={selected.streamUrl} onWatched={(s) => void api.watch(selected.id, s).catch(() => undefined)} />
              <h2>{selected.name}</h2>
              <p>
                Now: {nowNext[selected.id]?.now?.title ?? "—"} · Next: {nowNext[selected.id]?.next?.title ?? "—"}
              </p>
            </>
          ) : (
            <p>Select a channel, or import your own playlist below.</p>
          )}
          <Manager channels={channels} suggestions={suggestions} refresh={refresh} run={run} />
        </section>
      </div>
    </div>
  );
}

function Manager({
  channels, suggestions, refresh, run,
}: {
  channels: Channel[];
  suggestions: Suggestion[];
  refresh: () => Promise<unknown>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [attested, setAttested] = useState(false);
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await refresh(); });
  const readFile = (file: File | undefined, fn: (text: string) => Promise<unknown>) =>
    file && act(async () => fn(await file.text()));

  return (
    <div className="manager">
      <h3>My channels &amp; sources</h3>
      <form onSubmit={(e) => { e.preventDefault(); void act(() => api.addChannel({ name, streamUrl: url })).then(() => { setName(""); setUrl(""); }); }}>
        <input placeholder="Channel name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input placeholder="Stream URL (https://…m3u8)" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <button>Add channel</button>
      </form>
      <label className="attest">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
        I own or am entitled to use the playlists I import.
      </label>
      <label>Import M3U <input type="file" accept=".m3u,.m3u8,text/plain" disabled={!attested} onChange={(e) => readFile(e.target.files?.[0], api.importM3U)} /></label>
      <label>Import XMLTV guide <input type="file" accept=".xml,text/xml" onChange={(e) => readFile(e.target.files?.[0], api.importEpg)} /></label>
      <button
        onClick={() =>
          run(async () => {
            const url = URL.createObjectURL(new Blob([await api.exportM3U()], { type: "audio/x-mpegurl" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "my-channels.m3u";
            a.click();
            URL.revokeObjectURL(url);
          })
        }
      >
        Export my playlist (M3U)
      </button>
      {suggestions.length > 0 && (
        <div className="suggest">
          <h4>Suggested guide matches</h4>
          {suggestions.map((s) => (
            <div key={s.channelId}>
              {channels.find((c) => c.id === s.channelId)?.name} → {s.epgChannelId} ({Math.round(s.confidence * 100)}%)
              <button onClick={() => act(() => api.editChannel(s.channelId, { epgChannelId: s.epgChannelId }))}>Accept</button>
            </div>
          ))}
        </div>
      )}
      <ul>
        {channels.map((c) => (
          <li key={c.id}>
            <input
              defaultValue={c.name}
              onBlur={(e) => e.target.value && e.target.value !== c.name && void act(() => api.editChannel(c.id, { name: e.target.value }))}
            />
            <button onClick={() => act(() => api.editChannel(c.id, { hidden: !c.hidden }))}>{c.hidden ? "Show" : "Hide"}</button>
            <button onClick={() => act(() => api.deleteChannel(c.id))}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
