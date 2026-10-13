import { useEffect, useState } from "react";

type Article = { title: string; link: string; pubDate?: string; description?: string };
const sources = [
  { name: "أخبار كرة القدم العربية", url: "https://news.google.com/rss/search?q=" + encodeURIComponent("كرة القدم الدوري المصري الدوري السعودي") + "&hl=ar&gl=AE&ceid=AE:ar", home: "https://news.google.com/?hl=ar&gl=AE&ceid=AE:ar" },
  { name: "دوري أبطال أوروبا بالعربية", url: "https://news.google.com/rss/search?q=" + encodeURIComponent("دوري أبطال أوروبا مباريات") + "&hl=ar&gl=AE&ceid=AE:ar", home: "https://news.google.com/?hl=ar&gl=AE&ceid=AE:ar" },
  { name: "الدوري الإنجليزي والإسباني", url: "https://news.google.com/rss/search?q=" + encodeURIComponent("الدوري الإنجليزي الدوري الإسباني") + "&hl=ar&gl=AE&ceid=AE:ar", home: "https://news.google.com/?hl=ar&gl=AE&ceid=AE:ar" },
  { name: "الأخبار الرياضية العالمية بالعربية", url: "https://news.google.com/rss/search?q=" + encodeURIComponent("رياضة كرة قدم انتقالات نتائج") + "&hl=ar&gl=AE&ceid=AE:ar", home: "https://news.google.com/?hl=ar&gl=AE&ceid=AE:ar" }
];
export function SportsNewsView() {
  const [items, setItems] = useState<{ source: string; article: Article }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setBusy(true); setError("");
    Promise.allSettled(sources.map(async source => {
      // RSS feeds are accessed through a public RSS-to-JSON gateway; failure never fabricates news.
      const response = await fetch("https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(source.url));
      if (!response.ok) throw Error(String(response.status));
      const data = await response.json() as { status?: string; items?: Article[] };
      if (data.status !== "ok" || !Array.isArray(data.items)) throw Error("Feed unavailable");
      return data.items.filter(a => /^https?:\/\//.test(a.link)).slice(0, 15).map(article => ({ source: source.name, article }));
    })).then(results => {
      if (cancelled) return;
      const news = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
      news.sort((a, b) => (Date.parse(b.article.pubDate || "") || 0) - (Date.parse(a.article.pubDate || "") || 0));
      setItems(news);
      if (!news.length) setError("تعذر تحميل العناوين تلقائيًا من مصادر RSS. يمكنك فتح المصادر مباشرة أدناه.");
      setBusy(false);
    });
    return () => { cancelled = true; };
  }, [refresh]);
  return <section dir="rtl" style={{ padding: "1rem" }}>
    <h2>📰 أخبار الرياضة العالمية</h2>
    <p>عناوين وروابط للمصادر الأصلية، وليست نسخًا من المقالات. الأخبار تُحدث عند فتح الصفحة أو الضغط على تحديث.</p>
    <button onClick={() => setRefresh(v => v + 1)}>↻ تحديث الأخبار</button>
    {busy && <p role="status">جاري جلب الأخبار...</p>}
    {error && <p role="alert">{error}</p>}
    <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
      {items.map(({ source, article }, i) => <article key={source + article.link + i} style={{ padding: 12, border: "1px solid #8885", borderRadius: 10 }}>
        <a href={article.link} target="_blank" rel="noopener noreferrer"><strong>{article.title}</strong></a>
        <div><small>{source} · {article.pubDate ? new Date(article.pubDate).toLocaleString("ar-AE", { timeZone: "Asia/Dubai" }) : ""}</small></div>
      </article>)}
    </div>
    <h3>المصادر</h3>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>{sources.map(s => <a key={s.name} href={s.home} target="_blank" rel="noopener noreferrer">{s.name} ↗</a>)}</div>
  </section>;
}
