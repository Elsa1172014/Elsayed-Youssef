import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";

export type ApiErrorCode =
  | "unauthenticated" | "forbidden" | "invalid_input" | "not_found" | "rate_limited"
  | "budget_exceeded" | "conflict" | "upstream_error" | "not_configured" | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401, forbidden: 403, invalid_input: 400, not_found: 404, rate_limited: 429,
  budget_exceeded: 429, conflict: 409, upstream_error: 502, not_configured: 503, internal: 500,
};

export function apiError(code: ApiErrorCode, message: string, extra?: { retryAfterSec?: number; details?: unknown }) {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (extra?.retryAfterSec) headers["Retry-After"] = String(extra.retryAfterSec);
  return NextResponse.json({ error: { code, message, details: extra?.details } }, { status: STATUS[code], headers });
}

export function json<T>(body: T, init?: ResponseInit) {
  return NextResponse.json(body, { ...init, headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) } });
}

export const newRequestId = () => randomUUID();

/** Parse + validate a JSON body with Zod. Bodies over `maxBytes` are rejected before parsing. */
export async function parseBody<T>(req: Request, schema: ZodType<T>, maxBytes = 64 * 1024): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) return { ok: false, response: apiError("invalid_input", "الطلب كبير جدًا") };
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > maxBytes) return { ok: false, response: apiError("invalid_input", "الطلب كبير جدًا") };
    raw = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, response: apiError("invalid_input", "JSON غير صالح") };
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    return { ok: false, response: apiError("invalid_input", "مدخلات غير صالحة", { details: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }) };
  }
  return { ok: true, data: r.data };
}
