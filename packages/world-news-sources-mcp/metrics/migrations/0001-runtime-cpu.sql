-- Daily numeric application measurements only. Existing usage counters are untouched.
CREATE TABLE IF NOT EXISTS daily_runtime_cpu (
  day TEXT NOT NULL,
  traffic TEXT NOT NULL CHECK(traffic IN ('unclassified','inspection')),
  route TEXT NOT NULL CHECK(route IN ('mcp','web_export','source_packs','health','quality','other')),
  outcome TEXT NOT NULL CHECK(outcome IN ('success','error')),
  revision TEXT NOT NULL CHECK(revision IN ('cpu-optimized-v1')),
  eligible_calls INTEGER NOT NULL DEFAULT 0 CHECK(eligible_calls>=0),
  overlap_calls INTEGER NOT NULL DEFAULT 0 CHECK(overlap_calls>=0),
  cpu_us INTEGER NOT NULL DEFAULT 0 CHECK(cpu_us>=0),
  wall_ms INTEGER NOT NULL DEFAULT 0 CHECK(wall_ms>=0),
  PRIMARY KEY(day,traffic,route,outcome,revision)
) WITHOUT ROWID;
