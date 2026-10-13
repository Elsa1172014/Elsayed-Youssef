import { useEffect, useState } from "react";

type Article = { title: string; link: string; pubDate?: string; description?: string };
const sources = [
  { name: "BBC Football", url: "https://feeds.bbci.co.uk/sport/football/rss.xml", home: "https://www.bbc.com/sport/football" },
  { name: "BBC Champions League", url: "https://feeds.bbci.co.uk/sport/football/champions-league/rss.xml", home: "https://www.bbc.com/sport/football/champions-league" },
  { name: "Sky Sports Football", url: "https://www.skysports.com/rss/11095", home: "https://www.skysports.com/football" },
  { name: "The Athletic", url: "https://www.nytimes.com/athletic/rss/news/", home: "https://www.nytimes.com/athletic/football/" },
  { name: "Google News Arabic Sports", url: "https://news.google.com/rss/search?q=%D8%A3%D8%AE%D8%A8%D8%A7%D8%B1+%D9%83%D8%B1%D8%A9+%D8%A7%D9%84%D9%82%D8%AF%D9%85&hl=ar&gl=AE&ceid=AE:ar", home: "https://news.google.com/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREZqT0dZU0FtVnVLQUFQAQ?hl=ar" },
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
      news.sort((a, b) => Date.parse(b.article.pubDate || "") - Date.parse(a.article.pubDate || ""));
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
