import { vi } from "vitest";

type Result = { data?: unknown; error?: { message: string; code?: string } | null };
type Handler = (op: { table: string; action: "select" | "insert" | "update" | "delete"; values?: unknown; filters: Record<string, unknown> }) => Result;

/** Minimal chainable stand-in for a PostgREST client, driven by a handler. TEST-ONLY. */
export function fakeDb(opts: { user: { id: string } | null; handler: Handler; rpc?: (name: string, args: unknown) => Result }) {
  const calls: { table: string; action: string; values?: unknown; filters: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    let action: "select" | "insert" | "update" | "delete" = "select";
    let values: unknown;
    const filters: Record<string, unknown> = {};
    const exec = (): Promise<Result & { data: unknown }> => {
      calls.push({ table, action, values, filters: { ...filters } });
      const r = opts.handler({ table, action, values, filters });
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: (v: unknown) => ((action = "insert"), (values = v), chain),
      update: (v: unknown) => ((action = "update"), (values = v), chain),
      delete: () => ((action = "delete"), chain),
      eq: (k: string, v: unknown) => ((filters[k] = v), chain),
      in: (k: string, v: unknown) => ((filters[k] = v), chain),
      order: () => chain,
      limit: () => chain,
      is: (k: string, v: unknown) => ((filters[k] = v), chain),
      single: () => exec(),
      maybeSingle: () => exec(),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => exec().then(res, rej),
    };
    return chain;
  };
  return {
    calls,
    client: {
      auth: { getUser: async () => ({ data: { user: opts.user } }) },
      from,
      rpc: vi.fn(async (name: string, args: unknown) => {
        const r = opts.rpc?.(name, args) ?? { data: null };
        return { data: r.data ?? null, error: r.error ?? null };
      }),
    },
  };
}
