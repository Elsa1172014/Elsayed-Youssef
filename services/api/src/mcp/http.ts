import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import type { Authenticator } from "../auth";
import { createMcpServer, type ApiCall } from "./server";
import type { McpStore } from "./store";

/**
 * In-process identity for the MCP's private copy of the API. That Fastify instance is never bound to a port; the header
 * carries a per-process random secret, so it cannot be forged from outside even in principle.
 */
export function internalIdentity() {
  const secret = randomBytes(32).toString("hex");
  const header = "x-mcp-internal";
  const authenticate: Authenticator = async (req) => {
    const v = req.headers[header];
    if (typeof v !== "string") return null;
    const [s, uid] = v.split(":", 2);
    if (!s || !uid || s.length !== secret.length || !timingSafeEqual(Buffer.from(s), Buffer.from(secret))) return null;
    return uid;
  };
  const apiFor = (app: FastifyInstance, uid: string): ApiCall => async (method, url, body) => {
    const r = await app.inject({ method, url, headers: { [header]: `${secret}:${uid}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    let json: unknown = null;
    try { json = r.body ? JSON.parse(r.body) : null; } catch { json = r.body; }
    return { status: r.statusCode, json };
  };
  return { authenticate, apiFor };
}

const MAX_BODY = 6 * 1024 * 1024;
async function readBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

const jsonRpcError = (res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: status === 401 ? -32001 : -32000, message }, id: null }));
};

/** Stateless Streamable HTTP endpoint (one MCP server per request — suits serverless). Auth: `Authorization: Bearer gim_…`. */
export async function handleMcpHttp(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  ctx: { store: McpStore; app: FastifyInstance; apiFor: (app: FastifyInstance, uid: string) => ApiCall; webBase: string },
) {
  if (req.method !== "POST") return jsonRpcError(res, 405, "Method not allowed: this server is stateless, use POST", { allow: "POST" });
  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
  const userId = await ctx.store.userForToken(bearer).catch(() => undefined);
  if (!userId) return jsonRpcError(res, 401, "Missing or invalid token. Create one in Smart Receiver → الترفيه → MCP.", { "www-authenticate": 'Bearer realm="Global IPTV MCP"' });
  let body: unknown;
  try { body = await readBody(req); } catch { return jsonRpcError(res, 400, "Invalid JSON body"); }
  const server = createMcpServer({ api: ctx.apiFor(ctx.app, userId), store: ctx.store, userId, webBase: ctx.webBase });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
