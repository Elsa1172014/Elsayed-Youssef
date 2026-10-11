import { useEffect, useRef, useState } from "react";
import { api, type Channel } from "./api";
import type { PanelState, StepId } from "./core";
import { rememberSource, runRepair } from "./engine";
import type { Lang, Strings } from "./i18n";

const STEPS: StepId[] = ["device", "inspect", "protection", "play", "repair", "start"];
const MARK = { pending: "○", running: "◐", ok: "✓", fail: "✗", skip: "–" } as const;

/**
 * Per-channel AI button. Pressing it starts "Repair & Play" straight away: it inspects the real stream, repairs what
 * can be repaired, tries the channel's authorized alternates, and only reports success once media is actually playing.
 * The older helpers (now/next summary, translation, similar channels) live under "More AI tools".
 */
export function AiButton({ s, lang, channel, channels, onPick, onPlayed, onNavigate }: {
  s: Strings; lang: Lang; channel: Channel; channels: Channel[]; onPick: (c: Channel) => void;
  /** Called once playback was verified: the app selects the channel and its player starts with the remembered source. */
  onPlayed?: (c: Channel) => void; onNavigate?: (tab: "manage" | "premium") => void;
}) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [state, setState] = useState<PanelState>();
  const [note, setNote] = useState("");
  const abort = useRef<AbortController | undefined>(undefined);
  const run = useRef(0);

  const start = async () => {
    abort.current?.abort();
    const ctl = (abort.current = new AbortController());
    const id = ++run.current;
    setNote("");
    setOpen(true);
    setMore(false);
    const final = await runRepair(channel, (u) => id === run.current && setState(u), ctl.signal).catch((e: Error) => {
      if (id === run.current) setState((prev) => ({ ...(prev as PanelState), scanning: false, outcome: "unavailable", causeDetail: e.message }));
      return undefined;
    });
    if (!final || id !== run.current || ctl.signal.aborted) return;
    if (final.outcome === "playing" && final.source) {
      const { url, proxy, mode, engine, kind, origin } = final.source;
      rememberSource(channel.id, { url, proxy, mode, engine, kind, origin });
      (onPlayed ?? onPick)(channel);
      setTimeout(() => id === run.current && setOpen(false), 2500); // success: minimize, the AI button stays for re-diagnosis
    } else if (final.outcome) {
      void api.explain(channel.id, { lang, cause: final.cause, outcome: final.outcome, needs: final.needs, kind: final.diagnosis?.kind, log: final.log })
        .then((r) => id === run.current && r.text && setNote(r.text)).catch(() => undefined);
    }
  };
  useEffect(() => () => abort.current?.abort(), []);

  // Other helpers (kept from before): summary, translation, similar channels.
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
  const t = (k: string) => (s as Record<string, string>)[k] ?? k;

  const cur = state;
  const stageLabel = cur ? t(`st_${cur.stage}`) : "";
  const outcome = cur?.outcome;
  const needsText = cur?.needs && cur.needs !== "tap_play" ? t(`n_${cur.needs}`) : "";

  return (
    <>
      <button className="ai" aria-expanded={open} title={s.ai} onClick={() => (open && !cur?.scanning ? setOpen(false) : void start())}>✦</button>
      {open && (
        <div className="ai-panel" role="region" aria-label={s.ai} aria-live="polite">
          <dl className="ai-grid">
            <dt>{s.aiChannel}</dt><dd><strong>{channel.name}</strong></dd>
            <dt>{s.aiStatus}</dt><dd>{cur?.scanning ? s.aiScanning : s.aiFinished}</dd>
            <dt>{s.aiStage}</dt><dd>{stageLabel}</dd>
            <dt>{s.aiCause}</dt><dd>{cur?.cause ? <>{t(`c_${cur.cause}`)}{cur.causeDetail && <small> ({cur.causeDetail})</small>}</> : cur?.scanning && cur.steps.inspect.status !== "ok" && cur.steps.inspect.status !== "fail" ? s.aiNone : cur?.outcome === "playing" ? t("c_none") : s.aiNone}</dd>
            <dt>{s.aiAction}</dt><dd>{cur?.action ? t(`a_${cur.action}`) : s.aiNone}</dd>
            <dt>{s.aiResult}</dt><dd className={outcome ? `res-${outcome}` : ""}>{outcome ? t(`o_${outcome}`) : s.aiNone}{outcome === "playing" && cur?.source && <small> · {s.aiPlayHere} {cur.source.engine}/{cur.source.mode}{cur.source.origin !== "current" ? ` (${cur.source.name ?? cur.source.origin})` : ""}</small>}</dd>
          </dl>
          <progress max={1} value={cur?.progress ?? 0} aria-label={s.aiStatus} />
          <ol className="ai-steps">
            {STEPS.map((id) => <li key={id} className={`st-${cur?.steps[id].status ?? "pending"}`}><span aria-hidden>{MARK[cur?.steps[id].status ?? "pending"]}</span> {t(`st_${id}`)}{cur?.steps[id].detail && <small> — {cur.steps[id].detail}</small>}</li>)}
          </ol>
          {outcome === "needs_action" && needsText && <p className="error" role="alert">{needsText}</p>}
          {outcome === "unavailable" && <p className="error" role="alert">{t("u_none")}</p>}
          {cur?.needs === "tap_play" && <p className="hint">{s.n_tap_play}</p>}
          {note && <p dir={lang === "ar" ? "rtl" : "ltr"}><small>{s.aiExplain}:</small> {note}</p>}
          <div className="ai-actions">
            <button className="primary" disabled={cur?.scanning} onClick={() => void start()}>✦ {s.aiRepair}</button>
            {outcome === "needs_action" && cur?.needs === "login" && onNavigate && <button onClick={() => onNavigate("manage")}>{s.aiGoManage}</button>}
            {outcome === "needs_action" && (cur?.needs === "subscription" || cur?.needs === "device_drm") && onNavigate && <button onClick={() => onNavigate("premium")}>{s.aiGoPremium}</button>}
            <button onClick={() => setMore(!more)} aria-expanded={more}>{s.aiMore}</button>
            <button onClick={() => { abort.current?.abort(); setOpen(false); }}>{s.aiMinimize}</button>
          </div>
          {more && (
            <div className="ai-more">
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
        </div>
      )}
    </>
  );
}
