import { z } from "zod";

export const MAX_PDF_BYTES = 500 * 1024 * 1024;

export const createBookSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    yearMin: z.number().int().min(7).max(13),
    yearMax: z.number().int().min(7).max(13),
    publisher: z.string().trim().max(200).optional(),
    versionLabel: z.string().trim().min(1).max(40).default("1"),
    // Legal gate: the admin must explicitly confirm the licence and say on what basis.
    licenseConfirmed: z.literal(true, { error: "يجب تأكيد ترخيص استخدام الكتاب" }),
    licenseAttestation: z.string().trim().min(10).max(1000),
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
    fileSize: z.number().int().positive().max(MAX_PDF_BYTES),
  })
  .refine((v) => v.yearMin <= v.yearMax, { message: "yearMin must be <= yearMax", path: ["yearMax"] });
export type CreateBookInput = z.infer<typeof createBookSchema>;

export const ingestSchema = z.object({ force: z.boolean().default(false) });
export const uuidSchema = z.string().uuid();
