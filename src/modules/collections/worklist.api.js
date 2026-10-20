const { ObjectId } = require('mongodb');
const { localDate, collectionWorkItem } = require('../reports/reports.service');

const BUCKETS = new Set(['today_due', 'overdue_1_7', 'overdue_8_30', 'overdue_31_plus', 'never_paid']);

function matchesBucket(item, bucket) {
  if (bucket === 'never_paid') return item.noInstallmentPaid;
  if (bucket === 'today_due') return item.daysOverdue === 0;
  if (bucket === 'overdue_1_7') return item.daysOverdue >= 1 && item.daysOverdue <= 7;
  if (bucket === 'overdue_8_30') return item.daysOverdue >= 8 && item.daysOverdue <= 30;
  return item.daysOverdue >= 31;
}

function registerWorklistRoutes(app, { authenticate, customers, logger, now }) {
  app.get('/collections/worklist', authenticate, async (req, res) => {
    const actor = res.locals.currentUser;
    if (!['super_admin', 'yiguvchi'].includes(actor.role)) {
      return res.status(403).json({ message: 'Ish ro‘yxati faqat yig‘uvchi yoki super_admin uchun.' });
    }
    const query = req.query;
    if (Object.keys(query).some((key) => !['bucket', 'assignedTo', 'page', 'limit'].includes(key)) ||
        Object.values(query).some((value) => typeof value !== 'string') || !BUCKETS.has(query.bucket) ||
        (query.assignedTo !== undefined && !/^[0-9a-fA-F]{24}$/.test(query.assignedTo))) {
      return res.status(400).json({ message: 'bucket yoki assignedTo noto‘g‘ri.' });
    }
    function positive(value, fallback, max) {
      if (value === undefined) return fallback;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) return null;
      return Number(value);
    }
    const page = positive(query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = positive(query.limit, 20, 100);
    if (page === null || limit === null || !Number.isSafeInteger((page - 1) * limit)) {
      return res.status(400).json({ message: 'page yoki limit noto‘g‘ri.' });
    }
    if (actor.role === 'yiguvchi' && query.assignedTo && query.assignedTo.toLowerCase() !== actor._id.toString()) {
      return res.status(403).json({ message: 'Faqat o‘zingizga biriktirilgan mijozlarni ko‘ra olasiz.' });
    }
    const assignedTo = actor.role === 'yiguvchi' ? actor._id : query.assignedTo ? new ObjectId(query.assignedTo) : null;
    const asOfDate = localDate(new Date(now()));
    try {
      const filter = { remainingBalance: { $gt: 0 }, ...(assignedTo && { assignedTo }) };
      const cursor = customers.find(filter, { projection: {
        mijoz_id: 1, name: 1, phoneNumber: 1, addPhoneNumber: 1, address: 1,
        regionId: 1, assignedTo: 1, createdAt: 1, totalPrice: 1, downPayment: 1,
        totalPaid: 1, remainingBalance: 1, termMonths: 1,
      } }).sort({ mijoz_id: 1 });
      const rows = [];
      let total = 0;
      for await (const customer of cursor) {
        const item = collectionWorkItem(customer, asOfDate);
        if (!item || !matchesBucket(item, query.bucket)) continue;
        total++;
        if (total <= (page - 1) * limit || rows.length >= limit) continue;
        rows.push({
          mijoz_id: customer.mijoz_id, name: customer.name,
          phoneNumber: customer.phoneNumber, addPhoneNumber: customer.addPhoneNumber ?? null,
          address: customer.address ?? null, regionId: customer.regionId?.toString() ?? null,
          assignedTo: customer.assignedTo?.toString() ?? null,
          createdAt: customer.createdAt, totalPrice: customer.totalPrice,
          totalPaid: customer.totalPaid, remainingBalance: customer.remainingBalance,
          termMonths: customer.termMonths, ...item,
        });
      }
      return res.json({ asOfDate, bucket: query.bucket, customers: rows, total, page, limit });
    } catch (error) {
      logger.error('Undiruv ish ro‘yxatida xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });
}

module.exports = { registerWorklistRoutes, matchesBucket };
