-- Row-level security. Principle: deny by default, grant narrowly.
--   student  → only their own rows
--   teacher  → rows of students in their own classes (+ read access to textbook content)
--   admin    → everything administrative; textbooks write access
--   server   → service_role bypasses RLS and is used ONLY by trusted server code (never shipped to the browser)

-- New auth users always become students. Elevation is an admin action.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, display_name)
  values (new.id, 'student', left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 80))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Teachers may only change teacher_validated; AI estimate and evidence are server-owned.
create or replace function public.mastery_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), 'service_role') = 'service_role' then return new; end if;
  if tg_op <> 'UPDATE' then raise exception 'mastery is server-written' using errcode = '42501'; end if;
  if (new.ai_estimate, new.evidence_count, new.student_id, new.skill, new.lesson_id)
     is distinct from (old.ai_estimate, old.evidence_count, old.student_id, old.skill, old.lesson_id) then
    raise exception 'only teacher_validated may be changed' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger mastery_guard_trg before insert or update on public.skill_mastery
  for each row execute function public.mastery_guard();

-- ── explicit grants (RLS still applies to authenticated) ──
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- server-only tables: no end-user access at all
revoke all on public.rate_limits, public.usage_ledger, public.audit_logs from authenticated;
grant select on public.audit_logs to authenticated;   -- narrowed to admins by policy
grant usage on all sequences in schema public to authenticated;

alter table public.profiles          enable row level security;
alter table public.classes           enable row level security;
alter table public.class_members     enable row level security;
alter table public.books             enable row level security;
alter table public.book_versions     enable row level security;
alter table public.book_pages        enable row level security;
alter table public.lessons           enable row level security;
alter table public.content_chunks    enable row level security;
alter table public.ingestion_jobs    enable row level security;
alter table public.tutoring_sessions enable row level security;
alter table public.session_events    enable row level security;
alter table public.assessments       enable row level security;
alter table public.assessment_items  enable row level security;
alter table public.student_responses enable row level security;
alter table public.skill_mastery     enable row level security;
alter table public.audit_logs        enable row level security;
alter table public.rate_limits       enable row level security;
alter table public.usage_ledger      enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin() or (public.is_staff() and public.teaches_student(id)));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());
create policy profiles_delete on public.profiles for delete to authenticated
  using (public.is_admin());

-- classes
create policy classes_select on public.classes for select to authenticated
  using (teacher_id = auth.uid() or public.is_admin()
         or exists (select 1 from public.class_members m where m.class_id = id and m.student_id = auth.uid()));
create policy classes_insert on public.classes for insert to authenticated
  with check (public.is_staff() and (teacher_id = auth.uid() or public.is_admin()));
create policy classes_update on public.classes for update to authenticated
  using (teacher_id = auth.uid() or public.is_admin()) with check (teacher_id = auth.uid() or public.is_admin());
create policy classes_delete on public.classes for delete to authenticated
  using (teacher_id = auth.uid() or public.is_admin());

create policy class_members_select on public.class_members for select to authenticated
  using (student_id = auth.uid() or public.is_admin()
         or exists (select 1 from public.classes c where c.id = class_id and c.teacher_id = auth.uid()));
create policy class_members_insert on public.class_members for insert to authenticated
  with check (public.is_admin() or exists (select 1 from public.classes c where c.id = class_id and c.teacher_id = auth.uid()));
create policy class_members_delete on public.class_members for delete to authenticated
  using (public.is_admin() or exists (select 1 from public.classes c where c.id = class_id and c.teacher_id = auth.uid()));

-- textbooks: students see only metadata of READY books; raw pages/chunks are staff-only.
create policy books_select on public.books for select to authenticated
  using (public.is_staff() or exists (select 1 from public.book_versions v where v.book_id = id and v.status = 'ready'));
create policy books_write on public.books for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy book_versions_select on public.book_versions for select to authenticated
  using (public.is_staff() or status = 'ready');
create policy book_versions_write on public.book_versions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy lessons_select on public.lessons for select to authenticated
  using (public.is_staff()
         or exists (select 1 from public.book_versions v where v.id = book_version_id and v.status = 'ready'));
create policy lessons_insert on public.lessons for insert to authenticated with check (public.is_admin());
create policy lessons_update on public.lessons for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy lessons_delete on public.lessons for delete to authenticated using (public.is_admin());

create policy book_pages_select on public.book_pages for select to authenticated using (public.is_staff());
create policy content_chunks_select on public.content_chunks for select to authenticated using (public.is_staff());

create policy ingestion_jobs_select on public.ingestion_jobs for select to authenticated using (public.is_admin());

-- tutoring data
create policy sessions_select on public.tutoring_sessions for select to authenticated
  using (student_id = auth.uid() or public.is_admin() or (public.is_staff() and public.teaches_student(student_id)));
create policy sessions_insert on public.tutoring_sessions for insert to authenticated
  with check (student_id = auth.uid());
create policy sessions_update on public.tutoring_sessions for update to authenticated
  using (student_id = auth.uid()) with check (student_id = auth.uid());
create policy sessions_delete on public.tutoring_sessions for delete to authenticated
  using (student_id = auth.uid() or public.is_admin());

create policy events_select on public.session_events for select to authenticated
  using (student_id = auth.uid() or public.is_admin() or (public.is_staff() and public.teaches_student(student_id)));
create policy events_insert on public.session_events for insert to authenticated
  with check (student_id = auth.uid()
              and exists (select 1 from public.tutoring_sessions s where s.id = session_id and s.student_id = auth.uid()));

create policy assessments_select on public.assessments for select to authenticated
  using (student_id = auth.uid() or public.is_admin() or (public.is_staff() and public.teaches_student(student_id)));
create policy assessments_insert on public.assessments for insert to authenticated
  with check (student_id = auth.uid() or (public.is_staff() and public.teaches_student(student_id)));

create policy items_select on public.assessment_items for select to authenticated
  using (exists (select 1 from public.assessments a where a.id = assessment_id
                 and (a.student_id = auth.uid() or public.is_admin()
                      or (public.is_staff() and public.teaches_student(a.student_id)))));
create policy items_insert on public.assessment_items for insert to authenticated
  with check (exists (select 1 from public.assessments a where a.id = assessment_id
                      and (a.student_id = auth.uid() or (public.is_staff() and public.teaches_student(a.student_id)))));

create policy responses_select on public.student_responses for select to authenticated
  using (student_id = auth.uid() or public.is_admin() or (public.is_staff() and public.teaches_student(student_id)));
create policy responses_insert on public.student_responses for insert to authenticated
  with check (student_id = auth.uid());
create policy responses_update on public.student_responses for update to authenticated
  using (public.is_staff() and (public.is_admin() or public.teaches_student(student_id)))
  with check (public.is_staff() and (public.is_admin() or public.teaches_student(student_id)));

create policy mastery_select on public.skill_mastery for select to authenticated
  using (student_id = auth.uid() or public.is_admin() or (public.is_staff() and public.teaches_student(student_id)));
create policy mastery_update on public.skill_mastery for update to authenticated
  using (public.is_staff() and (public.is_admin() or public.teaches_student(student_id)))
  with check (public.is_staff() and (public.is_admin() or public.teaches_student(student_id)));

create policy audit_select on public.audit_logs for select to authenticated using (public.is_admin());
