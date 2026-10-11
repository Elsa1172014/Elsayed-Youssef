import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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

export function secretBoxFromEnv(env = process.env): SecretBox {
  const raw = env.SECRET_KEY;
  if (!raw) throw new Error("SECRET_KEY is required (32 random bytes, base64)");
  return aesSecretBox(Buffer.from(raw, "base64"));
}
