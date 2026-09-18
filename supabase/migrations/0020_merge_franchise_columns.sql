-- Merges sub_franchise into franchise as a multi-value list (matching genre's own text[]
-- pattern, GIN index included), per the user's own observation that franchise membership
-- isn't a clean two-level hierarchy - a film can genuinely belong to several franchises at
-- once, at different specificities (e.g. Captain Marvel (2019): Marvel, Marvel Cinematic
-- Universe, and the Captain Marvel character franchise itself). Existing rows are merged in
-- "franchise, sub_franchise" order per the user's own explicit instruction - verified live
-- against the real data first (3065 rows: 179 had both set, 1461 only franchise, 5 only
-- sub_franchise, the rest neither) so every real combination is accounted for below.

alter table titles add column franchise_merged text[];

update titles set franchise_merged =
  case
    when franchise is not null and sub_franchise is not null then array[franchise, sub_franchise]
    when franchise is not null then array[franchise]
    when sub_franchise is not null then array[sub_franchise]
    else '{}'::text[]
  end;

drop index if exists titles_franchise_idx;
alter table titles drop column franchise;
alter table titles drop column sub_franchise;
alter table titles rename column franchise_merged to franchise;
alter table titles alter column franchise set not null;
alter table titles alter column franchise set default '{}';
create index if not exists titles_franchise_idx on titles using gin (franchise);
