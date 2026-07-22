-- Inicializa las tablas para Postgres

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  date DATE NOT NULL,
  block_id TEXT NOT NULL,
  name TEXT NOT NULL,
  subject TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_students_date ON students (date);

CREATE TABLE IF NOT EXISTS known_students (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  subject TEXT,
  last_used_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_known_last_used ON known_students (last_used_at DESC);
