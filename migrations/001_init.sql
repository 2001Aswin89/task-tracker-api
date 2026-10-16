-- Task tracker schema. Applied once by src/db/migrate.js.

CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT        NOT NULL,
    name          TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    bio           TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Emails are case-insensitive.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- Logout support: a JWT's jti is stored here until the token would have expired anyway.
CREATE TABLE revoked_tokens (
    jti        TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX revoked_tokens_expires_idx ON revoked_tokens (expires_at);

CREATE TABLE teams (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT        NOT NULL,
    description TEXT,
    created_by  BIGINT      NOT NULL REFERENCES users (id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
    team_id   BIGINT      NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    user_id   BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role      TEXT        NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members (user_id);

-- team_id NULL means a personal task, visible only to its creator and assignee.
CREATE TABLE tasks (
    id           BIGSERIAL PRIMARY KEY,
    title        TEXT        NOT NULL,
    description  TEXT,
    status       TEXT        NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'in_progress', 'completed')),
    priority     TEXT        NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('low', 'medium', 'high')),
    due_date     TIMESTAMPTZ,
    team_id      BIGINT REFERENCES teams (id) ON DELETE CASCADE,
    created_by   BIGINT      NOT NULL REFERENCES users (id),
    assignee_id  BIGINT REFERENCES users (id) ON DELETE SET NULL,
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id, status);
CREATE INDEX tasks_team_idx     ON tasks (team_id, status);
CREATE INDEX tasks_creator_idx  ON tasks (created_by);
CREATE INDEX tasks_due_idx      ON tasks (due_date);

CREATE TABLE comments (
    id         BIGSERIAL PRIMARY KEY,
    task_id    BIGINT      NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users (id),
    body       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX comments_task_idx ON comments (task_id, created_at);

CREATE TABLE attachments (
    id            BIGSERIAL PRIMARY KEY,
    task_id       BIGINT      NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    user_id       BIGINT      NOT NULL REFERENCES users (id),
    original_name TEXT        NOT NULL,
    stored_name   TEXT        NOT NULL,
    mime_type     TEXT        NOT NULL,
    size_bytes    BIGINT      NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attachments_task_idx ON attachments (task_id);

CREATE TABLE notifications (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type       TEXT        NOT NULL,
    task_id    BIGINT REFERENCES tasks (id) ON DELETE CASCADE,
    message    TEXT        NOT NULL,
    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
