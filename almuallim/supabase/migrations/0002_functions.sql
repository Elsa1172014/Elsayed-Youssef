-- Helper functions, ingestion queue, hybrid retrieval, rate limiting.
-- Convention: SECURITY DEFINER functions pin search_path and re-check authorisation inside.

-- ───────────────────────────── role helpers (used by RLS) ─────────────────────────────
create or replace function public.current_app_role()
returns public.user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin', 'teacher') from public.profiles where id = auth.uid()), false)
$$;

-- True when the calling teacher has `sid` in at least one of their classes.
create or replace function public.teaches_student(sid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.class_members m
    join public.classes c on c.id = m.class_id
    where m.student_id = sid and c.teacher_id = auth.uid()
  )
$$;

-- ───────────────────────────── profile guards ─────────────────────────────
-- Users may never change their own role; only service_role (server) or an admin may.
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    if coalesce(auth.role(), 'service_role') <> 'service_role' and not public.is_admin() then
      raise exception 'role changes are not permitted' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' and new.role <> 'student' then
    if coalesce(auth.role(), 'service_role') <> 'service_role' and not public.is_admin() then
      raise exception 'only students may self-register' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger profiles_guard_trg before insert or update on public.profiles
  for each row execute function public.profiles_guard();

-- Teacher-validated fields on responses/mastery may only be written by staff or the server.
create or replace function public.responses_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text := coalesce(auth.role(), 'service_role');
begin
  if r = 'service_role' then return new; end if;
  if tg_op = 'INSERT' then
    if new.teacher_score is not null or new.teacher_validated_by is not null or new.ai_score is not null then
      raise exception 'scores cannot be set by the submitting user' using errcode = '42501';
    end if;
    return new;
  end if;
  -- UPDATE
  if (new.ai_score, new.ai_rubric, new.ai_feedback, new.ai_misconception, new.response_text, new.student_id)
     is distinct from (old.ai_score, old.ai_rubric, old.ai_feedback, old.ai_misconception, old.response_text, old.student_id) then
    raise exception 'immutable response fields' using errcode = '42501';
  end if;
  if (new.teacher_score, new.teacher_feedback, new.teacher_validated_by, new.teacher_validated_at)
     is distinct from (old.teacher_score, old.teacher_feedback, old.teacher_validated_by, old.teacher_validated_at) then
    if not public.is_staff() then
      raise exception 'only teachers may validate' using errcode = '42501';
    end if;
    new.teacher_validated_by := auth.uid();
    new.teacher_validated_at := now();
  end if;
  return new;
end $$;

create trigger responses_guard_trg before insert or update on public.student_responses
  for each row execute function public.responses_guard();

-- audit_logs is append-only for everyone, including service_role.
create or replace function public.audit_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs is append-only' using errcode = '42501';
end $$;
create trigger audit_immutable_trg before update or delete on public.audit_logs
  for each row execute function public.audit_immutable();

-- ───────────────────────────── ingestion queue (service_role only) ─────────────────────────────
create or replace function public.enqueue_ingestion(
  p_version uuid, p_requested_by uuid, p_force boolean default false)
returns public.ingestion_jobs language plpgsql security definer set search_path = public as $$
declare
  v public.book_versions;
  k text;
  j public.ingestion_jobs;
begin
  select * into v from public.book_versions where id = p_version;
  if not found then raise exception 'book version not found'; end if;
  k := 'ingest:' || v.id || ':' || v.file_sha256 || case when p_force then ':' || gen_random_uuid() else '' end;
  insert into public.ingestion_jobs (book_version_id, idempotency_key, requested_by)
  values (v.id, k, p_requested_by)
  on conflict (idempotency_key) do nothing
  returning * into j;
  if j.id is null then
    select * into j from public.ingestion_jobs where idempotency_key = k;
  else
    update public.book_versions set status = 'processing', error = null where id = v.id;
  end if;
  return j;
end $$;

create or replace function public.claim_ingestion_job(p_worker text, p_lease_seconds integer default 120)
returns public.ingestion_jobs language plpgsql security definer set search_path = public as $$
declare j public.ingestion_jobs;
begin
  -- Reap jobs whose lease expired after exhausting all attempts.
  with dead as (
    update public.ingestion_jobs
       set status = 'failed', error = coalesce(error, 'lease expired after max attempts'), finished_at = now(),
           locked_by = null, lease_expires_at = null
     where status = 'running' and lease_expires_at < now() and attempts >= max_attempts
    returning book_version_id, error)
  update public.book_versions v set status = 'failed', error = d.error
    from dead d where v.id = d.book_version_id;

  update public.ingestion_jobs q
     set status = 'running', locked_by = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = q.attempts + 1,
         started_at = coalesce(q.started_at, now())
   where q.id = (
     select id from public.ingestion_jobs
      where attempts < max_attempts
        and ((status = 'queued' and run_after <= now())
          or (status = 'running' and lease_expires_at < now()))
      order by run_after, created_at
      for update skip locked
      limit 1)
  returning q.* into j;
  return j;   -- all-null row when the queue is empty
end $$;

create or replace function public.heartbeat_ingestion_job(
  p_job uuid, p_worker text, p_lease_seconds integer, p_stage text, p_progress jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.ingestion_jobs
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         stage = coalesce(p_stage, stage),
         progress = progress || coalesce(p_progress, '{}'::jsonb)
   where id = p_job and locked_by = p_worker and status = 'running';
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function public.complete_ingestion_job(p_job uuid, p_worker text)
returns boolean language plpgsql security definer set search_path = public as $$
declare vid uuid; n integer;
begin
  update public.ingestion_jobs
     set status = 'succeeded', stage = 'done', finished_at = now(), locked_by = null,
         lease_expires_at = null, error = null
   where id = p_job and locked_by = p_worker and status = 'running'
  returning book_version_id into vid;
  get diagnostics n = row_count;
  if n = 1 then
    update public.book_versions set status = 'ready', ready_at = now(), error = null where id = vid;
  end if;
  return n = 1;
end $$;

create or replace function public.fail_ingestion_job(
  p_job uuid, p_worker text, p_error text, p_retryable boolean)
returns public.job_status language plpgsql security definer set search_path = public as $$
declare j public.ingestion_jobs; final boolean;
begin
  select * into j from public.ingestion_jobs where id = p_job and locked_by = p_worker for update;
  if not found then return null; end if;
  final := (not p_retryable) or j.attempts >= j.max_attempts;
  if final then
    update public.ingestion_jobs set status = 'failed', error = left(p_error, 2000), finished_at = now(),
           locked_by = null, lease_expires_at = null where id = p_job;
    update public.book_versions set status = 'failed', error = left(p_error, 2000) where id = j.book_version_id;
    return 'failed';
  end if;
  update public.ingestion_jobs
     set status = 'queued', error = left(p_error, 2000), locked_by = null, lease_expires_at = null,
         run_after = now() + make_interval(secs => least(1800, 30 * power(2, j.attempts - 1)::int))
   where id = p_job;
  return 'queued';
end $$;

-- ───────────────────────────── retrieval ─────────────────────────────
-- Hybrid (semantic + lexical) search with reciprocal-rank fusion. Callable by any
-- authenticated user, but only ever returns content from READY versions and at most 12 rows,
-- so a student cannot bulk-export a textbook through it.
create or replace function public.search_content(
  p_query_embedding vector(1536),
  p_query_text text,
  p_book_version_id uuid,
  p_lesson_id uuid default null,
  p_limit integer default 6)
returns table (
  chunk_id uuid, lesson_id uuid, lesson_title text, page_start integer, page_end integer,
  content text, vector_similarity double precision, lexical_score double precision, fused_score double precision)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 6), 1), 12);
  tsq tsquery;
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.book_versions bv
     where bv.id = p_book_version_id and (bv.status = 'ready' or public.is_staff())) then
    return;
  end if;
  tsq := nullif(replace(plainto_tsquery('simple', coalesce(p_query_text, ''))::text, '&', '|'), '')::tsquery;

  return query
  with sem as (
    select c.id, 1 - (c.embedding <=> p_query_embedding) as sim,
           row_number() over (order by c.embedding <=> p_query_embedding) as rnk
      from public.content_chunks c
     where c.book_version_id = p_book_version_id
       and (p_lesson_id is null or c.lesson_id = p_lesson_id)
       and c.embedding is not null and p_query_embedding is not null
     order by c.embedding <=> p_query_embedding
     limit 30),
  lex as (
    select c.id, ts_rank_cd(c.fts, tsq) as score,
           row_number() over (order by ts_rank_cd(c.fts, tsq) desc) as rnk
      from public.content_chunks c
     where tsq is not null
       and c.book_version_id = p_book_version_id
       and (p_lesson_id is null or c.lesson_id = p_lesson_id)
       and c.fts @@ tsq
     order by ts_rank_cd(c.fts, tsq) desc
     limit 30),
  fused as (
    select coalesce(s.id, l.id) as id, s.sim, l.score,
           coalesce(1.0 / (60 + s.rnk), 0) + coalesce(1.0 / (60 + l.rnk), 0) as rrf
      from sem s full outer join lex l on l.id = s.id)
  select c.id, c.lesson_id, ls.title, c.page_start, c.page_end, c.content,
         coalesce(f.sim, 0)::double precision, coalesce(f.score, 0)::double precision, f.rrf::double precision
    from fused f
    join public.content_chunks c on c.id = f.id
    left join public.lessons ls on ls.id = c.lesson_id
   order by f.rrf desc
   limit lim;
end $$;

-- Page-level candidates for camera page recognition. Returns raw signals; scoring/ambiguity
-- decisions live in application code (src/lib/retrieval/page-match.ts) where they are unit-tested.
create or replace function public.match_pages(
  p_query_embedding vector(1536),
  p_query_text text,
  p_book_version_id uuid,
  p_limit integer default 8)
returns table (
  page_id uuid, page_number integer, printed_label text, lesson_id uuid, lesson_title text,
  vector_similarity double precision, trigram_similarity double precision, lexical_score double precision)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 8), 1), 12);
  tsq tsquery;
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.book_versions bv
     where bv.id = p_book_version_id and (bv.status = 'ready' or public.is_staff())) then
    return;
  end if;
  tsq := nullif(replace(plainto_tsquery('simple', coalesce(p_query_text, ''))::text, '&', '|'), '')::tsquery;

  return query
  select p.id, p.page_number, p.printed_label,
         (select l.id from public.lessons l
           where l.book_version_id = p.book_version_id and p.page_number between l.start_page and l.end_page
           order by l.ordinal limit 1),
         (select l.title from public.lessons l
           where l.book_version_id = p.book_version_id and p.page_number between l.start_page and l.end_page
           order by l.ordinal limit 1),
         case when p_query_embedding is null or p.embedding is null then 0
              else 1 - (p.embedding <=> p_query_embedding) end::double precision,
         word_similarity(coalesce(p_query_text, ''), p.text_normalized)::double precision,
         case when tsq is null then 0 else ts_rank_cd(to_tsvector('simple', p.text_normalized), tsq) end::double precision
    from public.book_pages p
   where p.book_version_id = p_book_version_id and p.has_text
   order by (case when p_query_embedding is null or p.embedding is null then 0
                  else 1 - (p.embedding <=> p_query_embedding) end)
            + word_similarity(coalesce(p_query_text, ''), p.text_normalized) desc
   limit lim;
end $$;

-- Single page of text for tutoring context (READY versions only; staff may read any). One page per call:
-- bulk export is prevented by call-by-call rate limiting in the application layer.
create or replace function public.get_page_text(p_book_version_id uuid, p_page_number integer)
returns table (page_number integer, printed_label text, text text, lesson_id uuid, lesson_title text)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return query
  select p.page_number, p.printed_label, p.text,
         (select l.id from public.lessons l where l.book_version_id = p.book_version_id
            and p.page_number between l.start_page and l.end_page order by l.ordinal limit 1),
         (select l.title from public.lessons l where l.book_version_id = p.book_version_id
            and p.page_number between l.start_page and l.end_page order by l.ordinal limit 1)
    from public.book_pages p
    join public.book_versions bv on bv.id = p.book_version_id
   where p.book_version_id = p_book_version_id and p.page_number = p_page_number
     and (bv.status = 'ready' or public.is_staff());
end $$;

-- ───────────────────────────── session events ─────────────────────────────
-- Security INVOKER: row-level security applies, so only the owning student can append.
create or replace function public.append_session_event(
  p_session uuid, p_type text, p_payload jsonb, p_sources jsonb default '[]'::jsonb)
returns public.session_events language plpgsql security invoker set search_path = public as $$
declare s public.tutoring_sessions; e public.session_events; nxt integer;
begin
  select * into s from public.tutoring_sessions where id = p_session;
  if not found then raise exception 'session not found or not accessible' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext(p_session::text));
  select coalesce(max(seq), 0) + 1 into nxt from public.session_events where session_id = p_session;
  insert into public.session_events (session_id, student_id, seq, type, payload, sources)
  values (p_session, s.student_id, nxt, p_type, coalesce(p_payload, '{}'::jsonb), coalesce(p_sources, '[]'::jsonb))
  returning * into e;
  return e;
end $$;

-- ───────────────────────────── rate limits & budgets (service_role only) ─────────────────────────────
create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare w timestamptz; h integer;
begin
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits as r (key, window_start, hits) values (p_key, w, 1)
  on conflict (key, window_start) do update set hits = r.hits + 1
  returning r.hits into h;
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;
  return h <= p_max;
end $$;

create or replace function public.usage_sum(p_user uuid, p_kind text, p_since timestamptz)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0) from public.usage_ledger
   where kind = p_kind and created_at >= p_since and (p_user is null or user_id = p_user)
$$;

-- Lock server-only functions away from end users.
revoke all on function public.enqueue_ingestion(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.claim_ingestion_job(text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_ingestion_job(uuid, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.complete_ingestion_job(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_ingestion_job(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.usage_sum(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.search_content(vector, text, uuid, uuid, integer) from public, anon;
revoke all on function public.match_pages(vector, text, uuid, integer) from public, anon;
revoke all on function public.get_page_text(uuid, integer) from public, anon;
grant execute on function public.get_page_text(uuid, integer) to authenticated, service_role;
grant execute on function public.search_content(vector, text, uuid, uuid, integer) to authenticated, service_role;
grant execute on function public.match_pages(vector, text, uuid, integer) to authenticated, service_role;
grant execute on function public.enqueue_ingestion(uuid, uuid, boolean) to service_role;
grant execute on function public.claim_ingestion_job(text, integer) to service_role;
grant execute on function public.heartbeat_ingestion_job(uuid, text, integer, text, jsonb) to service_role;
grant execute on function public.complete_ingestion_job(uuid, text) to service_role;
grant execute on function public.fail_ingestion_job(uuid, text, text, boolean) to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
grant execute on function public.usage_sum(uuid, text, timestamptz) to service_role;
