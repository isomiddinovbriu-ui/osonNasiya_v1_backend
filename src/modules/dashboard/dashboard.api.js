const { ObjectId } = require('mongodb');
const { TIMEZONE, parsePeriod, outstandingByMonth, dueForPeriod, addPayment, newBucket, publicBucket,
  newSalesPeriod, addSalesPayment, newSalesCustomerSets, finishSalesPeriod } = require('./dashboard.service');
const { localDate, installmentDueDate } = require('../reports/reports.service');

function customerSearch(query) {
  if (query.search === undefined) return null;
  if (typeof query.search !== 'string') throw new Error('search noto‘g‘ri.');
  const value = query.search.trim();
  if (!value || value.length > 100) throw new Error('search 1–100 belgidan iborat bo‘lishi kerak.');
  const pattern = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const fields = ['name', 'phoneNumber', 'addPhoneNumber', 'address', 'productName', 'description'];
  return { $or: [
    ...fields.map((field) => ({ [`customer.${field}`]: pattern })),
    ...(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ?
      [{ 'customer.mijoz_id': Number(value) }] : []),
  ] };
}

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
        month: newSalesPeriod('month', month), today: newSalesPeriod('date', date) };
      const filter = { ...(employeeId && { createdBy: employeeId }), ...(regionId && { regionId }) };
      const cursor = customers.find(filter, { projection: { _id: 1, totalPrice: 1, downPayment: 1,
        termMonths: 1, totalPaid: 1, remainingBalance: 1, createdAt: 1 } });
      const monthPaidCustomers = newSalesCustomerSets();
      const dayPaidCustomers = newSalesCustomerSets();
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
            addSalesPayment(result.month, monthPaidCustomers, payment, month, id);
          }
          if (payment.paidAt >= day.start && payment.paidAt < day.end) {
            addSalesPayment(result.today, dayPaidCustomers, payment, date.slice(0, 7), id);
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
      finishSalesPeriod(result.month, monthPaidCustomers);
      finishSalesPeriod(result.today, dayPaidCustomers);
      res.set('Cache-Control', 'no-store');
      return res.json(result);
    } catch (error) {
      logger.error('Dashboard savdo statistikasi xatosi:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/dashboard/sales/payments', authenticate, allowed, async (req, res) => {
    let period;
    let page;
    let limit;
    let category;
    let search;
    try {
      const allowedFields = new Set(['month', 'createdBy', 'regionId', 'category', 'page', 'limit', 'search']);
      if (Object.keys(req.query).some((key) => !allowedFields.has(key))) throw new Error('Noma’lum parametr.');
      search = customerSearch(req.query);
      period = params({ query: Object.fromEntries(Object.entries(req.query).filter(([key]) =>
        ['month', 'createdBy', 'regionId'].includes(key))) }, res, 'createdBy');
      category = req.query.category ?? 'installment';
      if (!['installment', 'current_month', 'other_month', 'initial', 'unassigned'].includes(category)) {
        throw new Error('category noto‘g‘ri.');
      }
      const number = (key, fallback, max) => {
        const value = req.query[key] ?? fallback;
        if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) ||
          !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error(`${key} noto‘g‘ri.`);
        return Number(value);
      };
      page = number('page', '1', Number.MAX_SAFE_INTEGER);
      limit = number('limit', '20', 100);
      if (!Number.isSafeInteger((page - 1) * limit)) throw new Error('page juda katta.');
    } catch (error) { return res.status(error.status || 400).json({ message: error.message }); }
    try {
      const { month, monthDates, employeeId, regionId, admin } = period;
      const match = { status: { $ne: 'voided' }, amount: { $gt: 0 },
        paidAt: { $gte: monthDates.start, $lt: monthDates.end } };
      if (category === 'initial') match.type = 'initial';
      else {
        match.type = 'installment';
        if (category === 'current_month') match.forMonth = month;
        else if (category === 'other_month') match.forMonth = { $type: 'string', $ne: month };
        else if (category === 'unassigned') match.forMonth = null;
        else match.forMonth = { $type: 'string' };
      }
      const pipeline = [
        { $match: match },
        { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
        { $unwind: '$customer' },
        { $match: { ...(employeeId && { 'customer.createdBy': employeeId }),
          ...(regionId && { 'customer.regionId': regionId }), ...(search ?? {}) } },
        { $facet: {
          count: [{ $count: 'total' }],
          rows: [{ $sort: { paidAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit },
            { $project: { _id: 1, amount: 1, type: 1, forMonth: 1, paidAt: 1,
              'customer._id': 1, 'customer.mijoz_id': 1, 'customer.name': 1,
              'customer.phoneNumber': 1, 'customer.addPhoneNumber': 1 } }],
        } },
      ];
      const [data] = await payments.aggregate(pipeline).toArray();
      const result = { scope: admin ? (employeeId || regionId ? 'filtered' : 'all') : 'me',
        timezone: TIMEZONE, month, category, total: data?.count[0]?.total ?? 0, page, limit,
        payments: (data?.rows ?? []).map((payment) => ({
          paymentId: payment._id.toString(), customerId: payment.customer._id.toString(),
          mijoz_id: payment.customer.mijoz_id, customerName: payment.customer.name,
          phoneNumber: payment.customer.phoneNumber ?? null,
          addPhoneNumber: payment.customer.addPhoneNumber ?? null,
          type: payment.type, amount: payment.amount, forMonth: payment.forMonth ?? null,
          paidAt: payment.paidAt,
          category: payment.type === 'initial' ? 'initial' :
            payment.forMonth === month ? 'current_month' : payment.forMonth ? 'other_month' : 'unassigned',
        })) };
      res.set('Cache-Control', 'no-store');
      return res.json(result);
    } catch (error) {
      logger.error('Dashboard oylik to‘lovlar ro‘yxati xatosi:', error);
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

  app.get('/dashboard/collections/payments', authenticate, allowed, async (req, res) => {
    let period;
    let page;
    let limit;
    let category;
    let search;
    try {
      const allowedFields = new Set(['date', 'receivedBy', 'regionId', 'category', 'page', 'limit', 'search']);
      if (Object.keys(req.query).some((key) => !allowedFields.has(key))) throw new Error('Noma’lum parametr.');
      search = customerSearch(req.query);
      period = params({ query: Object.fromEntries(Object.entries(req.query).filter(([key]) =>
        ['date', 'receivedBy', 'regionId'].includes(key))) }, res, 'receivedBy');
      category = req.query.category ?? 'all';
      if (!['all', 'initial', 'installment'].includes(category)) throw new Error('category noto‘g‘ri.');
      const number = (key, fallback, max) => {
        const value = req.query[key] ?? fallback;
        if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) ||
          !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error(`${key} noto‘g‘ri.`);
        return Number(value);
      };
      page = number('page', '1', Number.MAX_SAFE_INTEGER);
      limit = number('limit', '20', 100);
      if (!Number.isSafeInteger((page - 1) * limit)) throw new Error('page juda katta.');
    } catch (error) { return res.status(error.status || 400).json({ message: error.message }); }
    try {
      const { date, day, employeeId, regionId, admin } = period;
      const pipeline = [
        { $match: { status: { $ne: 'voided' }, amount: { $gt: 0 }, customerId: { $exists: true, $ne: null },
          paidAt: { $gte: day.start, $lt: day.end },
          ...(employeeId && { receivedBy: employeeId }),
          ...(category !== 'all' && { type: category }) } },
        { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
        { $unwind: { path: '$customer', preserveNullAndEmptyArrays: !regionId } },
        ...(regionId || search ? [{ $match: { ...(regionId && { 'customer.regionId': regionId }),
          ...(search ?? {}) } }] : []),
        { $facet: {
          count: [{ $count: 'total' }],
          rows: [{ $sort: { paidAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit },
            { $project: { _id: 1, customerId: 1, amount: 1, type: 1, forMonth: 1, paidAt: 1,
              'customer.mijoz_id': 1, 'customer.name': 1,
              'customer.phoneNumber': 1, 'customer.addPhoneNumber': 1 } }],
        } },
      ];
      const [data] = await payments.aggregate(pipeline).toArray();
      res.set('Cache-Control', 'no-store');
      return res.json({ scope: admin ? (employeeId || regionId ? 'filtered' : 'all') : 'me',
        timezone: TIMEZONE, date, category, total: data?.count[0]?.total ?? 0, page, limit,
        payments: (data?.rows ?? []).map((payment) => ({
          paymentId: payment._id.toString(), customerId: payment.customerId.toString(),
          mijoz_id: payment.customer?.mijoz_id ?? null, customerName: payment.customer?.name ?? null,
          phoneNumber: payment.customer?.phoneNumber ?? null,
          addPhoneNumber: payment.customer?.addPhoneNumber ?? null,
          type: payment.type, amount: payment.amount, forMonth: payment.forMonth ?? null,
          paidAt: payment.paidAt,
        })) });
    } catch (error) {
      logger.error('Dashboard kunlik to‘lovlar ro‘yxati xatosi:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });
}

module.exports = { registerDashboardRoutes };
