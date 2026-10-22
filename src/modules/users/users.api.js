const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const multer = require('multer');
const { ObjectId } = require('mongodb');
const { STAFF_ROLES } = require('../../constants/roles');
const { publicUser } = require('./users.presenter');

const uploadAvatar = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 5 * 1024 * 1024 } });

function imageType(buffer) {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', ext: 'png' };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function registerUserRoutes(app, { users, customers, authenticate, requireSuperAdmin, imageStorage, logger, now }) {
  const activeStaff = { role: { $in: [...STAFF_ROLES] }, deletedAt: { $exists: false } };
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
      const filter = { ...activeStaff };
      if (search !== undefined) {
        const pattern = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ name: pattern }, { login: pattern }];
      }
      const staff = await users.find(filter)
        .project({ login: 1, role: 1, name: 1, description: 1, avatar: 1 })
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
        ...activeStaff,
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
        const current = await users.findOne({ _id: new ObjectId(req.params.id), ...activeStaff });
        if (!current) return res.status(404).json({ message: 'Foydalanuvchi topilmadi.' });
        if (await bcrypt.compare(req.body.password, current.passwordHash)) {
          return res.status(409).json({ message: 'Bu parol oldin mavjud.' });
        }
      }
      if ('password' in req.body) changes.passwordHash = await bcrypt.hash(req.body.password, 12);
      changes.updatedAt = new Date(now());
      changes.updatedBy = res.locals.currentUser._id;
      const updated = await users.findOneAndUpdate(
        { _id: new ObjectId(req.params.id), ...activeStaff },
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

  app.delete('/users/:id', authenticate, requireSuperAdmin, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Foydalanuvchi ID noto‘g‘ri.' });
    try {
      const id = new ObjectId(req.params.id);
      const existing = await users.findOne({ _id: id, ...activeStaff });
      if (!existing) return res.status(404).json({ message: 'Xodim topilmadi.' });
      if (await customers.countDocuments({ assignedTo: id }, { limit: 1 })) {
        return res.status(409).json({ message: 'Xodimga biriktirilgan mijozlarni avval boshqa xodimga o‘tkazing.' });
      }
      const deletedAt = new Date(now());
      const deleted = await users.findOneAndUpdate({ _id: id, ...activeStaff }, {
        $set: { deletedAt, deletedBy: res.locals.currentUser._id, updatedAt: deletedAt },
        $unset: { avatar: '' },
      }, { returnDocument: 'before' });
      if (!deleted) return res.status(404).json({ message: 'Xodim topilmadi.' });
      if (deleted.avatar && imageStorage) {
        await imageStorage.removeObject(deleted.avatar.objectName).catch((error) => logger.error('O‘chirilgan xodim avatarini tozalashda xatolik:', error));
      }
      return res.sendStatus(204);
    } catch (error) {
      logger.error('Xodimni o‘chirishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  if (imageStorage) {
    app.put('/users/:id/avatar', authenticate, requireSuperAdmin, (req, res, next) => {
      uploadAvatar.single('avatar')(req, res, (error) => {
        if (error) return res.status(400).json({ message: 'Bitta avatar rasmini yuklang (5 MB gacha).' });
        next();
      });
    }, async (req, res) => {
      if (!ObjectId.isValid(req.params.id) || !req.file) {
        return res.status(400).json({ message: 'Xodim ID va avatar faylini kiriting.' });
      }
      const type = imageType(req.file.buffer);
      if (!type) return res.status(400).json({ message: 'Faqat JPEG, PNG yoki WebP rasm yuklang.' });

      const id = new ObjectId(req.params.id);
      const objectName = `users/${id}/avatar-${crypto.randomUUID()}.${type.ext}`;
      let saved = false;
      try {
        const existing = await users.findOne({ _id: id, ...activeStaff });
        if (!existing) return res.status(404).json({ message: 'Xodim topilmadi.' });
        await imageStorage.ensureBucket();
        await imageStorage.putObject(objectName, req.file.buffer, type.mime);
        saved = true;
        const filter = { _id: id, ...activeStaff,
          ...(existing.avatar ? { 'avatar.objectName': existing.avatar.objectName } : { avatar: { $exists: false } }) };
        const updated = await users.findOneAndUpdate(filter, {
          $set: { avatar: { objectName, mime: type.mime, size: req.file.buffer.length }, updatedAt: new Date(now()) },
        }, { returnDocument: 'after' });
        if (!updated) {
          await imageStorage.removeObject(objectName);
          return res.status(409).json({ message: 'Xodim avatari o‘zgargan. Qayta urinib ko‘ring.' });
        }
        if (existing.avatar) {
          await imageStorage.removeObject(existing.avatar.objectName).catch((error) => logger.error('Eski avatarni o‘chirishda xatolik:', error));
        }
        return res.json({ user: publicUser(updated) });
      } catch (error) {
        if (saved) await imageStorage.removeObject(objectName).catch((cleanupError) => logger.error('Avatarni tozalashda xatolik:', cleanupError));
        logger.error('Avatar yuklashda xatolik:', error);
        if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(error.code)) {
          return res.status(503).json({ message: 'Rasm saqlash xizmati hozir mavjud emas.' });
        }
        return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
      }
    });

    app.delete('/users/:id/avatar', authenticate, requireSuperAdmin, async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Foydalanuvchi ID noto‘g‘ri.' });
      try {
        const id = new ObjectId(req.params.id);
        const existing = await users.findOne({ _id: id, ...activeStaff });
        if (!existing) return res.status(404).json({ message: 'Xodim topilmadi.' });
        if (!existing.avatar) return res.status(404).json({ message: 'Avatar topilmadi.' });
        const updated = await users.findOneAndUpdate({ _id: id, ...activeStaff, 'avatar.objectName': existing.avatar.objectName },
          { $unset: { avatar: '' }, $set: { updatedAt: new Date(now()) } }, { returnDocument: 'after' });
        if (!updated) return res.status(409).json({ message: 'Xodim avatari o‘zgargan. Qayta urinib ko‘ring.' });
        await imageStorage.removeObject(existing.avatar.objectName).catch((error) => logger.error('Avatarni o‘chirishda xatolik:', error));
        return res.json({ user: publicUser(updated) });
      } catch (error) {
        logger.error('Avatarni o‘chirishda xatolik:', error);
        return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
      }
    });

    app.get('/api/public/avatars/:id', async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) return res.sendStatus(404);
      try {
        const user = await users.findOne({ _id: new ObjectId(req.params.id), ...activeStaff });
        if (!user?.avatar) return res.sendStatus(404);
        const stream = await imageStorage.getObject(user.avatar.objectName);
        res.set('Content-Type', user.avatar.mime);
        res.set('Content-Length', String(user.avatar.size));
        res.set('Content-Disposition', 'inline');
        res.set('Cache-Control', 'no-store');
        stream.on('error', (error) => {
          logger.error('Avatarni uzatishda xatolik:', error);
          if (!res.headersSent) res.status(500).end();
          else res.destroy(error);
        });
        return stream.pipe(res);
      } catch (error) {
        if (error.code === 'NoSuchKey' || error.code === 'NotFound') return res.sendStatus(404);
        logger.error('Avatarni olishda xatolik:', error);
        return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
      }
    });
  }

}

module.exports = { registerUserRoutes };
