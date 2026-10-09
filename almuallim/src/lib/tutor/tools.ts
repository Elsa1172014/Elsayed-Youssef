import { tool } from "ai";
import { z } from "zod";
import { evidenceInput, pageInput, searchInput, toolGetPage, toolLessonOutline, toolRecordEvidence, toolSearchTextbook, type ToolEnv } from "./tool-core";

/** AI SDK tool set for the text tutor. Execution is delegated to the shared cores (same code the voice path uses). */
export function buildTutorTools(env: ToolEnv) {
  return {
    search_textbook: tool({
      description: "Search the student's textbook (hybrid semantic + keyword). Returns passages with chunkId and page numbers. Use before explaining any curriculum content.",
      inputSchema: searchInput,
      execute: (input) => toolSearchTextbook(env, input),
    }),
    get_page: tool({
      description: "Read the full text of one textbook page by its physical page number (e.g. the page the student confirmed with the camera).",
      inputSchema: pageInput,
      execute: (input) => toolGetPage(env, input),
    }),
    get_lesson_outline: tool({
      description: "List the lessons of the current textbook with their page ranges.",
      inputSchema: z.object({}),
      execute: () => toolLessonOutline(env),
    }),
    record_evidence: tool({
      description: "Record evidence about the student's answer for one skill (practice/assessment). Never tell the student a grade.",
      inputSchema: evidenceInput,
      execute: (input) => toolRecordEvidence(env, input),
    }),
  };
}
