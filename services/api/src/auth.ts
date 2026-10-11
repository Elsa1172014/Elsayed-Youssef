import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Db } from "./db";
import { checkPasswordPolicy, checkUsername, hashPassword, needsRehash, verifyPassword } from "./password";

/** Resolves the caller's user id from the request, or null when unauthenticated. */
export type Authenticator = (req: FastifyRequest) => Promise<string | null>;

export const SESSION_TTL_MS = 30 * 24 * 3600_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// A real hash of a throwaway password, verified against when the username is unknown so timing does not reveal which usernames exist.
let dummyHash: Promise<string> | undefined;

export class AuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export class AuthService {
  constructor(private db: Db, private now: () => Date = () => new Date()) {}

  async register(usernameRaw: unknown, password: unknown): Promise<{ userId: string; token: string }> {
    const username = checkUsername(usernameRaw);
    if (!username) throw new AuthError("Username must be 3-32 characters: letters, digits, '.', '_' or '-'", 400);
    if (typeof password !== "string") throw new AuthError("password is required", 400);
    const problem = checkPasswordPolicy(password, username);
    if (problem) throw new AuthError(problem, 400);
    const id = randomUUID();
    try {
      await this.db.query("INSERT INTO users (id, username, password_hash, created_at) VALUES ($1,$2,$3,$4)", [id, username, await hashPassword(password), this.now().toISOString()]);
    } catch (e) {
      if (/unique|duplicate/i.test((e as Error).message)) throw new AuthError("Username is already taken", 409);
      throw e;
    }
    return { userId: id, token: await this.createSession(id) };
  }

  async login(usernameRaw: unknown, password: unknown): Promise<{ userId: string; token: string }> {
    const invalid = new AuthError("Invalid username or password", 401);
    if (typeof usernameRaw !== "string" || typeof password !== "string" || password.length > 1024) throw invalid;
    const row = (await this.db.query<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE lower(username)=lower($1)", [usernameRaw])).rows[0];
    if (!row) {
      await verifyPassword(password, await (dummyHash ??= hashPassword(randomBytes(16).toString("hex"))));
      throw invalid;
    }
    if (!(await verifyPassword(password, row.password_hash))) throw invalid;
    if (needsRehash(row.password_hash)) {
      await this.db.query("UPDATE users SET password_hash=$2 WHERE id=$1", [row.id, await hashPassword(password)]);
    }
    return { userId: row.id, token: await this.createSession(row.id) };
  }

  private async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(this.now().getTime() + SESSION_TTL_MS);
    await this.db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)", [sha256(token), userId, expires.toISOString()]);
    return token;
  }

  async verifyToken(token: string): Promise<string | null> {
    const r = (await this.db.query<{ user_id: string }>("SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>$2", [sha256(token), this.now().toISOString()])).rows[0];
    return r?.user_id ?? null;
  }

  async purgeExpired(): Promise<void> {
    await this.db.query("DELETE FROM sessions WHERE expires_at<=$1", [this.now().toISOString()]);
  }

  async logout(token: string): Promise<void> {
    await this.db.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
  }

  async me(userId: string): Promise<{ id: string; username: string } | undefined> {
    return (await this.db.query<{ id: string; username: string }>("SELECT id, username FROM users WHERE id=$1", [userId])).rows[0];
  }

  /** Verifies the current password; used before sensitive changes. */
  private async confirm(userId: string, password: unknown): Promise<{ username: string }> {
    const row = (await this.db.query<{ username: string; password_hash: string }>("SELECT username, password_hash FROM users WHERE id=$1", [userId])).rows[0];
    if (!row || typeof password !== "string" || !(await verifyPassword(password, row.password_hash))) throw new AuthError("Current password is incorrect", 403);
    return { username: row.username };
  }

  /** Changes the password and signs out every other session (keeps `keepToken`). */
  async changePassword(userId: string, current: unknown, next: unknown, keepToken: string): Promise<void> {
    const { username } = await this.confirm(userId, current);
    if (typeof next !== "string") throw new AuthError("newPassword is required", 400);
    const problem = checkPasswordPolicy(next, username);
    if (problem) throw new AuthError(problem, 400);
    await this.db.query("UPDATE users SET password_hash=$2 WHERE id=$1", [userId, await hashPassword(next)]);
    await this.db.query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2", [userId, sha256(keepToken)]);
  }

  /** Deletes the account and, via cascading foreign keys, all of the user's sources, channels, guide data and history. */
  async deleteAccount(userId: string, password: unknown): Promise<void> {
    await this.confirm(userId, password);
    await this.db.query("DELETE FROM users WHERE id=$1", [userId]);
  }
}

export const bearerToken = (req: FastifyRequest): string | null => /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization ?? "")?.[1] ?? null;

export function tokenAuthenticator(auth: AuthService): Authenticator {
  return async (req) => {
    const t = bearerToken(req);
    return t ? auth.verifyToken(t) : null;
  };
}
