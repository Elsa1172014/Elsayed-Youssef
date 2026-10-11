export interface XmltvChannel {
  id: string;
  displayNames: string[];
  icon?: string;
}

export interface XmltvProgramme {
  channelId: string;
  /** ISO-8601 UTC. */
  start: string;
  stop: string;
  title: string;
  description?: string;
  category?: string;
  lang?: string;
}

export interface XmltvResult {
  channels: XmltvChannel[];
  programmes: XmltvProgramme[];
  warnings: string[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
      if (e[0] === "#") {
        const code = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      return ENTITIES[e.toLowerCase()] ?? "";
    })
    .trim();
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  const v = m?.[1] ?? m?.[2];
  return v === undefined ? undefined : decode(v);
}

function text(block: string, tag: string): { value: string; lang?: string } | undefined {
  const m = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!m) return undefined;
  return { value: decode(m[2]!), lang: attr(m[1]!, "lang") };
}

/** Parses XMLTV timestamps like `20261011183000 +0300` into ISO-8601 UTC. */
export function parseXmltvTime(raw: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "00", tz = "+0000"] = m;
  const sign = tz[0] === "-" ? -1 : 1;
  const offsetMin = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offsetMin * 60_000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Lightweight, dependency-free XMLTV reader. Skips bad programmes with a warning. */
export function parseXmltv(xml: string): XmltvResult {
  const out: XmltvResult = { channels: [], programmes: [], warnings: [] };
  for (const m of xml.matchAll(/<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi)) {
    const id = attr(m[1]!, "id");
    if (!id) {
      out.warnings.push("channel without id skipped");
      continue;
    }
    const names = [...m[2]!.matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/gi)].map((n) => decode(n[1]!));
    const icon = /<icon\b([^>]*)\/?>/i.exec(m[2]!);
    out.channels.push({ id, displayNames: names, icon: icon ? attr(icon[1]!, "src") : undefined });
  }
  for (const m of xml.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi)) {
    const channelId = attr(m[1]!, "channel");
    const start = parseXmltvTime(attr(m[1]!, "start") ?? "");
    const stop = parseXmltvTime(attr(m[1]!, "stop") ?? "");
    const title = text(m[2]!, "title");
    if (!channelId || !start || !stop || !title || stop <= start) {
      out.warnings.push(`programme skipped (channel=${channelId ?? "?"})`);
      continue;
    }
    out.programmes.push({
      channelId,
      start,
      stop,
      title: title.value,
      lang: title.lang,
      description: text(m[2]!, "desc")?.value,
      category: text(m[2]!, "category")?.value,
    });
  }
  return out;
}
