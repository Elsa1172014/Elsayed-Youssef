/**
 * Minimal MPEG-TS demuxer: pulls the first supported audio elementary stream out of an HLS .ts segment, so a few
 * seconds of a channel's sound can be transcribed server-side (works on iPhone, and for streams that block browser
 * audio capture). Supported: AAC in ADTS (stream_type 0x0F) → audio/aac, MPEG-1/2 audio (0x03/0x04) → audio/mpeg.
 * Encrypted (scrambled) packets are never decoded: they are skipped.
 */
export interface ExtractedAudio { data: Buffer; mime: "audio/aac" | "audio/mpeg" }

const PACKET = 188;
const AUDIO_TYPES: Record<number, ExtractedAudio["mime"]> = { 0x0f: "audio/aac", 0x03: "audio/mpeg", 0x04: "audio/mpeg" };

function payloadOf(pkt: Buffer): { pid: number; start: boolean; scrambled: boolean; payload?: Buffer } {
  const pid = ((pkt[1]! & 0x1f) << 8) | pkt[2]!;
  const start = (pkt[1]! & 0x40) !== 0;
  const scrambled = (pkt[3]! & 0xc0) !== 0;
  const afc = (pkt[3]! >> 4) & 0x03;
  if (afc === 0 || afc === 2) return { pid, start, scrambled };
  const offset = afc === 3 ? 5 + pkt[4]! : 4;
  return { pid, start, scrambled, payload: offset < PACKET ? pkt.subarray(offset) : undefined };
}

/** PSI section (PAT/PMT): skip the pointer field. */
const section = (p: Buffer) => p.subarray(1 + p[0]!);

export function extractTsAudio(ts: Buffer): ExtractedAudio | undefined {
  let start = ts.indexOf(0x47);
  while (start >= 0 && start + PACKET < ts.length && ts[start + PACKET] !== 0x47) start = ts.indexOf(0x47, start + 1);
  if (start < 0) return undefined;
  let pmtPid = -1;
  let audioPid = -1;
  let mime: ExtractedAudio["mime"] | undefined;
  const chunks: Buffer[] = [];
  let collecting = false;

  for (let i = start; i + PACKET <= ts.length; i += PACKET) {
    const pkt = ts.subarray(i, i + PACKET);
    if (pkt[0] !== 0x47) continue;
    const { pid, start: pusi, scrambled, payload } = payloadOf(pkt);
    if (!payload) continue;
    if (pid === 0 && pusi && pmtPid < 0) {
      const s = section(payload); // PAT
      const len = ((s[1]! & 0x0f) << 8) | s[2]!;
      for (let j = 8; j + 4 <= 3 + len - 4; j += 4) {
        const program = (s[j]! << 8) | s[j + 1]!;
        if (program !== 0) { pmtPid = ((s[j + 2]! & 0x1f) << 8) | s[j + 3]!; break; }
      }
    } else if (pid === pmtPid && pusi && audioPid < 0) {
      const s = section(payload); // PMT
      const len = ((s[1]! & 0x0f) << 8) | s[2]!;
      const infoLen = ((s[10]! & 0x0f) << 8) | s[11]!;
      for (let j = 12 + infoLen; j + 5 <= 3 + len - 4; ) {
        const type = s[j]!;
        const epid = ((s[j + 1]! & 0x1f) << 8) | s[j + 2]!;
        const esInfo = ((s[j + 3]! & 0x0f) << 8) | s[j + 4]!;
        if (AUDIO_TYPES[type]) { audioPid = epid; mime = AUDIO_TYPES[type]; break; }
        j += 5 + esInfo;
      }
    } else if (pid === audioPid && !scrambled) {
      if (pusi) {
        // PES header: 00 00 01 | stream_id | length(2) | flags(2) | header_data_length | …
        if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) { collecting = false; continue; }
        const headerLen = 9 + payload[8]!;
        if (headerLen < payload.length) chunks.push(payload.subarray(headerLen));
        collecting = true;
      } else if (collecting) chunks.push(payload);
    }
  }
  if (!mime || !chunks.length) return undefined;
  const data = Buffer.concat(chunks);
  return data.length > 512 ? { data, mime } : undefined;
}
