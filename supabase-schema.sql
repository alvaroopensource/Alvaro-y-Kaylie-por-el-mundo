-- Ejecuta este script en el SQL Editor de Supabase.

create extension if not exists "pgcrypto";

create table if not exists public.map_spots (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    lat double precision not null,
    lng double precision not null,
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.map_entries (
    id uuid primary key default gen_random_uuid(),
    spot_id uuid not null references public.map_spots(id) on delete cascade,
    spot_name text not null,
    title text not null,
    excerpt text not null,
    content_html text not null,
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_map_spots_set_updated_at on public.map_spots;
create trigger trg_map_spots_set_updated_at
before update on public.map_spots
for each row
execute function public.set_updated_at();

alter table public.map_spots enable row level security;
alter table public.map_entries enable row level security;

-- Lectura publica.
drop policy if exists "map_spots_select_all" on public.map_spots;
create policy "map_spots_select_all"
on public.map_spots
for select
using (true);

drop policy if exists "map_entries_select_all" on public.map_entries;
create policy "map_entries_select_all"
on public.map_entries
for select
using (true);

-- Escritura solo autenticados.
drop policy if exists "map_spots_insert_auth" on public.map_spots;
create policy "map_spots_insert_auth"
on public.map_spots
for insert
to authenticated
with check (true);

drop policy if exists "map_spots_update_auth" on public.map_spots;
create policy "map_spots_update_auth"
on public.map_spots
for update
to authenticated
using (true)
with check (true);

drop policy if exists "map_spots_delete_auth" on public.map_spots;
create policy "map_spots_delete_auth"
on public.map_spots
for delete
to authenticated
using (true);

drop policy if exists "map_entries_insert_auth" on public.map_entries;
create policy "map_entries_insert_auth"
on public.map_entries
for insert
to authenticated
with check (true);

drop policy if exists "map_entries_update_auth" on public.map_entries;
create policy "map_entries_update_auth"
on public.map_entries
for update
to authenticated
using (true)
with check (true);

drop policy if exists "map_entries_delete_auth" on public.map_entries;
create policy "map_entries_delete_auth"
on public.map_entries
for delete
to authenticated
using (true);
