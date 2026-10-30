const { ObjectId } = require('mongodb');
const { TIMEZONE, parsePeriod, outstandingByMonth, dueForPeriod, addPayment, newBucket, publicBucket } = require('./dashboard.service');
const { localDate, installmentDueDate } = require('../reports/reports.service');

function registerDashboardRoutes(app, { authenticate, customers, payments, logger, now }) {
  function allowed(req, res, next) {
    if (res.locals.currentUser.role === 'product_creator') return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    next();
  }

  function params(req, res, employeeField) {
    const allowedFields = new Set(['month', 'date', employeeField, 'regionId']);
    if (Object.keys(req.query).some((key) => !allowedFields.has(key))) throw new Error('Noma’lum parametr.');
    const period = parsePeriod(req.query, now);
    const admin = res.locals.currentUser.role === 'super_admin';
    if (!admin && (req.query[employeeField] !== undefined || req.query.regionId !== undefined)) {
      const error = new Error('Xodim va hudud filtrlari faqat super_admin uchun.');
      error.status = 403;
      throw error;
    }
    for (const field of [employeeField, 'regionId']) {
      if (req.query[field] !== undefined && !/^[0-9a-fA-F]{24}$/.test(req.query[field])) {
        throw new Error(`${field} noto‘g‘ri.`);
      }
    }
    return { ...period, admin,
      employeeId: admin ? (req.query[employeeField] && new ObjectId(req.query[employeeField])) || null : res.locals.currentUser._id,
      regionId: req.query.regionId ? new ObjectId(req.query.regionId) : null };
  }

  app.get('/dashboard/sales', authenticate, allowed, async (req, res) => {
    let period;
    try { period = params(req, res, 'createdBy'); }
    catch (error) { return res.status(error.status || 400).json({ message: error.message }); }
    try {
      const { date, month, day, monthDates, employeeId, regionId, admin } = period;
      const result = { scope: admin ? (employeeId || regionId ? 'filtered' : 'all') : 'me', asOfDate: date, timezone: TIMEZONE,
        soldAmount: 0, salesCount: 0, fullyPaidCount: 0, remainingAmount: 0, remainingCustomerCount: 0,
        month: { month, dueRemainingAmount: 0, dueCustomerCount: 0, paidAmount: 0, paidCustomerCount: 0 },
        today: { date, dueRemainingAmount: 0, dueCustomerCount: 0, paidAmount: 0, paidCustomerCount: 0 } };
      const filter = { ...(employeeId && { createdBy: employeeId }), ...(regionId && { regionId }) };
      const cursor = customers.find(filter, { projection: { _id: 1, totalPrice: 1, downPayment: 1,
        termMonths: 1, totalPaid: 1, remainingBalance: 1, createdAt: 1 } });
      const monthPaidCustomers = new Set();
      const dayPaidCustomers = new Set();
      const monthCutoff = new Date(Math.min(day.end.getTime(), monthDates.end.getTime()));
      const processBatch = async (batch) => {
        if (!batch.length) return;
        const byId = new Map(batch.map((item) => [item._id.toString(), item]));
        const paymentsByCustomer = new Map();
        const paymentCursor = payments.find({ customerId: { $in: batch.map((item) => item._id) },
          status: { $ne: 'voided' } },
        { projection: { customerId: 1, amount: 1, type: 1, forMonth: 1, paidAt: 1 } });
        for await (const payment of paymentCursor) {
          if (!Number.isSafeInteger(payment.amount) || payment.amount <= 0 || !(payment.paidAt instanceof Date)) continue;
          const id = payment.customerId?.toString();
          if (!byId.has(id)) continue;
          if (!paymentsByCustomer.has(id)) paymentsByCustomer.set(id, []);
          paymentsByCustomer.get(id).push(payment);
          if (payment.paidAt >= monthDates.start && payment.paidAt < monthDates.end) {
            result.month.paidAmount += payment.amount;
            monthPaidCustomers.add(id);
          }
          if (payment.paidAt >= day.start && payment.paidAt < day.end) {
            result.today.paidAmount += payment.amount;
            dayPaidCustomers.add(id);
          }
        }
        for (const customer of batch) {
          const id = customer._id.toString();
          result.salesCount++;
          result.soldAmount += customer.totalPrice;
          result.remainingAmount += customer.remainingBalance;
          if (customer.remainingBalance === 0) result.fullyPaidCount++;
          if (customer.remainingBalance > 0) result.remainingCustomerCount++;
          if (customer.remainingBalance <= 0) continue;
          const outstanding = outstandingByMonth(customer, paymentsByCustomer.get(id) ?? []);
          const monthDue = dueForPeriod(customer, month, localDate(new Date(monthCutoff.getTime() - 1)), outstanding);
          const todayDue = dueForPeriod(customer, date.slice(0, 7), date, outstanding);
          if (monthDue > 0) { result.month.dueRemainingAmount += monthDue; result.month.dueCustomerCount++; }
          if (todayDue > 0) {
            // Only installments whose due date is exactly the selected day belong to today's card.
            const created = localDate(customer.createdAt);
            const n = (Number(date.slice(0, 4)) - Number(created.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(created.slice(5, 7));
            if (n >= 1 && installmentDueDate(created, n) === date) {
              result.today.dueRemainingAmount += todayDue;
              result.today.dueCustomerCount++;
            }
          }
        }
      };
      let batch = [];
      for await (const customer of cursor) {
        batch.push(customer);
        if (batch.length === 500) { await processBatch(batch); batch = []; }
      }
      await processBatch(batch);
      result.month.paidCustomerCount = monthPaidCustomers.size;
      result.today.paidCustomerCount = dayPaidCustomers.size;
      res.set('Cache-Control', 'no-store');
      return res.json(result);
    } catch (error) {
      logger.error('Dashboard savdo statistikasi xatosi:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/dashboard/collections', authenticate, allowed, async (req, res) => {
    let period;
    try { period = params(req, res, 'receivedBy'); }
    catch (error) { return res.status(error.status || 400).json({ message: error.message }); }
    try {
      const { date, month, day, monthDates, employeeId, regionId, admin } = period;
      const allTime = newBucket();
      const monthly = newBucket();
      const today = newBucket();
      const match = { status: { $ne: 'voided' }, amount: { $gt: 0 },
        ...(employeeId && { receivedBy: employeeId }) };
      const pipeline = [{ $match: match }];
      if (regionId) pipeline.push({ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
        { $match: { 'customer.regionId': regionId } });
      pipeline.push({ $project: { customerId: 1, amount: 1, type: 1, paidAt: 1 } });
      for await (const payment of payments.aggregate(pipeline)) {
        if (!payment.customerId || !Number.isSafeInteger(payment.amount) || !(payment.paidAt instanceof Date)) continue;
        addPayment(allTime, payment);
        if (payment.paidAt >= monthDates.start && payment.paidAt < monthDates.end) addPayment(monthly, payment);
        if (payment.paidAt >= day.start && payment.paidAt < day.end) addPayment(today, payment);
      }
      res.set('Cache-Control', 'no-store');
      return res.json({ scope: admin ? (employeeId || regionId ? 'filtered' : 'all') : 'me', timezone: TIMEZONE,
        allTime: publicBucket(allTime), month: { month, ...publicBucket(monthly) },
        today: { date, ...publicBucket(today) } });
    } catch (error) {
      logger.error('Dashboard tushum statistikasi xatosi:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });
}

module.exports = { registerDashboardRoutes };
