import { useState } from "react";
import { api, type Channel } from "./api";
import type { Lang, Strings } from "./i18n";

/** Per-channel AI helpers: summary of now/next, translation of that summary, and similar channels. */
export function AiButton({ s, lang, channel, channels, onPick }: { s: Strings; lang: Lang; channel: Channel; channels: Channel[]; onPick: (c: Channel) => void }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [basic, setBasic] = useState(false);
  const [translated, setTranslated] = useState("");
  const [similar, setSimilar] = useState<Channel[] | null>(null);
  const [error, setError] = useState("");
  const guard = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const other = lang === "ar" ? "en" : "ar";

  return (
    <>
      <button className="ai" aria-expanded={open} title={s.ai} onClick={() => setOpen(!open)}>✦</button>
      {open && (
        <div className="ai-panel" role="region" aria-label={s.ai}>
          <button onClick={() => guard(async () => { const r = await api.aiSummary(channel.id, lang); setSummary(r.summary); setBasic(!r.ai); setTranslated(""); })}>{s.aiSummary}</button>
          <button disabled={!summary} onClick={() => guard(async () => setTranslated((await api.aiTranslate(summary, other)).text))}>{s.aiTranslate}</button>
          <button onClick={() => guard(async () => {
            const r = await api.similar(channel.id);
            setSimilar(r.map((x) => channels.find((c) => c.id === x.id)).filter((c): c is Channel => !!c));
          })}>{s.aiSimilar}</button>
          {/* Model output is rendered as plain text (React escapes it); it is never injected as HTML. */}
          {summary && <p>{summary}{basic && <small> ({s.aiBasic})</small>}</p>}
          {translated && <p dir={other === "ar" ? "rtl" : "ltr"}>{translated}</p>}
          {similar && (similar.length ? <ul>{similar.map((c) => <li key={c.id}><button className="link" onClick={() => onPick(c)}>{c.name}</button></li>)}</ul> : <p className="hint">{s.noMatches}</p>)}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      )}
    </>
  );
}
