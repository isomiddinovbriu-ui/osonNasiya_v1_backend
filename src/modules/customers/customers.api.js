const { ObjectId } = require('mongodb');
const { nextCustomerId } = require('./customer-id.service');
const { methodIds, validProviderCode, paymentDetails } = require('../payments/payment-options');
const { balanceSnapshot, paymentSnapshot, auditEntry, publicAudit } = require('../payments/payment-audit');
const { paymentRequestHash, validIdempotencyKey } = require('../payments/payment-idempotency');
const { withPaymentBalances } = require('../payments/payment-balances');
const { localDate } = require('../reports/reports.service');
const { withRollback } = require('./rollback');

const CREATOR_ROLES = new Set(['super_admin', 'sotuvchi', 'yiguvchi']);
const ID_FILTERS = ['regionId', 'groupId', 'sectionId', 'productId', 'createdBy', 'assignedTo', 'paymentId', 'receivedBy'];
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
    remainingBalanceAfter: payment.remainingBalanceAfter ?? null,
    method: payment.method,
    receivedBy: payment.receivedBy.toString(),
    dailyPlanId: payment.dailyPlanId?.toString() ?? null,
    paidAt: payment.paidAt,
    forMonth: payment.forMonth ?? null,
    cardLast4: payment.cardLast4 ?? null,
    provider: payment.provider ?? null,
    providerName: payment.providerName ?? null,
    status: payment.status ?? 'active',
    voidedAt: payment.voidedAt ?? null,
    voidedBy: payment.voidedBy?.toString() ?? null,
    voidedByName: payment.voidedByName ?? null,
    voidReason: payment.voidReason ?? null,
  };
}

function publicCustomer(customer) {
  return {
    mijoz_id: customer.mijoz_id,
    name: customer.name,
    phoneNumber: customer.phoneNumber,
    addPhoneNumber: customer.addPhoneNumber ?? null,
    address: customer.address ?? null,
    assignedTo: customer.assignedTo?.toString() ?? null,
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
    payments: withPaymentBalances(customer.totalPrice, customer.payments || []).map(publicPayment),
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

function restoreMetadata(document, fields = ['updatedAt']) {
  const $set = {};
  const $unset = {};
  for (const field of fields) {
    if (Object.hasOwn(document, field)) $set[field] = document[field];
    else $unset[field] = '';
  }
  return { $set, $unset };
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

function registerCustomerRoutes(app, { authenticate, users, customers, payments, paymentApps, paymentRequests, paymentVoidRequests, dailyPlans, auditLogs, counters, regions, productCategories, products, jwtSecret, logger, now }) {
  async function withPayments(items) {
    if (!items.length) return items;
    const rows = await payments.find({ customerId: { $in: items.map((item) => item._id) } })
      .sort({ paidAt: 1, _id: 1 }).toArray();
    const voiderIds = [...new Set(rows.filter((row) => row.voidedBy)
      .map((row) => row.voidedBy.toString()))].map((id) => new ObjectId(id));
    const voiders = voiderIds.length
      ? await users.find({ _id: { $in: voiderIds } }).project({ name: 1, login: 1 }).toArray()
      : [];
    const voiderNames = new Map(voiders.map((user) => [user._id.toString(), user.name || user.login]));
    const byCustomer = new Map();
    for (const row of rows) {
      if (row.voidedBy) row.voidedByName = voiderNames.get(row.voidedBy.toString()) ?? null;
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
      return res.json({ customers: hydrated.map((customer, index) => ({
        ...publicCustomer(customer),
        distanceMeters: Math.round(nearby[index].distance * 1000),
        distanceKm: Number(nearby[index].distance.toFixed(3)),
      })), total: nearby.length });
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
    const address = req.body?.address;
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
        typeof description !== 'string' || description.length > 1000 ||
        (address !== undefined && address !== null && (typeof address !== 'string' || address.trim().length > 500))) {
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
        address: typeof address === 'string' && address.trim() ? address.trim() : null,
        assignedTo: null,
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
      let result;
      await withRollback(async (step) => {
          result = await step(() => customers.insertOne(document),
            () => customers.deleteOne({ _id: result.insertedId }));
          const savedCustomer = { ...document, _id: result.insertedId };
          const customerAudit = auditEntry({ action: 'customer.created', customer: savedCustomer, actor, createdAt,
            after: { balance: balanceSnapshot(savedCustomer) } });
          customerAudit._id = new ObjectId();
          await step(() => auditLogs.insertOne(customerAudit),
            () => auditLogs.deleteOne({ _id: customerAudit._id }));
          if (initialPayment) {
            await step(() => payments.insertOne({ ...initialPayment, customerId: result.insertedId, mijoz_id: document.mijoz_id }),
              () => payments.deleteOne({ _id: initialPayment._id }));
            const paymentAudit = auditEntry({ action: 'payment.created', customer: savedCustomer, payment: initialPayment, actor, createdAt,
              before: { balance: { downPayment: 0, totalPaid: 0, remainingBalance: totalPrice } },
              after: { payment: paymentSnapshot(initialPayment), balance: balanceSnapshot(savedCustomer) } });
            paymentAudit._id = new ObjectId();
            await step(() => auditLogs.insertOne(paymentAudit),
              () => auditLogs.deleteOne({ _id: paymentAudit._id }));
          }
      }, logger);
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

  app.patch('/customers/:mijoz_id', authenticate, async (req, res) => {
    if (!CREATOR_ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!validCustomerNumber(req.params.mijoz_id)) return res.status(400).json({ message: 'mijoz_id noto‘g‘ri.' });
    const body = req.body;
    const allowed = new Set(['name', 'phoneNumber', 'addPhoneNumber', 'address', 'lat', 'long', 'assignedTo']);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
        Object.keys(body).some((field) => !allowed.has(field))) {
      return res.status(400).json({ message: 'O‘zgartiriladigan mijoz maydonlarini to‘g‘ri kiriting.' });
    }
    if ('assignedTo' in body && res.locals.currentUser.role !== 'super_admin') {
      return res.status(403).json({ message: 'Mas’ul xodimni faqat super_admin o‘zgartiradi.' });
    }
    const changes = {};
    if ('name' in body) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) return res.status(400).json({ message: 'Ism noto‘g‘ri.' });
      changes.name = body.name.trim();
    }
    if ('phoneNumber' in body) {
      if (!validPhone(body.phoneNumber?.trim?.())) return res.status(400).json({ message: 'Telefon raqami noto‘g‘ri.' });
      changes.phoneNumber = body.phoneNumber.trim();
    }
    if ('addPhoneNumber' in body) {
      if (body.addPhoneNumber !== null && typeof body.addPhoneNumber !== 'string') return res.status(400).json({ message: 'Qo‘shimcha telefon noto‘g‘ri.' });
      const value = body.addPhoneNumber?.trim() || null;
      if (value && !validPhone(value)) return res.status(400).json({ message: 'Qo‘shimcha telefon noto‘g‘ri.' });
      changes.addPhoneNumber = value;
    }
    if ('address' in body) {
      if (body.address !== null && (typeof body.address !== 'string' || body.address.trim().length > 500)) return res.status(400).json({ message: 'Manzil 500 belgidan oshmasligi kerak.' });
      changes.address = body.address?.trim() || null;
    }
    if ('lat' in body || 'long' in body) {
      if (!('lat' in body && 'long' in body) || typeof body.lat !== 'number' || !Number.isFinite(body.lat) || body.lat < -90 || body.lat > 90 ||
          typeof body.long !== 'number' || !Number.isFinite(body.long) || body.long < -180 || body.long > 180) {
        return res.status(400).json({ message: 'lat va long koordinatalarini birga to‘g‘ri kiriting.' });
      }
      changes.lat = body.lat;
      changes.long = body.long;
    }
    if ('assignedTo' in body) {
      if (body.assignedTo !== null && (typeof body.assignedTo !== 'string' || !/^[0-9a-fA-F]{24}$/.test(body.assignedTo))) return res.status(400).json({ message: 'Mas’ul xodim ID noto‘g‘ri.' });
      changes.assignedTo = body.assignedTo === null ? null : new ObjectId(body.assignedTo);
    }
    try {
      if (changes.assignedTo) {
        const staff = await users.findOne({ _id: changes.assignedTo, role: { $in: ['sotuvchi', 'yiguvchi'] }, deletedAt: { $exists: false } });
        if (!staff) return res.status(404).json({ message: 'Mas’ul xodim topilmadi.' });
      }
      let updated;
      let audit;
      await withRollback(async (step) => {
          const customer = await customers.findOne({ mijoz_id: Number(req.params.mijoz_id) });
          if (!customer) { const error = new Error('Mijoz topilmadi.'); error.status = 404; throw error; }
          const before = {};
          const after = {};
          for (const [field, value] of Object.entries(changes)) {
            const oldValue = customer[field] ?? null;
            const oldPublic = oldValue instanceof ObjectId ? oldValue.toString() : oldValue;
            const newPublic = value instanceof ObjectId ? value.toString() : value;
            if (oldPublic !== newPublic) { before[field] = oldPublic; after[field] = newPublic; }
          }
          if (!Object.keys(after).length) { updated = customer; return; }
          const changed = Object.fromEntries(Object.keys(after).map((field) => [field, changes[field]]));
          const changedAt = new Date(now());
          updated = await step(() => customers.findOneAndUpdate({ _id: customer._id,
            updatedAt: Object.hasOwn(customer, 'updatedAt') ? customer.updatedAt : { $exists: false } },
            { $set: { ...changed, updatedAt: changedAt, updatedBy: res.locals.currentUser._id } },
            { returnDocument: 'after' }), async () => {
              const restore = Object.fromEntries(Object.keys(changed).map((field) => [field, customer[field] ?? null]));
              const metadata = restoreMetadata(customer, ['updatedAt', 'updatedBy']);
              return customers.updateOne({ _id: customer._id, updatedAt: changedAt },
                { $set: { ...restore, ...metadata.$set }, $unset: metadata.$unset });
            });
          if (!updated) { const error = new Error('Mijoz bir vaqtda o‘zgartirilgan.'); error.status = 409; throw error; }
          audit = auditEntry({ action: 'customer.updated', customer: updated, actor: res.locals.currentUser,
            createdAt: changedAt, before, after });
          audit._id = new ObjectId();
          await step(() => auditLogs.insertOne(audit), () => auditLogs.deleteOne({ _id: audit._id }));
      }, logger);
      return res.json({ customer: publicCustomer((await withPayments([updated]))[0]), audit: audit ? publicAudit(audit) : null });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
      logger.error('Mijozni yangilashda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.patch('/customers/:mijoz_id/terms', authenticate, async (req, res) => {
    if (res.locals.currentUser.role !== 'super_admin') return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!validCustomerNumber(req.params.mijoz_id)) return res.status(400).json({ message: 'mijoz_id noto‘g‘ri.' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some((key) => !['totalPrice', 'termMonths', 'reason'].includes(key)) ||
        !('totalPrice' in body || 'termMonths' in body) ||
        typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500 ||
        ('totalPrice' in body && (!Number.isSafeInteger(body.totalPrice) || body.totalPrice <= 0)) ||
        ('termMonths' in body && (!Number.isInteger(body.termMonths) || body.termMonths < 1 || body.termMonths > 120))) {
      return res.status(400).json({ message: 'Narx, muddat va 1–500 belgili sababni to‘g‘ri kiriting.' });
    }
    let updated;
    let audit;
    try {
      await withRollback(async (step) => {
        const customer = await customers.findOne({ mijoz_id: Number(req.params.mijoz_id) });
        if (!customer) { const error = new Error('Mijoz topilmadi.'); error.status = 404; throw error; }
        const totalPrice = body.totalPrice ?? customer.totalPrice;
        const termMonths = body.termMonths ?? customer.termMonths;
        if (totalPrice < customer.totalPaid || !Number.isSafeInteger(totalPrice - customer.totalPaid)) {
          const error = new Error('Yangi narx to‘langan summadan kam bo‘lmasligi kerak.'); error.status = 409; throw error;
        }
        if (body.totalPrice !== undefined && customer.productId) {
          const product = await products.findOne({ _id: customer.productId });
          if (product?.minSellingPrice != null && totalPrice < product.minSellingPrice) {
            const error = new Error('Yangi narx mahsulotning eng past sotilish narxidan kam.'); error.status = 409; throw error;
          }
        }
        if (totalPrice === customer.totalPrice && termMonths === customer.termMonths) { updated = customer; return; }
        const changedAt = new Date(now());
        updated = await step(() => customers.findOneAndUpdate({ _id: customer._id,
          updatedAt: Object.hasOwn(customer, 'updatedAt') ? customer.updatedAt : { $exists: false }, totalPaid: customer.totalPaid },
          { $set: { totalPrice, termMonths, remainingBalance: totalPrice - customer.totalPaid,
            updatedAt: changedAt, updatedBy: res.locals.currentUser._id } },
          { returnDocument: 'after' }), () => customers.updateOne({ _id: customer._id, updatedAt: changedAt },
          { $set: { totalPrice: customer.totalPrice, termMonths: customer.termMonths,
            remainingBalance: customer.remainingBalance, ...restoreMetadata(customer, ['updatedAt', 'updatedBy']).$set },
            $unset: restoreMetadata(customer, ['updatedAt', 'updatedBy']).$unset }));
        if (!updated) { const error = new Error('Mijoz bir vaqtda o‘zgartirilgan.'); error.status = 409; throw error; }
        audit = auditEntry({ action: 'customer.terms_updated', customer: updated, actor: res.locals.currentUser,
          createdAt: changedAt, reason: body.reason.trim(),
          before: { totalPrice: customer.totalPrice, termMonths: customer.termMonths, remainingBalance: customer.remainingBalance },
          after: { totalPrice: updated.totalPrice, termMonths: updated.termMonths, remainingBalance: updated.remainingBalance } });
        audit._id = new ObjectId();
        await step(() => auditLogs.insertOne(audit), () => auditLogs.deleteOne({ _id: audit._id }));
      }, logger);
      return res.json({ customer: publicCustomer((await withPayments([updated]))[0]), audit: audit ? publicAudit(audit) : null });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
      logger.error('Mijoz shartlarini yangilashda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  async function addPaymentHandler(req, res) {
    if (!CREATOR_ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!validCustomerNumber(req.params.mijoz_id)) return res.status(400).json({ message: 'mijoz_id noto‘g‘ri.' });
    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey !== undefined && !validIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({ message: 'Idempotency-Key 8–128 belgili harf, raqam, nuqta, chiziq, pastki chiziq yoki ikki nuqtadan iborat bo‘lishi kerak.' });
    }
    const { amount, method, forMonth, cardNumber, provider, providerName } = req.body || {};
    const dailyPlanId = req.params.planId;
    if (!Number.isSafeInteger(amount) || amount <= 0 ||
        (forMonth !== undefined && !validPaymentMonth(forMonth)) ||
        Object.hasOwn(req.body || {}, 'dailyPlanId') ||
        (dailyPlanId !== undefined && !ObjectId.isValid(dailyPlanId))) {
      return res.status(400).json({ message: 'To‘lov summasi, usuli, forMonth (YYYY-MM) va reja ID sini to‘g‘ri kiriting.' });
    }
    const actorId = res.locals.currentUser._id;
    const mijozId = Number(req.params.mijoz_id);
    const requestHash = idempotencyKey ? paymentRequestHash(jwtSecret, mijozId,
      dailyPlanId === undefined ? req.body : { ...req.body, dailyPlanId }) : null;
    const requestFilter = idempotencyKey ? { actorId, key: idempotencyKey } : null;
    function replay(existing) {
      if (existing.requestHash !== requestHash) return res.status(409).json({ message: 'Idempotency-Key boshqa so‘rov uchun ishlatilgan.' });
      if (!existing.response) return res.status(409).json({ message: 'To‘lov so‘rovi hali bajarilmoqda. Qayta urinib ko‘ring.' });
      res.set('Idempotency-Replayed', 'true');
      return res.status(201).json(existing.response);
    }
    try {
      if (requestFilter) {
        const existing = await paymentRequests.findOne(requestFilter);
        if (existing) return replay(existing);
      }
      let details;
      try { details = await paymentDetails({ method, cardNumber, provider, providerName }, paymentApps); }
      catch (error) { return res.status(400).json({ message: error.message }); }
      const payment = {
        _id: new ObjectId(),
        type: 'installment',
        amount,
        method,
        receivedBy: res.locals.currentUser._id,
        ...(dailyPlanId !== undefined && { dailyPlanId: new ObjectId(dailyPlanId) }),
        paidAt: new Date(now()),
        forMonth: forMonth ?? null,
        status: 'active',
        ...details,
      };
      let updated;
      let savedResponse;
      await withRollback(async (step) => {
          if (requestFilter) {
            await step(() => paymentRequests.insertOne({ ...requestFilter, requestHash, createdAt: payment.paidAt }),
              () => paymentRequests.deleteOne({ ...requestFilter, requestHash }));
          }
          const oldCustomer = await customers.findOne({ mijoz_id: mijozId });
          updated = await step(() => customers.findOneAndUpdate(
            { mijoz_id: mijozId, remainingBalance: { $gte: amount } },
            { $inc: { totalPaid: amount, remainingBalance: -amount }, $set: { updatedAt: payment.paidAt } },
            { returnDocument: 'after' },
          ), () => updated && customers.updateOne(
            { _id: updated._id, updatedAt: payment.paidAt, totalPaid: updated.totalPaid, remainingBalance: updated.remainingBalance },
            { $inc: { totalPaid: -amount, remainingBalance: amount },
              ...restoreMetadata(oldCustomer ?? {}) }));
          if (!updated) {
            const customer = await customers.findOne({ mijoz_id: mijozId });
            const error = new Error(customer ? 'To‘lov qolgan qarzdan katta.' : 'Mijoz topilmadi.');
            error.status = customer ? 409 : 404;
            throw error;
          }
          if (payment.dailyPlanId) {
            const plan = await dailyPlans.findOne({ _id: payment.dailyPlanId });
            if (!plan) { const error = new Error('Kunlik reja topilmadi.'); error.status = 404; throw error; }
            if (!plan.regionId.equals(updated.regionId)) {
              const error = new Error('Mijoz boshqa hududdagi rejaga tegishli.'); error.status = 409; throw error;
            }
            const planUpdate = await step(() => dailyPlans.updateOne(
              { _id: payment.dailyPlanId, date: localDate(payment.paidAt), status: 'open' },
              { $push: { payments: { paymentId: payment._id, customerId: updated._id,
                mijoz_id: updated.mijoz_id, amount, receivedBy: actorId, paidAt: payment.paidAt,
                status: 'active' } }, $inc: { paymentCount: 1, totalAmount: amount } }),
              () => dailyPlans.updateOne({ _id: payment.dailyPlanId, 'payments.paymentId': payment._id },
                { $pull: { payments: { paymentId: payment._id } }, $inc: { paymentCount: -1, totalAmount: -amount } }));
            if (planUpdate.matchedCount !== 1) {
              const error = new Error('Reja yopilgan yoki bugungi kunga tegishli emas.'); error.status = 409; throw error;
            }
          }
          await step(() => payments.insertOne({ ...payment, customerId: updated._id, mijoz_id: updated.mijoz_id }),
            () => payments.deleteOne({ _id: payment._id }));
          const paymentAudit = auditEntry({ action: 'payment.created', customer: updated, payment,
            actor: res.locals.currentUser, createdAt: payment.paidAt,
            before: { balance: { downPayment: updated.downPayment, totalPaid: updated.totalPaid - amount,
              remainingBalance: updated.remainingBalance + amount } },
            after: { payment: paymentSnapshot(payment), balance: balanceSnapshot(updated) } });
          paymentAudit._id = new ObjectId();
          await step(() => auditLogs.insertOne(paymentAudit), () => auditLogs.deleteOne({ _id: paymentAudit._id }));
          if (requestFilter) {
            savedResponse = { paymentId: payment._id.toString(), payment: publicPayment({ ...payment, remainingBalanceAfter: updated.remainingBalance }),
              customer: publicCustomer((await withPayments([updated]))[0]) };
            const stored = await paymentRequests.updateOne(requestFilter, { $set: { response: savedResponse, paymentId: payment._id,
              customerId: updated._id, completedAt: payment.paidAt } });
            if (stored.matchedCount !== 1) throw new Error('Idempotency yozuvi topilmadi.');
          }
      }, logger);
      return res.status(201).json(savedResponse ?? { paymentId: payment._id.toString(), payment: publicPayment({ ...payment, remainingBalanceAfter: updated.remainingBalance }), customer: publicCustomer((await withPayments([updated]))[0]) });
    } catch (error) {
      if (error.code === 11000 && requestFilter) {
        try {
          const existing = await paymentRequests.findOne(requestFilter);
          if (existing) return replay(existing);
        } catch (lookupError) { logger.error('Takroriy to‘lovni tekshirishda xatolik:', lookupError); }
      }
      if (error.status) return res.status(error.status).json({ message: error.message });
      logger.error('To‘lovni yozishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  }
  app.post('/customers/:mijoz_id/payments', authenticate, addPaymentHandler);
  app.post('/daily-plans/:planId/customers/:mijoz_id/payments', authenticate, addPaymentHandler);

  app.patch('/customers/:mijoz_id/payments/:paymentId', authenticate, async (req, res) => {
    const actor = res.locals.currentUser;
    if (!CREATOR_ROLES.has(actor.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!validCustomerNumber(req.params.mijoz_id) || !ObjectId.isValid(req.params.paymentId)) {
      return res.status(400).json({ message: 'Mijoz yoki to‘lov ID noto‘g‘ri.' });
    }
    const body = req.body;
    const allowed = new Set(['amount', 'method', 'forMonth', 'cardNumber', 'provider', 'providerName']);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
        Object.keys(body).some((key) => !allowed.has(key)) ||
        ('amount' in body && (!Number.isSafeInteger(body.amount) || body.amount <= 0)) ||
        ('forMonth' in body && body.forMonth !== null && !validPaymentMonth(body.forMonth))) {
      return res.status(400).json({ message: 'To‘lov summasi, usuli yoki oyi noto‘g‘ri.' });
    }
    if ('forMonth' in body && actor.role !== 'super_admin') {
      return res.status(403).json({ message: 'To‘lov oyini faqat super_admin o‘zgartiradi.' });
    }
    const paymentId = new ObjectId(req.params.paymentId);
    const mijozId = Number(req.params.mijoz_id);
    let updatedPayment;
    let updatedCustomer;
    let audit = null;
    try {
      await withRollback(async (step) => {
        const previous = await payments.findOne({ _id: paymentId, mijoz_id: mijozId });
        if (!previous) { const error = new Error('To‘lov topilmadi.'); error.status = 404; throw error; }
        if (previous.receivedBy?.toString() !== actor._id.toString() && actor.role !== 'super_admin') {
          const error = new Error('Faqat o‘zingiz yozgan to‘lovni tahrirlay olasiz.'); error.status = 403; throw error;
        }
        if (previous.status === 'voided') {
          const error = new Error('Bekor qilingan to‘lov tahrirlanmaydi.'); error.status = 409; throw error;
        }
        if ('forMonth' in body && previous.type === 'initial') {
          const error = new Error('Boshlang‘ich to‘lov uchun oy kiritilmaydi.'); error.status = 400; throw error;
        }
        const customer = await customers.findOne({ _id: previous.customerId, mijoz_id: mijozId });
        if (!customer) { const error = new Error('Mijoz topilmadi.'); error.status = 404; throw error; }
        const amount = body.amount ?? previous.amount;
        const delta = amount - previous.amount;
        const nextTotalPaid = customer.totalPaid + delta;
        const nextRemainingBalance = customer.remainingBalance - delta;
        const nextDownPayment = customer.downPayment + (previous.type === 'initial' ? delta : 0);
        if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(nextTotalPaid) ||
            !Number.isSafeInteger(nextRemainingBalance) || !Number.isSafeInteger(nextDownPayment) ||
            nextTotalPaid < 0 || nextRemainingBalance < 0 || nextDownPayment < 0 ||
            nextDownPayment > customer.totalPrice || nextTotalPaid > customer.totalPrice) {
          const error = new Error('Yangi summa mijozning qolgan qarzi yoki to‘langan summasiga mos emas.');
          error.status = 409; throw error;
        }
        const detailsChanged = ['method', 'cardNumber', 'provider', 'providerName'].some((key) => key in body);
        let details = {};
        if (detailsChanged) {
          try { details = await paymentDetails({ method: body.method ?? previous.method,
            cardNumber: body.cardNumber, provider: body.provider, providerName: body.providerName }, paymentApps); }
          catch (error) { error.status = 400; throw error; }
        }
        const changes = {
          ...(delta && { amount }),
          ...(detailsChanged && { method: body.method ?? previous.method, ...details }),
          ...('forMonth' in body && { forMonth: body.forMonth }),
        };
        if (Object.entries(changes).every(([key, value]) => value === (previous[key] ?? null))) {
          updatedPayment = previous;
          updatedCustomer = customer;
          return;
        }
        const changedAt = new Date(now());
        const revision = previous.revision ?? 0;
        const oldMetadata = restoreMetadata(previous, ['updatedAt', 'updatedBy']);
        updatedPayment = await step(() => payments.findOneAndUpdate(
          { _id: paymentId, mijoz_id: mijozId, status: { $ne: 'voided' },
            revision: Object.hasOwn(previous, 'revision') ? revision : { $exists: false } },
          { $set: { ...changes, updatedAt: changedAt, updatedBy: actor._id }, $inc: { revision: 1 } },
          { returnDocument: 'after' },
        ), () => payments.updateOne({ _id: paymentId, revision: revision + 1, updatedAt: changedAt },
          { $set: { ...Object.fromEntries(Object.keys(changes).filter((key) => Object.hasOwn(previous, key))
            .map((key) => [key, previous[key]])), ...oldMetadata.$set },
          $unset: { ...Object.fromEntries(Object.keys(changes).filter((key) => !Object.hasOwn(previous, key))
            .map((key) => [key, ''])), ...oldMetadata.$unset,
            ...(!Object.hasOwn(previous, 'revision') && { revision: '' }) },
          ...(Object.hasOwn(previous, 'revision') && { $inc: { revision: -1 } }) }));
        if (!updatedPayment) {
          const error = new Error('To‘lov bir vaqtda o‘zgartirilgan yoki bekor qilingan.'); error.status = 409; throw error;
        }
        if (delta) {
          updatedCustomer = await step(() => customers.findOneAndUpdate(
            { _id: customer._id, mijoz_id: mijozId, totalPrice: customer.totalPrice,
              totalPaid: customer.totalPaid, remainingBalance: customer.remainingBalance,
              downPayment: customer.downPayment },
            { $inc: { totalPaid: delta, remainingBalance: -delta,
              ...(previous.type === 'initial' && { downPayment: delta }) },
            $set: { updatedAt: changedAt } }, { returnDocument: 'after' }),
          () => customers.updateOne({ _id: customer._id, updatedAt: changedAt,
            totalPaid: nextTotalPaid, remainingBalance: nextRemainingBalance,
            downPayment: nextDownPayment },
          { $inc: { totalPaid: -delta, remainingBalance: delta,
            ...(previous.type === 'initial' && { downPayment: -delta }) },
          ...restoreMetadata(customer) }));
          if (!updatedCustomer) {
            const error = new Error('Mijoz balansi bir vaqtda o‘zgartirilgan.'); error.status = 409; throw error;
          }
        } else updatedCustomer = customer;
        if (delta && previous.dailyPlanId) {
          const planUpdate = await step(() => dailyPlans.updateOne(
            { _id: previous.dailyPlanId, payments: { $elemMatch: { paymentId, status: 'active', amount: previous.amount } } },
            { $set: { 'payments.$.amount': amount }, $inc: { totalAmount: delta } }),
          () => dailyPlans.updateOne(
            { _id: previous.dailyPlanId, payments: { $elemMatch: { paymentId, status: 'active', amount } } },
            { $set: { 'payments.$.amount': previous.amount }, $inc: { totalAmount: -delta } }));
          if (planUpdate.matchedCount !== 1) {
            const error = new Error('Rejadagi to‘lov mos kelmadi.'); error.status = 409; throw error;
          }
        }
        audit = auditEntry({ action: 'payment.updated', customer: updatedCustomer, payment: updatedPayment,
          actor, createdAt: changedAt,
          before: { payment: paymentSnapshot(previous), balance: balanceSnapshot(customer) },
          after: { payment: paymentSnapshot(updatedPayment), balance: balanceSnapshot(updatedCustomer) } });
        audit._id = new ObjectId();
        await step(() => auditLogs.insertOne(audit), () => auditLogs.deleteOne({ _id: audit._id }));
      }, logger);
      const hydrated = (await withPayments([updatedCustomer]))[0];
      return res.json({ payment: publicCustomer(hydrated).payments.find((item) => item.paymentId === paymentId.toString()),
        customer: publicCustomer(hydrated), audit: audit ? publicAudit(audit) : null });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
      logger.error('To‘lovni tahrirlashda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  async function voidPaymentHandler(req, res) {
    if (res.locals.currentUser.role !== 'super_admin') return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!validCustomerNumber(req.params.mijoz_id) || !ObjectId.isValid(req.params.paymentId)) {
      return res.status(400).json({ message: 'Mijoz yoki to‘lov ID noto‘g‘ri.' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
        !(typeof body.reason === 'string' && body.reason.trim() && body.reason.trim().length <= 500) &&
        !ObjectId.isValid(body.requestId)) {
      return res.status(400).json({ message: 'Bekor qilish sababi yoki requestId ni to‘g‘ri kiriting.' });
    }
    const mijozId = Number(req.params.mijoz_id);
    const paymentId = new ObjectId(req.params.paymentId);
    const actor = res.locals.currentUser;
    const voidedAt = new Date(now());
    let reason = typeof body.reason === 'string' ? body.reason.trim() : null;
    let updatedPayment;
    let updatedCustomer;
    let audit;
    try {
      await withRollback(async (step) => {
        const previous = await payments.findOne({ _id: paymentId, mijoz_id: mijozId });
        if (!previous) {
          const error = new Error('To‘lov topilmadi.'); error.status = 404; throw error;
        }
        if (previous.status === 'voided') {
          const error = new Error('To‘lov allaqachon bekor qilingan.'); error.status = 409; throw error;
        }
        if (previous.dailyPlanId) {
          const requestId = ObjectId.isValid(body.requestId) ? new ObjectId(body.requestId) : null;
          if (!requestId && !reason) {
            const error = new Error('Bekor qilish sababini kiriting.'); error.status = 400; throw error;
          }
          const request = requestId
            ? await paymentVoidRequests.findOne({ _id: requestId, paymentId,
              customerId: previous.customerId, status: 'pending' })
            : await paymentVoidRequests.findOne({ paymentId, customerId: previous.customerId, status: 'pending' });
          if (requestId && !request) {
            const error = new Error('Ochiq bekor qilish so‘rovi topilmadi.'); error.status = 404; throw error;
          }
          if (request) {
            if (requestId) reason = request.reason;
            const approved = await step(() => paymentVoidRequests.updateOne({ _id: request._id, status: 'pending' },
              { $set: { status: 'approved', reviewedAt: voidedAt, reviewedBy: actor._id } }),
              () => paymentVoidRequests.updateOne({ _id: request._id, status: 'approved', reviewedAt: voidedAt },
                { $set: { status: 'pending' }, $unset: { reviewedAt: '', reviewedBy: '' } }));
            if (approved.matchedCount !== 1) {
              const error = new Error('So‘rov allaqachon ko‘rilgan.'); error.status = 409; throw error;
            }
          }
          const planUpdate = await step(() => dailyPlans.updateOne({ _id: previous.dailyPlanId,
            payments: { $elemMatch: { paymentId, status: 'active' } } },
          { $set: { 'payments.$.status': 'voided' }, $inc: { paymentCount: -1, totalAmount: -previous.amount } }),
          () => dailyPlans.updateOne({ _id: previous.dailyPlanId,
            payments: { $elemMatch: { paymentId, status: 'voided' } } },
          { $set: { 'payments.$.status': 'active' }, $inc: { paymentCount: 1, totalAmount: previous.amount } }));
          if (planUpdate.matchedCount !== 1) { const error = new Error('Rejadagi to‘lov mos kelmadi.'); error.status = 409; throw error; }
        } else if (!reason) {
          const error = new Error('Bekor qilish sababini kiriting.'); error.status = 400; throw error;
        }
        if (!Number.isSafeInteger(previous.amount) || previous.amount <= 0 ||
            !['initial', 'installment'].includes(previous.type) || !previous.customerId) {
          const error = new Error('To‘lov ma’lumotlari to‘g‘ri emas.'); error.status = 409; throw error;
        }
        updatedPayment = await step(() => payments.findOneAndUpdate(
          { _id: paymentId, mijoz_id: mijozId, status: { $ne: 'voided' },
            revision: Object.hasOwn(previous, 'revision') ? previous.revision : { $exists: false } },
          { $set: { status: 'voided', voidedAt, voidedBy: actor._id, voidReason: reason } },
          { returnDocument: 'after' },
        ), () => updatedPayment && payments.updateOne({ _id: paymentId, status: 'voided', voidedAt },
          { $set: { status: previous.status ?? 'active' },
            $unset: { voidedAt: '', voidedBy: '', voidReason: '' } }));
        if (!updatedPayment) {
          const error = new Error('To‘lov allaqachon bekor qilingan.'); error.status = 409; throw error;
        }
        const balanceChange = { totalPaid: -previous.amount, remainingBalance: previous.amount };
        if (previous.type === 'initial') balanceChange.downPayment = -previous.amount;
        const oldCustomer = await customers.findOne({ _id: previous.customerId });
        updatedCustomer = await step(() => customers.findOneAndUpdate(
          { _id: previous.customerId, mijoz_id: mijozId, totalPaid: { $gte: previous.amount },
            ...(previous.type === 'initial' && { downPayment: { $gte: previous.amount } }) },
          { $inc: balanceChange, $set: { updatedAt: voidedAt } },
          { returnDocument: 'after' },
        ), () => updatedCustomer && customers.updateOne({ _id: previous.customerId, updatedAt: voidedAt,
          totalPaid: updatedCustomer.totalPaid, remainingBalance: updatedCustomer.remainingBalance },
        { $inc: Object.fromEntries(Object.entries(balanceChange).map(([key, value]) => [key, -value])),
          ...restoreMetadata(oldCustomer ?? {}) }));
        if (!updatedCustomer) throw new Error('To‘lov va mijoz balansi mos emas.');
        audit = auditEntry({ action: 'payment.voided', customer: updatedCustomer, payment: previous,
          actor, createdAt: voidedAt, reason,
          before: { payment: paymentSnapshot(previous), balance: {
            downPayment: updatedCustomer.downPayment + (previous.type === 'initial' ? previous.amount : 0),
            totalPaid: updatedCustomer.totalPaid + previous.amount,
            remainingBalance: updatedCustomer.remainingBalance - previous.amount,
          } },
          after: { payment: paymentSnapshot(updatedPayment), balance: balanceSnapshot(updatedCustomer) } });
        audit._id = new ObjectId();
        await step(() => auditLogs.insertOne(audit), () => auditLogs.deleteOne({ _id: audit._id }));
      }, logger);
      return res.json({ payment: publicPayment(updatedPayment), customer: publicCustomer((await withPayments([updatedCustomer]))[0]), audit: publicAudit(audit) });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
      logger.error('To‘lovni bekor qilishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  }
  app.post('/customers/:mijoz_id/payments/:paymentId/void', authenticate, voidPaymentHandler);
  app.post('/payment-void-requests/:id/approve', authenticate, async (req, res) => {
    if (res.locals.currentUser.role !== 'super_admin') return res.status(403).json({ message: 'Ruxsat yo‘q.' });
    if (!ObjectId.isValid(req.params.id) || req.body && Object.keys(req.body).length) {
      return res.status(400).json({ message: 'So‘rov ID noto‘g‘ri.' });
    }
    try {
      const request = await paymentVoidRequests.findOne({ _id: new ObjectId(req.params.id), status: 'pending' });
      if (!request) return res.status(404).json({ message: 'Ochiq so‘rov topilmadi.' });
      req.params = { mijoz_id: String(request.mijoz_id), paymentId: request.paymentId.toString() };
      req.body = { requestId: request._id.toString() };
      return voidPaymentHandler(req, res);
    } catch (error) {
      logger.error('Bekor qilish so‘rovini tasdiqlashda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
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
