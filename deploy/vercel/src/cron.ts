import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkStreamHealth, syncIptvOrg } from "../../../services/api/src/jobs/catalog";
import { createSafeFetch } from "../../../services/api/src/safeFetch";
import { getRuntime } from "./app";

const authorized = (header: string | undefined): boolean => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // refuse to run unauthenticated
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Daily job: refresh the free-channel + premium directory, probe a batch of streams, purge expired sessions.
 *  Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when CRON_SECRET is set. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, body: unknown) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (!authorized(req.headers.authorization)) return send(401, { error: "unauthorized" });
  try {
    const started = Date.now();
    const { store, auth } = await getRuntime();
    const fetcher = createSafeFetch();
    const sync = process.env.CATALOG_SYNC === "false" ? null : await syncIptvOrg(store, fetcher);
    // The sync can take most of the function's 60 s budget; probe streams only with the time that is left.
    const left = 50_000 - (Date.now() - started);
    const health = left > 8_000 ? await checkStreamHealth(store, fetcher, Number(process.env.HEALTH_BATCH ?? 150), 25) : { checked: 0, dead: 0, skipped: "time budget used by catalog sync" };
    await auth.purgeExpired();
    send(200, { sync, health });
  } catch (e) {
    console.error("cron failed:", (e as Error).message);
    send(500, { error: (e as Error).message });
  }
}
