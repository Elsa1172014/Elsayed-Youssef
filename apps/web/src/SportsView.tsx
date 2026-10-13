import { useEffect, useMemo, useState } from "react";
import type { Channel } from "./api";
import { groupsOf } from "./groups";

type Event = { idEvent: string; strEvent?: string; strLeague?: string; strSport?: string; dateEvent?: string; strTime?: string; strTimestamp?: string; strTVStation?: string };
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, "");
const sportsChannel = (channel: Channel) => groupsOf(channel).includes("sports") || /sport|sports|رياضي|رياضة|beinsport|ontime|ssc|espn|eurosport|sky sport|dazn|arena sport|fox sport/i.test(channel.name);
const displayTime = (event: Event) => {
  const stamp = event.strTimestamp || (event.dateEvent ? event.dateEvent + "T" + (event.strTime || "00:00:00") + "Z" : "");
  if (!stamp) return "—";
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("ar-AE", { timeZone: "Asia/Dubai", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
};
export function SportsView({ channels, onPlay }: { channels: Channel[]; onPlay: (channel: Channel) => void }) {
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("all");
  const [events, setEvents] = useState<Event[]>([]);
  const [status, setStatus] = useState("جاري تحميل المباريات...");
  const [day, setDay] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" }));
  const [refreshKey, setRefreshKey] = useState(0);
  const sportChannels = useMemo(() => channels.filter((c) => !c.hidden && sportsChannel(c)), [channels]);
  const filtered = useMemo(() => sportChannels.filter((c) => {
    if (region === "arabic" && !groupsOf(c).includes("arabic")) return false;
    if (region === "europe" && !groupsOf(c).includes("europe")) return false;
    return normalize(c.name).includes(normalize(search));
  }), [sportChannels, region, search]);
  useEffect(() => {
    const controller = new AbortController();
    setStatus("جاري تحميل المباريات...");
    fetch("https://www.thesportsdb.com/api/v1/json/123/eventsday.php?d=" + encodeURIComponent(day), { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("HTTP " + response.status); return response.json(); })
      .then((data: { events?: Event[] }) => {
        const rows = Array.isArray(data.events) ? data.events : [];
        setEvents(rows);
        setStatus(rows.length ? "" : "لا توجد مباريات متاحة لهذا التاريخ في مصدر البيانات.");
      })
      .catch(() => { if (!controller.signal.aborted) { setEvents([]); setStatus("تعذر جلب جدول المباريات. حاول التحديث لاحقًا."); } });
    return () => controller.abort();
  }, [day, refreshKey]);
  return <div className="sports-hub" style={{ padding: "1rem" }}>
    <h2>🌍 Sports Live · الرياضة العالمية</h2>
    <p>القنوات الرياضية المحفوظة في حسابك من جميع الدول. لا تعني القائمة ضمان صلاحية البث أو توفر حقوق المشاهدة.</p>
    <div className="groups" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button onClick={() => setRegion("all")} aria-pressed={region === "all"}>جميع الدول ({sportChannels.length})</button>
      <button onClick={() => setRegion("arabic")} aria-pressed={region === "arabic"}>العربية</button>
      <button onClick={() => setRegion("europe")} aria-pressed={region === "europe"}>الأوروبية</button>
      <input type="search" aria-label="بحث في القنوات الرياضية" placeholder="ابحث عن قناة رياضية..." value={search} onChange={(e) => setSearch(e.target.value)} />
    </div>
    {filtered.length === 0 ? <p>لا توجد قنوات رياضية محفوظة ضمن هذا التصنيف. أضف القنوات المتاحة من Free channels أو من مزودك المصرح به.</p> :
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10, marginTop: 16 }}>
        {filtered.map((c) => <button key={c.id} onClick={() => onPlay(c)} style={{ textAlign: "start", padding: 12 }} title="فتح القناة في مشغل Live"><strong>{c.name}</strong><div><small>{c.country || "Global"} · ▶ تشغيل</small></div></button>)}
      </div>}
    <h2 style={{ marginTop: 24 }}>📅 مباريات اليوم والقنوات الناقلة</h2>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <input type="date" aria-label="تاريخ المباريات" value={day} onChange={(e) => setDay(e.target.value)} />
      <button onClick={() => setRefreshKey((v) => v + 1)}>↻ تحديث المباريات</button>
    </div>
    {status && <p role="status">{status}</p>}
    <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
      {events.map((event) => {
        const station = event.strTVStation?.trim() || "";
        const matches = station ? sportChannels.filter((c) => {
          const name = normalize(c.name); const tv = normalize(station);
          return name.length >= 4 && tv.length >= 4 && (name === tv || name.includes(tv) || tv.includes(name));
        }) : [];
        return <div key={event.idEvent} style={{ border: "1px solid #8885", borderRadius: 10, padding: 12 }}>
          <strong>{event.strEvent || "حدث رياضي"}</strong>
          <div><small>{event.strSport || "Sport"} · {event.strLeague || ""} · {displayTime(event)} (الإمارات)</small></div>
          <div>القناة الناقلة: {station || "غير محددة في مصدر البيانات"}</div>
          {matches.map((c) => <button key={c.id} onClick={() => onPlay(c)}>▶ {c.name}</button>)}
          {station && matches.length === 0 && <small> · القناة غير متاحة ضمن حسابك</small>}
        </div>;
      })}
    </div>
    <p><small>مصدر المباريات: TheSportsDB (واجهة مجانية، وقد تكون بيانات القنوات الناقلة ناقصة). لا يتم إنشاء روابط بث أو تجاوز الاشتراكات.</small></p>
  </div>;
}
