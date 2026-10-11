import type { FastifyRequest } from "fastify";

/** Resolves the caller's user id, or null when unauthenticated. */
export type Authenticator = (req: FastifyRequest) => string | null;

/**
 * Development-only authenticator: `Authorization: Bearer dev:<userId>`.
 * Placeholder until OIDC/JWT auth lands (ARCHITECTURE §5.2); refuses to run in production.
 */
export function devAuthenticator(): Authenticator {
  if (process.env.NODE_ENV === "production") {
    throw new Error("devAuthenticator must not be used in production; configure real auth");
  }
  return (req) => {
    const m = /^Bearer dev:([A-Za-z0-9_-]{1,64})$/.exec(req.headers.authorization ?? "");
    return m ? m[1]! : null;
  };
}
