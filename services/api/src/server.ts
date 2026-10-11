import { buildApp } from "./app";
import { devAuthenticator } from "./auth";
import { MemoryStore } from "./store";

const app = buildApp({ store: new MemoryStore(), authenticate: devAuthenticator() });
const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).then(() => console.log(`API listening on :${port}`));
