import { fileURLToPath } from "node:url";
import { modelFromEnv } from "../../../services/api/src/ai";
import { AuthService, tokenAuthenticator } from "../../../services/api/src/auth";
import { buildApp } from "../../../services/api/src/app";
import { secretBoxFromEnv } from "../../../services/api/src/crypto";
import { openDb } from "../../../services/api/src/openDb";
import { createSafeFetch } from "../../../services/api/src/safeFetch";
import { Store } from "../../../services/api/src/store";

// Serverless: no persistent containers, so keep one small pool per warm instance and build the app once.
process.env.MIGRATIONS_DIR ??= fileURLToPath(new URL("./migrations", import.meta.url));
process.env.PG_POOL_MAX ??= "2";
process.env.NODE_ENV ??= "production";

export interface Runtime {
  store: Store;
  auth: AuthService;
  app: ReturnType<typeof buildApp>;
}

let runtime: Promise<Runtime> | undefined;
export function getRuntime(): Promise<Runtime> {
  runtime ??= (async () => {
    const db = await openDb();
    const store = new Store(db);
    const auth = new AuthService(db);
    const app = buildApp({
      store,
      auth,
      authenticate: tokenAuthenticator(auth),
      secrets: secretBoxFromEnv(),
      fetcher: createSafeFetch(),
      allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      trustProxy: true, // Vercel's edge sets X-Forwarded-For
      model: modelFromEnv(),
    });
    await app.ready();
    return { store, auth, app };
  })();
  runtime.catch(() => (runtime = undefined)); // a failed cold start (e.g. DB down) must not be cached
  return runtime;
}
