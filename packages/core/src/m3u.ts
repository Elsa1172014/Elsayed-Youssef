import type { M3UEntry, M3UParseResult } from "./types";

const ATTR_RE = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s",]+))/g;
const ALLOWED_SCHEMES = new Set(["http:", "https:", "rtmp:", "rtsp:", "udp:", "rtp:"]);

function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of text.matchAll(ATTR_RE)) {
    attrs[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return attrs;
}

/** Splits `#EXTINF:<duration> <attrs>,<name>` honouring commas inside quotes. */
function parseExtinf(rest: string): { duration: number; attrs: Record<string, string>; name: string } | null {
  const durMatch = /^\s*(-?\d+(?:\.\d+)?)/.exec(rest);
  if (!durMatch) return null;
  let inQuote: string | null = null;
  let comma = -1;
  for (let i = durMatch[0].length; i < rest.length; i++) {
    const c = rest[i]!;
    if (inQuote) {
      if (c === inQuote) inQuote = null;
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (c === ",") {
      comma = i;
      break;
    }
  }
  const attrText = rest.slice(durMatch[0].length, comma === -1 ? undefined : comma);
  const name = comma === -1 ? "" : rest.slice(comma + 1).trim();
  return { duration: Number(durMatch[1]), attrs: parseAttrs(attrText), name };
}

function isAllowedUrl(raw: string): boolean {
  try {
    return ALLOWED_SCHEMES.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}

/**
 * Tolerant M3U/M3U8 channel-playlist parser. Never throws on malformed input;
 * problems are reported in `warnings`. Only an allow-list of URL schemes is
 * accepted so entries cannot smuggle in file:, javascript: or data: URLs.
 */
export function parseM3U(input: string): M3UParseResult {
  const result: M3UParseResult = { entries: [], warnings: [], epgUrls: [] };
  const lines = input.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  let pending: ReturnType<typeof parseExtinf> = null;
  let pendingLine = 0;
  let pendingGroup: string | undefined;

  const warn = (line: number, message: string) => result.warnings.push({ line, message });

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trim();
    if (!line) return;

    if (line.toUpperCase().startsWith("#EXTM3U")) {
      const attrs = parseAttrs(line.slice(7));
      const guide = attrs["url-tvg"] ?? attrs["x-tvg-url"];
      if (guide) result.epgUrls.push(...guide.split(",").map((s) => s.trim()).filter(Boolean));
      return;
    }
    if (line.toUpperCase().startsWith("#EXTINF:")) {
      if (pending) warn(pendingLine, "#EXTINF without a following URL");
      pending = parseExtinf(line.slice(8));
      pendingLine = lineNo;
      if (!pending) warn(lineNo, "Malformed #EXTINF line");
      return;
    }
    if (line.toUpperCase().startsWith("#EXTGRP:")) {
      pendingGroup = line.slice(8).trim() || undefined;
      return;
    }
    if (line.startsWith("#")) return; // other directives (#EXTVLCOPT etc.) are ignored

    if (!pending) {
      warn(lineNo, "URL without preceding #EXTINF");
      return;
    }
    if (!isAllowedUrl(line)) {
      warn(lineNo, "Skipped entry with unsupported or invalid URL");
      pending = null;
      pendingGroup = undefined;
      return;
    }
    const { attrs, duration, name } = pending;
    const entry: M3UEntry = {
      name: name || attrs["tvg-name"] || line,
      url: line,
      duration,
      tvgId: attrs["tvg-id"] || undefined,
      tvgName: attrs["tvg-name"] || undefined,
      tvgLogo: attrs["tvg-logo"] || undefined,
      groupTitle: attrs["group-title"] || pendingGroup,
      attrs,
    };
    result.entries.push(entry);
    pending = null;
    pendingGroup = undefined;
  });

  if (pending) warn(pendingLine, "#EXTINF without a following URL");
  return result;
}

/** Serialises entries back to M3U so users can export their edited playlists. */
export function serializeM3U(entries: M3UEntry[], epgUrls: string[] = []): string {
  const q = (v: string) => v.replace(/"/g, "'");
  const out = [epgUrls.length ? `#EXTM3U url-tvg="${q(epgUrls.join(","))}"` : "#EXTM3U"];
  for (const e of entries) {
    const attrs: Record<string, string> = { ...e.attrs };
    if (e.tvgId) attrs["tvg-id"] = e.tvgId;
    if (e.tvgName) attrs["tvg-name"] = e.tvgName;
    if (e.tvgLogo) attrs["tvg-logo"] = e.tvgLogo;
    if (e.groupTitle) attrs["group-title"] = e.groupTitle;
    const attrText = Object.entries(attrs).map(([k, v]) => ` ${k}="${q(v)}"`).join("");
    out.push(`#EXTINF:${e.duration}${attrText},${e.name.replace(/[\r\n]+/g, " ")}`, e.url);
  }
  return out.join("\n") + "\n";
}
