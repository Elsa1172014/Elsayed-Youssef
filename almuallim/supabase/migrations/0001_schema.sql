-- Al-Muallim Al-Arabi AI — core schema
-- Target: Supabase (PostgreSQL 15+) with pgvector. Embedding dimension is fixed at 1536
-- (OpenAI text-embedding-3-small). Changing the embedding model to a different dimension
-- requires a new migration plus a re-embedding job.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ───────────────────────────── enums ─────────────────────────────
create type public.user_role as enum ('admin', 'teacher', 'student');
create type public.version_status as enum ('uploaded', 'processing', 'ready', 'failed', 'archived');
create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'canceled');
create type public.tutoring_mode as enum ('explain', 'socratic', 'practice', 'assessment', 'review');
create type public.challenge_level as enum ('support', 'core', 'challenge');
create type public.skill_area as enum ('grammar', 'vocabulary', 'rhetoric', 'comprehension', 'writing', 'reading_aloud');

-- ───────────────────────────── people ─────────────────────────────
-- Data minimisation: no email, phone, DOB or photo is stored here. Email lives only in auth.users.
-- display_name may be a first name or a pseudonym chosen by the school.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null default 'student',
  display_name text not null default '' check (char_length(display_name) <= 80),
  year_group smallint check (year_group between 7 and 13),
  locale text not null default 'ar',
  consent_recorded_at timestamptz,           -- school/guardian consent recorded for minors
  allow_transcript_retention boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  year_group smallint not null check (year_group between 7 and 13),
  teacher_id uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.class_members (
  class_id uuid not null references public.classes (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (class_id, student_id)
);
create index class_members_student_idx on public.class_members (student_id);

-- ───────────────────────────── textbooks ─────────────────────────────
create table public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  subject text not null default 'arabic',
  year_min smallint not null check (year_min between 7 and 13),
  year_max smallint not null check (year_max between 7 and 13),
  publisher text,
  language text not null default 'ar',
  -- Legal gate: an admin must attest that the upload is licensed/authorised.
  license_attestation text not null check (char_length(license_attestation) >= 10),
  license_attested_by uuid not null references public.profiles (id),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint year_range check (year_min <= year_max)
);

create table public.book_versions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  version_label text not null default '1',
  status public.version_status not null default 'uploaded',
  storage_path text not null,               -- bucket "textbooks"
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  page_count integer check (page_count > 0),
  error text,
  uploaded_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  unique (book_id, file_sha256),
  unique (book_id, version_label)
);

create table public.book_pages (
  id uuid primary key default gen_random_uuid(),
  book_version_id uuid not null references public.book_versions (id) on delete cascade,
  page_number integer not null check (page_number > 0),   -- physical PDF page (1-based)
  printed_label text,                                       -- number printed on the page, when detected
  text text not null default '',
  text_normalized text not null default '',
  has_text boolean not null default false,
  image_path text,                                          -- bucket "page-images"
  embedding vector(1536),
  content_hash text,
  created_at timestamptz not null default now(),
  unique (book_version_id, page_number)
);
create index book_pages_embedding_idx on public.book_pages using hnsw (embedding vector_cosine_ops);
create index book_pages_trgm_idx on public.book_pages using gin (text_normalized gin_trgm_ops);

create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  book_version_id uuid not null references public.book_versions (id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  title text not null check (char_length(title) between 1 and 300),
  unit_title text,
  start_page integer not null check (start_page > 0),
  end_page integer not null,
  detection_method text not null check (detection_method in ('outline', 'heading', 'manual', 'whole_document')),
  learning_objectives text[] not null default '{}',   -- empty until a teacher verifies/enters them
  verified_by uuid references public.profiles (id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint page_order check (end_page >= start_page),
  unique (book_version_id, ordinal)
);
create index lessons_version_idx on public.lessons (book_version_id, start_page);

create table public.content_chunks (
  id uuid primary key default gen_random_uuid(),
  book_version_id uuid not null references public.book_versions (id) on delete cascade,
  lesson_id uuid references public.lessons (id) on delete set null,
  ordinal integer not null,
  page_start integer not null,
  page_end integer not null,
  content text not null,
  content_normalized text not null,
  token_estimate integer not null default 0,
  content_hash text not null,
  embedding vector(1536),
  fts tsvector generated always as (to_tsvector('simple', content_normalized)) stored,
  created_at timestamptz not null default now(),
  constraint chunk_page_order check (page_end >= page_start),
  unique (book_version_id, ordinal)
);
create index content_chunks_embedding_idx on public.content_chunks using hnsw (embedding vector_cosine_ops);
create index content_chunks_fts_idx on public.content_chunks using gin (fts);
create index content_chunks_trgm_idx on public.content_chunks using gin (content_normalized gin_trgm_ops);
create index content_chunks_lesson_idx on public.content_chunks (lesson_id);

-- ───────────────────────────── ingestion queue ─────────────────────────────
create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  book_version_id uuid not null references public.book_versions (id) on delete cascade,
  status public.job_status not null default 'queued',
  stage text not null default 'queued'
    check (stage in ('queued', 'download', 'extract', 'images', 'lessons', 'chunk', 'embed', 'finalize', 'done')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_after timestamptz not null default now(),
  locked_by text,
  lease_expires_at timestamptz,
  progress jsonb not null default '{}'::jsonb,
  error text,
  -- One active job per (version, idempotency key): re-enqueueing the same upload is a no-op.
  idempotency_key text not null,
  requested_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (idempotency_key)
);
create index ingestion_jobs_claim_idx on public.ingestion_jobs (status, run_after);

-- ───────────────────────────── tutoring ─────────────────────────────
create table public.tutoring_sessions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles (id) on delete cascade,
  mode public.tutoring_mode not null default 'explain',
  level public.challenge_level not null default 'core',
  book_version_id uuid references public.book_versions (id) on delete set null,
  lesson_id uuid references public.lessons (id) on delete set null,
  current_page integer,
  objective text check (char_length(objective) <= 500),
  channel text not null default 'text' check (channel in ('text', 'voice')),
  status text not null default 'active' check (status in ('active', 'ended')),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index tutoring_sessions_student_idx on public.tutoring_sessions (student_id, started_at desc);

create table public.session_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.tutoring_sessions (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade, -- denormalised for RLS speed
  seq integer not null,
  type text not null check (type in (
    'user_text', 'user_speech', 'assistant_text', 'assistant_speech',
    'vision_recognition', 'page_confirmed', 'page_rejected', 'tool_call', 'state', 'error')),
  payload jsonb not null default '{}'::jsonb,
  -- Source references actually retrieved and shown/used for this turn (chunk ids + pages).
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, seq)
);
create index session_events_student_idx on public.session_events (student_id, created_at desc);

create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles (id) on delete cascade,
  session_id uuid references public.tutoring_sessions (id) on delete set null,
  lesson_id uuid references public.lessons (id) on delete set null,
  kind text not null check (kind in ('practice', 'assessment')),
  objective text,
  authored_by text not null default 'ai' check (authored_by in ('ai', 'teacher')),
  created_at timestamptz not null default now()
);

create table public.assessment_items (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments (id) on delete cascade,
  ordinal integer not null,
  skill public.skill_area not null,
  level public.challenge_level not null default 'core',
  prompt text not null,
  source_chunk_ids uuid[] not null default '{}',
  rubric jsonb not null default '[]'::jsonb,          -- [{criterion, max_points}]
  hints text[] not null default '{}',
  unique (assessment_id, ordinal)
);

create table public.student_responses (
  id uuid primary key default gen_random_uuid(),
  assessment_item_id uuid not null references public.assessment_items (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  session_id uuid references public.tutoring_sessions (id) on delete set null,
  response_text text not null check (char_length(response_text) <= 4000),
  hints_used integer not null default 0,
  -- AI estimate (never presented as a grade)
  ai_score numeric(5, 2) check (ai_score between 0 and 100),
  ai_rubric jsonb,
  ai_feedback text,
  ai_scored_at timestamptz,
  -- Teacher-validated assessment (authoritative)
  teacher_score numeric(5, 2) check (teacher_score between 0 and 100),
  teacher_feedback text,
  teacher_validated_by uuid references public.profiles (id),
  teacher_validated_at timestamptz,
  created_at timestamptz not null default now()
);
create index student_responses_student_idx on public.student_responses (student_id, created_at desc);

create table public.skill_mastery (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles (id) on delete cascade,
  skill public.skill_area not null,
  lesson_id uuid references public.lessons (id) on delete cascade,
  ai_estimate numeric(4, 3) not null default 0 check (ai_estimate between 0 and 1),
  teacher_validated numeric(4, 3) check (teacher_validated between 0 and 1),
  evidence_count integer not null default 0,
  updated_at timestamptz not null default now()
);
create unique index skill_mastery_unique_idx
  on public.skill_mastery (student_id, skill, coalesce(lesson_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ───────────────────────────── governance ─────────────────────────────
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,                       -- null for system/worker
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);

create table public.usage_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('tutor_tokens', 'embedding_tokens', 'vision_calls', 'realtime_seconds')),
  amount numeric not null check (amount >= 0),
  created_at timestamptz not null default now()
);
create index usage_ledger_user_idx on public.usage_ledger (user_id, kind, created_at desc);
