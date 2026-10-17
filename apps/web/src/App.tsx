import { useCallback, useEffect, useMemo, useState } from "react";
import { api, persistToken, setBase, setOnUnauthorized, setToken, storedToken, type Channel, type NowNext, type Source, type Suggestion } from "./api";
import { t, type Lang } from "./i18n";
import { Player } from "./Player";
import { SportsView } from "./SportsView";
import { SportsNewsView } from "./SportsNewsView";
import { AiButton } from "./AiPanel";
import { CatalogView, GuideView, ManageView, PremiumView } from "./views";
import { SignIn } from "./SignIn";
import { YouTubeView } from "./YouTubeView";
import { GROUP_ORDER, groupCounts, groupsOf, type GroupId } from "./groups";

type Tab = "live" | "youtube" | "news" | "guide" | "catalog" | "premium" | "manage";

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
  const [showAudit, setShowAudit] = useState(false);
  const [health, setHealth] = useState<Record<string, { status: string; detail: string }>>({});
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthProgress, setHealthProgress] = useState(0);
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

  // Read-only audit: never deletes, hides, probes or modifies any stream.
  const audit = useMemo(() => {
    const byUrl = new Map<string, Channel[]>();
    const byName = new Map<string, Channel[]>();
    const invalid: Channel[] = [];
    for (const c of channels) {
      const url = (c.streamUrl ?? "").trim();
      const normalizedUrl = url.replace(/\/$/, "").toLowerCase();
      const normalizedName = (c.name ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
      if (normalizedUrl) byUrl.set(normalizedUrl, [...(byUrl.get(normalizedUrl) ?? []), c]);
      if (normalizedName) byName.set(normalizedName, [...(byName.get(normalizedName) ?? []), c]);
      if (!url || !/^(https?:\/\/|rtmps?:\/\/|rtsp:\/\/|udp:\/\/|rtp:\/\/)/i.test(url)) invalid.push(c);
    }
    const sameUrl = [...byUrl.values()].filter((g) => g.length > 1);
    const sameName = [...byName.values()].filter((g) => g.length > 1);
    return { sameUrl, sameName, invalid };
  }, [channels]);
  const downloadAudit = () => {
    const rows: string[][] = [["نوع الملاحظة", "اسم القناة", "معرف القناة", "المصدر", "رابط البث", "الحالة"]];
    const add = (kind: string, c: Channel, status: string) => rows.push([kind, c.name, c.id, c.sourceId ?? "", c.streamUrl ?? "", status]);
    audit.sameUrl.forEach((group) => group.forEach((c) => add("رابط مكرر", c, "لم يتم اختبار التشغيل")));
    audit.sameName.forEach((group) => group.forEach((c) => add("اسم مكرر", c, "قد تكون مصادر بث مختلفة")));
    audit.invalid.forEach((c) => add("رابط مفقود أو غير معروف البروتوكول", c, "يحتاج مراجعة يدوية"));
    const csv = "\uFEFF" + rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "smart-receiver-channel-audit.csv"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const checkChannelHealth = async () => {
    if (healthBusy) return;
    setHealthBusy(true);
    const results: Record<string, { status: string; detail: string }> = {};
    setHealthProgress(0);
    for (let i = 0; i < channels.length; i += 3) {
      await Promise.all(channels.slice(i, i + 3).map(async (c) => {
        try {
          const d = await api.diagnose(c.id);
          const detail = JSON.stringify(d);
          const outcome = String(d.outcome ?? "").toLowerCase();
          const status = /playing|playable|success/.test(outcome) ? "تعمل" : /unavailable|failed|offline/.test(outcome) ? "فشل" : "غير مؤكدة";
          results[c.id] = { status, detail: detail.slice(0, 350) };
        } catch (e) { results[c.id] = { status: "غير مؤكدة", detail: (e as Error).message }; }
      }));
      setHealth({ ...results });
      setHealthProgress(Math.min(i + 3, channels.length));
    }
    setHealthBusy(false);
  };
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

  const tabs: Tab[] = ["live", "youtube", "news", "guide", "catalog", "premium", "manage"];
  return (
    <div className="app" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang}>
      <header>
        <h1>Smart Receiver</h1>
        <nav>{tabs.map((x) => <button key={x} aria-pressed={tab === x} onClick={() => setTab(x)}>{x === "youtube" ? "▶ YouTube" : x === "news" ? "⚽ الرياضة والأخبار" : s[x]}</button>)}</nav>
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
            <div className="hint">
              <button onClick={() => setShowAudit((v) => !v)}>{showAudit ? "إخفاء تقرير الفحص" : "فحص التكرارات والروابط — دون حذف"}</button>
              {showAudit && <div role="region" aria-label="تقرير تدقيق القنوات" style={{ padding: 12, border: "1px solid #777", marginTop: 8 }}>
                <strong>تقرير جميع القنوات المحمّلة من المصادر المتاحة (قراءة فقط)</strong>
                <p>إجمالي القنوات: {channels.length} · مجموعات روابط مكررة: {audit.sameUrl.length} · مجموعات أسماء مكررة: {audit.sameName.length} · روابط مفقودة أو غير معروفة: {audit.invalid.length}</p>
                <p>حالة التشغيل غير مفحوصة: {channels.length}. لا يمكن اعتبار الرابط متعطلًا دون اختبار بث موثوق؛ لم تُرسل طلبات اختبار ولم تُعدّل أي قناة.</p>
                <button onClick={downloadAudit}>تنزيل تقرير CSV بالتفاصيل</button>
                <section aria-label="فحص تشغيل القنوات" style={{marginTop:14}}>
                  <h3>حالة تشغيل القنوات من جميع المصادر</h3>
                  <p>فحص قراءة فقط باستخدام تشخيص الخادم؛ قد لا يعكس بالضرورة التشغيل على التلفاز.</p>
                  <button disabled={healthBusy || !channels.length} onClick={() => void checkChannelHealth()}>{healthBusy ? "جارٍ الفحص..." : "فحص جميع القنوات دون حذف"}</button>
                  {healthBusy && <progress value={healthProgress} max={channels.length || 1} style={{width:"100%"}} />}
                  <p>تم فحص {Object.keys(health).length} من {channels.length} قناة · تعمل: {Object.values(health).filter(x=>x.status==="تعمل").length} · فشل: {Object.values(health).filter(x=>x.status==="فشل").length} · غير مؤكدة: {Object.values(health).filter(x=>x.status==="غير مؤكدة").length}</p>
                  <div style={{maxHeight:320,overflowY:"auto"}}>
                    {channels.filter(c=>health[c.id] && health[c.id].status!=="تعمل").slice(0,200).map(c=><p key={c.id}><strong>{c.name}</strong> — {health[c.id].status} — {health[c.id].detail}</p>)}
                  </div>
                </section>
                {audit.sameUrl.slice(0, 15).map((g, i) => <p key={"url"+i}>رابط مكرر ({g.length}): {g.map((c) => c.name).join("، ")}</p>)}
                {audit.sameName.slice(0, 15).map((g, i) => <p key={"name"+i}>اسم مكرر ({g.length}): {g.map((c) => c.name).join("، ")}</p>)}
              </div>}
            </div>
            {recs.length > 0 && !hits && <p className="hint">{s.forYou}: {recs.map((id) => channels.find((c) => c.id === id)?.name).filter(Boolean).slice(0, 3).join(", ")}</p>}
            {visible.length === 0 && <p className="hint" role="status">{hits ? s.noResults : channels.length > 0 ? "" : !loaded ? s.loading : stats && stats.channels > 0 ? `${s.loading} (${stats.channels.toLocaleString()})` : stats ? `${s.savedZero} ${stats.catalog > 0 ? s.catalogReady.replace("{n}", stats.catalog.toLocaleString()) : s.noChannelsYet}` : s.noChannelsYet}</p>}
            {!hits && (
              <div className="groups" role="tablist" aria-label="Groups">
                {GROUP_ORDER.filter((g) => g === "all" || counts[g] > 0).map((g) => (
                  <button key={g} role="tab" aria-selected={group === g} aria-pressed={group === g} onClick={() => { setGroup(g); }}>
                    {s[`g_${g}` as keyof typeof s]} <small>{counts[g]}</small>
                  </button>
                ))}
                {sources.filter((src) => src.type !== "xmltv").map((src) => (
                  <button key={src.id} className="srcchip" role="tab" aria-selected={group === `src:${src.id}`} aria-pressed={group === `src:${src.id}`} onClick={() => { setGroup(`src:${src.id}`); }} title={sourceCounts.get(src.id) ? undefined : s.emptySource}>
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
        {tab === "youtube" && <YouTubeView />}
        {tab === "news" && <><SportsView channels={channels} onPlay={(c) => { playChannel(c); setTab("live"); }} /><SportsNewsView /></>}
        {tab === "guide" && <GuideView channels={channels.filter((c) => !c.hidden)} />}
        {tab === "catalog" && <CatalogView s={s} run={run} refresh={refresh} />}
        {tab === "premium" && <PremiumView s={s} lang={lang} channels={channels} refresh={refresh} run={run} onPlay={(c) => { playChannel(c); setTab("live"); }} />}
        {tab === "manage" && <ManageView s={s} channels={channels} suggestions={suggestions} refresh={refresh} run={run} onAccountDeleted={signOut} />}
      </div>
    </div>
  );
}
