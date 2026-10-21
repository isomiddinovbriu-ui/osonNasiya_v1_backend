const crypto = require('node:crypto');
const multer = require('multer');
const { ObjectId } = require('mongodb');
const { nextProductUniversalId } = require('./product-id.service');

const MAX_IMAGES = 10;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { files: MAX_IMAGES, fileSize: MAX_IMAGE_SIZE } });

function imageType(buffer) {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', ext: 'png' };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function publicCategory(item) {
  return {
    id: item._id.toString(), name: item.name,
    parentId: item.parentId?.toString() || null,
    createdBy: item.createdBy.toString(), createdAt: item.createdAt,
    updatedAt: item.updatedAt || null,
  };
}

function publicProduct(item) {
  return {
    id: item._id.toString(), universalId: item.universalId, categoryId: item.categoryId.toString(),
    name: item.name, title: item.title,
    originalPrice: item.originalPrice ?? null,
    minSellingPrice: item.minSellingPrice ?? null,
    warrantyPeriod: item.warrantyMonths == null ? null : `${Math.floor(item.warrantyMonths / 12)}${item.warrantyMonths % 12 ? `.${item.warrantyMonths % 12}` : ''}`,
    images: (item.images || []).map((image) => ({
      id: image._id.toString(), publicId: image.publicId,
      url: `/api/public/files/${image.publicId}`,
    })),
    createdBy: item.createdBy.toString(), createdAt: item.createdAt,
    updatedAt: item.updatedAt || null,
  };
}

function searchPattern(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function parseWarrantyMonths(value) {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const years = Number(match[1]);
  const months = match[2] === undefined ? 0 : Number(match[2]);
  const total = years * 12 + months;
  return months < 12 && Number.isSafeInteger(total) && total > 0 ? total : null;
}

function registerCatalogRoutes(app, { authenticate, productCategories: categories, products, customers, counters, imageStorage, logger, now }) {
  function editor(_req, res, next) {
    if (!['product_creator', 'super_admin'].includes(res.locals.currentUser.role)) {
      return res.status(403).json({ message: 'Bu amal uchun product_creator yoki super_admin roli kerak.' });
    }
    next();
  }

  function validName(value) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100; }
  function key(name) { return name.toLocaleLowerCase('uz'); }
  function fail(res, error, context) {
    if (error.code === 11000) return res.status(409).json({ message: 'Bu nom shu guruhda allaqachon mavjud.' });
    logger.error(context, error);
    return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
  }

  app.post('/product-categories', authenticate, editor, async (req, res) => {
    const { name, parentId = null } = req.body || {};
    if (!validName(name) || (parentId !== null && !ObjectId.isValid(parentId))) return res.status(400).json({ message: 'Kategoriya nomi yoki parentId noto‘g‘ri.' });
    try {
      if (parentId) {
        const parent = await categories.findOne({ _id: new ObjectId(parentId) });
        if (!parent) return res.status(404).json({ message: 'Asosiy guruh topilmadi.' });
        if (parent.parentId) return res.status(400).json({ message: 'Faqat ikki darajali guruhlar mumkin.' });
      }
      const document = { name: name.trim(), nameKey: key(name.trim()), parentId: parentId ? new ObjectId(parentId) : null,
        createdBy: res.locals.currentUser._id, createdAt: new Date(now()) };
      const result = await categories.insertOne(document);
      return res.status(201).json({ category: publicCategory({ ...document, _id: result.insertedId }) });
    } catch (error) { return fail(res, error, 'Kategoriya yaratishda xatolik:'); }
  });

  app.get('/product-categories', authenticate, async (req, res) => {
    const parentId = req.query.parentId;
    if (parentId !== undefined && parentId !== 'null' && !ObjectId.isValid(parentId)) return res.status(400).json({ message: 'parentId noto‘g‘ri.' });
    const search = req.query.search;
    if (search !== undefined && (typeof search !== 'string' || !search.trim() || search.trim().length > 100)) {
      return res.status(400).json({ message: 'Qidiruv so‘zini kiriting (100 belgigacha).' });
    }
    const filter = parentId === undefined ? {} : { parentId: parentId === 'null' ? null : new ObjectId(parentId) };
    if (search !== undefined) filter.name = searchPattern(search.trim());
    try {
      const items = await categories.find(filter).sort({ createdAt: -1, _id: -1 }).toArray();
      return res.json({ categories: items.map(publicCategory) });
    } catch (error) { return fail(res, error, 'Kategoriyalarni olishda xatolik:'); }
  });

  app.get('/product-categories/:id', authenticate, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Kategoriya ID noto‘g‘ri.' });
    try {
      const category = await categories.findOne({ _id: new ObjectId(req.params.id) });
      return category ? res.json({ category: publicCategory(category) }) : res.status(404).json({ message: 'Kategoriya topilmadi.' });
    } catch (error) { return fail(res, error, 'Kategoriyani olishda xatolik:'); }
  });

  app.patch('/product-categories/:id', authenticate, editor, async (req, res) => {
    if (!ObjectId.isValid(req.params.id) || !req.body || Object.keys(req.body).length !== 1 || !validName(req.body.name)) return res.status(400).json({ message: 'Kategoriya ID va nomini kiriting.' });
    try {
      const name = req.body.name.trim();
      const updated = await categories.findOneAndUpdate({ _id: new ObjectId(req.params.id) },
        { $set: { name, nameKey: key(name), updatedAt: new Date(now()) } }, { returnDocument: 'after' });
      return updated ? res.json({ category: publicCategory(updated) }) : res.status(404).json({ message: 'Kategoriya topilmadi.' });
    } catch (error) { return fail(res, error, 'Kategoriyani yangilashda xatolik:'); }
  });

  app.delete('/product-categories/:id', authenticate, editor, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Kategoriya ID noto‘g‘ri.' });
    try {
      const id = new ObjectId(req.params.id);
      if (!await categories.findOne({ _id: id })) return res.status(404).json({ message: 'Kategoriya topilmadi.' });
      if (await categories.countDocuments({ parentId: id }, { limit: 1 }) || await products.countDocuments({ categoryId: id }, { limit: 1 })) {
        return res.status(409).json({ message: 'Kategoriyada bo‘lim yoki mahsulot mavjud.' });
      }
      await categories.deleteOne({ _id: id });
      return res.sendStatus(204);
    } catch (error) { return fail(res, error, 'Kategoriyani o‘chirishda xatolik:'); }
  });

  async function validLeaf(categoryId) {
    const category = await categories.findOne({ _id: new ObjectId(categoryId) });
    return category && category.parentId ? category : null;
  }

  app.post('/products', authenticate, editor, async (req, res) => {
    const { name, title, categoryId, originalPrice, minSellingPrice, warrantyPeriod } = req.body || {};
    const warrantyMonths = parseWarrantyMonths(warrantyPeriod);
    if (!validName(name) || typeof title !== 'string' || !title.trim() || title.length > 200 ||
        !ObjectId.isValid(categoryId) || !Number.isSafeInteger(originalPrice) || originalPrice <= 0 ||
        !Number.isSafeInteger(minSellingPrice) || minSellingPrice <= 0 || warrantyMonths === null) {
      return res.status(400).json({ message: 'Mahsulot nomi, sarlavhasi, bo‘limi, narxlari va kafolat muddatini to‘g‘ri kiriting.' });
    }
    try {
      const category = await validLeaf(categoryId);
      if (!category) return res.status(404).json({ message: 'Mahsulot bo‘limi topilmadi.' });
      const document = { name: name.trim(), title: title.trim(), categoryId: category._id,
        originalPrice, minSellingPrice, warrantyMonths, images: [],
        createdBy: res.locals.currentUser._id, createdAt: new Date(now()) };
      document.universalId = await nextProductUniversalId(counters, document.createdAt);
      const result = await products.insertOne(document);
      return res.status(201).json({ product: publicProduct({ ...document, _id: result.insertedId }) });
    } catch (error) { return fail(res, error, 'Mahsulot yaratishda xatolik:'); }
  });

  app.get('/products', authenticate, async (req, res) => {
    const categoryId = req.query.categoryId;
    if (categoryId !== undefined && !ObjectId.isValid(categoryId)) return res.status(400).json({ message: 'categoryId noto‘g‘ri.' });
    try {
      const items = await products.find(categoryId ? { categoryId: new ObjectId(categoryId) } : {}).sort({ createdAt: -1 }).toArray();
      return res.json({ products: items.map(publicProduct) });
    } catch (error) { return fail(res, error, 'Mahsulotlarni olishda xatolik:'); }
  });

  app.get('/products/search', authenticate, async (req, res) => {
    const search = req.query.search;
    if (typeof search !== 'string' || !search.trim() || search.trim().length > 100) {
      return res.status(400).json({ message: 'Qidiruv so‘zini kiriting (100 belgigacha).' });
    }
    try {
      const pattern = searchPattern(search.trim());
      const matchingCategories = await categories.find({ name: pattern }).toArray();
      const groupIds = matchingCategories.filter((item) => !item.parentId).map((item) => item._id);
      const sections = groupIds.length ? await categories.find({ parentId: { $in: groupIds } }).toArray() : [];
      const sectionIds = [...matchingCategories.filter((item) => item.parentId), ...sections].map((item) => item._id);
      const items = await products.find({ $or: [
        { name: pattern }, { title: pattern }, { universalId: pattern }, { categoryId: { $in: sectionIds } },
      ] }).sort({ createdAt: -1 }).toArray();
      return res.json({ products: items.map(publicProduct) });
    } catch (error) { return fail(res, error, 'Mahsulotlarni qidirishda xatolik:'); }
  });

  app.get('/products/:id', authenticate, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Mahsulot ID noto‘g‘ri.' });
    try {
      const product = await products.findOne({ _id: new ObjectId(req.params.id) });
      return product ? res.json({ product: publicProduct(product) }) : res.status(404).json({ message: 'Mahsulot topilmadi.' });
    } catch (error) { return fail(res, error, 'Mahsulotni olishda xatolik:'); }
  });

  app.patch('/products/:id', authenticate, editor, async (req, res) => {
    if (!ObjectId.isValid(req.params.id) || !req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        !Object.keys(req.body).length || Object.keys(req.body).some((field) => !['name', 'title', 'categoryId', 'originalPrice', 'minSellingPrice', 'warrantyPeriod'].includes(field))) return res.status(400).json({ message: 'Mahsulot maydonlarini to‘g‘ri kiriting.' });
    const changes = {};
    if ('name' in req.body) {
      if (!validName(req.body.name)) return res.status(400).json({ message: 'Mahsulot nomi noto‘g‘ri.' });
      changes.name = req.body.name.trim();
    }
    if ('title' in req.body) {
      if (typeof req.body.title !== 'string' || !req.body.title.trim() || req.body.title.length > 200) return res.status(400).json({ message: 'Sarlavha noto‘g‘ri.' });
      changes.title = req.body.title.trim();
    }
    if ('originalPrice' in req.body) {
      if (!Number.isSafeInteger(req.body.originalPrice) || req.body.originalPrice <= 0) {
        return res.status(400).json({ message: 'Asl narx musbat butun son bo‘lishi kerak.' });
      }
      changes.originalPrice = req.body.originalPrice;
    }
    if ('minSellingPrice' in req.body) {
      if (!Number.isSafeInteger(req.body.minSellingPrice) || req.body.minSellingPrice <= 0) {
        return res.status(400).json({ message: 'Eng past sotilish narxi musbat butun son bo‘lishi kerak.' });
      }
      changes.minSellingPrice = req.body.minSellingPrice;
    }
    if ('warrantyPeriod' in req.body) {
      const warrantyMonths = parseWarrantyMonths(req.body.warrantyPeriod);
      if (warrantyMonths === null) return res.status(400).json({ message: 'Kafolat muddati noto‘g‘ri.' });
      changes.warrantyMonths = warrantyMonths;
    }
    if ('categoryId' in req.body) {
      if (!ObjectId.isValid(req.body.categoryId)) return res.status(400).json({ message: 'Bo‘lim ID noto‘g‘ri.' });
      try {
        const category = await validLeaf(req.body.categoryId);
        if (!category) return res.status(404).json({ message: 'Mahsulot bo‘limi topilmadi.' });
        changes.categoryId = category._id;
      } catch (error) { return fail(res, error, 'Bo‘limni olishda xatolik:'); }
    }
    try {
      changes.updatedAt = new Date(now());
      const updated = await products.findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: changes }, { returnDocument: 'after' });
      return updated ? res.json({ product: publicProduct(updated) }) : res.status(404).json({ message: 'Mahsulot topilmadi.' });
    } catch (error) { return fail(res, error, 'Mahsulotni yangilashda xatolik:'); }
  });

  app.delete('/products/:id', authenticate, editor, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Mahsulot ID noto‘g‘ri.' });
    try {
      const id = new ObjectId(req.params.id);
      if (await customers.countDocuments({ productId: id }, { limit: 1 })) {
        return res.status(409).json({ message: 'Bu mahsulot mijoz savdosiga biriktirilgan.' });
      }
      const product = await products.findOneAndDelete({ _id: id });
      if (!product) return res.status(404).json({ message: 'Mahsulot topilmadi.' });
      const removed = await Promise.allSettled((product.images || []).map((image) => imageStorage.removeObject(image.objectName)));
      removed.forEach((result) => { if (result.status === 'rejected') logger.error('MinIO rasmini o‘chirishda xatolik:', result.reason); });
      return res.sendStatus(204);
    } catch (error) { return fail(res, error, 'Mahsulotni o‘chirishda xatolik:'); }
  });

  app.post('/products/:id/images', authenticate, editor, (req, res, next) => {
    upload.array('images', MAX_IMAGES)(req, res, (error) => {
      if (error) return res.status(400).json({ message: 'Rasmlar soni yoki hajmi cheklovdan oshdi (10 ta, har biri 5 MB).' });
      next();
    });
  }, async (req, res) => {
    if (!ObjectId.isValid(req.params.id) || !req.files?.length) return res.status(400).json({ message: 'Mahsulot ID va images fayllarini kiriting.' });
    const types = req.files.map((file) => imageType(file.buffer));
    if (types.some((type) => !type)) return res.status(400).json({ message: 'Faqat JPEG, PNG yoki WebP rasm yuklang.' });
    const saved = [];
    try {
      const id = new ObjectId(req.params.id);
      const existing = await products.findOne({ _id: id });
      if (!existing) return res.status(404).json({ message: 'Mahsulot topilmadi.' });
      if ((existing.images || []).length + req.files.length > MAX_IMAGES) return res.status(409).json({ message: 'Bitta mahsulotga 10 tagacha rasm mumkin.' });
      await imageStorage.ensureBucket();
      for (let index = 0; index < req.files.length; index++) {
        const publicId = crypto.randomUUID();
        const objectName = `products/${id}/${crypto.randomUUID()}.${types[index].ext}`;
        await imageStorage.putObject(objectName, req.files[index].buffer, types[index].mime);
        saved.push({ _id: new ObjectId(), publicId, objectName, mime: types[index].mime, size: req.files[index].buffer.length });
      }
      const updated = await products.findOneAndUpdate(
        { _id: id, $expr: { $lte: [{ $size: '$images' }, MAX_IMAGES - saved.length] } },
        { $push: { images: { $each: saved } }, $set: { updatedAt: new Date(now()) } }, { returnDocument: 'after' });
      if (!updated) {
        await Promise.allSettled(saved.map((image) => imageStorage.removeObject(image.objectName)));
        return res.status(409).json({ message: 'Mahsulot o‘zgardi yoki rasm limiti to‘ldi.' });
      }
      return res.status(201).json({ product: publicProduct(updated) });
    } catch (error) {
      await Promise.allSettled(saved.map((image) => imageStorage.removeObject(image.objectName)));
      if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(error.code)) {
        logger.error('MinIO ulanish xatosi:', error);
        return res.status(503).json({ message: 'Rasm saqlash xizmati hozir mavjud emas.' });
      }
      return fail(res, error, 'Rasm yuklashda xatolik:');
    }
  });

  app.get('/api/public/files/:publicId', async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.publicId)) return res.sendStatus(404);
    try {
      const product = await products.findOne({ 'images.publicId': req.params.publicId });
      if (!product) return res.sendStatus(404);
      const image = product.images.find((item) => item.publicId === req.params.publicId);
      const stream = await imageStorage.getObject(image.objectName);
      res.set('Content-Type', image.mime);
      res.set('Content-Length', String(image.size));
      res.set('Content-Disposition', 'inline');
      stream.on('error', (error) => {
        logger.error('MinIO rasmini uzatishda xatolik:', error);
        if (!res.headersSent) res.status(500).end();
        else res.destroy(error);
      });
      return stream.pipe(res);
    } catch (error) {
      if (error.code === 'NoSuchKey' || error.code === 'NotFound') return res.sendStatus(404);
      return fail(res, error, 'Rasmni olishda xatolik:');
    }
  });

  app.delete('/products/:id/images/:imageId', authenticate, editor, async (req, res) => {
    if (!ObjectId.isValid(req.params.id) || !ObjectId.isValid(req.params.imageId)) return res.status(400).json({ message: 'Mahsulot yoki rasm ID noto‘g‘ri.' });
    try {
      const id = new ObjectId(req.params.id);
      const imageId = new ObjectId(req.params.imageId);
      const product = await products.findOne({ _id: id, 'images._id': imageId });
      if (!product) return res.status(404).json({ message: 'Rasm topilmadi.' });
      const image = product.images.find((item) => item._id.equals(imageId));
      const updated = await products.findOneAndUpdate({ _id: id, 'images._id': imageId },
        { $pull: { images: { _id: imageId } }, $set: { updatedAt: new Date(now()) } }, { returnDocument: 'after' });
      if (!updated) return res.status(404).json({ message: 'Rasm topilmadi.' });
      await imageStorage.removeObject(image.objectName).catch((error) => logger.error('MinIO rasmini o‘chirishda xatolik:', error));
      return res.json({ product: publicProduct(updated) });
    } catch (error) { return fail(res, error, 'Rasmni o‘chirishda xatolik:'); }
  });
}

module.exports = { registerCatalogRoutes };
