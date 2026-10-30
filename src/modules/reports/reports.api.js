const { localDate, dateRange, overdueAmount, monthlyExpected, installmentDueDate, csv } = require('./reports.service');
const { allocatePayments } = require('../payments/payment-allocations');

function registerReportRoutes(app, { authenticate, customers, payments, regions, users, logger, now }) {
  async function eachCustomerWithAllocation(cursor, visit) {
    let batch = [];
    async function flush() {
      if (!batch.length) return;
      const byId = new Map(batch.map((customer) => [customer._id.toString(), []]));
      const rows = payments.find({ customerId: { $in: batch.map((customer) => customer._id) },
        type: 'installment', status: { $ne: 'voided' } },
      { projection: { customerId: 1, type: 1, amount: 1, forMonth: 1, paidAt: 1 } });
      for await (const payment of rows) {
        byId.get(payment.customerId?.toString())?.push(payment);
      }
      for (const customer of batch) {
        await visit(customer, allocatePayments(customer, byId.get(customer._id.toString())).remaining);
      }
      batch = [];
    }
    for await (const customer of cursor) {
      batch.push(customer);
      if (batch.length === 500) await flush();
    }
    await flush();
  }

  function requireAdmin(_req, res, next) {
    if (res.locals.currentUser.role !== 'super_admin') return res.status(403).json({ message: 'Hisobotlar faqat super_admin uchun.' });
    return next();
  }

  function sendReport(res, format, filename, columns, rows, body) {
    res.set('Cache-Control', 'no-store');
    if (format === 'csv') {
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      return res.type('text/csv; charset=utf-8').send(csv(columns, rows));
    }
    return res.json(body);
  }

  function reportQuery(query, fields) {
    if (Object.keys(query).some((key) => !fields.includes(key)) ||
        Object.values(query).some((value) => typeof value !== 'string') ||
        (query.format !== undefined && !['json', 'csv'].includes(query.format))) {
      throw new Error('Hisobot parametrlari noto‘g‘ri.');
    }
  }

  app.get('/reports/revenue', authenticate, requireAdmin, async (req, res) => {
    let range;
    const groupBy = req.query.groupBy ?? 'day';
    try {
      reportQuery(req.query, ['from', 'to', 'groupBy', 'format']);
      if (!['day', 'month'].includes(groupBy)) throw new Error('groupBy day yoki month bo‘lishi kerak.');
      range = dateRange(req.query, now);
    } catch (error) { return res.status(400).json({ message: error.message }); }
    try {
      const grouped = await payments.aggregate([
        { $match: { paidAt: { $gte: range.fromDate, $lt: range.toExclusive }, status: { $ne: 'voided' }, amount: { $gt: 0 } } },
        { $group: { _id: { $dateToString: { format: groupBy === 'day' ? '%Y-%m-%d' : '%Y-%m', date: '$paidAt', timezone: 'Asia/Tashkent' } },
          paymentCount: { $sum: 1 }, amount: { $sum: '$amount' } } },
        { $sort: { _id: 1 } },
      ]).toArray();
      const rows = grouped.map((item) => ({ period: item._id, paymentCount: item.paymentCount, amount: item.amount }));
      const total = rows.reduce((sum, row) => ({ paymentCount: sum.paymentCount + row.paymentCount, amount: sum.amount + row.amount }), { paymentCount: 0, amount: 0 });
      return sendReport(res, req.query.format, `revenue-${range.from}-${range.to}-${groupBy}.csv`,
        [['period', 'period'], ['paymentCount', 'paymentCount'], ['amount', 'amount']],
        [...rows, { period: 'TOTAL', ...total }], { from: range.from, to: range.to, groupBy, rows, total });
    } catch (error) {
      logger.error('Tushum hisobotida xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/reports/sales', authenticate, requireAdmin, async (req, res) => {
    let range;
    const groupBy = req.query.groupBy ?? 'region';
    try {
      reportQuery(req.query, ['from', 'to', 'groupBy', 'format']);
      if (!['region', 'staff'].includes(groupBy)) throw new Error('groupBy region yoki staff bo‘lishi kerak.');
      range = dateRange(req.query, now);
    } catch (error) { return res.status(400).json({ message: error.message }); }
    try {
      const field = groupBy === 'region' ? 'regionId' : 'createdBy';
      const grouped = await customers.aggregate([
        { $match: { createdAt: { $gte: range.fromDate, $lt: range.toExclusive } } },
        { $group: { _id: `$${field}`, salesCount: { $sum: 1 }, salesAmount: { $sum: '$totalPrice' } } },
        { $sort: { salesAmount: -1, _id: 1 } },
      ]).toArray();
      const collection = groupBy === 'region' ? regions : users;
      const ids = grouped.map((item) => item._id).filter(Boolean);
      const names = ids.length ? await collection.find({ _id: { $in: ids } }, { projection: { name: 1, login: 1 } }).toArray() : [];
      const byId = new Map(names.map((item) => [item._id.toString(), item.name || item.login || 'Noma’lum']));
      const rows = grouped.map((item) => ({ id: item._id?.toString() ?? null,
        name: byId.get(item._id?.toString()) ?? 'Noma’lum', salesCount: item.salesCount, salesAmount: item.salesAmount }));
      const total = rows.reduce((sum, row) => ({ salesCount: sum.salesCount + row.salesCount, salesAmount: sum.salesAmount + row.salesAmount }), { salesCount: 0, salesAmount: 0 });
      return sendReport(res, req.query.format, `sales-${range.from}-${range.to}-${groupBy}.csv`,
        [['id', 'id'], ['name', 'name'], ['salesCount', 'salesCount'], ['salesAmount', 'salesAmount']],
        [...rows, { id: '', name: 'TOTAL', ...total }], { from: range.from, to: range.to, groupBy, rows, total });
    } catch (error) {
      logger.error('Savdo hisobotida xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/reports/debt', authenticate, requireAdmin, async (req, res) => {
    try { reportQuery(req.query, ['format']); }
    catch (error) { return res.status(400).json({ message: error.message }); }
    try {
      const asOfDate = localDate(new Date(now()));
      const result = { asOfDate, customerCount: 0, totalDebt: 0, overdueCustomers: 0, overdueDebt: 0,
        unclassifiedCustomers: 0, unclassifiedDebt: 0 };
      const cursor = customers.find({ remainingBalance: { $gt: 0 } }, { projection: {
        totalPrice: 1, downPayment: 1, totalPaid: 1, remainingBalance: 1, termMonths: 1, createdAt: 1,
      } });
      await eachCustomerWithAllocation(cursor, async (customer, remaining) => {
        result.customerCount++;
        result.totalDebt += customer.remainingBalance;
        if (overdueAmount(customer, asOfDate) === null) {
          result.unclassifiedCustomers++;
          result.unclassifiedDebt += customer.remainingBalance;
          return;
        }
        const created = localDate(customer.createdAt);
        const overdue = [...remaining.values()].reduce((sum, amount, index) =>
          sum + (installmentDueDate(created, index + 1) <= asOfDate ? amount : 0), 0);
        if (overdue > 0) {
          result.overdueCustomers++;
          result.overdueDebt += overdue;
        }
      });
      return sendReport(res, req.query.format, `debt-${asOfDate}.csv`,
        Object.keys(result).map((key) => [key, key]), [result], result);
    } catch (error) {
      logger.error('Qarz hisobotida xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  async function annualDebts(req, res, { year, minAmount, maxAmount, page, limit }) {
    try {
      const toExclusive = new Date(Date.UTC(year + 1, 0, 1, -5));
      const rows = [];
      let total = 0;
      const cursor = customers.find({ remainingBalance: { $gt: 0 }, createdAt: { $lt: toExclusive } },
        { projection: { mijoz_id: 1, name: 1, phoneNumber: 1, productName: 1, regionId: 1, createdAt: 1,
          termMonths: 1, totalPrice: 1, downPayment: 1, totalPaid: 1, remainingBalance: 1 } })
        .sort({ mijoz_id: 1 });
      await eachCustomerWithAllocation(cursor, async (customer, remaining) => {
        const months = [];
        let monthlyAmount = 0;
        let paidAmount = 0;
        let debtAmount = 0;
        for (let number = 1; number <= 12; number++) {
          const month = `${year}-${String(number).padStart(2, '0')}`;
          const expected = monthlyExpected(customer, month);
          if (!expected || expected.amount <= 0) continue;
          const debt = remaining.get(month) ?? 0;
          const paid = expected.amount - debt;
          months.push({ month, monthlyAmount: expected.amount, paidAmount: paid, debtAmount: debt });
          monthlyAmount += expected.amount;
          paidAmount += paid;
          debtAmount += debt;
        }
        if (!debtAmount || debtAmount < minAmount || debtAmount > maxAmount) return;
        total++;
        if (total <= (page - 1) * limit || rows.length >= limit) return;
        rows.push({ mijoz_id: customer.mijoz_id, name: customer.name,
          phoneNumber: customer.phoneNumber ?? null, productName: customer.productName ?? null,
          createdAt: customer.createdAt?.toISOString() ?? null, regionId: customer.regionId?.toString() ?? null,
          monthlyAmount, paidAmount, debtAmount, remainingBalance: customer.remainingBalance, months });
      });
      return sendReport(res, req.query.format, `yearly-debts-${year}-page-${page}.csv`,
        [['mijoz_id', 'mijoz_id'], ['name', 'name'], ['phoneNumber', 'phoneNumber'],
          ['regionId', 'regionId'], ['monthlyAmount', 'monthlyAmount'], ['paidAmount', 'paidAmount'],
          ['debtAmount', 'debtAmount'], ['remainingBalance', 'remainingBalance']], rows,
        { year, minAmount, maxAmount, rows, total, page, limit });
    } catch (error) {
      logger.error('Yillik qarz hisobotida xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  }

  async function monthlyUnderpaid(req, res, filterByAmount = false) {
    let month;
    let page;
    let limit;
    let minAmount;
    let maxAmount;
    try {
      reportQuery(req.query, filterByAmount
        ? ['year', 'month', 'minAmount', 'maxAmount', 'page', 'limit', 'format']
        : ['month', 'page', 'limit', 'format']);
      if (filterByAmount) {
        if (!/^[1-9]\d{3}$/.test(req.query.year ?? '') ||
            (req.query.month !== undefined &&
              (!/^(?:[1-9]|0[1-9]|1[0-2])$/.test(req.query.month) || Number(req.query.month) > 12))) {
          throw new Error('year yoki month noto‘g‘ri.');
        }
        month = req.query.month === undefined ? null :
          `${req.query.year}-${String(Number(req.query.month)).padStart(2, '0')}`;
        const amount = (key) => {
          const value = req.query[key];
          if (value === undefined) throw new Error(`${key} kerak.`);
          if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
            throw new Error(`${key} noto‘g‘ri.`);
          }
          return Number(value);
        };
        minAmount = amount('minAmount');
        maxAmount = amount('maxAmount');
        if (minAmount > maxAmount) throw new Error('minAmount maxAmount dan katta bo‘lmasligi kerak.');
      } else {
        month = req.query.month ?? localDate(new Date(now())).slice(0, 7);
      }
      if (month !== null && !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) {
        throw new Error('month YYYY-MM formatida bo‘lishi kerak.');
      }
      const positive = (value, fallback, max) => {
        if (value === undefined) return fallback;
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error('page yoki limit noto‘g‘ri.');
        return Number(value);
      };
      page = positive(req.query.page, 1, Number.MAX_SAFE_INTEGER);
      limit = positive(req.query.limit, 20, 100);
      if (!Number.isSafeInteger((page - 1) * limit)) throw new Error('page juda katta.');
    } catch (error) { return res.status(400).json({ message: error.message }); }
    if (filterByAmount && month === null) {
      return annualDebts(req, res, { year: Number(req.query.year), minAmount, maxAmount, page, limit });
    }
    try {
      const [year, monthNumber] = month.split('-').map(Number);
      const toExclusive = new Date(Date.UTC(year, monthNumber, 1, -5));
      const rows = [];
      let total = 0;
      const cursor = customers.find({ remainingBalance: { $gt: 0 }, createdAt: { $lt: toExclusive } },
        { projection: { mijoz_id: 1, name: 1, phoneNumber: 1, productName: 1, regionId: 1, createdAt: 1, termMonths: 1,
          totalPrice: 1, downPayment: 1, totalPaid: 1, remainingBalance: 1 } }).sort({ mijoz_id: 1 });
      await eachCustomerWithAllocation(cursor, async (customer, remaining) => {
        const expected = monthlyExpected(customer, month);
        if (!expected || expected.amount <= 0) return;
        const shortfall = remaining.get(month) ?? 0;
        if (shortfall <= 0 || filterByAmount && (shortfall < minAmount || shortfall > maxAmount)) return;
        const paidAmount = expected.amount - shortfall;
        total++;
        if (total <= (page - 1) * limit || rows.length >= limit) return;
        const row = { mijoz_id: customer.mijoz_id, name: customer.name,
          productName: customer.productName ?? null, createdAt: customer.createdAt?.toISOString() ?? null,
          regionId: customer.regionId?.toString() ?? null, monthlyAmount: expected.amount,
          paidAmount, shortfall,
          status: paidAmount === 0 ? 'unpaid' : 'underpaid',
          message: paidAmount === 0 ? 'Oylik to‘lov qilinmadi' : 'Oylik to‘lovdan kam to‘landi' };
        if (filterByAmount) {
          row.phoneNumber = customer.phoneNumber ?? null;
          row.debtAmount = shortfall;
          row.remainingBalance = customer.remainingBalance;
        }
        rows.push(row);
      });
      return sendReport(res, req.query.format, `${filterByAmount ? 'monthly-debts' : 'monthly-underpaid'}-${month}-page-${page}.csv`,
        [['mijoz_id', 'mijoz_id'], ['name', 'name'], ['regionId', 'regionId'],
          ['monthlyAmount', 'monthlyAmount'], ['paidAmount', 'paidAmount'], ['shortfall', 'shortfall'],
          ['status', 'status'], ['message', 'message'],
          ...(filterByAmount ? [['phoneNumber', 'phoneNumber'], ['debtAmount', 'debtAmount'], ['remainingBalance', 'remainingBalance']] : [])], rows,
        { month, ...(filterByAmount && { minAmount, maxAmount }), rows, total, page, limit });
    } catch (error) {
      logger.error('Oylik kam to‘lov hisobotida xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  }

  app.get('/reports/monthly-underpaid', authenticate, (req, res) => monthlyUnderpaid(req, res));
  app.get('/reports/monthly-debts', authenticate, (req, res) => monthlyUnderpaid(req, res, true));
}

module.exports = { registerReportRoutes };
