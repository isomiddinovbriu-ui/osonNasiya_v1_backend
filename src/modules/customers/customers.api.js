const { ObjectId } = require('mongodb');
const { nextCustomerId } = require('./customer-id.service');
const { methodIds, validProviderCode, paymentDetails } = require('../payments/payment-options');
const { balanceSnapshot, paymentSnapshot, auditEntry, publicAudit } = require('../payments/payment-audit');

const CREATOR_ROLES = new Set(['super_admin', 'sotuvchi', 'yiguvchi']);
const ID_FILTERS = ['regionId', 'groupId', 'sectionId', 'productId', 'createdBy', 'paymentId', 'receivedBy'];
const TEXT_FILTERS = ['name', 'productName', 'description'];
const SEARCH_FIELDS = [...TEXT_FILTERS, 'phoneNumber', 'addPhoneNumber'];
const NUMBER_FILTERS = {
  mijoz_id: [1, Number.MAX_SAFE_INTEGER],
  totalPrice: [0, Number.MAX_SAFE_INTEGER], downPayment: [0, Number.MAX_SAFE_INTEGER],
  termMonths: [1, 120], totalPaid: [0, Number.MAX_SAFE_INTEGER],
  remainingBalance: [0, Number.MAX_SAFE_INTEGER], lat: [-90, 90], long: [-180, 180],
  paymentAmount: [0, Number.MAX_SAFE_INTEGER],
};
const DATE_FILTERS = ['createdFrom', 'createdTo', 'paidFrom', 'paidTo'];
const LIST_FILTERS = new Set([
  ...ID_FILTERS, ...TEXT_FILTERS, ...DATE_FILTERS, 'phoneNumber', 'search', 'createdByRole',
  'paymentMethod', 'paymentType', 'paymentMonth', 'paymentProvider', 'hasDebt', 'page', 'limit',
  ...Object.keys(NUMBER_FILTERS).flatMap((field) => [field, `${field}Min`, `${field}Max`]),
]);

function escapedPattern(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function validPaymentMonth(value) {
  return typeof value === 'string' && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
}

function buildCustomerListQuery(query) {
  if (Object.keys(query).some((field) => !LIST_FILTERS.has(field)) ||
      Object.values(query).some((value) => typeof value !== 'string')) {
    throw new Error('Noma’lum yoki takrorlangan filtr.');
  }
  function pageNumber(key, fallback, max) {
    const value = query[key];
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
      throw new Error(`${key} noto‘g‘ri.`);
    }
    return Number(value);
  }
  const page = pageNumber('page', 1, Number.MAX_SAFE_INTEGER);
  const limit = pageNumber('limit', 20, 100);
  if (!Number.isSafeInteger((page - 1) * limit)) throw new Error('page juda katta.');

  const filter = {};
  for (const field of ID_FILTERS) {
    if (query[field] === undefined) continue;
    if (!ObjectId.isValid(query[field])) throw new Error(`${field} noto‘g‘ri.`);
    if (field !== 'receivedBy' && field !== 'paymentId') filter[field] = new ObjectId(query[field]);
  }
  for (const field of TEXT_FILTERS) {
    if (query[field] === undefined) continue;
    const value = query[field].trim();
    if (!value || value.length > 100) throw new Error(`${field} 1–100 belgidan iborat bo‘lishi kerak.`);
    filter[field] = escapedPattern(value);
  }
  if (query.phoneNumber !== undefined) {
    const value = query.phoneNumber.trim();
    if (!value || value.length > 100) throw new Error('phoneNumber 1–100 belgidan iborat bo‘lishi kerak.');
    const pattern = escapedPattern(value);
    filter.$and = [{ $or: [{ phoneNumber: pattern }, { addPhoneNumber: pattern }] }];
  }
  if (query.search !== undefined) {
    const value = query.search.trim();
    if (!value || value.length > 100) throw new Error('search 1–100 belgidan iborat bo‘lishi kerak.');
    const pattern = escapedPattern(value);
    filter.$or = SEARCH_FIELDS.map((field) => ({ [field]: pattern }));
  }
  if (query.createdByRole !== undefined) {
    if (!CREATOR_ROLES.has(query.createdByRole)) throw new Error('createdByRole noto‘g‘ri.');
    filter.createdByRole = query.createdByRole;
  }
  if (query.hasDebt !== undefined) {
    if (!['true', 'false'].includes(query.hasDebt)) throw new Error('hasDebt true yoki false bo‘lishi kerak.');
    filter.remainingBalance = query.hasDebt === 'true' ? { $gt: 0 } : 0;
  }
  for (const [field, [minimum, maximum]] of Object.entries(NUMBER_FILTERS)) {
    const values = [field, `${field}Min`, `${field}Max`].map((key) => query[key]);
    if (values.every((value) => value === undefined)) continue;
    const parsed = values.map((value) => {
      if (value === undefined) return undefined;
      if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error(`${field} noto‘g‘ri.`);
      const number = Number(value);
      if (!Number.isFinite(number) || number < minimum || number > maximum ||
          (!['lat', 'long'].includes(field) && !Number.isSafeInteger(number))) throw new Error(`${field} noto‘g‘ri.`);
      return number;
    });
    const [exact, min, max] = parsed;
    if ((min !== undefined && max !== undefined && min > max) ||
        (exact !== undefined && ((min !== undefined && exact < min) || (max !== undefined && exact > max)))) {
      throw new Error(`${field} chegaralari noto‘g‘ri.`);
    }
    const key = field === 'paymentAmount' ? 'amount' : field;
    const target = field === 'paymentAmount' ? (filter.payments ??= { $elemMatch: {} }).$elemMatch : filter;
    if (field === 'remainingBalance' && query.hasDebt !== undefined) {
      if (exact !== undefined || min !== undefined || max !== undefined) throw new Error('hasDebt va remainingBalance filtrlarini birga bermang.');
    }
    target[key] = exact ?? { ...(min !== undefined && { $gte: min }), ...(max !== undefined && { $lte: max }) };
  }
  function dateValue(field) {
    const value = query[field];
    if (value === undefined) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
      throw new Error(`${field} ISO sana bo‘lishi kerak.`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || (value.length === 10 && date.toISOString().slice(0, 10) !== value)) {
      throw new Error(`${field} noto‘g‘ri sana.`);
    }
    return date;
  }
  for (const [prefix, target] of [['created', filter], ['paid', (filter.payments ??= { $elemMatch: {} }).$elemMatch]]) {
    const from = dateValue(`${prefix}From`);
    const to = dateValue(`${prefix}To`);
    if (from === undefined && to === undefined) continue;
    const end = to && query[`${prefix}To`].length === 10 ? new Date(to.getTime() + 86400000) : to;
    if (from && end && from > end) throw new Error(`${prefix} sana chegaralari noto‘g‘ri.`);
    target[prefix === 'created' ? 'createdAt' : 'paidAt'] = {
      ...(from && { $gte: from }), ...(end && { [end === to ? '$lte' : '$lt']: end }),
    };
  }
  if (query.paymentMethod !== undefined) {
    if (!methodIds.has(query.paymentMethod)) throw new Error('paymentMethod noto‘g‘ri.');
    (filter.payments ??= { $elemMatch: {} }).$elemMatch.method = query.paymentMethod;
  }
  if (query.paymentProvider !== undefined) {
    if (!validProviderCode(query.paymentProvider)) throw new Error('paymentProvider noto‘g‘ri.');
    (filter.payments ??= { $elemMatch: {} }).$elemMatch.provider = query.paymentProvider;
  }
  if (query.paymentType !== undefined) {
    if (!['initial', 'installment'].includes(query.paymentType)) throw new Error('paymentType noto‘g‘ri.');
    (filter.payments ??= { $elemMatch: {} }).$elemMatch.type = query.paymentType;
  }
  if (query.paymentMonth !== undefined) {
    if (!validPaymentMonth(query.paymentMonth)) throw new Error('paymentMonth YYYY-MM formatida bo‘lishi kerak.');
    (filter.payments ??= { $elemMatch: {} }).$elemMatch.forMonth = query.paymentMonth;
  }
  if (query.receivedBy !== undefined) {
    (filter.payments ??= { $elemMatch: {} }).$elemMatch.receivedBy = new ObjectId(query.receivedBy);
  }
  if (query.paymentId !== undefined) {
    (filter.payments ??= { $elemMatch: {} }).$elemMatch._id = new ObjectId(query.paymentId);
  }
  if (filter.payments && !Object.keys(filter.payments.$elemMatch).length) delete filter.payments;
  if (filter.payments) filter.payments.$elemMatch.status = { $ne: 'voided' };
  return { filter, page, limit };
}

function publicPayment(payment) {
  return {
    id: payment._id.toString(),
    paymentId: payment._id.toString(),
    type: payment.type,
    amount: payment.amount,
    method: payment.method,
    receivedBy: payment.receivedBy.toString(),
    paidAt: payment.paidAt,
    forMonth: payment.forMonth ?? null,
    cardLast4: payment.cardLast4 ?? null,
    provider: payment.provider ?? null,
    providerName: payment.providerName ?? null,
    status: payment.status ?? 'active',
    voidedAt: payment.voidedAt ?? null,
    voidedBy: payment.voidedBy?.toString() ?? null,
    voidReason: payment.voidReason ?? null,
  };
}

function publicCustomer(customer) {
  return {
    mijoz_id: customer.mijoz_id,
    name: customer.name,
    phoneNumber: customer.phoneNumber,
    addPhoneNumber: customer.addPhoneNumber ?? null,
    productName: customer.productName,
    groupId: customer.groupId?.toString() || null,
    sectionId: customer.sectionId?.toString() || null,
    productId: customer.productId?.toString() || null,
    regionId: customer.regionId.toString(),
    lat: customer.lat ?? null,
    long: customer.long ?? null,
    totalPrice: customer.totalPrice,
    downPayment: customer.downPayment,
    termMonths: customer.termMonths,
    totalPaid: customer.totalPaid,
    remainingBalance: customer.remainingBalance,
    description: customer.description,
    payments: (customer.payments || []).map(publicPayment),
    createdBy: customer.createdBy.toString(),
    createdByRole: customer.createdByRole,
    createdAt: customer.createdAt,
  };
}

function validPhone(value) {
  return typeof value === 'string' && value.length <= 25 &&
    /^[+\d\s()-]+$/.test(value) &&
    value.replace(/\D/g, '').length >= 9 && value.replace(/\D/g, '').length <= 15;
}

function validCustomerNumber(value) {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

function distanceKm(lat1, long1, lat2, long2) {
  const radians = Math.PI / 180;
  const latDelta = (lat2 - lat1) * radians;
  const longDelta = (long2 - long1) * radians;
  const haversine = Math.sin(latDelta / 2) ** 2 +
    Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(longDelta / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

function nearbyQuery(query) {
  if (Object.keys(query).some((field) => !['lat', 'long', 'radiusMeters'].includes(field))) return null;
  const coordinates = ['lat', 'long'].map((field) => query[field]);
  if (coordinates.some((value) => typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) ||
      typeof query.radiusMeters !== 'string' || !/^[1-9]\d*$/.test(query.radiusMeters)) return null;
  const [lat, long] = coordinates.map(Number);
  const radiusMeters = Number(query.radiusMeters);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(long) || long < -180 || long > 180 ||
      !Number.isSafeInteger(radiusMeters) || radiusMeters > 20038000) return null;
  return { lat, long, radiusMeters };
}

function registerCustomerRoutes(app, { authenticate, customers, payments, paymentApps, auditLogs, mongoClient, counters, regions, productCategories, products, logger, now }) {
  async function withPayments(items) {
    if (!items.length) return items;
    const rows = await payments.find({ customerId: { $in: items.map((item) => item._id) } })
      .sort({ paidAt: 1, _id: 1 }).toArray();
    const byCustomer = new Map();
    for (const row of rows) {
      const key = row.customerId.toString();
      if (!byCustomer.has(key)) byCustomer.set(key, []);
      byCustomer.get(key).push(row);
    }
    return items.map((item) => ({ ...item, payments: byCustomer.get(item._id.toString()) || [] }));
  }

  app.get('/customers', authenticate, async (req, res) => {
    if (!CREATOR_ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    let parsed;
    try { parsed = buildCustomerListQuery(req.query); }
    catch (error) { return res.status(400).json({ message: error.message }); }
    try {
      const { filter, page, limit } = parsed;
      if (filter.payments) {
        const matching = await payments.distinct('customerId', filter.payments.$elemMatch);
        filter._id = { $in: matching };
        delete filter.payments;
      }
      const [total, items] = await Promise.all([
        customers.countDocuments(filter),
        customers.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      ]);
      return res.json({ customers: (await withPayments(items)).map(publicCustomer), total, page, limit });
    } catch (error) {
      logger.error('Mijozlar ro‘yxatini olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/customers/nearby', authenticate, async (req, res) => {
    if (!CREATOR_ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    const location = nearbyQuery(req.query);
    if (!location) return res.status(400).json({ message: 'lat, long va radiusMeters ni to‘g‘ri kiriting.' });
    try {
      const { lat, long, radiusMeters } = location;
      const radiusKm = radiusMeters / 1000;
      const latitudeRange = radiusMeters / 110000;
      const candidates = await customers.find({ lat: {
        $gte: Math.max(-90, lat - latitudeRange),
        $lte: Math.min(90, lat + latitudeRange),
      } }).toArray();
      const nearby = candidates
        .filter((customer) => typeof customer.long === 'number' && customer.long >= -180 && customer.long <= 180)
        .map((customer) => ({ customer, distance: distanceKm(lat, long, customer.lat, customer.long) }))
        .filter(({ distance }) => distance <= radiusKm)
        .sort((a, b) => a.distance - b.distance || a.customer.mijoz_id - b.customer.mijoz_id);
      const hydrated = await withPayments(nearby.map(({ customer }) => customer));
      return res.json({ customers: hydrated.map((customer, index) => ({ ...publicCustomer(customer), distanceKm: Number(nearby[index].distance.toFixed(3)) })), total: nearby.length });
    } catch (error) {
      logger.error('Yaqin mijozlarni olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.post('/customers', authenticate, async (req, res) => {
    if (!CREATOR_ROLES.has(res.locals.currentUser.role)) {
      return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const phoneNumber = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber.trim() : '';
    const addPhoneNumber = req.body?.addPhoneNumber;
    const description = req.body?.description === undefined ? '' : req.body.description;
    const { groupId, sectionId, productId, regionId, lat, long, totalPrice, downPayment, termMonths, paymentMethod,
      cardNumber, provider, providerName } = req.body || {};
    if (!name || name.length > 100 || !validPhone(phoneNumber) ||
        (addPhoneNumber !== undefined && addPhoneNumber !== null &&
          (typeof addPhoneNumber !== 'string' || (addPhoneNumber.trim() !== '' && !validPhone(addPhoneNumber.trim())))) ||
        !ObjectId.isValid(groupId) || !ObjectId.isValid(sectionId) || !ObjectId.isValid(productId) ||
        !ObjectId.isValid(regionId) || !Number.isSafeInteger(totalPrice) || totalPrice <= 0 ||
        typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
        typeof long !== 'number' || !Number.isFinite(long) || long < -180 || long > 180 ||
        !Number.isSafeInteger(downPayment) || downPayment < 0 || downPayment > totalPrice ||
        !Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120 ||
        (downPayment === 0 && (paymentMethod != null || cardNumber !== undefined || provider !== undefined || providerName !== undefined)) ||
        typeof description !== 'string' || description.length > 1000) {
      return res.status(400).json({ message: 'Mijoz, telefon raqamlari, guruh, bo‘lim, mahsulot, hudud, lat, long, narx, muddat va boshlang‘ich to‘lov ma’lumotlarini to‘g‘ri kiriting.' });
    }

    let initialDetails = null;
    if (downPayment > 0) {
      try { initialDetails = await paymentDetails({ method: paymentMethod, cardNumber, provider, providerName }, paymentApps); }
      catch (error) { return res.status(400).json({ message: error.message }); }
    }

    try {
      const region = await regions.findOne({ _id: new ObjectId(regionId) });
      if (!region) return res.status(404).json({ message: 'Hudud topilmadi.' });

      const [group, section, product] = await Promise.all([
        productCategories.findOne({ _id: new ObjectId(groupId) }),
        productCategories.findOne({ _id: new ObjectId(sectionId) }),
        products.findOne({ _id: new ObjectId(productId) }),
      ]);
      if (!group || !section || !product) {
        return res.status(404).json({ message: 'Guruh, bo‘lim yoki mahsulot topilmadi.' });
      }
      if (group.parentId || !section.parentId?.equals(group._id) || !product.categoryId.equals(section._id)) {
        return res.status(400).json({ message: 'Mahsulot, bo‘lim va guruh o‘zaro mos emas.' });
      }
      if (product.minSellingPrice != null && totalPrice < product.minSellingPrice) {
        return res.status(400).json({ message: 'Sotuv narxi mahsulotning eng past sotilish narxidan kam bo‘lmasligi kerak.' });
      }

      const createdAt = new Date(now());
      const actor = res.locals.currentUser;
      const initialPayment = downPayment > 0 ? {
        _id: new ObjectId(),
        type: 'initial',
        amount: downPayment,
        method: paymentMethod,
        receivedBy: actor._id,
        paidAt: createdAt,
        status: 'active',
        ...initialDetails,
      } : null;
      const document = {
        name,
        phoneNumber,
        addPhoneNumber: typeof addPhoneNumber === 'string' && addPhoneNumber.trim() ? addPhoneNumber.trim() : null,
        productName: product.name,
        groupId: group._id,
        sectionId: section._id,
        productId: product._id,
        regionId: region._id,
        lat,
        long,
        totalPrice,
        downPayment,
        termMonths,
        totalPaid: downPayment,
        remainingBalance: totalPrice - downPayment,
        description: description.trim(),
        createdBy: actor._id,
        createdByRole: actor.role,
        createdAt,
      };
      document.mijoz_id = await nextCustomerId(counters);
      const session = mongoClient.startSession();
      let result;
      try {
        await session.withTransaction(async () => {
          result = await customers.insertOne(document, { session });
          const savedCustomer = { ...document, _id: result.insertedId };
          await auditLogs.insertOne(auditEntry({ action: 'customer.created', customer: savedCustomer, actor, createdAt,
            after: { balance: balanceSnapshot(savedCustomer) } }), { session });
          if (initialPayment) {
            await payments.insertOne({ ...initialPayment, customerId: result.insertedId, mijoz_id: document.mijoz_id }, { session });
            await auditLogs.insertOne(auditEntry({ action: 'payment.created', customer: savedCustomer, payment: initialPayment, actor, createdAt,
              before: { balance: { downPayment: 0, totalPaid: 0, remainingBalance: totalPrice } },
              after: { payment: paymentSnapshot(initialPayment), balance: balanceSnapshot(savedCustomer) } }), { session });
          }
        });
      } finally { await session.endSession(); }
      return res.status(201).json({ customer: publicCustomer({ ...document, _id: result.insertedId, payments: initialPayment ? [initialPayment] : [] }) });
    } catch (error) {
      logger.error('Mijoz yaratishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/customers/:mijoz_id', authenticate, async (req, res) => {
    if (!CREATOR_ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!validCustomerNumber(req.params.mijoz_id)) return res.status(400).json({ message: 'mijoz_id noto‘g‘ri.' });
    try {
      const customer = await customers.findOne({ mijoz_id: Number(req.params.mijoz_id) });
      if (!customer) return res.status(404).json({ message: 'Mijoz topilmadi.' });
      return res.json({ customer: publicCustomer((await withPayments([customer]))[0]) });
    } catch (error) {
      logger.error('Mijozni olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.post('/customers/:mijoz_id/payments', authenticate, async (req, res) => {
    if (!CREATOR_ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!validCustomerNumber(req.params.mijoz_id)) return res.status(400).json({ message: 'mijoz_id noto‘g‘ri.' });
    const { amount, method, forMonth, cardNumber, provider, providerName } = req.body || {};
    if (!Number.isSafeInteger(amount) || amount <= 0 ||
        (forMonth !== undefined && !validPaymentMonth(forMonth))) {
      return res.status(400).json({ message: 'To‘lov summasi, usuli va forMonth (YYYY-MM) ni to‘g‘ri kiriting.' });
    }
    let details;
    try { details = await paymentDetails({ method, cardNumber, provider, providerName }, paymentApps); }
    catch (error) { return res.status(400).json({ message: error.message }); }
    try {
      const payment = {
        _id: new ObjectId(),
        type: 'installment',
        amount,
        method,
        receivedBy: res.locals.currentUser._id,
        paidAt: new Date(now()),
        forMonth: forMonth ?? null,
        status: 'active',
        ...details,
      };
      const session = mongoClient.startSession();
      let updated;
      try {
        await session.withTransaction(async () => {
          updated = await customers.findOneAndUpdate(
            { mijoz_id: Number(req.params.mijoz_id), remainingBalance: { $gte: amount } },
            { $inc: { totalPaid: amount, remainingBalance: -amount }, $set: { updatedAt: payment.paidAt } },
            { returnDocument: 'after', session },
          );
          if (updated) await payments.insertOne({ ...payment, customerId: updated._id, mijoz_id: updated.mijoz_id }, { session });
          if (updated) await auditLogs.insertOne(auditEntry({ action: 'payment.created', customer: updated, payment,
            actor: res.locals.currentUser, createdAt: payment.paidAt,
            before: { balance: { downPayment: updated.downPayment, totalPaid: updated.totalPaid - amount,
              remainingBalance: updated.remainingBalance + amount } },
            after: { payment: paymentSnapshot(payment), balance: balanceSnapshot(updated) } }), { session });
        });
      } finally { await session.endSession(); }
      if (updated) return res.status(201).json({ paymentId: payment._id.toString(), payment: publicPayment(payment), customer: publicCustomer((await withPayments([updated]))[0]) });
      const customer = await customers.findOne({ mijoz_id: Number(req.params.mijoz_id) });
      if (!customer) return res.status(404).json({ message: 'Mijoz topilmadi.' });
      return res.status(409).json({ message: 'To‘lov qolgan qarzdan katta.' });
    } catch (error) {
      logger.error('To‘lovni yozishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.post('/customers/:mijoz_id/payments/:paymentId/void', authenticate, async (req, res) => {
    if (res.locals.currentUser.role !== 'super_admin') return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!validCustomerNumber(req.params.mijoz_id) || !ObjectId.isValid(req.params.paymentId)) {
      return res.status(400).json({ message: 'Mijoz yoki to‘lov ID noto‘g‘ri.' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
        typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500) {
      return res.status(400).json({ message: 'Bekor qilish sababi 1–500 belgidan iborat bo‘lishi kerak.' });
    }
    const mijozId = Number(req.params.mijoz_id);
    const paymentId = new ObjectId(req.params.paymentId);
    const actor = res.locals.currentUser;
    const voidedAt = new Date(now());
    const reason = body.reason.trim();
    const session = mongoClient.startSession();
    let updatedPayment;
    let updatedCustomer;
    let audit;
    try {
      await session.withTransaction(async () => {
        const previous = await payments.findOne({ _id: paymentId, mijoz_id: mijozId }, { session });
        if (!previous) {
          const error = new Error('To‘lov topilmadi.'); error.status = 404; throw error;
        }
        if (previous.status === 'voided') {
          const error = new Error('To‘lov allaqachon bekor qilingan.'); error.status = 409; throw error;
        }
        if (!Number.isSafeInteger(previous.amount) || previous.amount <= 0 ||
            !['initial', 'installment'].includes(previous.type) || !previous.customerId) {
          const error = new Error('To‘lov ma’lumotlari to‘g‘ri emas.'); error.status = 409; throw error;
        }
        updatedPayment = await payments.findOneAndUpdate(
          { _id: paymentId, mijoz_id: mijozId, status: { $ne: 'voided' } },
          { $set: { status: 'voided', voidedAt, voidedBy: actor._id, voidReason: reason } },
          { returnDocument: 'after', session },
        );
        if (!updatedPayment) {
          const error = new Error('To‘lov allaqachon bekor qilingan.'); error.status = 409; throw error;
        }
        const balanceChange = { totalPaid: -previous.amount, remainingBalance: previous.amount };
        if (previous.type === 'initial') balanceChange.downPayment = -previous.amount;
        updatedCustomer = await customers.findOneAndUpdate(
          { _id: previous.customerId, mijoz_id: mijozId, totalPaid: { $gte: previous.amount },
            ...(previous.type === 'initial' && { downPayment: { $gte: previous.amount } }) },
          { $inc: balanceChange, $set: { updatedAt: voidedAt } },
          { returnDocument: 'after', session },
        );
        if (!updatedCustomer) throw new Error('To‘lov va mijoz balansi mos emas.');
        audit = auditEntry({ action: 'payment.voided', customer: updatedCustomer, payment: previous,
          actor, createdAt: voidedAt, reason,
          before: { payment: paymentSnapshot(previous), balance: {
            downPayment: updatedCustomer.downPayment + (previous.type === 'initial' ? previous.amount : 0),
            totalPaid: updatedCustomer.totalPaid + previous.amount,
            remainingBalance: updatedCustomer.remainingBalance - previous.amount,
          } },
          after: { payment: paymentSnapshot(updatedPayment), balance: balanceSnapshot(updatedCustomer) } });
        const result = await auditLogs.insertOne(audit, { session });
        audit._id = result.insertedId;
      });
      return res.json({ payment: publicPayment(updatedPayment), customer: publicCustomer((await withPayments([updatedCustomer]))[0]), audit: publicAudit(audit) });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
      logger.error('To‘lovni bekor qilishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    } finally { await session.endSession(); }
  });

  app.get('/customers/:mijoz_id/audit', authenticate, async (req, res) => {
    if (res.locals.currentUser.role !== 'super_admin') return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!validCustomerNumber(req.params.mijoz_id)) return res.status(400).json({ message: 'mijoz_id noto‘g‘ri.' });
    if (Object.keys(req.query).some((key) => !['page', 'limit'].includes(key)) ||
        Object.values(req.query).some((value) => typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) {
      return res.status(400).json({ message: 'page yoki limit noto‘g‘ri.' });
    }
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit) || limit > 100 ||
        !Number.isSafeInteger((page - 1) * limit)) return res.status(400).json({ message: 'page yoki limit noto‘g‘ri.' });
    try {
      const mijozId = Number(req.params.mijoz_id);
      if (!await customers.findOne({ mijoz_id: mijozId })) return res.status(404).json({ message: 'Mijoz topilmadi.' });
      const filter = { mijoz_id: mijozId };
      const [total, entries] = await Promise.all([
        auditLogs.countDocuments(filter),
        auditLogs.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      ]);
      return res.json({ entries: entries.map(publicAudit), total, page, limit });
    } catch (error) {
      logger.error('Audit tarixini olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });
}

module.exports = { registerCustomerRoutes, buildCustomerListQuery };
