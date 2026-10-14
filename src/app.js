const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const openapi = require('./openapi.json');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

const docsHtml = `<!doctype html>
<html lang="uz">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OsonNasiya API — Swagger</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.0/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.0/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      persistAuthorization: false
    });
  </script>
</body>
</html>`;

function createApp({ users, jwtSecret, corsOrigins = [], logger = console, now = Date.now }) {
  if (!users || !jwtSecret) throw new Error('users va jwtSecret kerak.');

  const app = express();
  const allowedOrigins = new Set(corsOrigins);
  const attempts = new Map();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin && allowedOrigins.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/openapi.json', (_req, res) => res.json(openapi));
  app.get('/docs', (_req, res) => res.type('html').send(docsHtml));

  app.post('/auth/login', async (req, res) => {
    const login = typeof req.body?.login === 'string' ? req.body.login.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!login || !password || login.length > 100 || password.length > 1024) {
      return res.status(400).json({ message: 'Login va parolni kiriting.' });
    }

    const key = `${req.ip}:${login}`;
    const previous = attempts.get(key);
    if (previous && previous.until > now() && previous.count >= MAX_FAILURES) {
      return res.status(429).json({ message: 'Urinishlar ko‘payib ketdi. 15 daqiqadan keyin qayta urinib ko‘ring.' });
    }

    try {
      const user = await users.findOne({ login, role: 'super_admin' });
      const valid = user && await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        const current = attempts.get(key);
        attempts.set(key, current && current.until > now()
          ? { count: current.count + 1, until: current.until }
          : { count: 1, until: now() + WINDOW_MS });
        return res.status(401).json({ message: 'Login yoki parol noto‘g‘ri.' });
      }

      attempts.delete(key);
      const token = jwt.sign({ role: 'super_admin' }, jwtSecret, {
        subject: user._id.toString(),
        expiresIn: '12h',
        issuer: 'osonnasiya',
      });
      res.set('Cache-Control', 'no-store');
      return res.json({ token, user: { id: user._id.toString(), login: user.login, role: 'super_admin' } });
    } catch (error) {
      logger.error('Login xatosi:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/auth/me', async (req, res) => {
    const token = req.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return res.status(401).json({ message: 'Sessiya topilmadi.' });

    try {
      const payload = jwt.verify(token, jwtSecret, { issuer: 'osonnasiya' });
      if (typeof payload === 'string' || !ObjectId.isValid(payload.sub)) {
        return res.status(401).json({ message: 'Sessiya tugadi.' });
      }
      const user = await users.findOne({ _id: new ObjectId(payload.sub), role: 'super_admin' });
      if (!user) return res.status(401).json({ message: 'Sessiya tugadi.' });
      res.set('Cache-Control', 'no-store');
      return res.json({ user: { id: user._id.toString(), login: user.login, role: 'super_admin' } });
    } catch (_error) {
      return res.status(401).json({ message: 'Sessiya tugadi.' });
    }
  });

  app.use((_req, res) => res.status(404).json({ message: 'Manzil topilmadi.' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ message: 'So‘rov formati noto‘g‘ri.' });
    }
    logger.error('So‘rov xatosi:', error);
    return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
  });

  return app;
}

module.exports = { createApp };
