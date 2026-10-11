import { useCallback, useEffect, useMemo, useState } from "react";
import { api, persistToken, setBase, setOnUnauthorized, setToken, storedToken, type Channel, type NowNext, type Suggestion } from "./api";
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
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<GroupId>("all");
  const [limit, setLimit] = useState(200);
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

  // Channels can be added from other tabs (catalog, premium, manage) or other devices: reload when opening Live/Guide/Manage.
  useEffect(() => {
    if (signedIn && (tab === "live" || tab === "guide" || tab === "manage")) void refresh();
  }, [tab, signedIn, refresh]);

  const visible = useMemo(() => {
    const list = channels.filter((c) => !c.hidden);
    if (hits) return hits.map((id) => list.find((c) => c.id === id)).filter((c): c is Channel => !!c);
    return group === "all" ? list : list.filter((c) => groupsOf(c).includes(group));
  }, [channels, hits, group]);
  const counts = useMemo(() => groupCounts(channels.filter((c) => !c.hidden)), [channels]);
  useEffect(() => setLimit(200), [group, hits]);

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
            {visible.length === 0 && <p className="hint" role="status">{hits ? s.noResults : channels.length === 0 ? s.noChannelsYet : ""}</p>}
            {!hits && (
              <div className="groups" role="tablist" aria-label="Groups">
                {GROUP_ORDER.filter((g) => g === "all" || counts[g] > 0).map((g) => (
                  <button key={g} role="tab" aria-selected={group === g} aria-pressed={group === g} onClick={() => setGroup(g)}>
                    {s[`g_${g}` as keyof typeof s]} <small>{counts[g]}</small>
                  </button>
                ))}
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
                    <AiButton s={s} lang={lang} channel={c} channels={channels} onPick={(x) => setSelected(x)} />
                  </div>
                </li>
              ))}
            </ul>
            {visible.length > limit && <button className="more" onClick={() => setLimit((n) => n + 300)}>{s.showMore} ({visible.length - limit})</button>}
          </section>
          <section className="main">
            {selected ? (
              <>
                <Player relayLabel={s.viaRelay} relayTip={s.viaRelayTip} channelId={selected.id} onWatched={(sec) => void api.watch(selected.id, sec).catch(() => undefined)} />
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
        {tab === "premium" && <PremiumView s={s} lang={lang} channels={channels} refresh={refresh} run={run} onPlay={(c) => { setSelected(c); setTab("live"); }} />}
        {tab === "manage" && <ManageView s={s} channels={channels} suggestions={suggestions} refresh={refresh} run={run} onAccountDeleted={signOut} />}
      </div>
    </div>
  );
}
