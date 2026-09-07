-- Verified live against a real misspelling ("Titanik"): ranking by raw similarity first put
-- an obscure foreign title ("Bife 'Titanik'", popularity 1.9, sim 0.615) ahead of the real
-- "Titanic" (popularity 45.5, sim 0.6) - a 0.015 similarity difference shouldn't outrank a
-- ~23x popularity difference. Rounding similarity to one decimal place first groups
-- near-identical matches into the same band, then popularity breaks ties within that band -
-- "Titanic" and "Bife 'Titanik'" both round to 0.6, so popularity now correctly puts the
-- real film first, while a genuinely different similarity band (e.g. 0.8 vs 0.6) still
-- always wins outright regardless of popularity.
create or replace function fuzzy_search_tmdb_titles(search_query text, match_limit int default 5)
returns table (tmdb_id integer, title text, popularity real, sim real)
language sql
stable
as $$
  select tmdb_id, title, popularity, similarity(lower(title), lower(search_query)) as sim
  from tmdb_title_index
  where lower(title) % lower(search_query)
  order by round(similarity(lower(title), lower(search_query))::numeric, 1) desc, popularity desc, sim desc
  limit match_limit;
$$;
