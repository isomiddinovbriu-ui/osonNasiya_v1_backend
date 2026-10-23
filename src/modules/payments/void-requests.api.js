const { ObjectId } = require('mongodb');

function publicVoidRequest(row) {
  return { id: row._id.toString(), paymentId: row.paymentId.toString(),
    customerId: row.customerId.toString(), mijoz_id: row.mijoz_id,
    dailyPlanId: row.dailyPlanId.toString(), requestedBy: row.requestedBy.toString(),
    reason: row.reason, status: row.status, createdAt: row.createdAt,
    reviewedAt: row.reviewedAt ?? null, reviewedBy: row.reviewedBy?.toString() ?? null,
    reviewReason: row.reviewReason ?? null };
}

function registerVoidRequestRoutes(app, { authenticate, paymentVoidRequests, payments, dailyPlans, logger, now }) {
  app.post('/payments/:paymentId/void-requests', authenticate, async (req, res) => {
    const actor = res.locals.currentUser;
    if (actor.role !== 'yiguvchi') return res.status(403).json({ message: 'So‘rovni faqat yig‘uvchi yuboradi.' });
    const body = req.body;
    if (!ObjectId.isValid(req.params.paymentId) || !body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 1 || typeof body.reason !== 'string' ||
        !body.reason.trim() || body.reason.trim().length > 500) {
      return res.status(400).json({ message: 'paymentId va sababni to‘g‘ri kiriting.' });
    }
    try {
      const payment = await payments.findOne({ _id: new ObjectId(req.params.paymentId) });
      if (!payment) return res.status(404).json({ message: 'To‘lov topilmadi.' });
      if (!payment.dailyPlanId) return res.status(409).json({ message: 'To‘lov kunlik rejaga bog‘lanmagan.' });
      const plan = await dailyPlans.findOne({ _id: payment.dailyPlanId });
      if (!plan) return res.status(409).json({ message: 'Kunlik reja topilmadi.' });
      if (!plan.ownerId.equals(actor._id) && !payment.receivedBy.equals(actor._id)) {
        return res.status(403).json({ message: 'Faqat reja egasi yoki to‘lovni qabul qilgan yig‘uvchi so‘rov yuboradi.' });
      }
      if (payment.status === 'voided') return res.status(409).json({ message: 'To‘lov allaqachon bekor qilingan.' });
      if (await paymentVoidRequests.findOne({ paymentId: payment._id, status: 'pending' })) {
        return res.status(409).json({ message: 'Ushbu to‘lov uchun ochiq so‘rov bor.' });
      }
      const row = { paymentId: payment._id, customerId: payment.customerId, mijoz_id: payment.mijoz_id,
        dailyPlanId: payment.dailyPlanId, requestedBy: actor._id, reason: body.reason.trim(),
        status: 'pending', createdAt: new Date(now()), reviewedAt: null, reviewedBy: null };
      const result = await paymentVoidRequests.insertOne(row);
      return res.status(201).json({ request: publicVoidRequest({ ...row, _id: result.insertedId }) });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ message: 'Ushbu to‘lov uchun ochiq so‘rov bor.' });
      logger.error('Bekor qilish so‘rovini yaratishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/payments/:paymentId/void-requests', authenticate, async (req, res) => {
    const actor = res.locals.currentUser;
    if (!['yiguvchi', 'super_admin'].includes(actor.role)) return res.status(403).json({ message: 'Ruxsat yo‘q.' });
    if (!ObjectId.isValid(req.params.paymentId)) return res.status(400).json({ message: 'paymentId noto‘g‘ri.' });
    try {
      const payment = await payments.findOne({ _id: new ObjectId(req.params.paymentId) });
      if (!payment) return res.status(404).json({ message: 'To‘lov topilmadi.' });
      if (actor.role === 'yiguvchi') {
        const plan = payment.dailyPlanId ? await dailyPlans.findOne({ _id: payment.dailyPlanId }) : null;
        if (!plan || !plan.ownerId.equals(actor._id) && !payment.receivedBy.equals(actor._id)) {
          return res.status(403).json({ message: 'Ruxsat yo‘q.' });
        }
      }
      const rows = await paymentVoidRequests.find({ paymentId: payment._id }).sort({ createdAt: -1, _id: -1 }).toArray();
      return res.json({ requests: rows.map(publicVoidRequest) });
    } catch (error) {
      logger.error('To‘lov bekor qilish so‘rovlarini olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/payment-void-requests', authenticate, async (req, res) => {
    if (res.locals.currentUser.role !== 'super_admin') return res.status(403).json({ message: 'Ruxsat yo‘q.' });
    const status = req.query.status ?? 'pending';
    if (Object.keys(req.query).some((key) => key !== 'status') ||
        !['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ message: 'status noto‘g‘ri.' });
    try {
      const rows = await paymentVoidRequests.find({ status }).sort({ createdAt: -1, _id: -1 }).toArray();
      return res.json({ requests: rows.map(publicVoidRequest) });
    } catch (error) {
      logger.error('Bekor qilish so‘rovlarini olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.post('/payment-void-requests/:id/reject', authenticate, async (req, res) => {
    if (res.locals.currentUser.role !== 'super_admin') return res.status(403).json({ message: 'Ruxsat yo‘q.' });
    const body = req.body;
    if (!ObjectId.isValid(req.params.id) || !body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 1 || typeof body.reason !== 'string' ||
        !body.reason.trim() || body.reason.trim().length > 500) return res.status(400).json({ message: 'Rad etish sababini kiriting.' });
    try {
      const row = await paymentVoidRequests.findOneAndUpdate({ _id: new ObjectId(req.params.id), status: 'pending' },
        { $set: { status: 'rejected', reviewedAt: new Date(now()), reviewedBy: res.locals.currentUser._id,
          reviewReason: body.reason.trim() } }, { returnDocument: 'after' });
      if (!row) return res.status(404).json({ message: 'Ochiq so‘rov topilmadi.' });
      return res.json({ request: publicVoidRequest(row) });
    } catch (error) {
      logger.error('Bekor qilish so‘rovini rad etishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });
}

module.exports = { registerVoidRequestRoutes, publicVoidRequest };
