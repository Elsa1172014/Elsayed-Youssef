import { describe, expect, it } from "vitest";
import { assessGrounding, pageLabel, type Passage } from "@/lib/retrieval/grounding";
import { expandQueryTokens, lexicalQueryText } from "@/lib/retrieval/lexical";
import { searchTextbook } from "@/lib/retrieval/search";
import { FakeEmbeddings } from "../helpers/fakes";

const passage = (o: Partial<Passage> = {}): Passage => ({
  chunkId: "c1", lessonId: "l1", lessonTitle: "الدرس الأول", pageStart: 2, pageEnd: 3, content: "x",
  vectorSimilarity: 0, lexicalScore: 0, fusedScore: 0.01, ...o,
});

describe("assessGrounding", () => {
  it("none when nothing was retrieved", () => expect(assessGrounding([]).level).toBe("none"));
  it("none when similarity is below the floor and no lexical hit", () =>
    expect(assessGrounding([passage({ vectorSimilarity: 0.1 })]).level).toBe("none"));
  it("strong on high similarity", () => expect(assessGrounding([passage({ vectorSimilarity: 0.6 })]).level).toBe("strong"));
  it("lexical corroboration lifts a borderline vector match to strong", () =>
    expect(assessGrounding([passage({ vectorSimilarity: 0.3, lexicalScore: 0.2 })]).level).toBe("strong"));
  it("weak when only borderline similarity", () => expect(assessGrounding([passage({ vectorSimilarity: 0.3 })]).level).toBe("weak"));
  it("weak when only lexical match with poor vector similarity", () =>
    expect(assessGrounding([passage({ vectorSimilarity: 0.1, lexicalScore: 0.3 })]).level).toBe("weak"));
  it("uses the BEST passage, not the first", () =>
    expect(assessGrounding([passage({ vectorSimilarity: 0.05 }), passage({ vectorSimilarity: 0.7 })]).level).toBe("strong"));
});

describe("pageLabel", () => {
  it("formats Arabic-Indic digits and ranges", () => {
    expect(pageLabel(2, 2)).toBe("ص ٢");
    expect(pageLabel(12, 14)).toBe("ص ١٢–١٤");
  });
});

describe("query expansion", () => {
  it("drops stopwords and adds al-/prefix variants", () => {
    const t = expandQueryTokens("ما هو الفاعل؟");
    expect(t).toContain("الفاعل");
    expect(t).toContain("فاعل");
    expect(t).not.toContain("ما");
    expect(t).not.toContain("هو");
  });
  it("adds the definite form for bare nouns and strips conjunction+article", () => {
    expect(expandQueryTokens("فاعل")).toContain("الفاعل");
    expect(expandQueryTokens("والمفعول")).toEqual(expect.arrayContaining(["والمفعول", "المفعول", "مفعول"]));
  });
  it("is empty for stopword-only queries", () => expect(lexicalQueryText("ما هو هذا")).toBe(""));
});

describe("searchTextbook", () => {
  const rows = [{ chunk_id: "c1", lesson_id: "l1", lesson_title: "ت", page_start: 2, page_end: 2, content: "نص", vector_similarity: 0.55, lexical_score: 0.1, fused_score: 0.03 }];
  it("embeds the query, passes normalised lexical text, and maps rows", async () => {
    const calls: Record<string, unknown>[] = [];
    const db = { rpc: async (_n: string, a: Record<string, unknown>) => (calls.push(a), { data: rows, error: null }) };
    const emb = new FakeEmbeddings();
    const r = await searchTextbook({ db, embeddings: emb }, { query: "  ما هو الفاعل؟ ", versionId: "v1", limit: 99 });
    expect(r.passages[0]).toMatchObject({ chunkId: "c1", pageStart: 2, vectorSimilarity: 0.55 });
    expect(r.grounding.level).toBe("strong");
    expect(calls[0]).toMatchObject({ p_book_version_id: "v1", p_lesson_id: null, p_limit: 12 });
    expect(String(calls[0]!.p_query_text)).toContain("فاعل");
    expect(String(calls[0]!.p_query_embedding).startsWith("[")).toBe(true);
    expect(emb.calls).toBe(1);
  });
  it("skips the provider for an empty query", async () => {
    const emb = new FakeEmbeddings();
    const r = await searchTextbook({ db: { rpc: async () => ({ data: [], error: null }) }, embeddings: emb }, { query: "   ", versionId: "v" });
    expect(r.grounding.level).toBe("none");
    expect(emb.calls).toBe(0);
  });
  it("surfaces database errors", async () => {
    const db = { rpc: async () => ({ data: null, error: { message: "boom" } }) };
    await expect(searchTextbook({ db, embeddings: new FakeEmbeddings() }, { query: "الفاعل", versionId: "v" })).rejects.toThrow(/boom/);
  });
});
