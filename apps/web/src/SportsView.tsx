import { useEffect, useMemo, useState } from "react";
import type { Channel } from "./api";

type Event = { idEvent: string; strEvent?: string; strHomeTeam?: string; strAwayTeam?: string; strSport?: string; strTVStation?: string; dateEvent?: string; strTime?: string; strTimestamp?: string };
type Tv = { idEvent?: string; strChannel?: string; strTVStation?: string; strCountry?: string };
const norm = (s: string) => s.toLocaleLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, "");
function timeUAE(e: Event) {
  const raw = e.strTimestamp || (e.dateEvent && e.strTime ? e.dateEvent + "T" + e.strTime + "Z" : "");
  if (!raw) return "غير محدد";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "غير محدد" : new Intl.DateTimeFormat("ar-AE", { timeZone: "Asia/Dubai", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
}
export function SportsView({ channels, onPlay }: { channels: Channel[]; onPlay: (channel: Channel) => void }) {
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" }));
  const [refresh, setRefresh] = useState(0);
  const [events, setEvents] = useState<Event[]>([]);
  const [tv, setTv] = useState<Tv[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const playable = useMemo(() => channels.filter(c => !c.hidden && !!c.streamUrl), [channels]);
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true); setError(""); setEvents([]); setTv([]);
    const root = "https://www.thesportsdb.com/api/v1/json/123/";
    Promise.allSettled([
      fetch(root + "eventsday.php?d=" + encodeURIComponent(date) + "&s=Soccer", { signal: ctrl.signal }).then(r => { if (!r.ok) throw Error(String(r.status)); return r.json(); }),
      fetch(root + "eventstv.php?d=" + encodeURIComponent(date) + "&s=Soccer", { signal: ctrl.signal }).then(r => { if (!r.ok) throw Error(String(r.status)); return r.json(); })
    ]).then(([fixtures, broadcasts]) => {
      if (ctrl.signal.aborted) return;
      if (fixtures.status === "fulfilled") {
        const list = Array.isArray(fixtures.value.events) ? fixtures.value.events as Event[] : [];
        setEvents(list.filter(e => !e.strSport || /soccer|football/i.test(e.strSport)));
      } else setError("تعذر تحميل مباريات كرة القدم من المصدر.");
      if (broadcasts.status === "fulfilled") {
        const data = broadcasts.value;
        setTv((Array.isArray(data.tvevents) ? data.tvevents : Array.isArray(data.events) ? data.events : []) as Tv[]);
      }
      setLoading(false);
    });
    return () => ctrl.abort();
  }, [date, refresh]);
  const findStations = (e: Event) => {
    const names = [e.strTVStation, ...tv.filter(t => t.idEvent === e.idEvent).map(t => t.strChannel || t.strTVStation)].filter((x): x is string => !!x && !!x.trim());
    return [...new Set(names.flatMap(n => n.split(/[,،;]/).map(s => s.trim()).filter(Boolean)))];
  };
  return <section className="sports-fixtures" dir="rtl" style={{ padding: "1rem" }}>
    <h2>⚽ مباريات كرة القدم</h2>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
      <input aria-label="تاريخ المباريات" type="date" value={date} onChange={e => setDate(e.target.value)} />
      <button onClick={() => setRefresh(n => n + 1)}>تحديث</button>
    </div>
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "right" }}>
        <thead><tr><th style={{ padding: 12 }}>المباراة</th><th style={{ padding: 12 }}>القناة الناقلة</th><th style={{ padding: 12 }}>التوقيت (الإمارات)</th></tr></thead>
        <tbody>
          {events.map(e => {
            const stations = findStations(e);
            return <tr key={e.idEvent} style={{ borderTop: "1px solid #8885" }}>
              <td style={{ padding: 12 }}>{e.strEvent || [e.strHomeTeam, e.strAwayTeam].filter(Boolean).join(" × ") || "مباراة"}</td>
              <td style={{ padding: 12 }}>{stations.length ? stations.map((station, i) => {
                const channel = playable.find(c => norm(c.name) === norm(station));
                return <span key={i}>{i > 0 ? "، " : ""}{channel ? <button onClick={() => onPlay(channel)} title="فتح القناة في Live">▶ {station}</button> : station}</span>;
              }) : "لم يُعلن في المصدر"}</td>
              <td style={{ padding: 12, whiteSpace: "nowrap" }}>{timeUAE(e)}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    {loading && <p role="status">جاري تحديث المباريات...</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && events.length === 0 && <p>لا توجد مباريات متاحة لهذا اليوم في مصدر البيانات.</p>}
    <small>القنوات الناقلة بحسب بيانات TheSportsDB المتاحة؛ قد تكون غير مكتملة. زر التشغيل يظهر فقط عند تطابق اسم القناة مع قناة محفوظة في حسابك.</small>
  </section>;
}
