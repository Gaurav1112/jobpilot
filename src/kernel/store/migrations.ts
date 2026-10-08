export const SCHEMA_VERSION = 1;

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    pipeline TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed'))
  );
  CREATE TABLE steps (
    step_key TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    contract_hash TEXT NOT NULL,
    input_envelope_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'quarantined')),
    attempts INTEGER NOT NULL,
    error_code TEXT,
    detail TEXT
  );
  CREATE TABLE envelopes (
    envelope_id TEXT PRIMARY KEY,
    step_key TEXT NOT NULL,
    idx INTEGER NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX envelopes_by_step ON envelopes (step_key, idx);
  CREATE TABLE queue (
    run_id TEXT NOT NULL,
    stage INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    envelope_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'quarantined', 'skipped')),
    PRIMARY KEY (run_id, agent_id, envelope_id)
  );
  CREATE TABLE cost_ledger (
    run_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    usd REAL NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TABLE entities (
    entity_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    state TEXT NOT NULL
  );
  CREATE TABLE entity_transitions (
    entity_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    event TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    PRIMARY KEY (entity_id, step_key, event)
  );
  CREATE TABLE contracts (
    agent_id TEXT NOT NULL,
    version TEXT NOT NULL,
    hash TEXT NOT NULL,
    shape TEXT NOT NULL,
    PRIMARY KEY (agent_id, version)
  );
  `,
];
