const { ObjectId } = require('mongodb');
const { publicRegion } = require('./regions.presenter');

const REGION_CREATORS = new Set(['super_admin', 'sotuvchi']);

function registerRegionRoutes(app, { regions, customers, authenticate, logger, now }) {
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
      if (await customers.countDocuments({ regionId: res.locals.region._id }, { limit: 1 })) {
        return res.status(409).json({ message: 'Bu hududga mijozlar biriktirilgan.' });
      }
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
}

module.exports = { registerRegionRoutes };
