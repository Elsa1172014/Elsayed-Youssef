import { useState } from "react";
import type { Channel } from "./api";
import type { Lang } from "./i18n";
import { downloadM3u, externalLinks, platform } from "./tools";

const L = {
  en: { prev: "Previous", next: "Next", fav: "Add to favourites", unfav: "Remove from favourites", reload: "Reload", alt: "Other sources for this channel", noAlt: "No other source found for this channel.", ext: "Open in an external player", copy: "Copy link", copied: "Copied", m3u: "Download .m3u", keys: "Shortcuts: ↑/↓ or PageUp/PageDown change channel · type a number to jump · F favourite · R reload", failed: "This link failed — try another source:", vlc: "VLC", android: "Android player", infuse: "Infuse" },
  ar: { prev: "السابقة", next: "التالية", fav: "إضافة للمفضلة", unfav: "إزالة من المفضلة", reload: "إعادة التحميل", alt: "مصادر أخرى لنفس القناة", noAlt: "لا يوجد مصدر آخر لهذه القناة.", ext: "فتح في مشغّل خارجي", copy: "نسخ الرابط", copied: "تم النسخ", m3u: "تنزيل ‎.m3u", keys: "اختصارات: ↑/↓ أو PageUp/PageDown لتغيير القناة · اكتب رقمًا للانتقال · F للمفضلة · R لإعادة التحميل", failed: "تعذّر تشغيل هذا الرابط — جرّب مصدرًا آخر:", vlc: "VLC", android: "مشغّل أندرويد", infuse: "Infuse" },
};

export function ChannelTools({ lang, channel, position, total, isFav, alternatives, failed, onPrev, onNext, onToggleFav, onReload, onPlay }: {
  lang: Lang;
  channel: Channel;
  position: number; // 1-based index in the visible list, 0 if not in it
  total: number;
  isFav: boolean;
  alternatives: Channel[];
  failed: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToggleFav: () => void;
  onReload: () => void;
  onPlay: (c: Channel) => void;
}) {
  const s = L[lang];
  const [copied, setCopied] = useState(false);
  const [showExt, setShowExt] = useState(false);
  const url = channel.streamUrl ?? "";
  const links = externalLinks(url);
  const os = platform();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const t = document.createElement("textarea");
      t.value = url;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="ctools" role="toolbar" aria-label={lang === "ar" ? "أدوات القناة" : "Channel tools"}>
      <div className="ctools-row">
        <button type="button" onClick={onPrev} disabled={total < 2} title={s.prev} aria-label={s.prev}>{lang === "ar" ? "▶" : "◀"} {s.prev}</button>
        <span className="ctools-pos">{position > 0 ? `${position} / ${total}` : "—"}</span>
        <button type="button" onClick={onNext} disabled={total < 2} title={s.next} aria-label={s.next}>{s.next} {lang === "ar" ? "◀" : "▶"}</button>
        <button type="button" className={isFav ? "fav on" : "fav"} onClick={onToggleFav} aria-pressed={isFav} title={isFav ? s.unfav : s.fav}>{isFav ? "★" : "☆"}</button>
        <button type="button" onClick={onReload} title={s.reload} aria-label={s.reload}>⟳</button>
        <button type="button" onClick={() => void copy()} disabled={!url}>{copied ? `✓ ${s.copied}` : `⧉ ${s.copy}`}</button>
        <button type="button" onClick={() => setShowExt((v) => !v)} aria-expanded={showExt} disabled={!url}>↗ {s.ext}</button>
      </div>
      {showExt && url && (
        <div className="ctools-row">
          {os !== "ios" && <a className="btn" href={links.vlc}>{s.vlc}</a>}
          {os === "android" && <a className="btn" href={links.android}>{s.android}</a>}
          {os === "ios" && <a className="btn" href={links.iosVlc}>{s.vlc}</a>}
          {os === "ios" && <a className="btn" href={links.infuse}>{s.infuse}</a>}
          <button type="button" onClick={() => downloadM3u(channel)}>⬇ {s.m3u}</button>
        </div>
      )}
      {(failed || alternatives.length > 0) && (
        <div className={failed ? "ctools-alt warn" : "ctools-alt"}>
          <strong>{failed ? s.failed : s.alt}</strong>
          {alternatives.length === 0 ? <span className="hint"> {s.noAlt}</span> : (
            <div className="ctools-row">
              {alternatives.slice(0, 8).map((a, i) => (
                <button key={a.id} type="button" onClick={() => onPlay(a)} title={a.streamUrl}>
                  {i + 1}. {a.name}{a.country ? ` · ${a.country}` : ""}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="hint ctools-keys">{s.keys}</p>
    </div>
  );
}
