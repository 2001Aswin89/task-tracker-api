process.env.NODE_ENV = 'test';

const request = require('supertest');
const { migrate } = require('../src/db/migrate');
const { pool } = require('../src/db/pool');
const { createApp } = require('../src/app');

let app;

beforeAll(async () => {
  await migrate();
  app = createApp();
});

beforeEach(async () => {
  await pool.query('TRUNCATE users, revoked_tokens, teams, tasks, comments, attachments, notifications RESTART IDENTITY CASCADE');
});

afterAll(() => pool.end());

async function register(name, email = `${name}@example.com`) {
  const res = await request(app).post('/api/auth/register').send({ name, email, password: 'password123' });
  expect(res.status).toBe(201);
  return { token: res.body.token, id: res.body.user.id, email };
}
const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

describe('auth', () => {
  test('register hashes the password and never returns it', async () => {
    const res = await request(app).post('/api/auth/register').send({ name: 'Ann', email: 'ann@example.com', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.user.password_hash).toBeUndefined();
    const { rows } = await pool.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).not.toContain('password123');
  });

  test('duplicate email (case-insensitive) is 409; weak password is 422', async () => {
    await register('ann', 'ann@example.com');
    const dup = await request(app).post('/api/auth/register').send({ name: 'A2', email: 'ANN@example.com', password: 'password123' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('conflict');
    const weak = await request(app).post('/api/auth/register').send({ name: 'B', email: 'b@example.com', password: 'short' });
    expect(weak.status).toBe(422);
    expect(weak.body.code).toBe('validation_error');
  });

  test('login success, wrong password, and protected route without token', async () => {
    await register('ann');
    const ok = await request(app).post('/api/auth/login').send({ email: 'ann@example.com', password: 'password123' });
    expect(ok.status).toBe(200);
    const bad = await request(app).post('/api/auth/login').send({ email: 'ann@example.com', password: 'nope-nope' });
    expect(bad.status).toBe(401);
    expect((await request(app).get('/api/users/me')).status).toBe(401);
  });

  test('logout revokes the token', async () => {
    const ann = await register('ann');
    expect((await request(app).get('/api/users/me').set(auth(ann))).status).toBe(200);
    expect((await request(app).post('/api/auth/logout').set(auth(ann))).status).toBe(204);
    const after = await request(app).get('/api/users/me').set(auth(ann));
    expect(after.status).toBe(401);
  });

  test('profile view and update', async () => {
    const ann = await register('ann');
    const res = await request(app).patch('/api/users/me').set(auth(ann)).send({ name: 'Ann B', bio: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: 'Ann B', bio: 'hello', email: 'ann@example.com' });
    expect((await request(app).patch('/api/users/me').set(auth(ann)).send({})).status).toBe(422);
  });
});

describe('tasks', () => {
  test('create, list assigned, filter by status, search, complete', async () => {
    const ann = await register('ann');
    const create = (body) => request(app).post('/api/tasks').set(auth(ann)).send(body);
    const t1 = await create({ title: 'Write report', description: 'quarterly numbers', due_date: '2026-12-31', assignee_id: ann.id });
    expect(t1.status).toBe(201);
    await create({ title: 'Buy milk', description: 'and eggs', assignee_id: ann.id });

    const mine = await request(app).get('/api/tasks?assignee=me').set(auth(ann));
    expect(mine.body.tasks).toHaveLength(2);

    const done = await request(app).post(`/api/tasks/${t1.body.task.id}/complete`).set(auth(ann));
    expect(done.body.task.status).toBe('completed');
    expect(done.body.task.completed_at).toBeTruthy();

    const open = await request(app).get('/api/tasks?status=open').set(auth(ann));
    expect(open.body.tasks.map((t) => t.title)).toEqual(['Buy milk']);

    const search = await request(app).get('/api/tasks?q=quarterly').set(auth(ann));
    expect(search.body.tasks.map((t) => t.title)).toEqual(['Write report']);
    // LIKE wildcards in the search are matched literally.
    expect((await request(app).get('/api/tasks?q=%25').set(auth(ann))).body.tasks).toHaveLength(0);

    const sorted = await request(app).get('/api/tasks?sort=title&order=asc').set(auth(ann));
    expect(sorted.body.tasks.map((t) => t.title)).toEqual(['Buy milk', 'Write report']);
    expect(sorted.body.pagination.total).toBe(2);
  });

  test('validation errors use the standard error shape', async () => {
    const ann = await register('ann');
    const res = await request(app).post('/api/tasks').set(auth(ann)).send({ title: '', due_date: 'tomorrow-ish' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'validation_error' });
    expect(res.body.details.length).toBeGreaterThan(0);
    expect((await request(app).get('/api/tasks?status=bogus').set(auth(ann))).status).toBe(422);
    expect((await request(app).get('/api/tasks/abc').set(auth(ann))).status).toBe(400);
  });

  test('uncompleting clears completed_at', async () => {
    const ann = await register('ann');
    const t = (await request(app).post('/api/tasks').set(auth(ann)).send({ title: 'x' })).body.task;
    await request(app).post(`/api/tasks/${t.id}/complete`).set(auth(ann));
    const re = await request(app).patch(`/api/tasks/${t.id}`).set(auth(ann)).send({ status: 'open' });
    expect(re.body.task.completed_at).toBeNull();
  });
});

describe('teams and collaboration', () => {
  async function setup() {
    const ann = await register('ann');
    const bob = await register('bob');
    const cat = await register('cat');
    const team = (await request(app).post('/api/teams').set(auth(ann)).send({ name: 'Apollo' })).body.team;
    await request(app).post(`/api/teams/${team.id}/members`).set(auth(ann)).send({ email: bob.email }).expect(201);
    return { ann, bob, cat, team };
  }

  test('only owners add members; duplicates conflict; unknown email is 404', async () => {
    const { ann, bob, cat, team } = await setup();
    expect((await request(app).post(`/api/teams/${team.id}/members`).set(auth(bob)).send({ email: cat.email })).status).toBe(403);
    expect((await request(app).post(`/api/teams/${team.id}/members`).set(auth(ann)).send({ email: bob.email })).status).toBe(409);
    expect((await request(app).post(`/api/teams/${team.id}/members`).set(auth(ann)).send({ email: 'nobody@example.com' })).status).toBe(404);
    expect((await request(app).get(`/api/teams/${team.id}`).set(auth(cat))).status).toBe(403);
  });

  test('assignment is limited to team members and notifies the assignee', async () => {
    const { ann, bob, cat, team } = await setup();
    const bad = await request(app).post('/api/tasks').set(auth(ann)).send({ title: 'T', team_id: team.id, assignee_id: cat.id });
    expect(bad.status).toBe(400);

    const ok = await request(app).post('/api/tasks').set(auth(ann)).send({ title: 'Ship it', team_id: team.id, assignee_id: bob.id });
    expect(ok.status).toBe(201);
    const notes = await request(app).get('/api/notifications').set(auth(bob));
    expect(notes.body.notifications[0]).toMatchObject({ type: 'task_assigned', task_id: ok.body.task.id });
    // Actors are not notified about their own actions.
    expect((await request(app).get('/api/notifications').set(auth(ann))).body.notifications).toHaveLength(0);

    // Bob sees it in his assigned list; Cat (outsider) cannot see it at all.
    expect((await request(app).get('/api/tasks?assignee=me').set(auth(bob))).body.tasks).toHaveLength(1);
    expect((await request(app).get(`/api/tasks/${ok.body.task.id}`).set(auth(cat))).status).toBe(404);
  });

  test('comments and attachments: members can add, outsiders cannot, authors delete own comments', async () => {
    const { ann, bob, cat, team } = await setup();
    const task = (await request(app).post('/api/tasks').set(auth(ann)).send({ title: 'Doc', team_id: team.id })).body.task;

    const c = await request(app).post(`/api/tasks/${task.id}/comments`).set(auth(bob)).send({ body: 'On it' });
    expect(c.status).toBe(201);
    expect((await request(app).post(`/api/tasks/${task.id}/comments`).set(auth(cat)).send({ body: 'hi' })).status).toBe(404);
    expect((await request(app).delete(`/api/comments/${c.body.comment.id}`).set(auth(ann))).status).toBe(403);
    expect((await request(app).get(`/api/tasks/${task.id}/comments`).set(auth(ann))).body.comments).toHaveLength(1);

    const up = await request(app)
      .post(`/api/tasks/${task.id}/attachments`)
      .set(auth(bob))
      .attach('file', Buffer.from('hello world'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(up.status).toBe(201);
    expect(up.body.attachment.original_name).toBe('notes.txt');
    const dl = await request(app)
      .get(`/api/attachments/${up.body.attachment.id}/download`)
      .set(auth(ann))
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('notes.txt');
    expect(dl.body.toString()).toBe('hello world');
    expect((await request(app).get(`/api/attachments/${up.body.attachment.id}/download`).set(auth(cat))).status).toBe(404);

    const exe = await request(app)
      .post(`/api/tasks/${task.id}/attachments`)
      .set(auth(bob))
      .attach('file', Buffer.from('MZ'), { filename: 'bad.exe', contentType: 'application/x-msdownload' });
    expect(exe.status).toBe(415);
    await request(app).delete(`/api/attachments/${up.body.attachment.id}`).set(auth(bob)).expect(204);
  });

  test('only the creator or a team owner can delete a task', async () => {
    const { ann, bob, team } = await setup();
    const task = (await request(app).post('/api/tasks').set(auth(bob)).send({ title: 'Bob task', team_id: team.id })).body.task;
    const t2 = (await request(app).post('/api/tasks').set(auth(ann)).send({ title: 'Ann task', team_id: team.id })).body.task;
    expect((await request(app).delete(`/api/tasks/${t2.id}`).set(auth(bob))).status).toBe(403);
    expect((await request(app).delete(`/api/tasks/${task.id}`).set(auth(ann))).status).toBe(204); // owner
  });
});

describe('ai', () => {
  test('returns a suggestion (mock provider in tests) and validates input', async () => {
    const ann = await register('ann');
    const res = await request(app).post('/api/ai/task-description').set(auth(ann)).send({ prompt: 'prepare launch checklist' });
    expect(res.status).toBe(200);
    expect(res.body.suggestion.title).toBeTruthy();
    expect(res.body.suggestion.description).toBeTruthy();
    expect((await request(app).post('/api/ai/task-description').set(auth(ann)).send({})).status).toBe(422);
  });
});
