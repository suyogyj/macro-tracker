-- Macro Tracker: one JSON payload per user for logs, user foods, settings, weights.
-- Run this in Supabase SQL Editor (Dashboard → SQL → New query) on a new project.

create table if not exists public.user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

create policy "Users read own row"
  on public.user_data for select
  using (auth.uid() = user_id);

create policy "Users insert own row"
  on public.user_data for insert
  with check (auth.uid() = user_id);

create policy "Users update own row"
  on public.user_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Optional: keep updated_at fresh on every write from the client (client sends new updated_at).
