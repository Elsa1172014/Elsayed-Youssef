# Handoff prompt — give this file + the zip to another AI agent (e.g. ChatGPT with code/deploy access)

## Goal
Deploy and verify "Al-Muallim Al-Arabi AI" (folder `almuallim/`, Next.js 16 + Supabase + OpenAI/Gemini). Read `README.md`, `docs/SETUP.md`, `docs/architecture.md`, `docs/acceptance-tests.md` first.

## Rules
- Never commit or print secrets. Put them only in Vercel / worker env vars.
- Do not scrape/download copyrighted textbooks. The school's admin uploads licensed PDFs via `/admin/books`.
- Do not claim anything works without running it. Record real results in `docs/acceptance-tests.md`.
- Student data of minors: do not use free-tier AI plans that train on inputs with real students.

## Steps
1. `cd almuallim && npm install && npm run typecheck && npm test` (expect all green). `npm run build`.
2. Supabase: create project, enable `vector`, apply `supabase/migrations/0001..0004` in order, disable public sign-ups, make first admin via SQL in `docs/SETUP.md` §1.
3. Vercel: Root Directory = `almuallim`; set env vars from `.env.example` (incl. CRON_SECRET). Deploy. Check `/login` loads and `/api/admin/versions` returns 401 when signed out.
4. Worker: build `worker/Dockerfile`, run on a container host with `DATABASE_URL`, Supabase URL + service key, AI key.
5. Provider: code currently uses OpenAI (text, vision, embeddings, realtime voice). To use Gemini, add an AI SDK Google provider in `src/lib/providers/models.ts`, `embeddings.ts` (output dimension must be 1536) and `vision.ts`; voice needs a new transport (Gemini Live). Re-embed books after changing embedding model.
6. Admin uploads the first licensed PDF at `/admin/books`; follow `docs/SETUP.md` §5 to verify and calibrate.
7. Report: what passed, what failed, exact errors.
