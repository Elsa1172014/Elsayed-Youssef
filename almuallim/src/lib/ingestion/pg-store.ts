import { toVectorLiteral } from "@/lib/providers/embeddings";
import { buildEmbedText } from "./chunk";
import type { LessonDraft } from "./lessons";
import type { ChunkRow, IngestionStore, PageRow, VersionInfo } from "./ports";

/** Anything with pg's `query` (Pool, Client, PoolClient). */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export function createPgIngestionStore(db: Queryable): IngestionStore {
  return {
    async getVersion(versionId): Promise<VersionInfo> {
      const r = await db.query<{ id: string; book_id: string; title: string; storage_path: string; file_sha256: string }>(
        `select v.id, v.book_id, b.title, v.storage_path, v.file_sha256
           from book_versions v join books b on b.id = v.book_id where v.id = $1`,
        [versionId],
      );
      const row = r.rows[0];
      if (!row) throw new Error(`book version ${versionId} not found`);
      return { id: row.id, bookId: row.book_id, bookTitle: row.title, storagePath: row.storage_path, fileSha256: row.file_sha256 };
    },

    async setPageCount(versionId, n) {
      await db.query("update book_versions set page_count = $2 where id = $1", [versionId, n]);
    },

    async upsertPages(versionId, rows: PageRow[]) {
      if (!rows.length) return;
      await db.query(
        `insert into book_pages (book_version_id, page_number, printed_label, text, text_normalized, has_text, text_source, content_hash)
         select $1, t.* from unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::bool[], $7::text[], $8::text[])
           as t(page_number, printed_label, text, text_normalized, has_text, text_source, content_hash)
         on conflict (book_version_id, page_number) do update set
           printed_label = excluded.printed_label, text = excluded.text, text_normalized = excluded.text_normalized,
           has_text = excluded.has_text, text_source = excluded.text_source, content_hash = excluded.content_hash,
           embedding = case when book_pages.content_hash = excluded.content_hash then book_pages.embedding else null end`,
        [
          versionId,
          rows.map((r) => r.pageNumber),
          rows.map((r) => r.printedLabel),
          rows.map((r) => r.text),
          rows.map((r) => r.textNormalized),
          rows.map((r) => r.hasText),
          rows.map((r) => r.textSource),
          rows.map((r) => r.contentHash),
        ],
      );
    },

    async pagesMissingImages(versionId) {
      const r = await db.query<{ page_number: number }>(
        "select page_number from book_pages where book_version_id = $1 and image_path is null order by page_number",
        [versionId],
      );
      return r.rows.map((x) => x.page_number);
    },

    async setPageImage(versionId, pageNumber, path) {
      await db.query("update book_pages set image_path = $3 where book_version_id = $1 and page_number = $2", [versionId, pageNumber, path]);
    },

    async pagesNeedingEmbedding(versionId, limit) {
      const r = await db.query<{ page_number: number; text: string }>(
        `select page_number, text from book_pages
          where book_version_id = $1 and has_text and embedding is null order by page_number limit $2`,
        [versionId, limit],
      );
      return r.rows.map((x) => ({ pageNumber: x.page_number, text: x.text }));
    },

    async setPageEmbeddings(versionId, rows) {
      if (!rows.length) return;
      await db.query(
        `update book_pages p set embedding = v.e::vector
           from unnest($2::int[], $3::text[]) as v(n, e)
          where p.book_version_id = $1 and p.page_number = v.n`,
        [versionId, rows.map((r) => r.pageNumber), rows.map((r) => toVectorLiteral(r.vector))],
      );
    },

    async syncLessons(versionId, drafts: LessonDraft[]) {
      const ids = new Map<number, string>();
      for (const d of drafts) {
        const r = await db.query<{ id: string }>(
          `insert into lessons (book_version_id, ordinal, title, unit_title, start_page, end_page, detection_method)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (book_version_id, ordinal) do update set
             title = excluded.title, unit_title = excluded.unit_title, start_page = excluded.start_page,
             end_page = excluded.end_page, detection_method = excluded.detection_method
           returning id`,
          [versionId, d.ordinal, d.title, d.unitTitle, d.startPage, d.endPage, d.method === "heading" || d.method === "outline" ? d.method : "whole_document"],
        );
        ids.set(d.ordinal, r.rows[0]!.id);
      }
      await db.query("delete from lessons where book_version_id = $1 and ordinal >= $2", [versionId, drafts.length]);
      return ids;
    },

    async syncChunks(versionId, rows: ChunkRow[]) {
      for (let i = 0; i < rows.length; i += 50) {
        const part = rows.slice(i, i + 50);
        await db.query(
          `insert into content_chunks
             (book_version_id, lesson_id, ordinal, page_start, page_end, content, content_normalized, token_estimate, content_hash)
           select $1, t.* from unnest($2::uuid[], $3::int[], $4::int[], $5::int[], $6::text[], $7::text[], $8::int[], $9::text[])
             as t(lesson_id, ordinal, page_start, page_end, content, content_normalized, token_estimate, content_hash)
           on conflict (book_version_id, ordinal) do update set
             lesson_id = excluded.lesson_id, page_start = excluded.page_start, page_end = excluded.page_end,
             content = excluded.content, content_normalized = excluded.content_normalized,
             token_estimate = excluded.token_estimate,
             embedding = case when content_chunks.content_hash = excluded.content_hash then content_chunks.embedding else null end,
             content_hash = excluded.content_hash`,
          [
            versionId,
            part.map((r) => r.lessonId),
            part.map((r) => r.ordinal),
            part.map((r) => r.pageStart),
            part.map((r) => r.pageEnd),
            part.map((r) => r.content),
            part.map((r) => r.contentNormalized),
            part.map((r) => r.tokenEstimate),
            part.map((r) => r.contentHash),
          ],
        );
      }
      await db.query("delete from content_chunks where book_version_id = $1 and ordinal >= $2", [versionId, rows.length]);
    },

    async chunksNeedingEmbedding(versionId, limit) {
      const r = await db.query<{ id: string; content: string; title: string | null }>(
        `select c.id, c.content, l.title from content_chunks c left join lessons l on l.id = c.lesson_id
          where c.book_version_id = $1 and c.embedding is null order by c.ordinal limit $2`,
        [versionId, limit],
      );
      return r.rows.map((x) => ({ id: x.id, embedText: buildEmbedText(x.title, x.content) }));
    },

    async setChunkEmbeddings(rows) {
      if (!rows.length) return;
      await db.query(
        `update content_chunks c set embedding = v.e::vector
           from unnest($1::uuid[], $2::text[]) as v(id, e) where c.id = v.id`,
        [rows.map((r) => r.id), rows.map((r) => toVectorLiteral(r.vector))],
      );
    },

    async recordUsage(userId, kind, amount) {
      await db.query("insert into usage_ledger (user_id, kind, amount) values ($1, $2, $3)", [userId, kind, amount]);
    },
  };
}
