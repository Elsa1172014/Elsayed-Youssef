import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentEvent } from "./agent/loop.js";
import { summarize } from "./agent/loop.js";
import type { Approver } from "./security/permissions.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { UI_HTML } from "./ui.js";
import type { LlmProvider, RiskLevel } from "./types.js";
import type { NexusConfig } from "./config.js";

interface PendingApproval {
  id: string;
  tool: string;
  risk: RiskLevel;
  summary: string;
  resolve: (ok: boolean) => void;
}

export interface NexusServer {
  server: Server;
  token: string;
  port: number;
  runtime: Runtime;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

/**
 * Local web control center. Binds to loopback only, requires a random bearer token,
 * and rejects foreign Host headers (DNS-rebinding protection) because it can operate the computer.
 */
export async function startServer(o: {
  port?: number;
  provider?: LlmProvider;
  config?: NexusConfig;
  home?: string;
  cwd?: string;
  token?: string;
  connectMcp?: boolean;
}): Promise<NexusServer> {
  const token = o.token ?? randomBytes(24).toString("hex");
  const approvals = new Map<string, PendingApproval>();
  const sse = new Set<ServerResponse>();
  const controllers = new Map<string, AbortController>();
  const broadcast = (type: string, data: unknown): void => {
    for (const r of sse) r.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const approver: Approver = (req) =>
    new Promise<boolean>((resolve) => {
      const id = randomUUID().slice(0, 8);
      approvals.set(id, { id, ...req, resolve });
      broadcast("approval", { id, ...req });
      // Unanswered approvals expire as a rejection.
      setTimeout(() => {
        if (approvals.delete(id)) {
          resolve(false);
          broadcast("approval-expired", { id });
        }
      }, 5 * 60_000).unref();
    });

  const runtime = await createRuntime({
    approver, provider: o.provider, config: o.config, home: o.home, cwd: o.cwd, connectMcp: o.connectMcp,
    onEvent: (e: AgentEvent) => broadcast(e.type, e),
  });

  const authOk = (req: IncomingMessage, url: URL): boolean => {
    const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) reject(new Error("body too large"));
        else chunks.push(c);
      });
      req.on("end", () => {
        try { resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {}); }
        catch { reject(new Error("invalid JSON")); }
      });
    });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const host = (req.headers.host ?? "").replace(/:\d+$/, "");
        if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return json(res, 403, { error: "bad host" });

        if (url.pathname === "/" && req.method === "GET") {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
            "x-frame-options": "DENY",
          });
          return res.end(UI_HTML);
        }
        if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
        if (!authOk(req, url)) return json(res, 401, { error: "unauthorized" });

        if (url.pathname === "/api/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          res.write(": connected\n\n");
          for (const a of approvals.values()) res.write(`event: approval\ndata: ${JSON.stringify({ id: a.id, tool: a.tool, risk: a.risk, summary: a.summary })}\n\n`);
          sse.add(res);
          req.on("close", () => sse.delete(res));
          return;
        }
        if (url.pathname === "/api/status") {
          return json(res, 200, {
            platform: process.platform,
            mode: runtime.permissions.config.mode,
            tools: runtime.registry.list().map((t) => ({ name: t.name, group: t.group })),
            mcp: runtime.hub.list(),
          });
        }
        if (url.pathname === "/api/tasks" && req.method === "GET") {
          return json(res, 200, runtime.store.list(30).map((t) => ({ ...summarize(t), goal: t.goal, updatedAt: t.updatedAt })));
        }
        if (url.pathname === "/api/tasks" && req.method === "POST") {
          const body = await readBody(req);
          const goal = typeof body["goal"] === "string" ? body["goal"].trim() : "";
          if (!goal || goal.length > 8000) return json(res, 400, { error: "goal required (max 8000 chars)" });
          const taskId = randomUUID().slice(0, 8);
          const ac = new AbortController();
          controllers.set(taskId, ac);
          void runtime.run(goal, { signal: ac.signal, taskId }).finally(() => controllers.delete(taskId));
          return json(res, 202, { taskId });
        }
        const m = /^\/api\/tasks\/([\w-]+)(\/cancel|\/resume)?$/.exec(url.pathname);
        if (m) {
          const id = m[1]!;
          if (m[2] === "/cancel" && req.method === "POST") {
            controllers.get(id)?.abort();
            return json(res, 200, { cancelled: controllers.has(id) });
          }
          if (m[2] === "/resume" && req.method === "POST") {
            const rec = runtime.store.get(id);
            if (!rec) return json(res, 404, { error: "not found" });
            if (controllers.has(id)) return json(res, 409, { error: "already running" });
            const ac = new AbortController();
            controllers.set(id, ac);
            void runtime.run(rec.goal, { signal: ac.signal, resumeId: id }).finally(() => controllers.delete(id));
            return json(res, 202, { taskId: id });
          }
          const rec = runtime.store.get(id);
          return rec ? json(res, 200, { ...rec, report: summarize(rec) }) : json(res, 404, { error: "not found" });
        }
        if (url.pathname === "/api/approvals" && req.method === "GET") {
          return json(res, 200, [...approvals.values()].map(({ resolve: _r, ...a }) => a));
        }
        const am = /^\/api\/approvals\/([\w-]+)$/.exec(url.pathname);
        if (am && req.method === "POST") {
          const a = approvals.get(am[1]!);
          if (!a) return json(res, 404, { error: "no such approval" });
          const body = await readBody(req);
          approvals.delete(a.id);
          a.resolve(body["approve"] === true);
          broadcast("approval-resolved", { id: a.id, approved: body["approve"] === true });
          return json(res, 200, { ok: true });
        }
        if (url.pathname === "/api/emergency-stop" && req.method === "POST") {
          for (const c of controllers.values()) c.abort();
          for (const a of approvals.values()) a.resolve(false);
          approvals.clear();
          return json(res, 200, { stopped: true });
        }
        json(res, 404, { error: "not found" });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
    })();
  });

  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    server, token, port, runtime,
    async close() {
      for (const c of controllers.values()) c.abort();
      for (const r of sse) r.end();
      await new Promise<void>((r) => server.close(() => r()));
      await runtime.close();
    },
  };
}
