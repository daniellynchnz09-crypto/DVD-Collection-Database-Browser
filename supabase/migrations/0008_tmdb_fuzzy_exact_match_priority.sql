-- Found while auditing the real collection for misspellings: a genuine exact match (e.g.
-- "The Godfather Part III", sim = 1) was sometimes outranked by a different, more popular
-- title within the same rounded-similarity band (e.g. "The Godfather Part II", sim 0.9545 -
-- both round to 1.0 at one decimal place, so 0007's popularity tiebreak picked the more
-- popular but factually wrong film over the exact match). Verified live via
-- fuzzy_search_tmdb_titles('The Godfather Part III', 5) before this fix.
--
-- Fixed by adding an explicit "is this an exact (or near-exact) match" sort key ahead of
-- everything else - an exact match always wins outright regardless of any other
-- candidate's popularity, while the 0007 popularity-band tiebreak still applies exactly as
-- before among the remaining (non-exact) candidates, preserving that fix's intent (e.g.
-- "Titanik" still correctly prefers the popular "Titanic" over an obscure same-band title).
create or replace function fuzzy_search_tmdb_titles(search_query text, match_limit int default 5)
returns table (tmdb_id integer, title text, popularity real, sim real)
language sql
stable
as $$
  select tmdb_id, title, popularity, similarity(lower(title), lower(search_query)) as sim
  from tmdb_title_index
  where lower(title) % lower(search_query)
  order by
    (similarity(lower(title), lower(search_query)) >= 0.999) desc,
    round(similarity(lower(title), lower(search_query))::numeric, 1) desc,
    popularity desc,
    similarity(lower(title), lower(search_query)) desc
  limit match_limit;
$$;
