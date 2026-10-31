CREATE TABLE harness_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hold_reason TEXT CHECK (hold_reason IN ('balance', 'daily_limit', 'blocked')),
  hold_until TEXT,
  hold_since TEXT,
  last_plan_date TEXT,
  plan_attempts INTEGER NOT NULL DEFAULT 0,
  plan_retry_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  output_fail_count INTEGER NOT NULL DEFAULT 0,
  output_fail_key TEXT,
  turn_retry_at TEXT,
  daily_calls INTEGER NOT NULL DEFAULT 0,
  daily_calls_date TEXT
);
INSERT INTO harness_state (id) VALUES (1);

CREATE TABLE goals (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL,
  job_snapshot TEXT NOT NULL,
  title TEXT NOT NULL,
  done_criteria TEXT NOT NULL,
  due_at TEXT,
  progress TEXT NOT NULL DEFAULT '',
  plan_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'done', 'failed', 'dropped', 'expired')),
  end_reason TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX goals_state ON goals(state);
CREATE INDEX goals_closed_at ON goals(closed_at);
CREATE INDEX goals_plan_date ON goals(plan_date);

CREATE TABLE flows (
  id INTEGER PRIMARY KEY,
  opener TEXT NOT NULL CHECK (opener IN ('ai', 'user')),
  opened_by_reservation_id INTEGER,
  opened_intent TEXT,
  opened_job_id TEXT,
  plan_date TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  answered_upto_id INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('agent', 'blackout', 'stale', 'failed')),
  cleanup_status TEXT CHECK (cleanup_status IN ('pending', 'done', 'failed', 'skipped')),
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  cleanup_next_at TEXT,
  summary TEXT,
  compacted_until_id INTEGER
);
CREATE UNIQUE INDEX flows_one_open ON flows((ended_at IS NULL)) WHERE ended_at IS NULL;

CREATE TABLE flow_goals (
  flow_id INTEGER NOT NULL REFERENCES flows(id),
  goal_id INTEGER NOT NULL REFERENCES goals(id),
  PRIMARY KEY (flow_id, goal_id)
);

CREATE TABLE reservations (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('continue', 'open')),
  at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled', 'fired')),
  flow_id INTEGER REFERENCES flows(id),
  intent TEXT,
  job_id TEXT,
  plan_date TEXT,
  source TEXT NOT NULL CHECK (source IN ('turn', 'plan', 'harness')),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'continue') = (flow_id IS NOT NULL)),
  CHECK ((kind = 'open') = (plan_date IS NOT NULL))
);
CREATE UNIQUE INDEX one_continue ON reservations(flow_id) WHERE kind = 'continue';
CREATE INDEX reservations_state_at ON reservations(state, at);

CREATE TABLE reservation_goals (
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  goal_id INTEGER NOT NULL REFERENCES goals(id),
  PRIMARY KEY (reservation_id, goal_id)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  flow_id INTEGER REFERENCES flows(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  ts TEXT NOT NULL,
  triage TEXT CHECK (triage IN ('pending', 'ignored', 'accepted')),
  void_reason TEXT CHECK (void_reason IN ('undelivered', 'busy', 'trimmed')),
  sent_at TEXT,
  tg_update_id INTEGER UNIQUE,
  tg_message_id INTEGER
);
CREATE INDEX messages_flow ON messages(flow_id);

CREATE TABLE plans (
  plan_date TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'plan', 'cleanup', 'compact')),
  flow_id INTEGER,
  request TEXT NOT NULL,
  response TEXT,
  input_tokens INTEGER,
  cached_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  success INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX llm_calls_created_at ON llm_calls(created_at);
CREATE INDEX llm_calls_kind ON llm_calls(kind);

CREATE TABLE memory_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  updated_by_flow_id INTEGER
);
INSERT INTO memory_state (id) VALUES (1);

CREATE TABLE memory_sections (
  title TEXT PRIMARY KEY,
  content TEXT NOT NULL CHECK (content <> ''),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_flow_id INTEGER NOT NULL
);
