import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PageRecognizer } from "@/lib/providers/vision";
import type { PageImages, PageOcr, PdfSource } from "./ports";

const run = promisify(execFile);

/** Downloads the uploaded PDF from the private `textbooks` bucket (service-role client). */
export function createSupabasePdfSource(supabase: SupabaseClient): PdfSource {
  return {
    async download(storagePath) {
      const { data, error } = await supabase.storage.from("textbooks").download(storagePath);
      if (error || !data) throw new Error(`storage download failed: ${error?.message ?? "no data"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}

export async function hasPdftoppm(): Promise<boolean> {
  try {
    await run("pdftoppm", ["-v"]);
    return true;
  } catch (e) {
    // poppler prints its version to stderr and exits 0 or 99 depending on build; ENOENT is the real "missing"
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Renders pages with poppler's pdftoppm; uploads to the private `page-images` bucket. */
export function createPopplerPageImages(supabase: SupabaseClient, dpi: number): PageImages & { dispose(): Promise<void> } {
  let dir: string | undefined;
  let lastBytes: Uint8Array | undefined;
  let available: boolean | undefined;
  return {
    async render(pdf, pageNumber) {
      available ??= await hasPdftoppm();
      if (!available) return null;
      dir ??= await mkdtemp(join(tmpdir(), "almuallim-"));
      const pdfPath = join(dir, "in.pdf");
      if (lastBytes !== pdf) {
        await writeFile(pdfPath, pdf);
        lastBytes = pdf;
      }
      const outBase = join(dir, `p${pageNumber}`);
      await run("pdftoppm", ["-f", String(pageNumber), "-l", String(pageNumber), "-r", String(dpi), "-png", "-singlefile", pdfPath, outBase], {
        timeout: 60_000,
      });
      const png = await readFile(`${outBase}.png`);
      await rm(`${outBase}.png`, { force: true });
      return new Uint8Array(png);
    },
    async put(versionId, pageNumber, png) {
      const path = `${versionId}/${String(pageNumber).padStart(4, "0")}.png`;
      const { error } = await supabase.storage.from("page-images").upload(path, png, { contentType: "image/png", upsert: true });
      if (error) throw new Error(`page image upload failed: ${error.message}`);
      return path;
    },
    async dispose() {
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = undefined;
    },
  };
}

/** OCR for pages without a text layer, via the vision provider adapter. */
export function createVisionOcr(recognizer: PageRecognizer): PageOcr {
  return {
    async transcribe(png) {
      const { result } = await recognizer.transcribe(png, "image/png");
      return { text: result.containsPageOfBook ? result.text : "" };
    },
  };
}
