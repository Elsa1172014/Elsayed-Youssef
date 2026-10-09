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

export const createClassSchema = z.object({ name: z.string().trim().min(1).max(80), yearGroup: z.number().int().min(7).max(13) });

export const validateResponseSchema = z.object({
  teacherScore: z.number().min(0).max(100),
  teacherFeedback: z.string().trim().max(1000).optional(),
});

export const validateMasterySchema = z.object({
  studentId: z.string().uuid(),
  skill: z.enum(["grammar", "vocabulary", "rhetoric", "comprehension", "writing", "reading_aloud"]),
  lessonId: z.string().uuid().nullable().default(null),
  value: z.number().min(0).max(1).nullable(), // null clears the validation
});

export const createUserSchema = z.object({
  email: z.string().email().max(200),
  displayName: z.string().trim().max(80).default(""),
  role: z.enum(["student", "teacher", "admin"]),
  yearGroup: z.number().int().min(7).max(13).nullable().default(null),
  classId: z.string().uuid().nullable().default(null),
  consentRecorded: z.boolean().default(false),
});

export const addMembersSchema = z.object({ studentIds: z.array(z.string().uuid()).min(1).max(100) });

export const deleteDataSchema = z.object({
  scope: z.enum(["learning_data", "account"]),
  studentId: z.string().uuid().optional(),
  confirm: z.literal("حذف", { error: "اكتب كلمة «حذف» للتأكيد" }),
});
export const preferencesSchema = z.object({ allowTranscriptRetention: z.boolean() });
