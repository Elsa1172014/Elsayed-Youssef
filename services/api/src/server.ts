import { buildApp } from "./app";
import { claudeModel } from "./ai";
import { AuthService, tokenAuthenticator } from "./auth";
import { secretBoxFromEnv } from "./crypto";
import { openDb } from "./openDb";
import { createSafeFetch } from "./safeFetch";
import { Store } from "./store";

const db = await openDb();
const auth = new AuthService(db);
const app = buildApp({
  store: new Store(db),
  auth,
  authenticate: tokenAuthenticator(auth),
  secrets: secretBoxFromEnv(),
  fetcher: createSafeFetch(),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  trustProxy: process.env.TRUST_PROXY === "true",
  model: process.env.ANTHROPIC_API_KEY ? claudeModel(process.env.ANTHROPIC_API_KEY, { model: process.env.AI_MODEL }) : undefined,
});
setInterval(() => void auth.purgeExpired().catch(() => undefined), 3600_000).unref();
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`API listening on :${port}`);
