-- Extensão para uuid (se necessário)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('user','manager','developer','admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz NULL,
  deleted_by_user_id uuid NULL REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);

-- Developer stacks catalog
CREATE TABLE IF NOT EXISTS developer_stacks (
  id smallint PRIMARY KEY,
  code text UNIQUE NOT NULL CHECK (code IN ('frontend','backend','infra')),
  label text NOT NULL
);

INSERT INTO developer_stacks (id, code, label)
VALUES
  (1, 'frontend', 'Front-end'),
  (2, 'backend', 'Back-end'),
  (3, 'infra', 'Infra')
ON CONFLICT DO NOTHING;

-- User stacks (global)
CREATE TABLE IF NOT EXISTS user_developer_stacks (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stack_id smallint NOT NULL REFERENCES developer_stacks(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, stack_id)
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz NULL,
  deleted_by_user_id uuid NULL REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_projects_is_active ON projects(is_active);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- Memberships
CREATE TABLE IF NOT EXISTS project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- Suggestions
CREATE TABLE IF NOT EXISTS suggestions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','rejected')),
  progress_percent int NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  score int NOT NULL DEFAULT 0,
  upvotes_count int NOT NULL DEFAULT 0,
  downvotes_count int NOT NULL DEFAULT 0,
  backlog_item_id uuid NULL,
  locked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Backlog items
CREATE TABLE IF NOT EXISTS backlog_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin_type text NOT NULL CHECK (origin_type IN ('manual','suggestion')),
  suggestion_id uuid NULL REFERENCES suggestions(id) ON DELETE SET NULL,
  title text NOT NULL,
  summary text,
  stage text NOT NULL DEFAULT 'todo' CHECK (stage IN ('todo','doing','review','done','blocked')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  progress_percent int NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz NULL,
  deleted_by_user_id uuid NULL REFERENCES users(id) ON DELETE RESTRICT
);

-- 1:1 suggestion -> backlog per project
CREATE UNIQUE INDEX IF NOT EXISTS uq_backlog_suggestion_per_project
  ON backlog_items(project_id, suggestion_id)
  WHERE suggestion_id IS NOT NULL;

-- Link suggestions.backlog_item_id to backlog_items.id
ALTER TABLE suggestions
  ADD CONSTRAINT fk_suggestions_backlog_item
  FOREIGN KEY (backlog_item_id) REFERENCES backlog_items(id) ON DELETE SET NULL;

-- Tasks
CREATE TABLE IF NOT EXISTS backlog_tasks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  backlog_item_id uuid NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  stack_id smallint NOT NULL REFERENCES developer_stacks(id) ON DELETE RESTRICT,
  title text NOT NULL,
  description text,
  is_done boolean NOT NULL DEFAULT false,
  order_index int NOT NULL DEFAULT 0,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz NULL
);

-- Votes
CREATE TABLE IF NOT EXISTS suggestion_votes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suggestion_id uuid NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote smallint NOT NULL CHECK (vote IN (-1,0,1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, suggestion_id, user_id)
);
