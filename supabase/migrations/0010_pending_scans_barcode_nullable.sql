-- Supports the Pending Scans "+" manual-entry button (per the user's request): some of
-- the collection's "DVD (Custom Burn)" discs are the user's own creations, never listed on
-- IMDb/OMDB/TMDb at all and never carrying a real barcode - there's nothing to scan for
-- these, so a pending_scans row needs to exist with no barcode at all rather than a faked
-- placeholder value (which would otherwise pollute titles.barcode_id with junk).
--
-- A manual entry is created directly with status = 'needs_manual' (bypassing 'pending'
-- entirely), so resolvePendingScansBatch's `.eq("status", "pending")` query never touches
-- it - there is nothing to look up for a row with no barcode.
alter table pending_scans alter column barcode drop not null;
