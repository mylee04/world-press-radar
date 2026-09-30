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
