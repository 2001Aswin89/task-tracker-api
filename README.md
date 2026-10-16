# Task Tracker API

A backend for task tracking and team collaboration: users register and log in, create and assign tasks, filter and search them, work in teams, and collaborate through comments and attachments. It also pushes real-time notifications (Server-Sent Events) and can draft task titles and descriptions with Google Gemini.

**Stack:** Node.js 22, Express 5, PostgreSQL (raw SQL via `pg`), JWT + bcrypt, zod validation, multer uploads, Jest + Supertest.

## Quick start

Requirements: Node.js 20+ and a running PostgreSQL 14+.

```bash
npm install
cp .env.example .env        # then edit DATABASE_URL, JWT_SECRET (and GEMINI_API_KEY if you have one)
npm start                   # creates the database if missing, applies migrations, listens on :3000
```

`npm start` creates the `tasktracker` database and applies everything in `migrations/` automatically, so no manual SQL is needed. Check it is up with `GET http://localhost:3000/health`.

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgres://postgres:postgres@localhost:5432/tasktracker` |
| `JWT_SECRET` | Signing key for tokens. Set a long random value | dev-only value |
| `JWT_EXPIRES_IN` | Token lifetime | `2h` |
| `LLM_PROVIDER` | `gemini` or `mock` (no key needed) | `mock` |
| `GEMINI_API_KEY` | Google AI Studio key, used when provider is `gemini` | none |
| `GEMINI_MODEL` | Gemini model id | `gemini-3.1-flash-lite` |
| `UPLOAD_DIR`, `MAX_UPLOAD_BYTES` | Attachment storage and size limit | `uploads`, 5 MB |

### Tests

```bash
npm test
```

The suite runs against a real PostgreSQL database named `tasktracker_test` (created automatically from the same server as `DATABASE_URL`). The AI provider is forced to the mock in tests, so no key or network is needed. Current result: 13 tests passing, covering auth, logout, tasks, filters, teams, permissions, comments, attachments, notifications and AI.

## API overview

All routes are under `/api`. Everything except register and login needs `Authorization: Bearer <token>`.

### Auth and profile
| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | Create account `{name, email, password}`, returns user and token |
| POST | `/auth/login` | Returns user and token |
| POST | `/auth/logout` | Revokes the current token |
| GET | `/users/me` | View profile |
| PATCH | `/users/me` | Update `name`, `email`, `bio` |
| PUT | `/users/me/password` | Change password |

### Teams
| Method | Path | Description |
|---|---|---|
| POST | `/teams` | Create a team (creator becomes owner) |
| GET | `/teams` | Teams I belong to |
| GET | `/teams/:id` | Team details and members (members only) |
| POST | `/teams/:id/members` | Owner adds a registered user `{email}` |
| DELETE | `/teams/:id/members/:userId` | Owner removes a member, or a member leaves |

### Tasks
| Method | Path | Description |
|---|---|---|
| POST | `/tasks` | Create `{title, description?, due_date?, priority?, team_id?, assignee_id?}` |
| GET | `/tasks` | List and search (see filters below) |
| GET | `/tasks/:id` | Get one task |
| PATCH | `/tasks/:id` | Update fields, change `status`, or reassign with `assignee_id` |
| POST | `/tasks/:id/complete` | Mark completed |
| DELETE | `/tasks/:id` | Creator or team owner only |

**List filters (query string):** `status` (`open`, `in_progress`, `completed`), `priority`, `team_id`, `assignee` (`me`, `unassigned`, or a user id), `created_by`, `q` (searches title and description), `due_before`, `due_after`, `sort` (`created_at`, `due_date`, `priority`, `title`, `status`), `order` (`asc`, `desc`), `page`, `limit` (max 100). The response includes `pagination: {page, limit, total, pages}`.

Example: tasks assigned to me that are still open, soonest due first:
`GET /api/tasks?assignee=me&status=open&sort=due_date&order=asc`

### Comments and attachments
| Method | Path | Description |
|---|---|---|
| POST / GET | `/tasks/:id/comments` | Add or list comments `{body}` |
| DELETE | `/comments/:id` | Author only |
| POST | `/tasks/:id/attachments` | `multipart/form-data`, field name `file` |
| GET | `/tasks/:id/attachments` | List attachments |
| GET | `/attachments/:id/download` | Download (authorised) |
| DELETE | `/attachments/:id` | Uploader, task creator, or team owner |

Allowed types: png, jpeg, gif, pdf, txt, csv, zip, docx, xlsx. Other types return 415; files over the size limit return 413.

### Notifications (real time)
| Method | Path | Description |
|---|---|---|
| GET | `/notifications/stream` | Server-Sent Events stream of new notifications |
| GET | `/notifications?unread=true` | Stored notifications |
| PATCH | `/notifications/:id/read`, POST `/notifications/read-all` | Mark read |

Notifications are created when a task is assigned to you, updated, commented on, given an attachment, or completed (the creator is told). You are never notified about your own actions. They are stored in the database and also pushed live to open streams. Browsers' `EventSource` cannot set headers, so the stream also accepts `?token=<jwt>`:

```js
const es = new EventSource(`http://localhost:3000/api/notifications/stream?token=${token}`);
es.addEventListener('notification', (e) => console.log(JSON.parse(e.data)));
```

### AI task drafting
`POST /ai/task-description` with `{ "prompt": "fix the login bug before Friday" }` returns `{ suggestion: { title, description } }`. It does not create a task: the client reviews the suggestion and then calls `POST /tasks`. Gemini is called with a system instruction, JSON-only output, a timeout and one retry; the reply is validated before being returned. With `LLM_PROVIDER=mock` a deterministic stub is used.

### Errors
Every error has one shape: `{ "code": "...", "message": "...", "details": [...] }` (`details` only for validation errors).

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | Malformed JSON or id, rule violations such as assigning to a non-member |
| 401 | `unauthorized` | Missing, invalid, expired or revoked token |
| 403 | `forbidden` | Authenticated but not allowed (e.g. non-owner adding members) |
| 404 | `not_found` | Missing resource, or a task you cannot see |
| 409 | `conflict` | Duplicate email or team member |
| 413 / 415 | `upload_error` / `unsupported_media_type` | Attachment too big or wrong type |
| 422 | `validation_error` | Body or query failed validation |

## Design notes

- **Passwords and tokens.** Passwords are hashed with bcrypt. Login returns the same error for an unknown email and a wrong password. JWTs carry a unique id (`jti`); logout stores it in `revoked_tokens` until natural expiry, so a logged-out token really stops working even though JWTs are stateless.
- **Authorization.** A task is visible to its creator, its assignee, and members of its team. Anything else returns 404 (not 403) so task ids cannot be probed. Tasks without a team are personal. Assignees must be team members. Only a task's creator or a team owner can delete it.
- **Teams.** Joining is by owner invitation (the owner adds an existing user by email); there is no email delivery. A team always keeps at least one owner. Removing a member unassigns their tasks in that team.
- **Data layer.** Plain SQL with parameterised queries, no ORM. Constraints live in the schema (`migrations/001_init.sql`): status and priority enums, `completed_at` must be set exactly when status is `completed`, case-insensitive unique email, cascading deletes. Team creation runs in a transaction. Search wildcards (`%`, `_`) typed by users are escaped.
- **Uploads.** Files are stored under random names; the original name is kept in the database only, so user-supplied names never reach the filesystem path.

## Project layout

```
migrations/        SQL schema, applied in order on startup
src/
  app.js           Express app and route wiring
  server.js        migrate + listen
  config.js        environment configuration
  db/              pool and migration runner
  middleware/      auth, validation, error handling
  routes/          auth, users, teams, tasks, comments, attachments, notifications, ai
  services/        access rules, SSE notifier, LLM provider
tests/             Jest + Supertest integration tests (real Postgres)
```
