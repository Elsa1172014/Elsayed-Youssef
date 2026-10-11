import { buildApp } from "./app";
import { devAuthenticator } from "./auth";
import { secretBoxFromEnv } from "./crypto";
import { openDb } from "./openDb";
import { createSafeFetch } from "./safeFetch";
import { Store } from "./store";

const db = await openDb();
const app = buildApp({
  store: new Store(db),
  authenticate: devAuthenticator(),
  secrets: secretBoxFromEnv(),
  fetcher: createSafeFetch(),
});
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`API listening on :${port}`);
