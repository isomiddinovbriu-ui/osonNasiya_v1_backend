const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { createApp } = require('../src/app');
const { readConfig } = require('../src/config');
const openapi = require('../src/openapi.json');

const id = new ObjectId();
const user = {
  _id: id,
  login: 'admin',
  role: 'super_admin',
  passwordHash: bcrypt.hashSync('long-test-password', 4),
};
const users = {
  async findOne(query) {
    if (query.role !== 'super_admin') return null;
    if (query.login) return query.login === user.login ? user : null;
    if (query._id) return query._id.equals(id) ? user : null;
    return null;
  },
};

let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve) => {
    const listener = createApp({
      users,
      jwtSecret: 'a-test-secret-longer-than-thirty-two-characters',
      corsOrigins: ['http://localhost:8081'],
    }).listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('health and OpenAPI describe the running endpoints', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const spec = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(spec.status, 200);
  const body = await spec.json();
  assert.equal(body.openapi, openapi.openapi);
  assert.deepEqual(Object.keys(body.paths).sort(), ['/auth/login', '/auth/me', '/health']);

  const docs = await fetch(`${baseUrl}/docs`);
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /SwaggerUIBundle/);
});

test('mobile login contract returns a token and /auth/me returns the user', async () => {
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: ' ADMIN ', password: 'long-test-password' }),
  });
  assert.equal(login.status, 200);
  const body = await login.json();
  assert.equal(typeof body.token, 'string');
  assert.deepEqual(body.user, { id: id.toString(), login: 'admin', role: 'super_admin' });

  const me = await fetch(`${baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${body.token}` },
  });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { user: body.user });
});

test('bad credentials, missing token and malformed JSON are rejected', async () => {
  const badLogin = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'wrong-password' }),
  });
  assert.equal(badLogin.status, 401);

  const me = await fetch(`${baseUrl}/auth/me`);
  assert.equal(me.status, 401);

  const malformed = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
});

test('CORS only allows configured web origin', async () => {
  const allowed = await fetch(`${baseUrl}/health`, { headers: { Origin: 'http://localhost:8081' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:8081');

  const denied = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://unrelated.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('configuration rejects placeholder secrets', () => {
  assert.throws(() => readConfig({
    MONGODB_URI: 'mongodb://127.0.0.1:27017/osonnasiya',
    JWT_SECRET: 'replace-with-a-random-secret-at-least-32-characters',
  }), /JWT_SECRET/);
});
