CREATE TABLE IF NOT EXISTS daily_tool_usage (
  day TEXT NOT NULL,
  tool TEXT NOT NULL CHECK(tool IN ('search_sources','get_source','list_countries','get_endpoint_health','unknown')),
  traffic TEXT NOT NULL CHECK(traffic IN ('unclassified','inspection')),
  calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  duration_sum_ms INTEGER NOT NULL DEFAULT 0,
  duration_max_ms INTEGER NOT NULL DEFAULT 0,
  latency_le_100 INTEGER NOT NULL DEFAULT 0,
  latency_101_500 INTEGER NOT NULL DEFAULT 0,
  latency_501_2000 INTEGER NOT NULL DEFAULT 0,
  latency_gt_2000 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,tool,traffic)
) WITHOUT ROWID;

-- Separate aggregate table preserves every existing counter and requires no destructive migration.
CREATE TABLE IF NOT EXISTS daily_activity_tool_usage (
  day TEXT NOT NULL,
  tool TEXT NOT NULL CHECK(tool IN ('get_source_article_activity','get_country_article_activity','get_country_source_inventory')),
  traffic TEXT NOT NULL CHECK(traffic IN ('unclassified','inspection')),
  calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  duration_sum_ms INTEGER NOT NULL DEFAULT 0,
  duration_max_ms INTEGER NOT NULL DEFAULT 0,
  latency_le_100 INTEGER NOT NULL DEFAULT 0,
  latency_101_500 INTEGER NOT NULL DEFAULT 0,
  latency_501_2000 INTEGER NOT NULL DEFAULT 0,
  latency_gt_2000 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,tool,traffic)
) WITHOUT ROWID;

-- New tools retain separate totals without changing either original table.
CREATE TABLE IF NOT EXISTS daily_extended_tool_usage (
  day TEXT NOT NULL,
  tool TEXT NOT NULL CHECK(tool IN ('get_country_collection_quality','get_source_collection_quality','list_source_packs','get_source_pack','export_source_pack','set_usage_analytics')),
  traffic TEXT NOT NULL CHECK(traffic IN ('unclassified','inspection')),
  calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  duration_sum_ms INTEGER NOT NULL DEFAULT 0,
  duration_max_ms INTEGER NOT NULL DEFAULT 0,
  latency_le_100 INTEGER NOT NULL DEFAULT 0,
  latency_101_500 INTEGER NOT NULL DEFAULT 0,
  latency_501_2000 INTEGER NOT NULL DEFAULT 0,
  latency_gt_2000 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,tool,traffic)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS daily_product_usage (
  day TEXT NOT NULL,
  traffic TEXT NOT NULL CHECK(traffic IN ('unclassified','inspection')),
  channel TEXT NOT NULL CHECK(channel IN ('mcp','web_export')),
  events INTEGER NOT NULL DEFAULT 0,
  identity_provided INTEGER NOT NULL DEFAULT 0,
  identity_missing INTEGER NOT NULL DEFAULT 0,
  identity_excluded INTEGER NOT NULL DEFAULT 0,
  identity_suppressed INTEGER NOT NULL DEFAULT 0,
  identity_disabled INTEGER NOT NULL DEFAULT 0,
  search_nonempty INTEGER NOT NULL DEFAULT 0,
  search_zero_matches INTEGER NOT NULL DEFAULT 0,
  search_empty_page INTEGER NOT NULL DEFAULT 0,
  search_unknown INTEGER NOT NULL DEFAULT 0,
  export_nonempty INTEGER NOT NULL DEFAULT 0,
  export_empty INTEGER NOT NULL DEFAULT 0,
  export_unknown INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,traffic,channel)
) WITHOUT ROWID;

-- Presence only: no tool names, per-call timestamps, prompts, IPs or source queries.
CREATE TABLE IF NOT EXISTS usage_actor_days (
  day TEXT NOT NULL,
  actor_key TEXT NOT NULL CHECK(length(actor_key)=64 AND actor_key NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY(day,actor_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS usage_actor_days_actor_day ON usage_actor_days(actor_key,day);
-- Kept until opt-in so expiration of the observation window cannot silently re-enable tracking.
CREATE TABLE IF NOT EXISTS usage_opt_out (
  actor_key TEXT PRIMARY KEY NOT NULL CHECK(length(actor_key)=64 AND actor_key NOT GLOB '*[^a-f0-9]*')
) WITHOUT ROWID;
