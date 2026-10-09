# Setup, deployment and verification runbook

Nothing below has been run against live Supabase / OpenAI / Vercel accounts by the author of this code (no credentials were available). Every step that depends on them is marked **[verify]** — do those first, in order, and record results in `acceptance-tests.md`.

## 1. Supabase
1. Create a project (choose a region close to the school). Enable the `vector` extension (Database → Extensions) — the first migration also does `create extension`.
2. Apply migrations in order from `supabase/migrations/` (`supabase db push` or paste into the SQL editor): `0001_schema` → `0002_functions` → `0003_rls` → `0004_storage`. **[verify]** that `storage.buckets` now has private `textbooks` and `page-images`. Free-plan object limit is 50 MB per file; large textbooks need Pro or a split PDF.
3. Auth → disable public sign-ups (accounts are school-provisioned) and set the Site URL to your Vercel URL.
4. Create the **first admin**: sign up one user in the dashboard (Auth → Users → Add user), then in SQL: `update public.profiles set role='admin', display_name='…' where id='<user uuid>';` (role escalation is intentionally impossible from the app). Further accounts are created at `/admin/users`.
5. Keys: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public), `SUPABASE_SERVICE_ROLE_KEY` (server only). The worker also needs `DATABASE_URL` (Settings → Database → connection string; use the direct or session-pooler string, **not** the transaction pooler, because the queue uses advisory/`SKIP LOCKED` queries from a long-lived process).

## 2. Environment
Copy `.env.example`; set variables in Vercel (Project → Settings → Environment Variables) and on the worker host. Never commit `.env*`. Model ids in `.env.example` are configuration — **[verify]** they exist on your OpenAI account.

## 3. Vercel (web app)
* Import the GitHub repo; **Root Directory = `almuallim`**; framework Next.js (`vercel.json` adds the daily retention cron).
* Set all server env vars incl. `CRON_SECRET` (≥16 chars) so Vercel Cron can authenticate to `/api/cron/purge`.
* Camera/microphone require HTTPS (Vercel provides it). `Permissions-Policy` already allows camera/mic for the app origin only.
* **[verify]** after deploy: `/login` loads; `/api/admin/versions` returns 401 when signed out (503 means env vars missing).

## 4. Ingestion worker (separate, durable)
The worker is a normal long-lived Node process (it is **not** a Vercel function: PDF ingestion can run many minutes).
```
docker build -f worker/Dockerfile -t almuallim-worker almuallim/
docker run -d --restart=always --env-file worker.env almuallim-worker
```
`worker.env`: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, optional `INGEST_OCR=1`, `EMBEDDING_MODEL`, `VISION_MODEL`. Any container host works (Fly.io, Railway, Render, ECS). Run ≥2 replicas for availability: leases + `SKIP LOCKED` make that safe, and a crashed replica's job resumes on another after the lease (120 s) expires. Logs are JSON lines.

## 5. First textbook (end-to-end acceptance, **[verify]**)
1. Sign in as admin → `/admin/books` → upload a **licensed** PDF with the licence attestation. Watch status move to *ready*; read the warnings (scanned pages, visual-order repair, lessons not detected).
2. Spot-check 5 pages: compare stored text with the printed page; check lesson boundaries in the DB (`lessons`). A teacher should fill/verify `learning_objectives` (they are never invented).
3. As a student: choose the book/lesson; ask a question (text); confirm the citation page is right; point the camera at a page and confirm the match; start voice and ask the same question aloud; interrupt the tutor mid-sentence.
4. Calibrate: collect ~30 (question → correct page) and ~30 photo→page pairs, then tune `DEFAULT_THRESHOLDS` (`src/lib/retrieval/grounding.ts`) and `MATCH_THRESHOLDS` (`src/lib/vision/page-match.ts`) and the stability thresholds (`src/lib/vision/stability.ts`).

## 6. Local development
```
npm install
npm run typecheck && npm test               # unit tests (no network, no credentials)
scripts/test-db-cluster.sh start && npm run test:db   # RLS/queue/search on real PostgreSQL+pgvector
npm run build && npm run check:bundle        # also scans the client bundle for secrets
node scripts/make-fixture-pdf.mjs            # regenerates the Arabic test PDFs (needs Chromium)
npm run dev
```
Without Supabase variables the app runs in a safe "not configured" mode: public pages render, protected pages redirect to `/login?error=config`, APIs answer 503.

## 7. Known limitations (honest list)
* **No live provider test has been run** — OpenAI client-secret + WebRTC SDP endpoints, realtime Arabic quality, barge-in on real audio, vision OCR accuracy, embeddings quality, Supabase Storage signed uploads, the worker process end to end.
* Thresholds (grounding, page matching, stability) are uncalibrated defaults.
* PDF extraction was tested on Chromium-generated Arabic PDFs only. Publisher PDFs (InDesign, scanned, visual-order, embedded fonts without ToUnicode) vary; the pipeline reports quality warnings and supports OCR for scanned pages, but each real book needs a QA pass.
* Lesson detection uses outline → headings → whole document; mid-page lesson starts are assigned by start page.
* The answer-leak guard relies on the model's self-declared flag; the safeguarding detector is keyword-based (false negatives possible). Neither replaces school procedures.
* Not implemented: streaming tutor text, native app, multi-school tenancy, SSO, per-school branding, offline mode, automated data-subject request tickets, guardian portal.
