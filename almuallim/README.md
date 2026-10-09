# المعلّم العربي الذكي — Al-Muallim Al-Arabi AI

Arabic-first, camera-aware, voice-capable tutor that teaches **from the school's uploaded textbook** (Years 7–13). Next.js 16 · React 19 · TypeScript · Tailwind 4 · Supabase (Auth, Postgres + pgvector, Storage, RLS) · AI SDK 7 · OpenAI Realtime (WebRTC).

> This app lives in `almuallim/`. The repository root still contains the original, unrelated Vite *Arabic Assessment Designer*, untouched.

Start with: [`docs/architecture.md`](docs/architecture.md) · [`docs/implementation-plan.md`](docs/implementation-plan.md) (milestone status) · [`docs/acceptance-tests.md`](docs/acceptance-tests.md) (what is verified vs not) · [`docs/SETUP.md`](docs/SETUP.md) (Supabase, Vercel, worker, first-book checklist).

**Status in one line:** logic, security rules, ingestion pipeline, retrieval, tutor guards, camera/voice state machines, teacher analytics and privacy workflows are implemented and covered by automated tests (unit + real-PostgreSQL); **nothing has been exercised against live OpenAI/Supabase/Vercel yet** — see SETUP §5 for the verification checklist.
