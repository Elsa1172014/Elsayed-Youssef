import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createPopplerPageImages, hasPdftoppm } from "@/lib/ingestion/adapters";
import { readFixture } from "../helpers/fakes";

function fakeSupabase() {
  const uploads: { bucket: string; path: string; size: number }[] = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: Uint8Array) => {
          uploads.push({ bucket, path, size: body.length });
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  return { client, uploads };
}

describe("poppler page image renderer", async () => {
  const available = await hasPdftoppm();
  it.skipIf(!available)("renders a real PDF page to PNG and stores it under <version>/<page>.png", async () => {
    const { client, uploads } = fakeSupabase();
    const images = createPopplerPageImages(client, 60);
    const png = await images.render(readFixture("sample-textbook.pdf"), 2);
    expect(png).not.toBeNull();
    expect([...png!.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
    const path = await images.put("ver-1", 2, png!);
    expect(path).toBe("ver-1/0002.png");
    expect(uploads).toEqual([{ bucket: "page-images", path: "ver-1/0002.png", size: png!.length }]);
    await images.dispose();
  });
});
