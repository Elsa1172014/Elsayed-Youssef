// Server-side search keeps the YouTube API key out of the browser.
export default async function handler(req: { method?: string; query?: { q?: string | string[] } }, res: { status: (code: number) => { json: (body: unknown) => void }; setHeader: (key: string, value: string) => void }) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const q = typeof req.query?.q === "string" ? req.query.q.trim().slice(0, 120) : "";
  if (!q) return res.status(400).json({ error: "أدخل عبارة للبحث." });
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(503).json({ error: "البحث يحتاج إلى إعداد مفتاح YouTube Data API في Vercel. يمكنك الآن تشغيل أي فيديو بلصق رابطه." });
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet"); url.searchParams.set("type", "video");
    url.searchParams.set("videoEmbeddable", "true"); url.searchParams.set("maxResults", "12");
    url.searchParams.set("q", q); url.searchParams.set("key", key);
    const response = await fetch(url);
    if (!response.ok) return res.status(502).json({ error: "خدمة بحث YouTube غير متاحة حاليًا." });
    const data = await response.json() as { items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; thumbnails?: { medium?: { url?: string } } } }> };
    const videos = (data.items || []).filter(v => v.id?.videoId).map(v => ({ id: v.id!.videoId, title: v.snippet?.title || "فيديو", channel: v.snippet?.channelTitle || "", thumbnail: v.snippet?.thumbnails?.medium?.url || "" }));
    return res.status(200).json({ videos });
  } catch { return res.status(502).json({ error: "تعذر الاتصال ببحث YouTube." }); }
}
