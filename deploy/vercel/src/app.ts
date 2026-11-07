import { fileURLToPath } from "node:url";
import { modelFromEnv } from "../../../services/api/src/ai";
import { AuthService, tokenAuthenticator } from "../../../services/api/src/auth";
import { buildApp } from "../../../services/api/src/app";
import { proxyKeyFromEnv, secretBoxFromEnv } from "../../../services/api/src/crypto";
import { openDb } from "../../../services/api/src/openDb";
import { createSafeFetch } from "../../../services/api/src/safeFetch";
import { Store } from "../../../services/api/src/store";
import { hubFromEnv, type Hub } from "../../../services/api/src/hub";
import { internalIdentity } from "../../../services/api/src/mcp";

// Serverless: no persistent containers, so keep one small pool per warm instance and build the app once.
process.env.MIGRATIONS_DIR ??= fileURLToPath(new URL("./migrations", import.meta.url));
process.env.PG_POOL_MAX ??= "2";
process.env.NODE_ENV ??= "production";

export interface Runtime {
  store: Store;
  auth: AuthService;
  app: ReturnType<typeof buildApp>;
  hub?: Hub;
}

/** Startup failure tagged with the stage that failed, so a 503 tells the owner what to fix (never includes secrets). */
export class StartupError extends Error {
  constructor(readonly stage: "config" | "database", message: string) {
    super(message);
  }
}
/** Strips connection strings and Neon/Vercel hostnames from an error message before it is shown to a visitor. */
export const redact = (m: string) =>
  m.replace(/postgres(ql)?:\/\/\S+/gi, "[url]").replace(/[a-z0-9.-]+\.(supabase\.co|pooler\.supabase\.com)\b/gi, "[host]").replace(/[a-z0-9.-]+\.(neon\.tech|vercel-storage\.com|aws\.neon\.tech)\b/gi, "[host]").slice(0, 300);

let runtime: Promise<Runtime> | undefined;
export function getRuntime(): Promise<Runtime> {
  runtime ??= (async () => {
    let secrets;
    try {
      secrets = secretBoxFromEnv();
    } catch (e) {
      throw new StartupError("config", `SECRET_KEY is missing or invalid: ${(e as Error).message}`);
    }
    let db;
    try {
      db = await openDb();
    } catch (e) {
      const err = e as Error & { code?: string };
      throw new StartupError("database", `${err.code ? `${err.code}: ` : ""}${err.message}`);
    }
    const store = new Store(db);
    const auth = new AuthService(db);
    // Entertainment Hub is optional: a Supabase problem must never take the main platform down.
    const hub = await hubFromEnv().catch((e: Error) => { console.error("hub disabled:", redact(e.message)); return undefined; });
    const app = buildApp({
      store,
      auth,
      authenticate: tokenAuthenticator(auth),
      secrets,
      fetcher: createSafeFetch(),
      proxyKey: proxyKeyFromEnv(),
      allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      trustProxy: true, // Vercel's edge sets X-Forwarded-For
      model: modelFromEnv(),
      hub,
    });
    await app.ready();
    return { store, auth, app, hub };
  })();
  runtime.catch(() => (runtime = undefined)); // a failed cold start (e.g. DB down) must not be cached
  return runtime;
}

/**
 * Global IPTV MCP: a private copy of the API (same store/auth/hub) authenticated by an in-process identity,
 * used by /mcp and the MCP part of the hub cron. Never bound to a port.
 */
let mcpRuntime: Promise<{ app: ReturnType<typeof buildApp>; apiFor: ReturnType<typeof internalIdentity>["apiFor"]; hub?: Hub }> | undefined;
export function getMcpRuntime() {
  mcpRuntime ??= (async () => {
    const rt = await getRuntime();
    const id = internalIdentity();
    const app = buildApp({
      store: rt.store, auth: rt.auth, authenticate: id.authenticate, secrets: secretBoxFromEnv(), fetcher: createSafeFetch(),
      proxyKey: proxyKeyFromEnv(), trustProxy: true, model: modelFromEnv(), hub: rt.hub,
    });
    await app.ready();
    return { app, apiFor: id.apiFor, hub: rt.hub };
  })();
  mcpRuntime.catch(() => (mcpRuntime = undefined));
  return mcpRuntime;
}
