-- Private buckets. No storage RLS policies are created for end users on purpose:
-- uploads use server-issued signed upload URLs (admin-authorised), and page images are
-- served through server-issued, short-lived signed URLs after an authorisation check.
-- Note: Supabase's Free plan caps a single object at 50 MB; larger textbooks need the Pro plan
-- (raise the global limit in Storage settings) or splitting the PDF.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('textbooks', 'textbooks', false, 524288000, array['application/pdf'])
    on conflict (id) do nothing;
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('page-images', 'page-images', false, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end $$;
