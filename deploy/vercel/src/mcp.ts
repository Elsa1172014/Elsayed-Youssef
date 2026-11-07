import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMcpHttp } from "../../../services/api/src/mcp";
import { getMcpRuntime, redact } from "./app";

/** Global IPTV MCP — Streamable HTTP (stateless) at /mcp. Auth: Authorization: Bearer gim_… (created in the Hub). */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const rt = await getMcpRuntime();
    if (!rt.hub?.mcp) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Global IPTV MCP is not configured (SUPABASE_DB_URL)" }, id: null }));
      return;
    }
    await handleMcpHttp(req, res, { store: rt.hub.mcp, app: rt.app, apiFor: rt.apiFor, webBase: rt.hub.publicUrl ?? "" });
  } catch (e) {
    console.error("mcp failed:", redact((e as Error).message));
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  }
}
