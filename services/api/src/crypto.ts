import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/** Encrypts small secrets (e.g. Xtream credentials) at rest. Swap the key source for a KMS in production. */
export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function aesSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error("SECRET_KEY must be 32 bytes (base64-encoded)");
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
    },
    open(sealed) {
      const [v, iv, tag, data] = sealed.split(".");
      if (v !== "v1" || !iv || !tag || !data) throw new Error("Unsupported secret format");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
    },
  };
}

/** 32 raw bytes from SECRET_KEY. A valid 32-byte base64 value is used as-is (`openssl rand -base64 32`); any other
 *  non-empty text is stretched to 32 bytes with scrypt so a plain passphrase works instead of failing start-up.
 *  Use a long random value: a short phrase is only as strong as the phrase. */
export function deriveSecretKey(raw: string): Buffer {
  const text = raw.trim();
  if (!text) throw new Error("SECRET_KEY is required (any long random text, or 32 random bytes in base64)");
  const asBase64 = Buffer.from(text, "base64");
  if (asBase64.length === 32 && asBase64.toString("base64") === text) return asBase64;
  return scryptSync(text, "receiver/secret-key/v1", 32);
}

export function secretBoxFromEnv(env = process.env): SecretBox {
  return aesSecretBox(deriveSecretKey(env.SECRET_KEY ?? ""));
}
