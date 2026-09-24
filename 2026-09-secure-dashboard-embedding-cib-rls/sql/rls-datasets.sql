-- ============================================================================
-- Per-viewer RLS dataset queries (filter column: airport)
--
-- For each dashboard dataset, use one of these as the dataset's SQL. The RLS
-- value arrives inside the dashboard as the global variable __aibi_external_value,
-- which the app sets server-side from the viewer's groups:
--
--   ''                 -> all rows        (admin)
--   'FRA' / 'FRA,BSB'   -> those airports  (single or multi-airport viewer)
--   '__no_access__'     -> zero rows       (unscoped viewer, fail-closed)
--
-- Notes:
--   * Multi-airport needs membership SQL: array_contains(split(..., ','), ...),
--     NOT a plain `= __aibi_external_value` (that only matches a single code).
--   * Drop upper(airport) if the airport column is already uppercase.
--   * Reference/lookup tables that are not airport-specific skip the predicate.
--   * Replace `main.gold` with your own catalog.schema.
-- ============================================================================


-- flight_boarding_summary --------------------------------------------------
select *
from main.gold.flight_boarding_summary
where nullif(__aibi_external_value, '') is null
   or array_contains(split(__aibi_external_value, ','), upper(airport));


-- device_usage_summary -----------------------------------------------------
select *
from main.gold.device_usage_summary
where nullif(__aibi_external_value, '') is null
   or array_contains(split(__aibi_external_value, ','), upper(airport));


-- kiosk_summary ------------------------------------------------------------
select *
from main.gold.kiosk_summary
where nullif(__aibi_external_value, '') is null
   or array_contains(split(__aibi_external_value, ','), upper(airport));


-- aggregate example (apply the RLS predicate BEFORE grouping) ---------------
select
  event_date,
  airport,
  carrier,
  terminal,
  sum(pax_count) as total
from main.gold.pax_demographics_summary
where nullif(__aibi_external_value, '') is null
   or array_contains(split(__aibi_external_value, ','), upper(airport))
group by event_date, airport, carrier, terminal
order by event_date, airport;
