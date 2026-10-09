/** Camera permission/availability modelling. Everything here takes injectable dependencies so it is unit-testable. */

export type CameraStatus =
  | "idle"
  | "requesting"
  | "live"
  | "denied"       // user or policy blocked camera access
  | "no-device"
  | "in-use"       // another app holds the camera
  | "insecure"     // page not served over HTTPS (getUserMedia unavailable)
  | "unsupported"
  | "error";

export const CAMERA_MESSAGE_AR: Record<Exclude<CameraStatus, "idle" | "requesting" | "live">, string> = {
  denied: "تم رفض إذن الكاميرا. فعّله من إعدادات المتصفح (رمز القفل بجانب العنوان) ثم أعد المحاولة، أو اكتب رقم الصفحة يدويًا.",
  "no-device": "لم يتم العثور على كاميرا في هذا الجهاز. يمكنك كتابة رقم الصفحة أو اسم الدرس.",
  "in-use": "الكاميرا مستخدمة في تطبيق آخر. أغلقه ثم أعد المحاولة.",
  insecure: "الكاميرا تعمل فقط عبر اتصال آمن (HTTPS).",
  unsupported: "هذا المتصفح لا يدعم الكاميرا. استخدم متصفحًا حديثًا أو اكتب رقم الصفحة.",
  error: "تعذّر تشغيل الكاميرا. حاول مرة أخرى.",
};

export function classifyCameraError(err: unknown): Exclude<CameraStatus, "idle" | "requesting" | "live"> {
  const name = (err as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "no-device";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "in-use";
    case "SecurityError":
      return "insecure";
    case "TypeError":
      return "unsupported";
    default:
      return "error";
  }
}

export interface MediaDevicesLike {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
}

export type OpenResult = { ok: true; stream: MediaStream } | { ok: false; status: Exclude<CameraStatus, "idle" | "requesting" | "live"> };

/** Open the rear camera at a useful resolution, relaxing constraints once if the device can't satisfy them. */
export async function openCamera(md: MediaDevicesLike | undefined, secureContext: boolean): Promise<OpenResult> {
  if (!secureContext) return { ok: false, status: "insecure" };
  if (!md?.getUserMedia) return { ok: false, status: "unsupported" };
  const ideal: MediaStreamConstraints = { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
  try {
    return { ok: true, stream: await md.getUserMedia(ideal) };
  } catch (e) {
    if ((e as { name?: string }).name === "OverconstrainedError") {
      try {
        return { ok: true, stream: await md.getUserMedia({ audio: false, video: true }) };
      } catch (e2) {
        return { ok: false, status: classifyCameraError(e2) };
      }
    }
    return { ok: false, status: classifyCameraError(e) };
  }
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Sniff the real image type from magic bytes (never trust the client's declared type). */
export function sniffImageType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}
