-- Drops the standalone `imdb_id` column - redundant with `imdb_page`, which already
-- contains the same id embedded in a fixed URL shape
-- (`https://www.imdb.com/title/<imdb_id>/`, always written that way by this app's own
-- code). Anywhere the raw id was needed (TMDb's /find lookup, the similar-entry title/id
-- match), it's now parsed from `imdb_page` on the fly via `extractImdbIdFromPage` in
-- packages/shared/src/titleParsing.ts rather than kept as a second stored copy that could
-- drift out of sync with it.
alter table titles drop column imdb_id;
