/**
 * The phase 1 schema.
 *
 * Every statement is `IF NOT EXISTS`, so applying it on every open is the
 * migration story for phase 1. A real migration ladder can wait until the
 * schema has to change under data someone would miss.
 */
export const SCHEMA = `
/** Every table keys on run_id; a run is the unit of ingest and of pruning. */
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  started_at INTEGER,
  ended_at INTEGER,
  exit_code INTEGER,
  invocation TEXT,
  repo TEXT,
  branch TEXT,
  worktree TEXT,
  git_sha TEXT,
  dirty INTEGER,
  host_id TEXT,
  cpu_count INTEGER,
  total_memory_bytes INTEGER,
  concurrency INTEGER,
  live_slots INTEGER,
  turbo_force INTEGER,
  /** 0 when the run had no envelope (an ad-hoc invocation outside the wrapper). */
  has_envelope INTEGER NOT NULL DEFAULT 0
);

/**
 * No primary key: an append-only time series, and neither \`at\` nor any other
 * column is needed to make a row unique, so none but \`run_id\` is NOT NULL.
 * \`isLedgerEvent\` validates only \`kind\` and \`runId\` before ingest ever sees a
 * row, so a truncated-but-parseable \`sample\` line legitimately reaches this
 * insert missing \`at\`; a NOT NULL constraint there would turn one malformed
 * telemetry line into a thrown error that aborts ingest of the rest of the
 * run, which is the trade this table is designed to avoid.
 */
CREATE TABLE IF NOT EXISTS run_samples (
  run_id TEXT NOT NULL,
  at INTEGER,
  load1 REAL,
  load5 REAL,
  free_memory_bytes INTEGER,
  live_slots INTEGER
);
CREATE INDEX IF NOT EXISTS run_samples_run_at ON run_samples (run_id, at);

/** Same reasoning as \`run_samples\`: no primary key, so only \`run_id\` is NOT NULL. */
CREATE TABLE IF NOT EXISTS turbo_tasks (
  run_id TEXT NOT NULL,
  package_name TEXT,
  task TEXT,
  duration_ms INTEGER,
  cache_status TEXT
);

CREATE TABLE IF NOT EXISTS files (
  run_id TEXT NOT NULL,
  pid INTEGER,
  lane TEXT,
  package_name TEXT,
  file TEXT NOT NULL,
  started_at INTEGER,
  duration_ms INTEGER,
  setup_ms INTEGER,
  collect_ms INTEGER,
  environment_setup_ms INTEGER,
  prepare_ms INTEGER,
  passed INTEGER,
  failed INTEGER,
  skipped INTEGER,
  PRIMARY KEY (run_id, file)
);
CREATE INDEX IF NOT EXISTS files_file ON files (file);

CREATE TABLE IF NOT EXISTS tests (
  run_id TEXT NOT NULL,
  pid INTEGER,
  file TEXT NOT NULL,
  full_name TEXT NOT NULL,
  state TEXT NOT NULL,
  duration_ms INTEGER,
  started_at INTEGER,
  retry_count INTEGER,
  failure_class TEXT,
  failure_message TEXT,
  PRIMARY KEY (run_id, file, full_name)
);
CREATE INDEX IF NOT EXISTS tests_identity ON tests (file, full_name);
CREATE INDEX IF NOT EXISTS tests_state ON tests (state);

/** Which run directories have already been folded in, so ingest is idempotent. */
CREATE TABLE IF NOT EXISTS ingested_runs (
  run_id TEXT PRIMARY KEY,
  ingested_at INTEGER NOT NULL
);
`
