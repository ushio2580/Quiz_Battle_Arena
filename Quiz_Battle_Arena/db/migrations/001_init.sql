PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  question TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  correct_index INTEGER NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  time_limit INTEGER NOT NULL DEFAULT 25,
  difficulty TEXT NOT NULL DEFAULT 'medium',
  wrong_damage INTEGER NOT NULL DEFAULT 25,
  correct_reward INTEGER NOT NULL DEFAULT 10,
  image TEXT,
  UNIQUE(quiz_id, position)
);

CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  quiz_id TEXT NOT NULL,
  room_code TEXT NOT NULL UNIQUE,
  public_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'lobby',
  settings_json TEXT NOT NULL,
  quiz_snapshot_json TEXT,
  results_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS tournament_players (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  character TEXT NOT NULL DEFAULT 'bot',
  placement INTEGER,
  stats_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  player_a_id TEXT,
  player_b_id TEXT,
  winner_id TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  stats_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS question_attempts (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES tournament_players(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  correct INTEGER NOT NULL,
  answered INTEGER NOT NULL DEFAULT 1,
  response_ms INTEGER,
  round_number INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quiz_templates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  questions_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quizzes_host ON quizzes(host_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_tournament ON question_attempts(tournament_id);
