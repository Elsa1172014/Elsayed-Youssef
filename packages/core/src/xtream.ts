/**
 * Client helpers for a user's own Xtream Codes account (a subscription the user legitimately holds and entered).
 * Only metadata (categories, channel lists) is fetched; media is played by the client directly from the provider.
 */
export interface XtreamAccount {
  /** Provider base URL, e.g. https://provider.example:8080 */
  baseUrl: string;
  username: string;
  password: string;
}

export interface XtreamChannel {
  streamId: number;
  name: string;
  categoryName?: string;
  logo?: string;
  epgChannelId?: string;
}

export const XTREAM_CRED_PLACEHOLDERS = { username: "{username}", password: "{password}" } as const;

export function xtreamApiUrl(acc: XtreamAccount, action?: string): string {
  const u = new URL("/player_api.php", acc.baseUrl);
  u.searchParams.set("username", acc.username);
  u.searchParams.set("password", acc.password);
  if (action) u.searchParams.set("action", action);
  return u.toString();
}

/** Stream URL with credential placeholders, so credentials never sit in a stored channel row. */
export function xtreamStreamTemplate(baseUrl: string, streamId: number): string {
  const origin = new URL(baseUrl).origin;
  return `${origin}/live/${XTREAM_CRED_PLACEHOLDERS.username}/${XTREAM_CRED_PLACEHOLDERS.password}/${streamId}.m3u8`;
}

export function fillCredentials(template: string, acc: Pick<XtreamAccount, "username" | "password">): string {
  return template
    .replace(XTREAM_CRED_PLACEHOLDERS.username, encodeURIComponent(acc.username))
    .replace(XTREAM_CRED_PLACEHOLDERS.password, encodeURIComponent(acc.password));
}

type Json = Record<string, unknown>;
const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function parseXtreamLive(categories: unknown, streams: unknown): XtreamChannel[] {
  const catName = new Map<string, string>();
  if (Array.isArray(categories)) {
    for (const c of categories as Json[]) {
      const id = String(c.category_id ?? "");
      const name = s(c.category_name);
      if (id && name) catName.set(id, name);
    }
  }
  if (!Array.isArray(streams)) return [];
  const out: XtreamChannel[] = [];
  for (const raw of streams as Json[]) {
    const streamId = Number(raw.stream_id);
    const name = s(raw.name);
    if (!Number.isInteger(streamId) || streamId < 0 || !name) continue;
    out.push({
      streamId,
      name,
      categoryName: catName.get(String(raw.category_id ?? "")),
      logo: s(raw.stream_icon),
      epgChannelId: s(raw.epg_channel_id),
    });
  }
  return out;
}

/** The account-info response signals whether the subscription is active; we never try to work around a lapsed one. */
export function xtreamAuthOk(info: unknown): boolean {
  const ui = (info as { user_info?: Json } | null)?.user_info;
  return !!ui && (ui.auth === 1 || ui.auth === "1") && (ui.status === undefined || ui.status === "Active");
}
