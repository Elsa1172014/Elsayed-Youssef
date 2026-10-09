// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnswerView } from "@/components/tutor/AnswerView";
import { TutorWorkspace } from "@/components/tutor/TutorWorkspace";
import type { VerifiedAnswer } from "@/lib/tutor/answer";
import type { BookOption } from "@/lib/tutor/client-types";

const answer: VerifiedAnswer = {
  grounding: "grounded", droppedQuotes: 0, detectedMisconception: null, suggestedNextStep: null,
  sources: [],
  segments: [
    { kind: "quote", text: "الفاعل اسم مرفوع", source: { chunkId: "c", lessonTitle: "الدرس الأول", pageStart: 2, pageEnd: 3, label: "ص ٢–٣" } },
    { kind: "explanation", text: "أي أنه يأخذ الضمة غالبًا." },
    { kind: "question", text: "من الفاعل؟" },
  ],
};
const books: BookOption[] = [{ versionId: "v1", title: "لغتي", lessons: [{ id: "l1", title: "الدرس الأول: الفاعل", unit: null, startPage: 2, endPage: 3 }] }];

afterEach(cleanup);

describe("AnswerView", () => {
  it("shows textbook quotes in a labelled figure, separate from generated explanation", () => {
    render(<AnswerView answer={answer} />);
    const fig = screen.getByRole("figure");
    expect(within(fig).getByText(/من الكتاب · ص ٢–٣/)).toBeTruthy();
    expect(within(fig).getByText("الفاعل اسم مرفوع")).toBeTruthy();
    const expl = screen.getByText("أي أنه يأخذ الضمة غالبًا.");
    expect(fig.contains(expl)).toBe(false);
    expect(screen.getByText("مبني على الكتاب")).toBeTruthy();
  });
  it("shows an explicit out-of-book badge and notice for ungrounded answers", () => {
    render(<AnswerView answer={{ ...answer, grounding: "ungrounded", segments: [{ kind: "notice", text: "لم أجد هذه المعلومة في الكتاب" }, { kind: "explanation", text: "x" }], droppedQuotes: 2 }} />);
    expect(screen.getByText("من خارج الكتاب")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("لم أجد");
    expect(screen.getByText(/حُذف 2 اقتباس/)).toBeTruthy();
  });
});

describe("TutorWorkspace (text fallback)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    window.HTMLElement.prototype.scrollTo = vi.fn();
    fetchMock = vi.fn(async (url: string) =>
      url === "/api/sessions"
        ? new Response(JSON.stringify({ session: { id: "s1" } }), { status: 201 })
        : new Response(JSON.stringify({ answer }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("creates a session, sends the question, and renders the cited answer", async () => {
    render(<TutorWorkspace books={books} />);
    fireEvent.change(screen.getByLabelText("اكتب رسالتك"), { target: { value: "ما هو الفاعل؟" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال" }));
    await waitFor(() => expect(screen.getByRole("figure")).toBeTruthy());
    const calls = fetchMock.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["/api/sessions", "/api/tutor/chat"]);
    const chatBody = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(chatBody).toMatchObject({ sessionId: "s1", text: "ما هو الفاعل؟", mode: "explain" });
    expect(screen.getByText("ما هو الفاعل؟")).toBeTruthy();
  });

  it("reuses the session for the next question and sends the selected mode", async () => {
    render(<TutorWorkspace books={books} />);
    const box = screen.getByLabelText("اكتب رسالتك");
    fireEvent.change(box, { target: { value: "س1" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال" }));
    await waitFor(() => expect(screen.getAllByRole("figure")).toHaveLength(1));
    fireEvent.click(screen.getByRole("radio", { name: "حوار موجَّه" }));
    fireEvent.change(box, { target: { value: "س2" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال" }));
    await waitFor(() => expect(screen.getAllByRole("figure")).toHaveLength(2));
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/sessions")).toHaveLength(1);
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body).mode).toBe("socratic");
  });

  it("shows a recoverable error when the server fails", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/sessions"
        ? new Response(JSON.stringify({ session: { id: "s1" } }), { status: 201 })
        : new Response(JSON.stringify({ error: { message: "تعذّر الحصول على إجابة الآن" } }), { status: 502 }),
    );
    render(<TutorWorkspace books={books} />);
    fireEvent.change(screen.getByLabelText("اكتب رسالتك"), { target: { value: "سؤال" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("تعذّر الحصول"));
    expect((screen.getByLabelText("اكتب رسالتك") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("explains when no book is ready and disables input", () => {
    render(<TutorWorkspace books={[]} />);
    expect(screen.getByText(/لا توجد كتب جاهزة/)).toBeTruthy();
    expect((screen.getByLabelText("اكتب رسالتك") as HTMLTextAreaElement).disabled).toBe(true);
  });
});
