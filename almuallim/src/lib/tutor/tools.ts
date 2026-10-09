import { tool } from "ai";
import { z } from "zod";
import { evaluateResponseInput, evidenceInput, pageInput, proposeQuestionInput, searchInput, toolEvaluateResponse, toolGetPage, toolLessonOutline, toolProposeQuestion, toolRecordEvidence, toolSearchTextbook, type ToolEnv } from "./tool-core";

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
    propose_question: tool({
      description: "Create a practice/assessment question (with a scoring rubric and hints) BEFORE asking it, so the student's answer can be evaluated and saved. Returns an itemId.",
      inputSchema: proposeQuestionInput,
      execute: (input) => toolProposeQuestion(env, input),
    }),
    evaluate_response: tool({
      description: "After the student answers a question created with propose_question, score it against the rubric and record it. Does not return a grade; never announce numeric grades.",
      inputSchema: evaluateResponseInput,
      execute: (input) => toolEvaluateResponse(env, input),
    }),
    record_evidence: tool({
      description: "Record evidence about the student's answer for one skill (practice/assessment). Never tell the student a grade.",
      inputSchema: evidenceInput,
      execute: (input) => toolRecordEvidence(env, input),
    }),
  };
}
