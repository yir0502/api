create table if not exists public.sucursal_reparto_config (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  capital_pct numeric(5,2) not null default 0 check (capital_pct >= 0 and capital_pct <= 100),
  socios jsonb not null default '[]'::jsonb check (jsonb_typeof(socios) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_sucursal_reparto_org_suc unique (org_id, sucursal_id)
);

create index if not exists idx_sucursal_reparto_config_org_id
  on public.sucursal_reparto_config (org_id);

create or replace function public.set_sucursal_reparto_config_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_sucursal_reparto_config_updated_at on public.sucursal_reparto_config;

create trigger trg_sucursal_reparto_config_updated_at
  before update on public.sucursal_reparto_config
  for each row
  execute function public.set_sucursal_reparto_config_updated_at();

alter table public.sucursal_reparto_config enable row level security;

drop policy if exists sucursal_reparto_config_org_isolation on public.sucursal_reparto_config;

create policy sucursal_reparto_config_org_isolation
  on public.sucursal_reparto_config
  for all
  using (
    exists (
      select 1
      from public.organizacion_miembros om
      where om.org_id = sucursal_reparto_config.org_id
        and om.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.organizacion_miembros om
      where om.org_id = sucursal_reparto_config.org_id
        and om.user_id = auth.uid()
    )
  );
