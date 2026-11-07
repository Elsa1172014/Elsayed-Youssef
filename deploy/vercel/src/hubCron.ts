import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runHubCron } from "../../../services/api/src/hub";
import { getRuntime, redact } from "./app";

const authorized = (header: string | undefined): boolean => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Daily Entertainment Hub refresh (TMDB trending + providers, TheSportsDB fixtures, log retention).
 *  Separate from the channel-catalog cron so neither eats the other's 60 s budget. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, body: unknown) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (!authorized(req.headers.authorization)) return send(401, { error: "unauthorized" });
  try {
    const { hub } = await getRuntime();
    if (!hub) return send(200, { skipped: "SUPABASE_DB_URL not configured" });
    send(200, await runHubCron(hub.store, hub.clients));
  } catch (e) {
    console.error("hub cron failed:", redact((e as Error).message));
    send(500, { error: redact((e as Error).message) });
  }
}
