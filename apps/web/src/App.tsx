import { useCallback, useEffect, useMemo, useState } from "react";
import { api, persistToken, setBase, setOnUnauthorized, setToken, storedToken, type Channel, type NowNext, type Suggestion } from "./api";
import { t, type Lang } from "./i18n";
import { Player } from "./Player";
import { CatalogView, GuideView, ManageView } from "./views";
import { SignIn } from "./SignIn";

type Tab = "live" | "guide" | "catalog" | "manage";

// Packaged TV builds (Tizen/webOS) set VITE_API_BASE at build time; the web build uses the dev proxy / same origin.
setBase((import.meta.env.VITE_API_BASE as string | undefined) ?? "");

export function App() {
  const [signedIn, setSignedIn] = useState(() => {
    const t = storedToken();
    setToken(t);
    return !!t;
  });
  const [username, setUsername] = useState<string>("");
  const [lang, setLang] = useState<Lang>("en");
  const [tab, setTab] = useState<Tab>("live");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [nowNext, setNowNext] = useState<NowNext>({});
  const [selected, setSelected] = useState<Channel | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<string[] | null>(null);
  const [recs, setRecs] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [msg, setMsg] = useState("");
  const s = t(lang);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setMsg("");
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);

  const signOut = useCallback(() => {
    setToken("");
    persistToken("");
    setSignedIn(false);
    setChannels([]);
    setSelected(null);
  }, []);
  useEffect(() => setOnUnauthorized(signOut), [signOut]);

  const refresh = useCallback(
    () => run(async () => {
      const [c, nn, r, sg] = await Promise.all([api.channels(), api.nowNext(), api.recommendations(), api.suggestions()]);
      setChannels(c); setNowNext(nn); setRecs(r.map((x) => x.id)); setSuggestions(sg);
    }),
    [run],
  );
  useEffect(() => {
    if (!signedIn) return;
    void refresh();
    void api.me().then((m) => setUsername(m.username)).catch(() => undefined);
  }, [signedIn, refresh]);

  const visible = useMemo(() => {
    const list = channels.filter((c) => !c.hidden);
    return hits ? hits.map((id) => list.find((c) => c.id === id)).filter((c): c is Channel => !!c) : list;
  }, [channels, hits]);

  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;

  const tabs: Tab[] = ["live", "guide", "catalog", "manage"];
  return (
    <div className="app" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang}>
      <header>
        <h1>Smart Receiver</h1>
        <nav>{tabs.map((x) => <button key={x} aria-pressed={tab === x} onClick={() => setTab(x)}>{s[x]}</button>)}</nav>
        <input
          placeholder={s.search}
          value={query}
          onChange={(e) => {
            const q = e.target.value;
            setQuery(q);
            if (!q.trim()) return setHits(null);
            void run(async () => setHits((await api.search(q)).map((h) => h.id)));
          }}
        />
        <button onClick={() => setLang(lang === "ar" ? "en" : "ar")}>{lang === "ar" ? "English" : "العربية"}</button>
        <button onClick={() => { void api.logout().catch(() => undefined).finally(signOut); }} title={username}>{s.signOut}{username ? ` (${username})` : ""}</button>
      </header>
      {msg && <p className="error" role="alert">{msg}</p>}
      {tab === "live" && (
        <div className="layout">
          <section className="list">
            {recs.length > 0 && !hits && <p className="hint">{s.forYou}: {recs.map((id) => channels.find((c) => c.id === id)?.name).filter(Boolean).slice(0, 3).join(", ")}</p>}
            <ul>
              {visible.map((c) => (
                <li key={c.id} className={selected?.id === c.id ? "active" : ""}>
                  <button className="row" onClick={() => setSelected(c)}>
                    <strong>{c.name}</strong>
                    <small>{nowNext[c.id]?.now ? (nowNext[c.id]!.now as { title: string }).title : c.group ?? ""}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="main">
            {selected ? (
              <>
                <Player channelId={selected.id} onWatched={(sec) => void api.watch(selected.id, sec).catch(() => undefined)} />
                <h2>{selected.name}</h2>
                <p>{s.now}: {nowNext[selected.id]?.now?.title ?? "—"} · {s.next}: {nowNext[selected.id]?.next?.title ?? "—"}</p>
              </>
            ) : <p>{s.pick}</p>}
          </section>
        </div>
      )}
      <div className="page">
        {tab === "guide" && <GuideView channels={channels.filter((c) => !c.hidden)} />}
        {tab === "catalog" && <CatalogView s={s} run={run} refresh={refresh} />}
        {tab === "manage" && <ManageView s={s} channels={channels} suggestions={suggestions} refresh={refresh} run={run} onAccountDeleted={signOut} />}
      </div>
    </div>
  );
}
