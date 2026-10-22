-- Zoomed high-resolution tiles of each page (sent to the model alongside the full page
-- so small handwriting keeps its detail). Purged together with the page image.

alter table public.pages add column if not exists tile_paths text[] not null default '{}';

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
  select array_agg(p.id),
         array_agg(x.path) filter (where x.path is not null)
    into v_ids, v_paths
  from public.pages p
  join target t on t.pid = p.id
  left join lateral (select unnest(array_append(p.tile_paths, p.image_path)) as path) x on true;

  if v_ids is null then return; end if;

  update public.pages set ocr_text = null, ocr_layout = null, image_path = null, tile_paths = '{}'
   where id = any(v_ids);

  return query select distinct unnest(coalesce(v_paths, '{}'));
end $$;
