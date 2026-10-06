-- Restricts what the public (anon) key can read (2026-10-06).
--
-- The anon key is embedded in the scanner app bundle and used by the public-by-link website,
-- so anything it can SELECT is effectively public. Before this, 0032/0034 granted it every
-- column of `titles` and every row of `pending_scans`, which exposed private fields: who a disc
-- is lent to (a real third party's name), personal ratings, condition notes and barcodes - and
-- `pending_scans.resolved_candidates.existingMatch` holds a full copy of an already-catalogued
-- title, private columns included. The website never selected those columns, but the key could.
--
-- titles: table-level SELECT is swapped for a column-level grant of every column EXCEPT the
-- private ones. Built from information_schema rather than a hand-written column list because
-- the private and public projects don't have identical columns (some migrations are
-- private-only), and so future columns are covered by re-running this block. Any NEW column
-- added later is NOT visible to anon until it's granted - re-run this migration (it's
-- idempotent) after adding a column that should be public.
--
-- pending_scans: no anon read at all. The scanner app now reads it through the scan-secret-gated
-- /api/scan/pending route, and its Rented By suggestions through /api/scan/rented-by-options.
-- Apply only AFTER that app/server change is live, or Pending Scans will come up empty.

do $$
declare
  private_columns text[] := array[
    'rented_by_who', 'date_rented', 'personal_rating', 'case_notes', 'disc_condition', 'barcode_id'
  ];
  public_columns text;
begin
  revoke select on public.titles from anon;

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into public_columns
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'titles'
     and column_name <> all (private_columns);

  execute format('grant select (%s) on public.titles to anon', public_columns);
end
$$;

revoke select on public.pending_scans from anon;
