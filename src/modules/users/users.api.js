const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { STAFF_ROLES } = require('../../constants/roles');
const { publicUser } = require('./users.presenter');

function registerUserRoutes(app, { users, authenticate, requireSuperAdmin, logger, now }) {
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

  app.get('/users', authenticate, requireSuperAdmin, async (req, res) => {
    const search = req.query.search;
    if (search !== undefined && (typeof search !== 'string' || !search.trim() || search.trim().length > 100)) {
      return res.status(400).json({ message: 'Qidiruv so‘zini to‘g‘ri kiriting (100 belgigacha).' });
    }
    try {
      const filter = { role: { $in: [...STAFF_ROLES] } };
      if (search !== undefined) {
        const pattern = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ name: pattern }, { login: pattern }];
      }
      const staff = await users.find(filter)
        .project({ login: 1, role: 1, name: 1, description: 1 })
        .sort({ createdAt: -1 })
        .toArray();
      return res.json({ users: staff.map(publicUser) });
    } catch (error) {
      logger.error('Foydalanuvchilarni olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/users/:id', authenticate, requireSuperAdmin, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Foydalanuvchi ID noto‘g‘ri.' });
    }
    try {
      const user = await users.findOne({
        _id: new ObjectId(req.params.id),
        role: { $in: [...STAFF_ROLES] },
      });
      if (!user) return res.status(404).json({ message: 'Foydalanuvchi topilmadi.' });
      return res.json({ user: publicUser(user) });
    } catch (error) {
      logger.error('Foydalanuvchini olishda xatolik:', error);
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

}

module.exports = { registerUserRoutes };
