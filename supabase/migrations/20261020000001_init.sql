-- Commitment-form extraction: schema
-- One row in `records` per commitment number. Patient/sample details live once in `forms`
-- and repeat in every row through the `records_flat` view.

create extension if not exists pgcrypto;

create table public.batches (
  id          uuid primary key default gen_random_uuid(),
  file_name   text not null,
  page_count  int  not null default 0,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create table public.pages (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references public.batches on delete cascade,
  page_no       int  not null,
  image_path    text,                 -- storage path in bucket "pages"; nulled by purge
  rotation      int  not null default 0,
  ocr_text      text,                 -- nulled by purge
  ocr_layout    jsonb,                -- {width,height,words:[{t,x0,y0,x1,y1}]}; nulled by purge
  ocr_confidence real,
  status        text not null default 'pending'
                check (status in ('pending','extracting','done','skipped','error')),
  error         text,
  form_type     text,
  continuation  boolean not null default false,
  processed_ms  int,
  created_at    timestamptz not null default now(),
  unique (batch_id, page_no)
);

create table public.senders (
  id       serial primary key,
  name     text not null unique,        -- canonical display name
  kind     text not null check (kind in ('kupa','hospital','other')),
  aliases  text[] not null default '{}'
);

create table public.forms (
  id               uuid primary key default gen_random_uuid(),
  batch_id         uuid not null references public.batches on delete cascade,
  page_id          uuid not null references public.pages on delete cascade,
  extra_page_ids   uuid[] not null default '{}',  -- continuation pages merged into this form
  form_type        text,
  first_name       text,
  last_name        text,
  national_id      text,
  sender           text,
  central_numbers  text[] not null default '{}',
  received_date    date,
  field_meta       jsonb not null default '{}',   -- per field: confidence, quote, flagged, reasons, verified, edited
  warnings         text[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.records (
  id                 uuid primary key default gen_random_uuid(),
  form_id            uuid not null references public.forms on delete cascade,
  commitment_number  text,
  commitment_meta    jsonb not null default '{}',
  status             text not null default 'pending' check (status in ('pending','approved')),
  approved_at        timestamptz,
  approved_by        uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index on public.pages (batch_id, page_no);
create index on public.forms (batch_id);
create index on public.records (form_id);
create index on public.records (commitment_number);
create index on public.forms using gin (central_numbers);
create index on public.forms (national_id);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger forms_touch before update on public.forms for each row execute function public.touch_updated_at();
create trigger records_touch before update on public.records for each row execute function public.touch_updated_at();

-- Flat view: one row per commitment (the "Excel row")
create or replace view public.records_flat with (security_invoker = true) as
select r.id, r.form_id, r.commitment_number, r.commitment_meta, r.status, r.approved_at,
       f.first_name, f.last_name, f.national_id, f.sender, f.central_numbers, f.received_date,
       f.form_type, f.field_meta, f.warnings, f.batch_id, f.page_id,
       p.page_no, b.file_name
from public.records r
join public.forms f on f.id = r.form_id
join public.pages p on p.id = f.page_id
join public.batches b on b.id = f.batch_id;

-- RLS: signed-in lab staff only. No anon access.
alter table public.batches enable row level security;
alter table public.pages   enable row level security;
alter table public.senders enable row level security;
alter table public.forms   enable row level security;
alter table public.records enable row level security;

create policy staff_all on public.batches for all to authenticated using (true) with check (true);
create policy staff_all on public.pages   for all to authenticated using (true) with check (true);
create policy staff_read on public.senders for select to authenticated using (true);
create policy staff_all on public.forms   for all to authenticated using (true) with check (true);
create policy staff_all on public.records for all to authenticated using (true) with check (true);

-- An approved record is final: the extractor (or anyone) may not silently change it.
create or replace function public.guard_approved() returns trigger
language plpgsql as $$
begin
  if old.status = 'approved' and new.status = 'approved'
     and new.commitment_number is distinct from old.commitment_number then
    raise exception 'record % is approved; un-approve before editing', old.id;
  end if;
  return new;
end $$;
create trigger records_guard before update on public.records for each row execute function public.guard_approved();

-- Private storage bucket for page images
insert into storage.buckets (id, name, public) values ('pages', 'pages', false)
on conflict (id) do nothing;

create policy pages_staff_rw on storage.objects for all to authenticated
  using (bucket_id = 'pages') with check (bucket_id = 'pages');

-- Data minimisation: drop source images/OCR of fully-approved forms older than N days.
-- Returns the storage paths to delete (the client removes the objects).
create or replace function public.purge_source_data(p_days int default 0)
returns setof text
language plpgsql security invoker as $$
declare
  v_paths text[];
  v_ids   uuid[];
begin
  with done_forms as (
    select f.page_id, f.extra_page_ids
    from public.forms f
    where exists (select 1 from public.records r where r.form_id = f.id)
      and not exists (select 1 from public.records r where r.form_id = f.id and r.status <> 'approved')
      and f.updated_at < now() - make_interval(days => p_days)
  ),
  target as (
    select page_id as pid from done_forms
    union select unnest(extra_page_ids) from done_forms
  )
  select array_agg(p.id), array_agg(p.image_path) filter (where p.image_path is not null)
    into v_ids, v_paths
  from public.pages p join target t on t.pid = p.id;

  if v_ids is null then return; end if;

  update public.pages set ocr_text = null, ocr_layout = null, image_path = null
   where id = any(v_ids);

  return query select unnest(coalesce(v_paths, '{}'));
end $$;
