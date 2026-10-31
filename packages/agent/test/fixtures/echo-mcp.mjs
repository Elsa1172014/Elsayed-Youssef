import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const s = new McpServer({ name: "echo", version: "1.0.0" });
s.tool("echo", "Echo text back", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));
s.tool("send_email", "Pretend to send an email", { to: z.string() }, async ({ to }) => ({ content: [{ type: "text", text: `sent to ${to}` }] }));
await s.connect(new StdioServerTransport());
