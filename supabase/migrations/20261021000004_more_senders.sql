-- Senders seen in the samples that are not a kupa or a hospital.
insert into public.senders (name, kind, aliases) values
  ('תיירות מרפא', 'other', array['תיירות רפואית'])
on conflict (name) do nothing;
