import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// scrypt (memory-hard, built into Node: no native build step). Parameters are stored in each hash so they can be raised later.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const opts: ScryptOptions = { N: n, r, p, maxmem: 256 * n * r };
    scrypt(password.normalize("NFKC"), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when stored parameters are weaker than current ones (rehash after a successful login). */
export function needsRehash(stored: string): boolean {
  const [scheme, n, r, p] = stored.split("$");
  return scheme !== "scrypt" || Number(n) < N || Number(r) < R || Number(p) < P;
}

export type PasswordProblem = string | null;

export function checkPasswordPolicy(password: string, username: string): PasswordProblem {
  if (password.length < 10) return "Password must be at least 10 characters";
  if (password.length > 128) return "Password must be at most 128 characters";
  if (password.toLowerCase().includes(username.toLowerCase())) return "Password must not contain the username";
  if (/^(.)\1+$/.test(password)) return "Password is too repetitive";
  return null;
}

export function checkUsername(username: unknown): string | null {
  return typeof username === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(username) ? username : null;
}
