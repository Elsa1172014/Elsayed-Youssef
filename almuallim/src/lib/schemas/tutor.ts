import { z } from "zod";
import { levelSchema, modeSchema } from "@/lib/tutor/types";

export const createSessionSchema = z.object({
  mode: modeSchema.default("explain"),
  level: levelSchema.default("core"),
  versionId: z.string().uuid().nullable().default(null),
  lessonId: z.string().uuid().nullable().default(null),
  objective: z.string().trim().max(500).nullable().default(null),
  channel: z.enum(["text", "voice"]).default("text"),
});

export const chatSchema = z.object({
  sessionId: z.string().uuid(),
  text: z.string().trim().min(1).max(2000),
  mode: modeSchema.optional(),
});

export const patchSessionSchema = z.object({
  mode: modeSchema.optional(),
  level: levelSchema.optional(),
  status: z.literal("ended").optional(),
});

export const confirmPageSchema = z.object({
  sessionId: z.string().uuid(),
  pageNumber: z.number().int().min(1).max(2000),
  source: z.enum(["camera", "manual"]),
  accepted: z.boolean().default(true),
});

export const realtimeTokenSchema = z.object({ sessionId: z.string().uuid() });

export const realtimeToolSchema = z.object({
  sessionId: z.string().uuid(),
  name: z.enum(["search_textbook", "get_page", "get_lesson_outline", "record_evidence"]),
  arguments: z.union([z.string().max(4000), z.record(z.string(), z.unknown())]).default("{}"),
  callId: z.string().max(100),
});

export const realtimeEventsSchema = z.object({
  sessionId: z.string().uuid(),
  events: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("user_speech"), text: z.string().max(4000) }),
        z.object({ type: z.literal("assistant_speech"), text: z.string().max(8000), interrupted: z.boolean().default(false) }),
        z.object({ type: z.literal("state"), voice: z.enum(["started", "ended", "reconnecting", "reconnected", "muted", "unmuted"]) }),
        z.object({ type: z.literal("error"), code: z.string().max(60) }),
      ]),
    )
    .min(1)
    .max(20),
});
