// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraPanel } from "@/components/tutor/CameraPanel";
import { LessonCard } from "@/components/tutor/LessonCard";
import type { RecognitionResult } from "@/lib/vision/client-types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const noop = () => undefined;
const props = { confirmed: null, busy: false, onConfirm: noop, onReject: noop, onChange: noop };
const cand = (pageNumber: number, score: number) => ({ pageNumber, printedLabel: String(pageNumber), lessonTitle: "الدرس الثاني", score, printedNumberMatch: false });

describe("LessonCard", () => {
  it("confident: shows confidence and requires an explicit confirmation", () => {
    const onConfirm = vi.fn();
    const rec: RecognitionResult = { status: "matched", decision: "confident", confidence: 0.83, reason: "ok", candidates: [cand(4, 0.83)] };
    render(<LessonCard {...props} recognition={rec} onConfirm={onConfirm} />);
    expect(screen.getByText(/ثقة عالية/)).toBeTruthy();
    expect(screen.getByText(/هل هذه صفحة ٤/)).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled(); // nothing is auto-confirmed
    fireEvent.click(screen.getByRole("button", { name: "نعم، هذه هي" }));
    expect(onConfirm).toHaveBeenCalledWith(4, "camera");
  });

  it("ambiguous: lists candidates, disables confirm until one is chosen", () => {
    const onConfirm = vi.fn();
    const rec: RecognitionResult = { status: "matched", decision: "ambiguous", confidence: 0.6, reason: "close_runner_up", candidates: [cand(4, 0.6), cand(5, 0.58)] };
    render(<LessonCard {...props} recognition={rec} onConfirm={onConfirm} />);
    const confirmBtn = screen.getByRole("button", { name: "أكّد الصفحة" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(screen.getByText(/لست متأكدًا/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith(5, "camera");
  });

  it("none / no_page: says it did not recognise and offers manual page entry", () => {
    const onConfirm = vi.fn();
    render(<LessonCard {...props} recognition={{ status: "no_page" }} onConfirm={onConfirm} />);
    expect(screen.getByText("لم أتعرّف على الصفحة")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("أو اكتب رقم الصفحة"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "اعتمد" }));
    expect(onConfirm).toHaveBeenCalledWith(12, "manual");
  });

  it("confirmed: shows book, lesson, page and objectives; allows changing", () => {
    const onChange = vi.fn();
    render(<LessonCard {...props} recognition={null} onChange={onChange} confirmed={{ pageNumber: 4, printedLabel: "4", lessonId: "l", lessonTitle: "الدرس الثاني: المفعول به", bookTitle: "لغتي", objectives: ["أن يعرب المفعول به"] }} onExplain={noop} />);
    expect(screen.getByText("الدرس الثاني: المفعول به")).toBeTruthy();
    expect(screen.getByText("أن يعرب المفعول به")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "تغيير الصفحة" }));
    expect(onChange).toHaveBeenCalled();
  });

  it("idle state is honest that images are only sent at capture time", () => {
    render(<LessonCard {...props} recognition={null} />);
    expect(screen.getByText(/لا تُرسَل صور إلا لحظة الالتقاط/)).toBeTruthy();
  });
});

describe("CameraPanel permission handling", () => {
  beforeEach(() => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  });
  const stubMedia = (impl: () => Promise<MediaStream>) =>
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn(impl) }, configurable: true });

  it("shows an actionable Arabic message when permission is denied, and allows retry", async () => {
    stubMedia(async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); });
    render(<CameraPanel onCapture={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "تشغيل الكاميرا" }));
    await waitFor(() => expect(screen.getByText(/تم رفض إذن الكاميرا/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeTruthy();
  });

  it("reports a missing camera and an in-use camera distinctly", async () => {
    stubMedia(async () => { throw Object.assign(new Error("x"), { name: "NotFoundError" }); });
    const { unmount } = render(<CameraPanel onCapture={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "تشغيل الكاميرا" }));
    await waitFor(() => expect(screen.getByText(/لم يتم العثور على كاميرا/)).toBeTruthy());
    unmount();
    stubMedia(async () => { throw Object.assign(new Error("x"), { name: "NotReadableError" }); });
    render(<CameraPanel onCapture={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "تشغيل الكاميرا" }));
    await waitFor(() => expect(screen.getByText(/مستخدمة في تطبيق آخر/)).toBeTruthy());
  });

  it("explains that HTTPS is required in an insecure context without prompting", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    stubMedia(async () => ({}) as MediaStream);
    render(<CameraPanel onCapture={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "تشغيل الكاميرا" }));
    await waitFor(() => expect(screen.getByText(/عبر اتصال آمن/)).toBeTruthy());
    expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("starts the preview, shows the live state, and releases the camera on stop", async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    stubMedia(async () => stream);
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    render(<CameraPanel onCapture={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "تشغيل الكاميرا" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "التقط الآن" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "إيقاف" }));
    expect(stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "تشغيل الكاميرا" })).toBeTruthy();
  });
});
