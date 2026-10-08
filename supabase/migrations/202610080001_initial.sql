create table if not exists public.recordings (
 id uuid primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 filename text not null, code text not null, camera_id integer not null,
 employee text not null default '', duration integer not null default 0,
 size bigint not null default 0, mime text not null,
 created_at timestamptz not null default now(),
 drive_file_id text, drive_url text, upload_status text not null default 'local'
);
create index if not exists recordings_user_created on public.recordings(user_id,created_at desc);
alter table public.recordings enable row level security;
create policy recordings_read_own on public.recordings for select to authenticated using ((select auth.uid())=user_id);
create policy recordings_insert_own on public.recordings for insert to authenticated with check ((select auth.uid())=user_id);
create policy recordings_update_own on public.recordings for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create table if not exists public.user_settings (
 user_id uuid primary key references auth.users(id) on delete cascade,
 settings jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;
create policy settings_read_own on public.user_settings for select to authenticated using ((select auth.uid())=user_id);
create policy settings_insert_own on public.user_settings for insert to authenticated with check ((select auth.uid())=user_id);
create policy settings_update_own on public.user_settings for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
revoke all on public.recordings,public.user_settings from anon;
grant select,insert,update on public.recordings,public.user_settings to authenticated;
