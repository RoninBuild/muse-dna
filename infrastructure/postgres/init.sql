CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt TEXT NOT NULL,
  task_type VARCHAR(50),
  brand_name VARCHAR(255),
  status VARCHAR(20) DEFAULT 'running',
  budget_usdc DECIMAL(12,6),
  estimated_cost_usdc DECIMAL(12,6),
  investment_cost_usdc DECIMAL(12,6),
  total_spent_usdc DECIMAL(12,6) DEFAULT 0,
  savings_usdc DECIMAL(12,6) DEFAULT 0,
  dna_exists BOOLEAN DEFAULT FALSE,
  dna_file_created VARCHAR(255),
  plan_steps TEXT[],
  plan_skipped TEXT[],
  result JSONB,
  error_log TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS task_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id),
  service_name VARCHAR(50),
  unit_name VARCHAR(50),
  status VARCHAR(20),
  cost_usdc DECIMAL(12,6),
  tx_hash VARCHAR(255),
  arc_url TEXT,
  payment_network VARCHAR(64),
  payment_note TEXT,
  reused_from_dna BOOLEAN DEFAULT FALSE,
  dna_section_key VARCHAR(100),
  output_json JSONB,
  error_log TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS task_steps_task_service_unit_unique ON task_steps (task_id, service_name, unit_name);
-- Postgres does not auto-index foreign keys; queries like
--   SELECT * FROM task_steps WHERE task_id = $1
-- would otherwise fall back to sequential scans once the table grows. The
-- composite unique index above only helps when service_name and unit_name are
-- also in the WHERE clause.
CREATE INDEX IF NOT EXISTS task_steps_task_id_idx ON task_steps (task_id);
-- History page orders tasks by created_at for the dashboard.
CREATE INDEX IF NOT EXISTS tasks_status_created_at_idx ON tasks (status, created_at DESC);

CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id),
  skill_name VARCHAR(255),
  times_applied INTEGER DEFAULT 0,
  total_saved_usdc DECIMAL(12,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS skills_task_skill_name_unique ON skills (task_id, skill_name);
CREATE INDEX IF NOT EXISTS skills_task_id_idx ON skills (task_id);
