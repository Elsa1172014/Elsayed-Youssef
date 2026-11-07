import { useEffect, useState } from "react";
import { api, type HubAdminSource, type HubOverview, type HubTitle } from "./api";

const when = (iso?: string) => (iso ? new Intl.DateTimeFormat("ar", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—");
const JOBS: Record<string, string> = { tmdb: "تحديث الأفلام والمسلسلات (TMDB)", sports: "تحديث المباريات (TheSportsDB)", archive: "تحميل أفلام كلاسيكية مجانية (أرشيف الإنترنت)" };

/** Arabic, responsive admin panel for the Entertainment Hub (HUB_ADMIN_USERS only — enforced by the server). */
export function HubAdmin() {
  const [ov, setOv] = useState<HubOverview | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const load = () => api.hubAdminOverview().then(setOv).catch((e: Error) => setMsg(e.message));
  useEffect(() => { void load(); }, []);
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setMsg("");
    try { await fn(); await load(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  };
  if (!ov) return <p className="hint">{msg || "جارٍ التحميل…"}</p>;
  const key = (ok: boolean, label: string, hint: string) => <li className={ok ? "ok" : "warn"}>{ok ? "✓" : "✗"} {label} <small>{ok ? "مضبوط" : hint}</small></li>;

  return (
    <section className="hub-admin">
      {msg && <p className="error" role="alert">{msg}</p>}
      <div className="hub-stats">
        {([["العناوين", ov.counts.titles], ["أفلام مجانية", ov.counts.openFilms ?? 0], ["مصادر مرخّصة", ov.counts.licensed], ["الدوريات", ov.counts.leagues], ["مباريات قادمة", ov.counts.events], ["أخطاء 24 ساعة", ov.counts.errors24h]] as const).map(([l, n]) => (
          <div key={l} className={l === "أخطاء 24 ساعة" && n > 0 ? "stat warn" : "stat"}><b>{n.toLocaleString("ar")}</b><span>{l}</span></div>
        ))}
      </div>

      <div className="hub-cols">
        <div className="hub-block">
          <h4>المفاتيح والإعداد</h4>
          <ul className="hub-keys">
            {key(ov.keys.supabase, "قاعدة Supabase", "")}
            {key(ov.keys.tmdb, "مفتاح TMDB", "أضف TMDB_READ_TOKEN في Vercel")}
            {key(ov.keys.sportsdbOwnKey, "مفتاح TheSportsDB خاص", "يُستخدم المفتاح المجاني المحدود")}
          </ul>
          <p className="hint">لا تُعرض قيم المفاتيح هنا أبدًا. منطقة «أين تشاهد»: {ov.region}</p>
        </div>
        <div className="hub-block">
          <h4>التحديثات المجدولة</h4>
          <p className="hint">تعمل تلقائيًا يوميًا الساعة 04:30 UTC (08:30 بتوقيت دبي).</p>
          <div className="ctools-row">
            {(["archive", "tmdb", "sports"] as const).map((j) => (
              <button key={j} disabled={!!busy} onClick={() => void run(j, () => api.hubAdminSync(j))}>{busy === j ? "جارٍ التحديث…" : `تشغيل الآن: ${JOBS[j]}`}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="hub-block">
        <h4>سجل التشغيل</h4>
        <div className="hub-table" role="table">
          <div role="row" className="head"><span>المهمة</span><span>البدء</span><span>الحالة</span><span>التفاصيل</span></div>
          {ov.jobs.map((j) => (
            <div role="row" key={j.id}>
              <span>{JOBS[j.job] ?? j.job} <small>({j.trigger === "cron" ? "مجدول" : "يدوي"})</small></span>
              <span>{when(j.startedAt)}</span>
              <span className={j.ok === undefined ? "" : j.ok ? "ok" : "bad"}>{j.ok === undefined ? "قيد التشغيل" : j.ok ? "نجح" : "فشل"}</span>
              <span><small>{j.error ?? Object.entries(j.stats).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</small></span>
            </div>
          ))}
          {ov.jobs.length === 0 && <p className="hint">لم تُشغَّل أي مهمة بعد.</p>}
        </div>
      </div>

      <div className="hub-block">
        <h4>سجل الأخطاء (آخر 30 يومًا)</h4>
        {ov.errors.length === 0 ? <p className="hint">لا أخطاء مسجّلة.</p> : (
          <ul className="hub-errors">
            {ov.errors.map((e) => <li key={e.id}><small>{when(e.at)} · {e.source}{e.job ? ` · ${e.job}` : ""}</small><span dir="ltr">{e.message}</span></li>)}
          </ul>
        )}
      </div>

      <OwnFilm run={run} busy={busy} />
      <Leagues ov={ov} run={run} busy={busy} />
      <Titles run={run} busy={busy} />
    </section>
  );
}

function Leagues({ ov, run, busy }: { ov: HubOverview; run: (l: string, fn: () => Promise<unknown>) => Promise<void>; busy: string }) {
  const [id, setId] = useState("");
  return (
    <div className="hub-block">
      <h4>الدوريات المتابَعة (TheSportsDB)</h4>
      <ul className="hub-list">
        {ov.leagues.map((l) => <li key={l.id}><span>{l.name}</span><small>#{l.id}{l.sport ? ` · ${l.sport}` : ""}</small><button disabled={!!busy} onClick={() => void run("league", () => api.hubAdminRemoveLeague(l.id))}>إزالة</button></li>)}
      </ul>
      <div className="filters">
        <input value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ""))} placeholder="رقم الدوري في TheSportsDB (مثل 4328)" inputMode="numeric" aria-label="رقم الدوري" />
        <button disabled={!id || !!busy} onClick={() => void run("league", async () => { await api.hubAdminAddLeague(id); setId(""); })}>إضافة دوري</button>
      </div>
    </div>
  );
}

function Titles({ run, busy }: { run: (l: string, fn: () => Promise<unknown>) => Promise<void>; busy: string }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ tmdbId: number; kind: "movie" | "tv"; title: string; releaseDate?: string }[]>([]);
  const [lib, setLib] = useState<HubTitle[]>([]);
  const [sel, setSel] = useState<HubTitle | null>(null);
  const [sources, setSources] = useState<HubAdminSource[]>([]);
  const [form, setForm] = useState({ label: "", url: "", kind: "hls", drmSystem: "", licenseUrl: "", rightsHolder: "", licenseRef: "", validUntil: "" });
  const [attest, setAttest] = useState(false);
  const loadLib = () => api.hubTitles({}).then((r) => setLib(r.items)).catch(() => undefined);
  useEffect(() => { void loadLib(); }, []);
  const openTitle = (t: HubTitle) => { setSel(t); void api.hubAdminSources(t.id).then(setSources).catch(() => setSources([])); };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="hub-block">
      <h4>العناوين والمصادر المرخّصة</h4>
      <div className="filters">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث في TMDB لإضافة عنوان" aria-label="بحث TMDB" />
        <button disabled={!q.trim() || !!busy} onClick={() => void run("search", async () => setFound(await api.hubAdminSearchTmdb(q.trim())))}>بحث</button>
      </div>
      {found.length > 0 && (
        <ul className="hub-list">
          {found.map((f) => <li key={`${f.kind}${f.tmdbId}`}><span>{f.title}</span><small>{f.kind === "movie" ? "فيلم" : "مسلسل"} {f.releaseDate?.slice(0, 4)}</small><button disabled={!!busy} onClick={() => void run("add", async () => { const t = await api.hubAdminAddTitle(f.kind, f.tmdbId); setFound([]); await loadLib(); openTitle(t); })}>إضافة للمكتبة</button></li>)}
        </ul>
      )}
      <label className="hint">اختر عنوانًا لإدارة مصادره:{" "}
        <select value={sel?.id ?? ""} onChange={(e) => { const t = lib.find((x) => x.id === Number(e.target.value)); if (t) openTitle(t); }}>
          <option value="">—</option>
          {lib.map((t) => <option key={t.id} value={t.id}>{t.title}{t.licensedCount ? ` (${t.licensedCount})` : ""}</option>)}
        </select>
      </label>
      {sel && (
        <div className="hub-sources">
          <h5>{sel.title}</h5>
          <ul className="hub-list">
            {sources.map((s) => (
              <li key={s.id}>
                <span>{s.label} {s.drmSystem && `🔒 ${s.drmSystem}`}</span>
                <small>{s.rightsHolder} · {s.licenseRef}{s.validUntil ? ` · حتى ${s.validUntil}` : ""}</small>
                <button disabled={!!busy} onClick={() => void run("src", async () => { await api.hubAdminToggleSource(s.id, !s.enabled); setSources(await api.hubAdminSources(sel.id)); })}>{s.enabled ? "إيقاف" : "تفعيل"}</button>
                <button disabled={!!busy} onClick={() => window.confirm("حذف هذا المصدر؟") && void run("src", async () => { await api.hubAdminDeleteSource(s.id); setSources(await api.hubAdminSources(sel.id)); })}>حذف</button>
              </li>
            ))}
          </ul>
          <div className="hub-form">
            <input value={form.label} onChange={set("label")} placeholder="اسم المصدر (مثل: النسخة الكاملة)" />
            <input value={form.url} onChange={set("url")} placeholder="https://… (m3u8 / mpd / mp4)" dir="ltr" />
            <select value={form.kind} onChange={set("kind")}><option value="hls">HLS</option><option value="dash">DASH</option><option value="mp4">MP4</option></select>
            <select value={form.drmSystem} onChange={set("drmSystem")}><option value="">بدون DRM</option><option value="widevine">Widevine</option><option value="playready">PlayReady</option><option value="fairplay">FairPlay</option><option value="clearkey">ClearKey</option></select>
            {form.drmSystem && <input value={form.licenseUrl} onChange={set("licenseUrl")} placeholder="خادم الترخيص الرسمي لصاحب الحقوق https://…" dir="ltr" />}
            <input value={form.rightsHolder} onChange={set("rightsHolder")} placeholder="صاحب الحقوق" />
            <input value={form.licenseRef} onChange={set("licenseRef")} placeholder="مرجع الترخيص / رقم العقد" />
            <input type="date" value={form.validUntil} onChange={set("validUntil")} aria-label="ينتهي الترخيص في" />
          </div>
          <label className="hub-attest"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /> أقرّ بأن لدينا حق عرض هذا المحتوى، وأن خادم الترخيص (إن وُجد) هو الخادم الرسمي لصاحب الحقوق.</label>
          <button className="primary" disabled={!attest || !!busy} onClick={() => void run("src", async () => {
            await api.hubAdminAddSource(sel.id, { ...form, drmSystem: form.drmSystem || undefined, licenseUrl: form.licenseUrl || undefined, validUntil: form.validUntil || undefined, rightsAttested: true });
            setForm({ label: "", url: "", kind: "hls", drmSystem: "", licenseUrl: "", rightsHolder: "", licenseRef: "", validUntil: "" }); setAttest(false);
            setSources(await api.hubAdminSources(sel.id));
          })}>حفظ المصدر</button>
        </div>
      )}
    </div>
  );
}

function OwnFilm({ run, busy }: { run: (l: string, fn: () => Promise<unknown>) => Promise<void>; busy: string }) {
  const empty = { title: "", url: "", posterUrl: "", overview: "", year: "", kind: "movie", rightsHolder: "", licenseRef: "" };
  const [f, setF] = useState(empty);
  const [attest, setAttest] = useState(false);
  const [done, setDone] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ok = attest && f.title.trim() && /^https:\/\//.test(f.url.trim()) && f.rightsHolder.trim() && (!f.posterUrl || /^https:\/\//.test(f.posterUrl.trim()));
  return (
    <div className="hub-block">
      <h4>⭐ إضافة فيلم من أفلامي</h4>
      <p className="hint">أضف فيلمًا تملكه أو لديك حق عرضه برابط https مباشر لملف الفيديو (MP4 أو m3u8 أو mpd)، مثل رابط من خدمة استضافة فيديو تملك حسابها. يظهر في المكتبة ضمن «أفلامي» ويعمل فورًا.</p>
      <div className="hub-form">
        <input value={f.title} onChange={set("title")} placeholder="اسم الفيلم" />
        <input value={f.url} onChange={set("url")} placeholder="رابط الفيديو https://…" dir="ltr" />
        <input value={f.posterUrl} onChange={set("posterUrl")} placeholder="رابط صورة الغلاف https://… (اختياري)" dir="ltr" />
        <input value={f.year} onChange={(e) => setF({ ...f, year: e.target.value.replace(/\D/g, "").slice(0, 4) })} placeholder="سنة الإنتاج (اختياري)" inputMode="numeric" />
        <select value={f.kind} onChange={set("kind")}><option value="movie">فيلم</option><option value="tv">حلقة / مسلسل</option></select>
        <input value={f.rightsHolder} onChange={set("rightsHolder")} placeholder="صاحب الحقوق (أنت أو الجهة المرخِّصة)" />
        <input value={f.licenseRef} onChange={set("licenseRef")} placeholder="مرجع الترخيص (اختياري)" />
      </div>
      <textarea value={f.overview} onChange={set("overview")} placeholder="نبذة عن الفيلم (اختياري)" rows={2} />
      <label className="hub-attest"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /> أقرّ بأنني أملك هذا الفيلم أو لديّ حق عرضه.</label>
      <button className="primary" disabled={!ok || !!busy} onClick={() => void run("own", async () => {
        const t = await api.hubAdminAddOwn({ ...f, year: f.year ? Number(f.year) : undefined, posterUrl: f.posterUrl.trim() || undefined, licenseRef: f.licenseRef.trim() || undefined });
        setDone(`أُضيف «${t.title}» إلى المكتبة.`); setF(empty); setAttest(false);
      })}>حفظ الفيلم</button>
      {done && <p className="hint" role="status">{done}</p>}
    </div>
  );
}
