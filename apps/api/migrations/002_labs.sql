-- Lab catalog, sessions, objectives, flags, progress, gamification.
CREATE TABLE IF NOT EXISTS lab_templates (
  lab_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published', 'coming_soon', 'unavailable')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  template JSONB NOT NULL,
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lab_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lab_id TEXT NOT NULL,
  lab_version TEXT NOT NULL,
  template_checksum TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','provisioning','starting','ready','stopping','stopped','failed','expired')),
  runner_mode TEXT,
  secret_encrypted TEXT NOT NULL,
  targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure JSONB,
  resources JSONB,
  walkthrough_used BOOLEAN NOT NULL DEFAULT FALSE,
  hints_used INTEGER NOT NULL DEFAULT 0,
  extension_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  max_expires_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  CHECK (ended_at IS NULL OR ended_at >= created_at)
);
CREATE INDEX IF NOT EXISTS lab_sessions_user_idx ON lab_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lab_sessions_state_idx ON lab_sessions(state);
CREATE UNIQUE INDEX IF NOT EXISTS lab_sessions_one_active
  ON lab_sessions(user_id, lab_id)
  WHERE state IN ('queued','provisioning','starting','ready');

CREATE TABLE IF NOT EXISTS session_events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES lab_sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_events_session_idx ON session_events(session_id, id);

CREATE TABLE IF NOT EXISTS session_flags (
  session_id UUID NOT NULL REFERENCES lab_sessions(id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL,
  flag_hmac TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, objective_id)
);

CREATE TABLE IF NOT EXISTS objective_completions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lab_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  session_id UUID REFERENCES lab_sessions(id) ON DELETE SET NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL CHECK (method IN ('flag','check')),
  walkthrough_used BOOLEAN NOT NULL DEFAULT FALSE,
  hints_used INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, lab_id, objective_id)
);
CREATE INDEX IF NOT EXISTS objective_completions_user_idx ON objective_completions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS flag_attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES lab_sessions(id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL,
  submitted_hmac TEXT NOT NULL,
  accepted BOOLEAN NOT NULL,
  ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flag_attempts_session_idx ON flag_attempts(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hint_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES lab_sessions(id) ON DELETE SET NULL,
  lab_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  hint_id TEXT NOT NULL,
  xp_penalty INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, session_id, objective_id, hint_id)
);

CREATE TABLE IF NOT EXISTS walkthrough_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES lab_sessions(id) ON DELETE SET NULL,
  lab_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, session_id, step_index)
);

CREATE TABLE IF NOT EXISTS lab_progress (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lab_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  score INTEGER NOT NULL DEFAULT 0,
  objectives_completed INTEGER NOT NULL DEFAULT 0,
  walkthrough_used BOOLEAN NOT NULL DEFAULT FALSE,
  hints_used INTEGER NOT NULL DEFAULT 0,
  first_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, lab_id)
);

CREATE TABLE IF NOT EXISTS achievements (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  icon TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('bronze','silver','gold','platinum')),
  xp INTEGER NOT NULL DEFAULT 0,
  criteria JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL REFERENCES achievements(slug) ON DELETE CASCADE,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slug)
);

CREATE TABLE IF NOT EXISTS learning_paths (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  level TEXT NOT NULL,
  icon TEXT NOT NULL,
  estimated_hours NUMERIC(4,1) NOT NULL DEFAULT 4,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS path_labs (
  path_id TEXT NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
  lab_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (path_id, lab_id)
);

CREATE TABLE IF NOT EXISTS path_enrollments (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path_id TEXT NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, path_id)
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  host TEXT,
  capacity JSONB NOT NULL DEFAULT '{}'::jsonb,
  healthy BOOLEAN NOT NULL DEFAULT TRUE,
  checks JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
