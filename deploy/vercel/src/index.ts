import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntime } from "./app";

/** All /v1/* and /healthz requests are rewritten here (see vercel.json) and handed to Fastify unchanged. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { app } = await getRuntime();
    app.server.emit("request", req, res);
  } catch (e) {
    console.error("startup failed:", (e as Error).message);
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "service unavailable" }));
  }
}
