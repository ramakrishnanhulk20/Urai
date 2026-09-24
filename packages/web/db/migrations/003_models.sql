-- One row only: the last model list SERV returned, so the picker and the lint do not call SERV on
-- every request. The age check in lib/models.ts bounds how stale it can be (C18).
CREATE TABLE model_cache (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  models jsonb NOT NULL,
  fetched_at timestamptz NOT NULL
);
