import { useState } from "react";

type Video = { id: string; title: string; channel: string; thumbnail: string };
function videoId(input: string): string | null {
  const value = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(url.hostname)) return null;
    const id = url.hostname.includes("youtu.be") ? url.pathname.slice(1).split("/")[0] : url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/") ? url.pathname.split("/")[2] : url.searchParams.get("v");
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
export function YouTubeView() {
  const [input, setInput] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [results, setResults] = useState<Video[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function search() {
    const term = input.trim();
    if (!term) return;
    const direct = videoId(term);
    if (direct) { setActive(direct); setError(""); return; }
    setLoading(true); setError(""); setResults([]);
    try {
      const response = await fetch("/api/youtube-search?q=" + encodeURIComponent(term));
      const data = await response.json() as { videos?: Video[]; error?: string };
      if (!response.ok) throw new Error(data.error || "تعذر البحث");
      setResults(data.videos || []);
      if (!data.videos?.length) setError("لم يتم العثور على فيديوهات.");
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر البحث"); }
    finally { setLoading(false); }
  }
  return <section dir="rtl" style={{maxWidth:1100,margin:"0 auto",padding:20}}>
    <h2>▶ YouTube داخل Smart Receiver</h2>
    <p>ابحث عن الفيديوهات أو ألصق رابط فيديو من YouTube لتشغيله هنا دون مغادرة المنصة.</p>
    <form onSubmit={e => { e.preventDefault(); void search(); }} style={{display:"flex",gap:8,flexWrap:"wrap"}}>
      <input aria-label="البحث في يوتيوب أو رابط فيديو" value={input} onChange={e=>setInput(e.target.value)} placeholder="ابحث في YouTube أو ألصق رابط الفيديو" style={{flex:"1 1 250px",minWidth:0,padding:12}} />
      <button type="submit" disabled={loading}>{loading ? "جارٍ البحث…" : "بحث / تشغيل"}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {active && <div style={{marginTop:20,aspectRatio:"16 / 9",width:"100%",maxWidth:900}}>
      <iframe key={active} title="مشغل YouTube" src={"https://www.youtube-nocookie.com/embed/"+active+"?autoplay=1"} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" style={{border:0,width:"100%",height:"100%",borderRadius:12}} />
    </div>}
    {results.length > 0 && <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))",gap:16,marginTop:24}}>
      {results.map(v=><button key={v.id} onClick={()=>setActive(v.id)} style={{textAlign:"right",padding:10,whiteSpace:"normal"}}>
        <img src={v.thumbnail} alt="" loading="lazy" style={{width:"100%",aspectRatio:"16 / 9",objectFit:"cover",borderRadius:8}} />
        <strong style={{display:"block",marginTop:8}}>{v.title}</strong>
        <small>{v.channel}</small>
      </button>)}
    </div>}
  </section>;
}
