const { ObjectId } = require('mongodb');
const { localDate, validDate } = require('../reports/reports.service');

function publicPlan(plan, today) {
  return {
    id: plan._id.toString(), regionId: plan.regionId.toString(), ownerId: plan.ownerId.toString(),
    date: plan.date, status: plan.date < today ? 'closed' : plan.status,
    createdAt: plan.createdAt, closedAt: plan.closedAt ?? null,
    paymentCount: plan.paymentCount ?? 0, totalAmount: plan.totalAmount ?? 0,
    payments: (plan.payments ?? []).map((item) => ({
      paymentId: item.paymentId.toString(), customerId: item.customerId.toString(),
      mijoz_id: item.mijoz_id, amount: item.amount, receivedBy: item.receivedBy.toString(),
      paidAt: item.paidAt, status: item.status ?? 'active',
    })),
  };
}

async function closeExpiredPlans(dailyPlans, nowDate) {
  await dailyPlans.updateMany(
    { date: { $lt: localDate(nowDate) }, status: 'open' },
    { $set: { status: 'closed', closedAt: nowDate, closeReason: 'day_end' } },
  );
}

function registerDailyPlanRoutes(app, { authenticate, dailyPlans, regions, customers, logger, now }) {
  app.post('/daily-plans', authenticate, async (req, res) => {
    const actor = res.locals.currentUser;
    if (actor.role !== 'yiguvchi') return res.status(403).json({ message: 'Rejani faqat yig‘uvchi ochadi.' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some((key) => !['regionId', 'date'].includes(key)) ||
        !ObjectId.isValid(body.regionId) || (body.date !== undefined && !validDate(body.date))) {
      return res.status(400).json({ message: 'regionId va date (YYYY-MM-DD) ni to‘g‘ri kiriting.' });
    }
    const nowDate = new Date(now());
    const date = body.date ?? localDate(nowDate);
    if (date < localDate(nowDate)) return res.status(400).json({ message: 'O‘tgan kun uchun reja ochib bo‘lmaydi.' });
    try {
      const regionId = new ObjectId(body.regionId);
      if (!await regions.findOne({ _id: regionId })) return res.status(404).json({ message: 'Hudud topilmadi.' });
      async function useExisting(existing) {
        if (!existing.ownerId.equals(actor._id)) {
          return res.status(409).json({ message: 'Bu hudud uchun shu kunda boshqa yig‘uvchining rejasi mavjud.' });
        }
        if (existing.status !== 'closed') {
          return res.status(409).json({ message: 'Bu hudud uchun shu kunda reja allaqachon ochilgan.' });
        }
        const reopened = await dailyPlans.findOneAndUpdate(
          { _id: existing._id, ownerId: actor._id, date, status: 'closed' },
          { $set: { status: 'open', closedAt: null, closeReason: null } },
          { returnDocument: 'after' },
        );
        if (!reopened) return res.status(409).json({ message: 'Reja allaqachon ochilgan.' });
        return res.json({ plan: publicPlan(reopened, localDate(nowDate)) });
      }
      const existing = await dailyPlans.findOne({ regionId, date });
      if (existing) return await useExisting(existing);
      const plan = { regionId, regionDateKey: `${regionId}:${date}`, ownerId: actor._id, date, status: 'open', createdAt: nowDate,
        closedAt: null, paymentCount: 0, totalAmount: 0, payments: [] };
      let result;
      try {
        result = await dailyPlans.insertOne(plan);
      } catch (error) {
        if (error.code !== 11000) throw error;
        const concurrent = await dailyPlans.findOne({ regionId, date });
        if (!concurrent) throw error;
        return await useExisting(concurrent);
      }
      return res.status(201).json({ plan: publicPlan({ ...plan, _id: result.insertedId }, localDate(nowDate)) });
    } catch (error) {
      logger.error('Kunlik reja yaratishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/daily-plans', authenticate, async (req, res) => {
    const actor = res.locals.currentUser;
    if (!['yiguvchi', 'super_admin'].includes(actor.role)) return res.status(403).json({ message: 'Ruxsat yo‘q.' });
    const { date, regionId, ownerId } = req.query;
    if (Object.keys(req.query).some((key) => !['date', 'regionId', 'ownerId'].includes(key)) ||
        (date !== undefined && !validDate(date)) ||
        (regionId !== undefined && !ObjectId.isValid(regionId)) ||
        (ownerId !== undefined && !ObjectId.isValid(ownerId))) return res.status(400).json({ message: 'Filtr noto‘g‘ri.' });
    if (actor.role === 'yiguvchi' && ownerId && ownerId.toLowerCase() !== actor._id.toString()) return res.status(403).json({ message: 'Faqat o‘z rejalaringizni ko‘rasiz.' });
    try {
      const nowDate = new Date(now());
      await closeExpiredPlans(dailyPlans, nowDate);
      const filter = { ...(actor.role === 'yiguvchi' ? { ownerId: actor._id } : ownerId ? { ownerId: new ObjectId(ownerId) } : {}),
        ...(date && { date }), ...(regionId && { regionId: new ObjectId(regionId) }) };
      const plans = await dailyPlans.find(filter).sort({ date: -1, createdAt: -1, _id: -1 }).toArray();
      return res.json({ plans: plans.map((plan) => publicPlan(plan, localDate(nowDate))) });
    } catch (error) {
      logger.error('Kunlik rejalarni olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/daily-plans/:id', authenticate, async (req, res) => {
    const actor = res.locals.currentUser;
    if (!['yiguvchi', 'super_admin'].includes(actor.role)) return res.status(403).json({ message: 'Ruxsat yo‘q.' });
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Reja ID noto‘g‘ri.' });
    try {
      const nowDate = new Date(now());
      await closeExpiredPlans(dailyPlans, nowDate);
      const plan = await dailyPlans.findOne({ _id: new ObjectId(req.params.id) });
      if (!plan) return res.status(404).json({ message: 'Reja topilmadi.' });
      if (actor.role === 'yiguvchi' && !plan.ownerId.equals(actor._id)) return res.status(403).json({ message: 'Ruxsat yo‘q.' });
      return res.json({ plan: publicPlan(plan, localDate(nowDate)) });
    } catch (error) {
      logger.error('Kunlik rejani olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/daily-plans/:id/customers', authenticate, async (req, res) => {
    const actor = res.locals.currentUser;
    if (!['yiguvchi', 'super_admin'].includes(actor.role)) return res.status(403).json({ message: 'Ruxsat yo‘q.' });
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Reja ID noto‘g‘ri.' });
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    const search = req.query.search;
    if (Object.keys(req.query).some((key) => !['page', 'limit', 'search'].includes(key)) ||
        !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger((page - 1) * limit) ||
        (search !== undefined && (typeof search !== 'string' || !search.trim() || search.trim().length > 100))) {
      return res.status(400).json({ message: 'page, limit yoki search noto‘g‘ri.' });
    }
    try {
      const plan = await dailyPlans.findOne({ _id: new ObjectId(req.params.id) });
      if (!plan) return res.status(404).json({ message: 'Reja topilmadi.' });
      if (actor.role === 'yiguvchi' && !plan.ownerId.equals(actor._id)) return res.status(403).json({ message: 'Ruxsat yo‘q.' });
      const filter = { regionId: plan.regionId };
      if (search !== undefined) {
        const value = search.trim();
        const pattern = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ name: pattern }, { phoneNumber: pattern }, { addPhoneNumber: pattern }];
        if (/^\d+$/.test(value)) {
          filter.$or.push({ $expr: { $regexMatch: { input: { $toString: '$mijoz_id' }, regex: value } } });
        }
      }
      const [total, rows] = await Promise.all([
        customers.countDocuments(filter),
        customers.find(filter).project({ mijoz_id: 1, name: 1, phoneNumber: 1, address: 1,
          remainingBalance: 1, assignedTo: 1 }).sort({ mijoz_id: 1 }).skip((page - 1) * limit).limit(limit).toArray(),
      ]);
      return res.json({ customers: rows.map((row) => ({ mijoz_id: row.mijoz_id, name: row.name,
        phoneNumber: row.phoneNumber, address: row.address ?? null, remainingBalance: row.remainingBalance,
        assignedTo: row.assignedTo?.toString() ?? null })), total, page, limit });
    } catch (error) {
      logger.error('Reja mijozlarini olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  for (const action of ['close', 'reopen']) {
    app.post(`/daily-plans/:id/${action}`, authenticate, async (req, res) => {
      const actor = res.locals.currentUser;
      if (actor.role !== 'yiguvchi') return res.status(403).json({ message: 'Ruxsat yo‘q.' });
      if (!ObjectId.isValid(req.params.id) || req.body && Object.keys(req.body).length) return res.status(400).json({ message: 'So‘rov noto‘g‘ri.' });
      const nowDate = new Date(now());
      const today = localDate(nowDate);
      try {
        const current = await dailyPlans.findOne({ _id: new ObjectId(req.params.id) });
        if (!current) return res.status(404).json({ message: 'Reja topilmadi.' });
        if (!current.ownerId.equals(actor._id)) return res.status(403).json({ message: 'Faqat reja egasi o‘zgartiradi.' });
        if (current.date !== today) return res.status(409).json({ message: 'Faqat reja kunida ochish yoki yopish mumkin.' });
        const expected = action === 'close' ? 'open' : 'closed';
        const status = action === 'close' ? 'closed' : 'open';
        const update = action === 'close' ? { status, closedAt: nowDate, closeReason: 'manual' } : { status, closedAt: null, closeReason: null };
        const plan = await dailyPlans.findOneAndUpdate({ _id: current._id, ownerId: actor._id, date: today, status: expected },
          { $set: update }, { returnDocument: 'after' });
        if (!plan) return res.status(409).json({ message: `Reja allaqachon ${expected === 'open' ? 'yopilgan' : 'ochilgan'}.` });
        return res.json({ plan: publicPlan(plan, today) });
      } catch (error) {
        logger.error('Reja holatini o‘zgartirishda xatolik:', error);
        return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
      }
    });
  }
}

module.exports = { registerDailyPlanRoutes, closeExpiredPlans, publicPlan };
