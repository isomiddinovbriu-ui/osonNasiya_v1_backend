const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const openapi = require('./openapi.json');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const STAFF_ROLES = new Set(['yiguvchi', 'sotuvchi']);
const ROLES = new Set(['super_admin', ...STAFF_ROLES]);
const REGION_CREATORS = new Set(['super_admin', 'sotuvchi']);

function publicUser(user) {
  return {
    id: user._id.toString(),
    login: user.login,
    role: user.role,
    name: user.name || '',
    description: user.description || '',
  };
}

function publicRegion(region) {
  return {
    id: region._id.toString(),
    name: region.name,
    description: region.description,
    createdBy: region.createdBy.toString(),
    createdAt: region.createdAt,
  };
}

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

function createApp({ users, loginRequests, regions, jwtSecret, corsOrigins = [], logger = console, now = Date.now }) {
  if (!users || !loginRequests || !regions || !jwtSecret) throw new Error('users, loginRequests, regions va jwtSecret kerak.');

  const app = express();
  const allowedOrigins = new Set(corsOrigins);
  const attempts = new Map();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin && allowedOrigins.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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
    let recordAttempted = false;
    const record = async (status, userId = null) => {
      recordAttempted = true;
      await loginRequests.insertOne({
        createdAt: new Date(now()),
        login,
        ip: req.ip,
        userAgent: req.get('User-Agent') || null,
        status,
        userId,
      });
    };
    if (!login || !password || login.length > 100 || password.length > 1024) {
      await record(400);
      return res.status(400).json({ message: 'Login va parolni kiriting.' });
    }

    const key = `${req.ip}:${login}`;
    const previous = attempts.get(key);
    if (previous && previous.until > now() && previous.count >= MAX_FAILURES) {
      await record(429);
      return res.status(429).json({ message: 'Urinishlar ko‘payib ketdi. 15 daqiqadan keyin qayta urinib ko‘ring.' });
    }

    try {
      const user = await users.findOne({ login });
      const valid = user && ROLES.has(user.role) && await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        const current = attempts.get(key);
        attempts.set(key, current && current.until > now()
          ? { count: current.count + 1, until: current.until }
          : { count: 1, until: now() + WINDOW_MS });
        await record(401);
        return res.status(401).json({ message: 'Login yoki parol noto‘g‘ri.' });
      }

      attempts.delete(key);
      const token = jwt.sign({ role: user.role }, jwtSecret, {
        subject: user._id.toString(),
        expiresIn: '12h',
        issuer: 'osonnasiya',
      });
      await record(200, user._id);
      res.set('Cache-Control', 'no-store');
      return res.json({ token, user: publicUser(user) });
    } catch (error) {
      logger.error('Login xatosi:', error);
      if (!recordAttempted) {
        try {
          await record(500);
        } catch (logError) {
          logger.error('Login so‘rovini yozishda xatolik:', logError);
        }
      }
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  async function authenticate(req, res, next) {
    const token = req.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return res.status(401).json({ message: 'Sessiya topilmadi.' });

    try {
      const payload = jwt.verify(token, jwtSecret, { issuer: 'osonnasiya' });
      if (typeof payload === 'string' || !ObjectId.isValid(payload.sub)) {
        return res.status(401).json({ message: 'Sessiya tugadi.' });
      }
      const user = await users.findOne({ _id: new ObjectId(payload.sub) });
      if (!user || !ROLES.has(user.role) || user.role !== payload.role) {
        return res.status(401).json({ message: 'Sessiya tugadi.' });
      }
      res.locals.currentUser = user;
      return next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
        return res.status(401).json({ message: 'Sessiya tugadi.' });
      }
      logger.error('Autentifikatsiya xatosi:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  }

  function requireSuperAdmin(_req, res, next) {
    if (res.locals.currentUser.role !== 'super_admin') {
      return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    }
    return next();
  }

  app.get('/auth/me', authenticate, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({ user: publicUser(res.locals.currentUser) });
  });

  app.post('/users', authenticate, requireSuperAdmin, async (req, res) => {
    const login = typeof req.body?.login === 'string' ? req.body.login.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role = req.body?.role;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = req.body?.description === undefined ? '' : req.body.description;
    if (!login || login.length > 100 || !/^\d{5}$/.test(password) ||
        !STAFF_ROLES.has(role) || !name || name.length > 100 ||
        typeof description !== 'string' || description.length > 1000) {
      return res.status(400).json({ message: 'Login, ism, 5 xonali raqamli parol va to‘g‘ri rolni kiriting.' });
    }

    try {
      const existing = await users.findOne({ login });
      if (existing) {
        const samePassword = await bcrypt.compare(password, existing.passwordHash);
        return res.status(409).json({ message: samePassword
          ? 'Bu login va parol oldin mavjud.'
          : 'Bu login allaqachon mavjud.' });
      }
      const document = {
        login,
        passwordHash: await bcrypt.hash(password, 12),
        role,
        name,
        description: description.trim(),
        createdAt: new Date(now()),
        createdBy: res.locals.currentUser._id,
      };
      const result = await users.insertOne(document);
      return res.status(201).json({ user: publicUser({ ...document, _id: result.insertedId }) });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ message: 'Bu login allaqachon mavjud.' });
      }
      logger.error('Foydalanuvchi yaratishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/users', authenticate, requireSuperAdmin, async (_req, res) => {
    try {
      const staff = await users.find({ role: { $in: [...STAFF_ROLES] } })
        .project({ login: 1, role: 1, name: 1, description: 1 })
        .sort({ createdAt: -1 })
        .toArray();
      return res.json({ users: staff.map(publicUser) });
    } catch (error) {
      logger.error('Foydalanuvchilarni olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.patch('/users/:id', authenticate, requireSuperAdmin, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Foydalanuvchi ID noto‘g‘ri.' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'O‘zgartiriladigan maydonlarni kiriting.' });
    }

    const allowedFields = new Set(['login', 'password', 'role', 'name', 'description']);
    const fields = Object.keys(req.body);
    if (!fields.length || fields.some((field) => !allowedFields.has(field))) {
      return res.status(400).json({ message: 'O‘zgartiriladigan maydonlarni to‘g‘ri kiriting.' });
    }

    const changes = {};
    if ('login' in req.body) {
      if (typeof req.body.login !== 'string') return res.status(400).json({ message: 'Login noto‘g‘ri.' });
      changes.login = req.body.login.trim().toLowerCase();
      if (!changes.login || changes.login.length > 100) return res.status(400).json({ message: 'Login noto‘g‘ri.' });
    }
    if ('name' in req.body) {
      if (typeof req.body.name !== 'string') return res.status(400).json({ message: 'Ism noto‘g‘ri.' });
      changes.name = req.body.name.trim();
      if (!changes.name || changes.name.length > 100) return res.status(400).json({ message: 'Ism noto‘g‘ri.' });
    }
    if ('description' in req.body) {
      if (typeof req.body.description !== 'string' || req.body.description.length > 1000) {
        return res.status(400).json({ message: 'Description noto‘g‘ri.' });
      }
      changes.description = req.body.description.trim();
    }
    if ('role' in req.body) {
      if (!STAFF_ROLES.has(req.body.role)) return res.status(400).json({ message: 'Rol noto‘g‘ri.' });
      changes.role = req.body.role;
    }
    if ('password' in req.body) {
      if (typeof req.body.password !== 'string' || !/^\d{5}$/.test(req.body.password)) {
        return res.status(400).json({ message: 'Parol 5 xonali raqam bo‘lishi kerak.' });
      }
    }

    try {
      if ('password' in req.body) {
        const current = await users.findOne({ _id: new ObjectId(req.params.id), role: { $in: [...STAFF_ROLES] } });
        if (!current) return res.status(404).json({ message: 'Foydalanuvchi topilmadi.' });
        if (await bcrypt.compare(req.body.password, current.passwordHash)) {
          return res.status(409).json({ message: 'Bu parol oldin mavjud.' });
        }
      }
      if ('password' in req.body) changes.passwordHash = await bcrypt.hash(req.body.password, 12);
      changes.updatedAt = new Date(now());
      changes.updatedBy = res.locals.currentUser._id;
      const updated = await users.findOneAndUpdate(
        { _id: new ObjectId(req.params.id), role: { $in: [...STAFF_ROLES] } },
        { $set: changes },
        { returnDocument: 'after' },
      );
      if (!updated) return res.status(404).json({ message: 'Foydalanuvchi topilmadi.' });
      return res.json({ user: publicUser(updated) });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ message: 'Bu login allaqachon mavjud.' });
      logger.error('Foydalanuvchini yangilashda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.post('/regions', authenticate, async (req, res) => {
    if (!REGION_CREATORS.has(res.locals.currentUser.role)) {
      return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = req.body?.description === undefined ? '' : req.body.description;
    if (!name || name.length > 100 || typeof description !== 'string' || description.length > 1000) {
      return res.status(400).json({ message: 'Hudud nomini to‘g‘ri kiriting (izoh 1000 belgigacha).' });
    }

    try {
      const document = {
        name,
        nameKey: name.toLocaleLowerCase('uz'),
        description: description.trim(),
        createdBy: res.locals.currentUser._id,
        createdAt: new Date(now()),
      };
      const result = await regions.insertOne(document);
      return res.status(201).json({ region: publicRegion({ ...document, _id: result.insertedId }) });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ message: 'Bu hudud allaqachon mavjud.' });
      logger.error('Hudud yaratishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/regions', authenticate, async (_req, res) => {
    try {
      const items = await regions.find({}).sort({ createdAt: -1 }).toArray();
      return res.json({ regions: items.map(publicRegion) });
    } catch (error) {
      logger.error('Hududlarni olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  async function loadRegion(req, res, next) {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Hudud ID noto‘g‘ri.' });
    }
    try {
      const region = await regions.findOne({ _id: new ObjectId(req.params.id) });
      if (!region) return res.status(404).json({ message: 'Hudud topilmadi.' });
      res.locals.region = region;
      return next();
    } catch (error) {
      logger.error('Hududni olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  }

  function requireRegionEditor(_req, res, next) {
    const currentUser = res.locals.currentUser;
    const region = res.locals.region;
    if (currentUser.role !== 'super_admin' &&
        (currentUser.role !== 'sotuvchi' || !region.createdBy.equals(currentUser._id))) {
      return res.status(403).json({ message: 'Bu hududni o‘zgartirishga ruxsat yo‘q.' });
    }
    return next();
  }

  app.get('/regions/:id', authenticate, loadRegion, (_req, res) => {
    return res.json({ region: publicRegion(res.locals.region) });
  });

  app.patch('/regions/:id', authenticate, loadRegion, requireRegionEditor, async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'O‘zgartiriladigan maydonlarni kiriting.' });
    }
    const fields = Object.keys(req.body);
    if (!fields.length || fields.some((field) => !['name', 'description'].includes(field))) {
      return res.status(400).json({ message: 'Faqat name va description maydonlarini o‘zgartirish mumkin.' });
    }

    const changes = {};
    if ('name' in req.body) {
      if (typeof req.body.name !== 'string') return res.status(400).json({ message: 'Hudud nomi noto‘g‘ri.' });
      changes.name = req.body.name.trim();
      if (!changes.name || changes.name.length > 100) return res.status(400).json({ message: 'Hudud nomi noto‘g‘ri.' });
      changes.nameKey = changes.name.toLocaleLowerCase('uz');
    }
    if ('description' in req.body) {
      if (typeof req.body.description !== 'string' || req.body.description.length > 1000) {
        return res.status(400).json({ message: 'Hudud izohi noto‘g‘ri.' });
      }
      changes.description = req.body.description.trim();
    }

    try {
      changes.updatedAt = new Date(now());
      changes.updatedBy = res.locals.currentUser._id;
      const filter = { _id: res.locals.region._id };
      if (res.locals.currentUser.role === 'sotuvchi') filter.createdBy = res.locals.currentUser._id;
      const updated = await regions.findOneAndUpdate(
        filter,
        { $set: changes },
        { returnDocument: 'after' },
      );
      if (!updated) return res.status(404).json({ message: 'Hudud topilmadi.' });
      return res.json({ region: publicRegion(updated) });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ message: 'Bu hudud allaqachon mavjud.' });
      logger.error('Hududni yangilashda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.delete('/regions/:id', authenticate, loadRegion, requireRegionEditor, async (_req, res) => {
    try {
      const filter = { _id: res.locals.region._id };
      if (res.locals.currentUser.role === 'sotuvchi') filter.createdBy = res.locals.currentUser._id;
      const result = await regions.deleteOne(filter);
      if (!result.deletedCount) return res.status(404).json({ message: 'Hudud topilmadi.' });
      return res.sendStatus(204);
    } catch (error) {
      logger.error('Hududni o‘chirishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.use((_req, res) => res.status(404).json({ message: 'Manzil topilmadi.' }));
  app.use(async (error, req, res, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      if (req.method === 'POST' && req.path === '/auth/login') {
        try {
          await loginRequests.insertOne({
            createdAt: new Date(now()),
            login: '',
            ip: req.ip,
            userAgent: req.get('User-Agent') || null,
            status: 400,
            userId: null,
          });
        } catch (logError) {
          logger.error('Login so‘rovini yozishda xatolik:', logError);
          return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
        }
      }
      return res.status(400).json({ message: 'So‘rov formati noto‘g‘ri.' });
    }
    logger.error('So‘rov xatosi:', error);
    return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
  });

  return app;
}

module.exports = { createApp };
