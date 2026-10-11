import { useCallback, useEffect, useMemo, useState } from "react";
import { api, persistToken, setBase, setOnUnauthorized, setToken, storedToken, type Channel, type NowNext, type Source, type Suggestion } from "./api";
import { t, type Lang } from "./i18n";
import { Player } from "./Player";
import { AiButton } from "./AiPanel";
import { CatalogView, GuideView, ManageView, PremiumView } from "./views";
import { SignIn } from "./SignIn";
import { GROUP_ORDER, groupCounts, groupsOf, type GroupId } from "./groups";

type Tab = "live" | "guide" | "catalog" | "premium" | "manage";

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
  const [playNonce, setPlayNonce] = useState(0); // bumps to restart the player when the AI repair found a better source
  const playChannel = useCallback((c: Channel) => { setSelected(c); setPlayNonce((n) => n + 1); }, []);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string>("all"); // a GroupId, or "src:<sourceId>" for one of the user's own sources
  const [sources, setSources] = useState<Source[]>([]);
  const [limit, setLimit] = useState(200);
  const [country, setCountry] = useState("");
  const [hits, setHits] = useState<string[] | null>(null);
  const [recs, setRecs] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [msg, setMsg] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [stats, setStats] = useState<{ channels: number; sources: number; catalog: number } | null>(null);
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
    setLoaded(false);
    setStats(null);
    setSelected(null);
  }, []);
  useEffect(() => setOnUnauthorized(signOut), [signOut]);

  const refresh = useCallback(
    () => run(async () => {
      // The channel list is what matters: it is shown as soon as it arrives, and a failure of the optional extras
      // (guide, recommendations, suggestions) never blanks it. A failed reload also keeps the previous list.
      const extras = Promise.allSettled([api.nowNext(), api.recommendations(), api.suggestions()]);
      void api.stats().then(setStats).catch(() => undefined);
      void api.sources().then(setSources).catch(() => undefined);
      try {
        // Show the first pages immediately on a cold load; on a reload keep the current list until the new one is complete.
        setChannels(await api.channels((soFar) => setChannels((prev) => (prev.length ? prev : soFar))));
      } finally {
        setLoaded(true);
      }
      const [nn, r, sg] = await extras;
      if (nn.status === "fulfilled") setNowNext(nn.value);
      if (r.status === "fulfilled") setRecs(r.value.map((x) => x.id));
      if (sg.status === "fulfilled") setSuggestions(sg.value);
    }),
    [run],
  );
  useEffect(() => {
    if (!signedIn) return;
    void refresh();
    void api.me().then((m) => setUsername(m.username)).catch(() => undefined);
  }, [signedIn, refresh]);

  // Channels can be added from other tabs (catalog, premium, manage) or other devices: reload when opening Live/Guide/Manage.
  useEffect(() => {
    if (signedIn && (tab === "live" || tab === "guide" || tab === "manage")) void refresh();
  }, [tab, signedIn, refresh]);

  const inGroup = (c: Channel, g: string) => (g === "all" ? true : g.startsWith("src:") ? c.sourceId === g.slice(4) : groupsOf(c).includes(g as GroupId));
  const visible = useMemo(() => {
    const list = channels.filter((c) => !c.hidden);
    if (hits) return hits.map((id) => list.find((c) => c.id === id)).filter((c): c is Channel => !!c);
    return list.filter((c) => inGroup(c, group) && (!country || c.country === country));
  }, [channels, hits, group, country]);
  // Countries present in the chosen group (so "Europe" can be narrowed to France, Germany, ...), with counts.
  const countries = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of channels) if (!c.hidden && c.country && inGroup(c, group)) n.set(c.country, (n.get(c.country) ?? 0) + 1);
    const names = (() => { try { return new Intl.DisplayNames([lang], { type: "region" }); } catch { return undefined; } })();
    return [...n].map(([code, count]) => ({ code, count, name: names?.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name));
  }, [channels, group, lang]);
  const counts = useMemo(() => groupCounts(channels.filter((c) => !c.hidden)), [channels]);
  // One chip per source the user added, named as they named it, so it is clear which channels came from which file/provider.
  const sourceCounts = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of channels) if (!c.hidden && c.sourceId) n.set(c.sourceId, (n.get(c.sourceId) ?? 0) + 1);
    return n;
  }, [channels]);
  useEffect(() => setLimit(200), [group, hits, country]);
  useEffect(() => setCountry(""), [group]);
  useEffect(() => {
    if (group.startsWith("src:") && sources.length > 0 && !sources.some((x) => `src:${x.id}` === group)) setGroup("all"); // the source was deleted
  }, [group, sources]);

  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;

  const tabs: Tab[] = ["live", "guide", "catalog", "premium", "manage"];
  return (
    <div className="app" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang}>
      <header>
        <h1>Smart Receiver</h1>
        <nav>{tabs.map((x) => <button key={x} aria-pressed={tab === x} onClick={() => setTab(x)}>{s[x]}</button>)}</nav>
        <input
          type="search"
          name="channel-search"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          aria-label={s.search}
          placeholder={s.search}
          value={query}
          onChange={(e) => {
            // Browser/password-manager autofill (e.g. the saved username) fills this box without the user focusing it;
            // only typing counts as a search.
            if (document.activeElement !== e.target) return;
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
            {visible.length === 0 && <p className="hint" role="status">{hits ? s.noResults : channels.length > 0 ? "" : !loaded ? s.loading : stats && stats.channels > 0 ? `${s.loading} (${stats.channels.toLocaleString()})` : stats ? `${s.savedZero} ${stats.catalog > 0 ? s.catalogReady.replace("{n}", stats.catalog.toLocaleString()) : s.noChannelsYet}` : s.noChannelsYet}</p>}
            {!hits && (
              <div className="groups" role="tablist" aria-label="Groups">
                {GROUP_ORDER.filter((g) => g === "all" || counts[g] > 0).map((g) => (
                  <button key={g} role="tab" aria-selected={group === g} aria-pressed={group === g} onClick={() => setGroup(g)}>
                    {s[`g_${g}` as keyof typeof s]} <small>{counts[g]}</small>
                  </button>
                ))}
                {sources.filter((src) => src.type !== "xmltv").map((src) => (
                  <button key={src.id} className="srcchip" role="tab" aria-selected={group === `src:${src.id}`} aria-pressed={group === `src:${src.id}`} onClick={() => setGroup(`src:${src.id}`)} title={sourceCounts.get(src.id) ? undefined : s.emptySource}>
                    ▤ {src.name} <small>{sourceCounts.get(src.id) ?? 0}</small>
                  </button>
                ))}
                {countries.length > 1 && (
                  <select aria-label={s.country} value={country} onChange={(e) => setCountry(e.target.value)}>
                    <option value="">{s.allCountries}</option>
                    {countries.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.count})</option>)}
                  </select>
                )}
              </div>
            )}
            <ul>
              {visible.slice(0, limit).map((c) => (
                <li key={c.id} className={selected?.id === c.id ? "active" : ""}>
                  <div className="rowwrap">
                    <button className="row" onClick={() => setSelected(c)}>
                      <strong>{c.name}</strong>
                      <small>{nowNext[c.id]?.now ? (nowNext[c.id]!.now as { title: string }).title : c.group ?? ""}</small>
                    </button>
                    <AiButton s={s} lang={lang} channel={c} channels={channels} onPick={(x) => setSelected(x)} onPlayed={playChannel} onNavigate={setTab} />
                  </div>
                </li>
              ))}
            </ul>
            {visible.length > limit && <button className="more" onClick={() => setLimit((n) => n + 300)}>{s.showMore} ({visible.length - limit})</button>}
          </section>
          <section className="main">
            {selected ? (
              <>
                <Player key={`${selected.id}:${playNonce}`} relayLabel={s.viaRelay} relayTip={s.viaRelayTip} playLabel={s.playBtn} fixedLabel={s.aiFixed} channelId={selected.id} onWatched={(sec) => void api.watch(selected.id, sec).catch(() => undefined)} />
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
        {tab === "premium" && <PremiumView s={s} lang={lang} channels={channels} refresh={refresh} run={run} onPlay={(c) => { playChannel(c); setTab("live"); }} />}
        {tab === "manage" && <ManageView s={s} channels={channels} suggestions={suggestions} refresh={refresh} run={run} onAccountDeleted={signOut} />}
      </div>
    </div>
  );
}
