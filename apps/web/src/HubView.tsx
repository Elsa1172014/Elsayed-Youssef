import { useEffect, useMemo, useState } from "react";
import { api, type HubMatch, type HubPlaySource, type HubStatus, type HubTitle, type Source } from "./api";
import { HubAdmin } from "./HubAdmin";
import { HubPlayer } from "./HubPlayer";

type Section = "library" | "matches" | "receiver" | "iptv" | "admin";
const IMG = "https://image.tmdb.org/t/p/";
const fmtTime = (iso?: string) => (iso ? new Intl.DateTimeFormat("ar", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—");

/** Entertainment Hub: movies & series (TMDB metadata + licensed sources), matches (TheSportsDB), receiver library, IPTV-org, admin. */
export function HubView({ onNavigate }: { onNavigate: (tab: "catalog" | "live" | "manage") => void }) {
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [section, setSection] = useState<Section>("library");
  const [err, setErr] = useState("");
  useEffect(() => { void api.hubStatus().then(setStatus).catch((e: Error) => setErr(e.message)); }, []);

  const sections: [Section, string][] = [["library", "🎬 أفلام ومسلسلات"], ["matches", "⚽ المباريات"], ["receiver", "📡 مكتبة الرسيفر"], ["iptv", "🌍 قنوات IPTV-org"]];
  if (status?.isAdmin) sections.push(["admin", "🛠 لوحة الإدارة"]);

  return (
    <div className="hub" dir="rtl" lang="ar">
      <div className="hub-head">
        <h2>Entertainment Hub</h2>
        <nav className="hub-tabs" role="tablist">
          {sections.map(([k, label]) => <button key={k} role="tab" aria-selected={section === k} aria-pressed={section === k} onClick={() => setSection(k)}>{label}</button>)}
        </nav>
      </div>
      {err && <p className="error">{err}</p>}
      {status && !status.enabled && (section === "library" || section === "matches") && (
        <p className="hub-note">وحدة الترفيه غير مفعّلة على الخادم بعد: يلزم ضبط متغير البيئة <code>SUPABASE_DB_URL</code> في Vercel. قسما الرسيفر وIPTV-org يعملان الآن.</p>
      )}
      {section === "library" && status?.enabled && <Library />}
      {section === "matches" && status?.enabled && <Matches />}
      {section === "receiver" && <Receiver onNavigate={onNavigate} />}
      {section === "iptv" && <Iptv onNavigate={onNavigate} />}
      {section === "admin" && status?.isAdmin && <HubAdmin />}
      <footer className="hub-credits">
        بيانات الأفلام والمسلسلات من TMDB — هذا المنتج يستخدم واجهة TMDB البرمجية لكنه غير معتمد من TMDB. بيانات «أين تشاهد» مقدَّمة من JustWatch. بيانات المباريات من TheSportsDB. القنوات المفتوحة من دليل iptv-org.
      </footer>
    </div>
  );
}

function Library() {
  const [kind, setKind] = useState<"" | "movie" | "tv">("");
  const [q, setQ] = useState("");
  const [licensed, setLicensed] = useState(false);
  const [items, setItems] = useState<HubTitle[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<(HubTitle & { sources: HubPlaySource[] }) | null>(null);
  const [playing, setPlaying] = useState<HubPlaySource | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const h = setTimeout(() => void api.hubTitles({ kind: kind || undefined, q: q.trim() || undefined, licensed }).then((r) => { setItems(r.items); setTotal(r.total); setErr(""); }).catch((e: Error) => setErr(e.message)), 250);
    return () => clearTimeout(h);
  }, [kind, q, licensed]);
  const more = () => void api.hubTitles({ kind: kind || undefined, q: q.trim() || undefined, licensed, offset: items.length }).then((r) => setItems([...items, ...r.items])).catch(() => undefined);

  return (
    <section>
      <div className="filters">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث عن فيلم أو مسلسل" aria-label="بحث في المكتبة" />
        {([["", "الكل"], ["movie", "أفلام"], ["tv", "مسلسلات"]] as const).map(([k, l]) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}
        <button aria-pressed={licensed} onClick={() => setLicensed((x) => !x)}>▶ متاح للمشاهدة هنا</button>
      </div>
      {err && <p className="error">{err}</p>}
      {!err && items.length === 0 && <p className="hint">المكتبة فارغة. تُحدَّث تلقائيًا كل يوم، أو يشغّل المشرف التحديث من لوحة الإدارة.</p>}
      <div className="hub-grid">
        {items.map((t) => (
          <button key={t.id} className="hub-card" onClick={() => void api.hubTitle(t.id).then(setOpen).catch((e: Error) => setErr(e.message))}>
            {t.posterPath ? <img src={`${IMG}w342${t.posterPath}`} alt="" loading="lazy" /> : <div className="hub-noposter">🎬</div>}
            <strong>{t.title}</strong>
            <small>{t.kind === "movie" ? "فيلم" : "مسلسل"}{t.releaseDate ? ` · ${t.releaseDate.slice(0, 4)}` : ""}{t.voteAverage ? ` · ★ ${t.voteAverage}` : ""}</small>
            {t.licensedCount > 0 && <span className="hub-badge">▶ متاح</span>}
          </button>
        ))}
      </div>
      {items.length < total && <button className="more" onClick={more}>عرض المزيد ({total - items.length})</button>}
      {open && (
        <div className="hub-modal" role="dialog" aria-label={open.title} onClick={(e) => e.target === e.currentTarget && (setOpen(null), setPlaying(null))}>
          <div className="hub-detail">
            <button className="hub-close" onClick={() => { setOpen(null); setPlaying(null); }} aria-label="إغلاق">✕</button>
            {playing ? <HubPlayer source={playing} onClose={() => setPlaying(null)} /> : open.backdropPath && <img className="hub-backdrop" src={`${IMG}w780${open.backdropPath}`} alt="" />}
            <h3>{open.title} {open.originalTitle && open.originalTitle !== open.title && <small>({open.originalTitle})</small>}</h3>
            <p className="hint">{[open.kind === "movie" ? "فيلم" : "مسلسل", open.releaseDate, open.voteAverage && `★ ${open.voteAverage}`, ...open.genres].filter(Boolean).join(" · ")}</p>
            {open.overview && <p>{open.overview}</p>}
            {open.sources.length > 0 && (
              <div className="hub-block">
                <h4>المشاهدة هنا (مصادر مرخّصة)</h4>
                <div className="ctools-row">{open.sources.map((s) => <button key={s.id} className="primary" onClick={() => setPlaying(s)}>▶ {s.label}{s.drmSystem ? " 🔒" : ""}</button>)}</div>
              </div>
            )}
            <WhereToWatch t={open} />
          </div>
        </div>
      )}
    </section>
  );
}

function WhereToWatch({ t }: { t: HubTitle }) {
  const p = t.providers ?? {};
  const groups: [string, { name: string; logo?: string }[] | undefined][] = [["اشتراك", p.flatrate], ["مجانًا", p.free], ["مع إعلانات", p.ads], ["إيجار", p.rent], ["شراء", p.buy]];
  const any = groups.some(([, l]) => l && l.length);
  return (
    <div className="hub-block">
      <h4>أين تشاهده رسميًا {t.providersRegion ? `(${t.providersRegion})` : ""}</h4>
      {!any && <p className="hint">لا تتوفر منصات رسمية معروفة في منطقتك حاليًا.</p>}
      {groups.filter(([, l]) => l && l.length).map(([label, l]) => (
        <p key={label} className="hub-providers"><b>{label}:</b> {l!.map((x) => <span key={x.name} className="hub-prov">{x.logo && <img src={`${IMG}w45${x.logo}`} alt="" />}{x.name}</span>)}</p>
      ))}
      {p.link && <a href={p.link} target="_blank" rel="noopener noreferrer">روابط المشاهدة الرسمية ↗</a>}
      <small className="hint"> · البيانات من JustWatch</small>
    </div>
  );
}

function Matches() {
  const [range, setRange] = useState<"upcoming" | "recent">("upcoming");
  const [league, setLeague] = useState("");
  const [leagues, setLeagues] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<HubMatch[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => { void api.hubLeagues().then(setLeagues).catch(() => undefined); }, []);
  useEffect(() => { void api.hubMatches(range, league || undefined).then((r) => { setItems(r); setErr(""); }).catch((e: Error) => setErr(e.message)); }, [range, league]);
  const byDay = useMemo(() => {
    const m = new Map<string, HubMatch[]>();
    for (const e of items) {
      const k = e.eventTime ? new Intl.DateTimeFormat("ar", { weekday: "long", day: "numeric", month: "long" }).format(new Date(e.eventTime)) : "—";
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m];
  }, [items]);
  return (
    <section>
      <div className="filters">
        <button aria-pressed={range === "upcoming"} onClick={() => setRange("upcoming")}>القادمة</button>
        <button aria-pressed={range === "recent"} onClick={() => setRange("recent")}>النتائج الأخيرة</button>
        <select value={league} onChange={(e) => setLeague(e.target.value)} aria-label="الدوري">
          <option value="">كل الدوريات</option>
          {leagues.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      {err && <p className="error">{err}</p>}
      {!err && items.length === 0 && <p className="hint">لا مباريات محفوظة بعد. تُحدَّث تلقائيًا كل يوم من TheSportsDB.</p>}
      {byDay.map(([d, list]) => (
        <div key={d} className="hub-day">
          <h4>{d}</h4>
          {list.map((e) => (
            <div key={e.idEvent} className="hub-match">
              <span className="team">{e.homeBadge && <img src={`${e.homeBadge}/tiny`} alt="" />}{e.homeTeam}</span>
              <span className="score">{e.homeScore !== undefined && e.awayScore !== undefined ? `${e.homeScore} - ${e.awayScore}` : fmtTime(e.eventTime).split("،").pop()}</span>
              <span className="team">{e.awayBadge && <img src={`${e.awayBadge}/tiny`} alt="" />}{e.awayTeam}</span>
              <small>{[e.league, e.venue, e.status].filter(Boolean).join(" · ")}</small>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function Receiver({ onNavigate }: { onNavigate: (tab: "live" | "manage") => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [name, setName] = useState("الرسيفر");
  const [url, setUrl] = useState("");
  const [attest, setAttest] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api.sources().then((s) => setSources(s.filter((x) => x.type === "tuner" || x.type === "m3u_url" || x.type === "m3u_file"))).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const connect = async () => {
    setBusy(true); setMsg("");
    try {
      const src = await api.addSource({ name: name.trim() || "الرسيفر", type: "tuner", url: url.trim() });
      const r = await api.syncSource(src.id);
      setMsg(`تم ربط الرسيفر وإضافة ${r.added ?? 0} قناة إلى «البث المباشر».`);
      setUrl(""); setAttest(false); await load();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="hub-receiver">
      <div className="hub-block">
        <h4>ربط رسيفر عبر واجهته الرسمية</h4>
        <p className="hint">يدعم HDHomeRun (ملف <code>lineup.json</code>) وأجهزة Enigma2 عبر OpenWebif. يجب أن يكون عنوان الجهاز متاحًا من الإنترنت عبر https (مثل عنوان DDNS)، لأن الخادم لا يصل إلى شبكتك المنزلية. القنوات المحمية التي يعلنها الجهاز تُستبعد تلقائيًا.</p>
        <div className="filters">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم الرسيفر" aria-label="اسم الرسيفر" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://receiver.example.com أو …/lineup.json" aria-label="عنوان الرسيفر" dir="ltr" />
        </div>
        <label className="hub-attest"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /> أقرّ بأن هذا الجهاز ملكي، وأن القنوات تُستقبل باشتراكي أو مجانًا بشكل نظامي.</label>
        <button className="primary" disabled={busy || !attest || !/^https?:\/\//.test(url.trim())} onClick={() => void connect()}>{busy ? "جارٍ الربط…" : "ربط ومزامنة"}</button>
        {msg && <p className="hint" role="status">{msg}</p>}
      </div>
      <div className="hub-block">
        <h4>أو ارفع ملف M3U مصرّحًا به</h4>
        <p className="hint">صدّر قائمة القنوات من الرسيفر (مثل <code>/web/services.m3u</code> في OpenWebif) ثم ارفعها من صفحة «إدارة».</p>
        <button onClick={() => onNavigate("manage")}>فتح «إدارة» لرفع الملف</button>
      </div>
      <div className="hub-block">
        <h4>مصادر الرسيفر والقوائم الحالية ({sources.length})</h4>
        {sources.length === 0 ? <p className="hint">لا توجد مصادر بعد.</p> : (
          <ul className="hub-list">
            {sources.map((s) => (
              <li key={s.id}>
                <span>{s.type === "tuner" ? "📡" : "▤"} {s.name}</span>
                <small>{s.lastSyncAt ? `آخر مزامنة ${fmtTime(s.lastSyncAt)}` : "لم تُزامَن بعد"}</small>
                {s.type !== "m3u_file" && <button onClick={() => void api.syncSource(s.id).then((r) => setMsg(`أُضيفت ${r.added ?? 0} قناة جديدة.`)).then(load).catch((e: Error) => setMsg(e.message))}>مزامنة</button>}
              </li>
            ))}
          </ul>
        )}
        <button onClick={() => onNavigate("live")}>مشاهدة القنوات في «البث المباشر»</button>
      </div>
    </section>
  );
}

function Iptv({ onNavigate }: { onNavigate: (tab: "catalog" | "live") => void }) {
  const [stats, setStats] = useState<{ channels: number; catalog: number } | null>(null);
  useEffect(() => { void api.stats().then(setStats).catch(() => undefined); }, []);
  return (
    <section className="hub-block">
      <h4>قنوات IPTV-org المفتوحة</h4>
      <p>دليل iptv-org يجمع القنوات المتاحة مجانًا للعامة، مع استبعاد القنوات المحذوفة بطلب أصحابها والمحتوى للبالغين. {stats ? `في الدليل الآن ${stats.catalog.toLocaleString("ar")} قناة، ولديك ${stats.channels.toLocaleString("ar")} قناة محفوظة.` : ""}</p>
      <div className="ctools-row">
        <button className="primary" onClick={() => onNavigate("catalog")}>تصفّح الدليل حسب المنطقة والدولة</button>
        <button onClick={() => onNavigate("live")}>البث المباشر</button>
      </div>
      <p className="hint">التشغيل بمحرك Shaka Player أو hls.js تلقائيًا، ويمكن اختيار المحرك من زر ⚙ في المشغّل.</p>
    </section>
  );
}
