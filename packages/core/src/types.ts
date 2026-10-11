export type SourceKind = "official" | "fast" | "directory" | "fta" | "user";

export interface M3UEntry {
  /** Display name (text after the last comma of #EXTINF). */
  name: string;
  /** Stream URL as written in the playlist. */
  url: string;
  /** Duration from #EXTINF; -1 for live streams. */
  duration: number;
  tvgId?: string;
  tvgName?: string;
  tvgLogo?: string;
  groupTitle?: string;
  /** All remaining #EXTINF attributes, lower-cased keys. */
  attrs: Record<string, string>;
}

export interface M3UParseResult {
  entries: M3UEntry[];
  /** Non-fatal problems, with 1-based line numbers. */
  warnings: { line: number; message: string }[];
  /** Guide URL(s) from the #EXTM3U header (url-tvg / x-tvg-url). */
  epgUrls: string[];
}
