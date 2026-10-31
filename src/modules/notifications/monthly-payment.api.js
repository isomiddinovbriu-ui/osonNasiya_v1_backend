const { ObjectId } = require('mongodb');
const { localDate, monthlyExpected, installmentDueDate } = require('../reports/reports.service');
const { allocatePayments } = require('../payments/payment-allocations');

const STATUSES = new Set(['due', 'partial', 'paid', 'all']);

function monthlyNotification(customer, month, payments) {
  const expected = monthlyExpected(customer, month);
  if (!expected || expected.amount <= 0) return null;
  const remaining = allocatePayments(customer, payments).remaining.get(month) ?? 0;
  const paidAmount = expected.amount - remaining;
  const status = remaining === 0 ? 'paid' : paidAmount === 0 ? 'due' : 'partial';
  const created = localDate(customer.createdAt);
  const [year, number] = month.split('-').map(Number);
  const [createdYear, createdMonth] = created.split('-').map(Number);
  const installment = (year - createdYear) * 12 + number - createdMonth;
  return {
    id: `${month}:${customer.mijoz_id}`, type: 'monthly_payment', month,
    mijoz_id: customer.mijoz_id, customerName: customer.name,
    phoneNumber: customer.phoneNumber ?? null, regionId: customer.regionId?.toString() ?? null,
    assignedTo: customer.assignedTo?.toString() ?? null,
    dueDate: installmentDueDate(created, installment), monthlyAmount: expected.amount,
    paidAmount, remainingAmount: remaining, status,
    message: status === 'paid' ? 'Bu oy uchun to‘lov to‘liq qilindi.' :
      status === 'partial' ? `Bu oy uchun yana ${remaining} so‘m to‘lash kerak.` :
        `Bu oy uchun ${remaining} so‘m to‘lov qilish kerak.`,
  };
}

function registerMonthlyPaymentNotificationRoutes(app, { authenticate, customers, payments, logger, now }) {
  async function list(req, res, searchRoute) {
    const actor = res.locals.currentUser;
    if (!['super_admin', 'yiguvchi', 'sotuvchi'].includes(actor.role)) {
      return res.status(403).json({ message: 'Bu bildirishnomalar uchun ruxsat yo‘q.' });
    }
    const allowed = searchRoute ? ['q', 'month', 'status', 'page', 'limit', 'assignedTo'] :
      ['month', 'status', 'page', 'limit', 'assignedTo'];
    const query = req.query;
    const currentMonth = localDate(new Date(now())).slice(0, 7);
    const month = query.month ?? currentMonth;
    const status = query.status ?? 'all';
    const page = query.page === undefined ? 1 : Number(query.page);
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    const q = typeof query.q === 'string' ? query.q.trim().toLocaleLowerCase('uz') : '';
    if (Object.keys(query).some((key) => !allowed.includes(key)) ||
        Object.values(query).some((value) => typeof value !== 'string') ||
        !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) || month > currentMonth ||
        !STATUSES.has(status) || !Number.isSafeInteger(page) || page < 1 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger((page - 1) * limit) ||
        (searchRoute && (!q || q.length > 100)) ||
        (query.assignedTo !== undefined && !/^[0-9a-fA-F]{24}$/.test(query.assignedTo))) {
      return res.status(400).json({ message: 'Qidiruv yoki sahifalash parametrlari noto‘g‘ri.' });
    }
    if (actor.role !== 'super_admin' && query.assignedTo &&
        query.assignedTo.toLowerCase() !== actor._id.toString()) {
      return res.status(403).json({ message: 'Faqat o‘zingizga biriktirilgan mijozlarni ko‘ra olasiz.' });
    }
    const assignedTo = actor.role === 'super_admin' ?
      (query.assignedTo ? new ObjectId(query.assignedTo) : null) : actor._id;
    const [year, monthNumber] = month.split('-').map(Number);
    const toExclusive = new Date(Date.UTC(year, monthNumber, 1, -5));
    try {
      const filter = { createdAt: { $lt: toExclusive },
        ...(assignedTo && { assignedTo }) };
      const cursor = customers.find(filter, { projection: {
        mijoz_id: 1, name: 1, phoneNumber: 1, regionId: 1, assignedTo: 1,
        createdAt: 1, totalPrice: 1, downPayment: 1, totalPaid: 1,
        remainingBalance: 1, termMonths: 1,
      } }).sort({ mijoz_id: 1 });
      let batch = [];
      const rows = [];
      let total = 0;
      const counts = { due: 0, partial: 0, paid: 0 };
      async function flush() {
        if (!batch.length) return;
        const byId = new Map(batch.map((customer) => [customer._id.toString(), []]));
        const paymentCursor = payments.find({ customerId: { $in: batch.map((item) => item._id) },
          type: 'installment', status: { $ne: 'voided' } },
        { projection: { customerId: 1, type: 1, amount: 1, forMonth: 1, paidAt: 1 } });
        for await (const payment of paymentCursor) byId.get(payment.customerId?.toString())?.push(payment);
        for (const customer of batch) {
          if (searchRoute && !String(customer.mijoz_id).includes(q) &&
              !customer.name?.toLocaleLowerCase('uz').includes(q) &&
              !customer.phoneNumber?.includes(q)) continue;
          const item = monthlyNotification(customer, month, byId.get(customer._id.toString()));
          if (!item) continue;
          counts[item.status]++;
          if (status !== 'all' && item.status !== status) continue;
          total++;
          if (total > (page - 1) * limit && rows.length < limit) rows.push(item);
        }
        batch = [];
      }
      for await (const customer of cursor) {
        batch.push(customer);
        if (batch.length === 500) await flush();
      }
      await flush();
      res.set('Cache-Control', 'no-store');
      return res.json({ month, notifications: rows, total, counts, page, limit });
    } catch (error) {
      logger.error('Oylik to‘lov bildirishnomalarida xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  }
  app.get('/notifications/monthly-payments', authenticate, (req, res) => list(req, res, false));
  app.get('/notifications/monthly-payments/search', authenticate, (req, res) => list(req, res, true));
}

module.exports = { registerMonthlyPaymentNotificationRoutes, monthlyNotification };
