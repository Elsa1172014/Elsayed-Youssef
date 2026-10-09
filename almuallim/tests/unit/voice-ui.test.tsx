// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orbMode } from "@/components/tutor/VoiceOrb";
import { VoicePanel } from "@/components/tutor/VoicePanel";
import { mergeVoiceTranscript, type BookOption, type ChatMessage } from "@/lib/tutor/client-types";
import type { VoiceState } from "@/lib/voice/client";

afterEach(cleanup);

const base: VoiceState = { phase: "idle", activity: null, muted: false, error: null, warning: null, reconnectAttempt: 0, transcript: [] };
const handlers = () => ({ onStart: vi.fn(), onStop: vi.fn(), onMute: vi.fn(), onInterrupt: vi.fn() });

describe("orbMode", () => {
  it("maps session state to the orb animation", () => {
    expect(orbMode("idle", null, false)).toBe("idle");
    expect(orbMode("connecting", null, false)).toBe("connecting");
    expect(orbMode("reconnecting", null, false)).toBe("connecting");
    expect(orbMode("live", "listening", false)).toBe("listening");
    expect(orbMode("live", "user-speaking", false)).toBe("user-speaking");
    expect(orbMode("live", "model-speaking", false)).toBe("speaking");
    expect(orbMode("live", "thinking", false)).toBe("thinking");
    expect(orbMode("live", "listening", true)).toBe("muted");
    expect(orbMode("error", null, false)).toBe("error");
  });
});

describe("VoicePanel", () => {
  it("idle: offers to start, and starting calls the handler", () => {
    const h = handlers();
    render(<VoicePanel state={base} supported {...h} />);
    expect(screen.getByRole("img").getAttribute("data-mode")).toBe("idle");
    fireEvent.click(screen.getByRole("button", { name: "ابدأ المحادثة الصوتية" }));
    expect(h.onStart).toHaveBeenCalled();
  });

  it("unsupported browsers get an explanation and cannot start", () => {
    render(<VoicePanel state={base} supported={false} {...handlers()} />);
    expect((screen.getByRole("button", { name: "ابدأ المحادثة الصوتية" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toContain("لا يدعم المحادثة الصوتية");
  });

  it("connecting: shows progress and no live controls", () => {
    render(<VoicePanel state={{ ...base, phase: "connecting" }} supported {...handlers()} />);
    expect(screen.getByText("جارٍ التحضير…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "إنهاء" })).toBeNull();
  });

  it("live: mute toggles with aria-pressed, interrupt only while the model is speaking, end stops", () => {
    const h = handlers();
    const { rerender } = render(<VoicePanel state={{ ...base, phase: "live", activity: "listening" }} supported {...h} />);
    const interrupt = screen.getByRole("button", { name: "أوقف المعلّم" }) as HTMLButtonElement;
    expect(interrupt.disabled).toBe(true);
    rerender(<VoicePanel state={{ ...base, phase: "live", activity: "model-speaking" }} supported {...h} />);
    expect((screen.getByRole("button", { name: "أوقف المعلّم" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "أوقف المعلّم" }));
    expect(h.onInterrupt).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "كتم الميكروفون" }));
    expect(h.onMute).toHaveBeenCalledWith(true);
    rerender(<VoicePanel state={{ ...base, phase: "live", activity: "listening", muted: true }} supported {...h} />);
    expect(screen.getByRole("button", { name: "إلغاء الكتم" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "إنهاء" }));
    expect(h.onStop).toHaveBeenCalled();
  });

  it("reconnecting: announces the attempt", () => {
    render(<VoicePanel state={{ ...base, phase: "reconnecting", reconnectAttempt: 2 }} supported {...handlers()} />);
    expect(screen.getByRole("status").textContent).toContain("إعادة المحاولة (2)");
  });

  it("error: shows the actionable message and a restart button", () => {
    render(<VoicePanel state={{ ...base, phase: "error", error: { code: "mic-denied" } }} supported {...handlers()} />);
    expect(screen.getByRole("alert").textContent).toContain("رفض إذن الميكروفون");
    expect(screen.getByRole("button", { name: "إعادة بدء المحادثة الصوتية" })).toBeTruthy();
  });
});

describe("mergeVoiceTranscript", () => {
  it("appends new entries, updates streaming ones in place, keeps text messages", () => {
    const prev: ChatMessage[] = [{ id: "t1", role: "student", text: "typed", via: "text" }];
    let m = mergeVoiceTranscript(prev, [{ id: "u-1", role: "user", text: "سؤال", final: true }, { id: "a-1", role: "assistant", text: "الفا", final: false }]);
    expect(m.map((x) => x.id)).toEqual(["t1", "u-1", "a-1"]);
    m = mergeVoiceTranscript(m, [{ id: "a-1", role: "assistant", text: "الفاعل اسم", final: true, interrupted: true }]);
    expect(m).toHaveLength(3);
    expect(m[2]).toMatchObject({ role: "tutor-text", text: "الفاعل اسم", final: true, interrupted: true });
  });
});

// ── Workspace ↔ voice integration (voice hook mocked; everything else real) ──
const voiceMock = vi.hoisted(() => ({
  state: { phase: "idle", activity: null, muted: false, error: null, warning: null, reconnectAttempt: 0, transcript: [] } as unknown,
  start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), setMuted: vi.fn(), interrupt: vi.fn(), sendText: vi.fn(), pushContext: vi.fn(() => true),
}));
vi.mock("@/components/tutor/useVoiceSession", () => ({
  supportsVoice: () => true,
  useVoiceSession: () => voiceMock,
}));
import { TutorWorkspace } from "@/components/tutor/TutorWorkspace";

const books: BookOption[] = [{ versionId: "v1", title: "لغتي", lessons: [{ id: "l1", title: "الدرس الأول", unit: null, startPage: 2, endPage: 3 }] }];

describe("TutorWorkspace voice integration", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    window.HTMLElement.prototype.scrollTo = vi.fn();
    Object.values(voiceMock).forEach((v) => typeof v === "function" && "mockClear" in v && (v as ReturnType<typeof vi.fn>).mockClear());
    voiceMock.state = { phase: "idle", activity: null, muted: false, error: null, warning: null, reconnectAttempt: 0, transcript: [] };
    fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/sessions") return new Response(JSON.stringify({ session: { id: "s1" } }), { status: 201 });
      if (url === "/api/vision/confirm") {
        return new Response(JSON.stringify({ confirmed: true, context: { pageNumber: 4, printedLabel: "4", lessonId: "l1", lessonTitle: "الدرس الأول", bookTitle: "لغتي", objectives: [] }, contextMessage: "تحديث سياق: الصفحة 4" }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starting voice uses the voice hook", () => {
    render(<TutorWorkspace books={books} />);
    fireEvent.click(screen.getByRole("button", { name: "ابدأ المحادثة الصوتية" }));
    expect(voiceMock.start).toHaveBeenCalled();
  });

  it("typed input during a live voice session goes to the voice session, not the text endpoint", async () => {
    voiceMock.state = { ...(voiceMock.state as object), phase: "live", activity: "listening" };
    render(<TutorWorkspace books={books} />);
    fireEvent.change(screen.getByLabelText("اكتب رسالتك"), { target: { value: "ما الفاعل؟" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال" }));
    expect(voiceMock.sendText).toHaveBeenCalledWith("ما الفاعل؟");
    expect(fetchMock.mock.calls.some((c) => c[0] === "/api/tutor/chat")).toBe(false);
  });

  it("confirming a page while voice is live pushes the validated page context into the voice session", async () => {
    voiceMock.state = { ...(voiceMock.state as object), phase: "live", activity: "listening" };
    render(<TutorWorkspace books={books} />);
    fireEvent.change(screen.getByLabelText("أو اكتب رقم الصفحة"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "اعتمد" }));
    await waitFor(() => expect(voiceMock.pushContext).toHaveBeenCalledWith("تحديث سياق: الصفحة 4"));
    expect(screen.getByText("✓ صفحة مؤكَّدة")).toBeTruthy();
  });

  it("switching mode during a live session updates the server session and tells the voice tutor (silently)", async () => {
    voiceMock.state = { ...(voiceMock.state as object), phase: "live", activity: "listening" };
    render(<TutorWorkspace books={books} />);
    // create the session first via a page confirmation
    fireEvent.change(screen.getByLabelText("أو اكتب رقم الصفحة"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "اعتمد" }));
    await waitFor(() => expect(screen.getByText("✓ صفحة مؤكَّدة")).toBeTruthy());
    voiceMock.pushContext.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "تقييم" }));
    await waitFor(() => expect(voiceMock.pushContext).toHaveBeenCalled());
    const [msg, opts] = voiceMock.pushContext.mock.calls[0] as unknown as [string, { speak: boolean }];
    expect(msg).toContain("وضع «التقييم»");
    expect(opts).toEqual({ speak: false });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/sessions/s1") && (c[1] as RequestInit).method === "PATCH")).toBe(true);
  });
});
