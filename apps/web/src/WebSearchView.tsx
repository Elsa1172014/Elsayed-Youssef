import { useState } from "react";
import { api, type WebSearch } from "./api";
import type { Lang } from "./i18n";

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

/** General web search, answered from live Google Search results (Gemini grounding). */
export function WebSearchView({ lang }: { lang: Lang }) {
  const ar = lang === "ar";
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<(WebSearch & { q: string }) | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const search = async (query = q) => {
    const text = query.trim();
    if (!text || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await api.webSearch(text, lang);
      setRes({ ...r, q: text });
      setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 8));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="websearch" dir={ar ? "rtl" : "ltr"}>
      <form className="ws-bar" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={ar ? "ابحث في الويب عبر Google…" : "Search the web with Google…"} aria-label={ar ? "بحث في الويب" : "Web search"} maxLength={300} autoComplete="off" />
        <button type="submit" className="primary" disabled={busy || !q.trim()}>{busy ? (ar ? "جارٍ البحث…" : "Searching…") : (ar ? "🔎 بحث" : "🔎 Search")}</button>
      </form>
      {history.length > 0 && (
        <div className="ws-history">
          {history.map((h) => <button key={h} type="button" onClick={() => { setQ(h); void search(h); }}>{h}</button>)}
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {res && (
        <section className="ws-result" aria-live="polite">
          <h3>{res.q}</h3>
          <div className="ws-answer">{res.text.split(/\n+/).filter(Boolean).map((p, i) => <p key={i}>{p.replace(/^\s*[*-]\s+/, "• ").replace(/\*\*/g, "")}</p>)}</div>
          {res.sources.length > 0 && (
            <>
              <h4>{ar ? "المصادر" : "Sources"}</h4>
              <ol className="ws-sources">
                {res.sources.map((s) => (
                  <li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || host(s.url)}</a> <small>{host(s.title || s.url)}</small></li>
                ))}
              </ol>
            </>
          )}
          {res.suggestionsHtml ? (
            // Google's Search suggestions chip, shown as Google requires; sandboxed, no scripts, links open in a new tab.
            <iframe className="ws-suggest" title="Google Search suggestions" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={`<base target="_blank">${res.suggestionsHtml}`} />
          ) : res.queries.length > 0 && (
            <div className="ws-history">
              {res.queries.map((x) => <a key={x} className="btn" href={`https://www.google.com/search?q=${encodeURIComponent(x)}`} target="_blank" rel="noopener noreferrer">Google: {x}</a>)}
            </div>
          )}
        </section>
      )}
      {!res && !err && <p className="hint">{ar ? "اكتب سؤالك، فيبحث في Google ويجيبك باختصار مع روابط المصادر." : "Ask anything: it searches Google and answers briefly with source links."}</p>}
    </div>
  );
}
