const { ObjectId } = require('mongodb');

const ROLES = new Set(['super_admin', 'sotuvchi', 'yiguvchi']);
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit',
});

function localDay(date) {
  const parts = Object.fromEntries(dayFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validDay(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dayEnd(date) {
  return new Date(new Date(`${date}T00:00:00+05:00`).getTime() + 86400000);
}

function pagination(query, allowed = ['page', 'limit']) {
  if (Object.keys(query).some((key) => !allowed.includes(key)) ||
      Object.values(query).some((value) => typeof value !== 'string')) throw new Error('Filtr noto‘g‘ri.');
  function positive(value, fallback, max) {
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error('page yoki limit noto‘g‘ri.');
    return Number(value);
  }
  const page = positive(query.page, 1, Number.MAX_SAFE_INTEGER);
  const limit = positive(query.limit, 20, 100);
  if (!Number.isSafeInteger((page - 1) * limit)) throw new Error('page juda katta.');
  return { page, limit };
}

async function publicContact(contact, payments, now) {
  const result = {
    id: contact._id.toString(), mijoz_id: contact.mijoz_id,
    outcome: contact.outcome, note: contact.note,
    contactedAt: contact.contactedAt, contactedBy: contact.contactedBy.toString(),
    nextContactDate: contact.nextContactDate ?? null,
    promisedDate: contact.promisedDate ?? null,
    promisedAmount: contact.promisedAmount ?? null,
    promiseStatus: null, paidTowardPromise: null,
  };
  if (contact.promisedDate) {
    const cutoff = dayEnd(contact.promisedDate);
    const rows = await payments.find({ customerId: contact.customerId, type: 'installment',
      status: { $ne: 'voided' }, paidAt: { $gt: contact.contactedAt, $lt: cutoff, $lte: now } }).toArray();
    const paid = rows.reduce((sum, payment) => sum + payment.amount, 0);
    result.paidTowardPromise = paid;
    result.promiseStatus = paid >= contact.promisedAmount ? 'fulfilled' : now >= cutoff ? 'broken' : 'pending';
  }
  return result;
}

function registerContactRoutes(app, { authenticate, customers, contacts, payments, logger, now }) {
  app.post('/customers/:mijoz_id/contacts', authenticate, async (req, res) => {
    if (!ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!/^[1-9]\d*$/.test(req.params.mijoz_id) || !Number.isSafeInteger(Number(req.params.mijoz_id))) return res.status(400).json({ message: 'mijoz_id noto‘g‘ri.' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some((key) => !['outcome', 'note', 'nextContactDate', 'promisedDate', 'promisedAmount'].includes(key)) ||
        !['reached', 'no_answer'].includes(body.outcome) ||
        (body.note !== undefined && (typeof body.note !== 'string' || body.note.trim().length > 1000)) ||
        (body.nextContactDate !== undefined && body.nextContactDate !== null && !validDay(body.nextContactDate)) ||
        (body.promisedDate !== undefined && !validDay(body.promisedDate)) ||
        (body.promisedAmount !== undefined && (!Number.isSafeInteger(body.promisedAmount) || body.promisedAmount <= 0)) ||
        (('promisedDate' in body) !== ('promisedAmount' in body)) ||
        (body.outcome === 'no_answer' && 'promisedDate' in body)) {
      return res.status(400).json({ message: 'Aloqa natijasi, keyingi aloqa sanasi va va’da ma’lumotlarini to‘g‘ri kiriting.' });
    }
    const contactedAt = new Date(now());
    const today = localDay(contactedAt);
    if (body.promisedDate && body.promisedDate < today) return res.status(400).json({ message: 'Va’da sanasi o‘tgan bo‘lmasligi kerak.' });
    try {
      const customer = await customers.findOne({ mijoz_id: Number(req.params.mijoz_id) });
      if (!customer) return res.status(404).json({ message: 'Mijoz topilmadi.' });
      if (body.promisedAmount > customer.remainingBalance) return res.status(409).json({ message: 'Va’da summasi qolgan qarzdan katta.' });
      if (body.promisedDate) {
        const openCandidates = await contacts.find({ customerId: customer._id, promisedDate: { $gte: today } }).toArray();
        const statuses = await Promise.all(openCandidates.map((row) => publicContact(row, payments, contactedAt)));
        if (statuses.some((row) => row.promiseStatus === 'pending')) {
          return res.status(409).json({ message: 'Mijozning hali bajarilmagan va’dasi bor.' });
        }
      }
      const row = {
        customerId: customer._id, mijoz_id: customer.mijoz_id,
        outcome: body.outcome, note: body.note?.trim() ?? '',
        nextContactDate: body.nextContactDate ?? null,
        promisedDate: body.promisedDate ?? null,
        promisedAmount: body.promisedAmount ?? null,
        contactedAt, contactedBy: res.locals.currentUser._id,
      };
      const result = await contacts.insertOne(row);
      return res.status(201).json({ contact: await publicContact({ ...row, _id: result.insertedId }, payments, contactedAt) });
    } catch (error) {
      logger.error('Aloqa qaydini yaratishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/customers/:mijoz_id/contacts', authenticate, async (req, res) => {
    if (!ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!/^[1-9]\d*$/.test(req.params.mijoz_id) || !Number.isSafeInteger(Number(req.params.mijoz_id))) return res.status(400).json({ message: 'mijoz_id noto‘g‘ri.' });
    let paging;
    try { paging = pagination(req.query); }
    catch (error) { return res.status(400).json({ message: error.message }); }
    try {
      const customer = await customers.findOne({ mijoz_id: Number(req.params.mijoz_id) });
      if (!customer) return res.status(404).json({ message: 'Mijoz topilmadi.' });
      const filter = { customerId: customer._id };
      const [total, rows] = await Promise.all([
        contacts.countDocuments(filter),
        contacts.find(filter).sort({ contactedAt: -1, _id: -1 }).skip((paging.page - 1) * paging.limit).limit(paging.limit).toArray(),
      ]);
      return res.json({ contacts: await Promise.all(rows.map((row) => publicContact(row, payments, new Date(now())))), total, ...paging });
    } catch (error) {
      logger.error('Aloqa tarixini olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/contacts/follow-ups', authenticate, async (req, res) => {
    if (!ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    let paging;
    try {
      paging = pagination(req.query, ['page', 'limit', 'through', 'assignedTo']);
      paging.through = req.query.through ?? localDay(new Date(now()));
      if (!validDay(paging.through)) throw new Error('through YYYY-MM-DD formatida bo‘lishi kerak.');
      if (req.query.assignedTo !== undefined && !/^[0-9a-fA-F]{24}$/.test(req.query.assignedTo)) throw new Error('assignedTo noto‘g‘ri.');
    } catch (error) { return res.status(400).json({ message: error.message }); }
    try {
      const match = req.query.assignedTo ? { assignedTo: new ObjectId(req.query.assignedTo) } : {};
      const assigned = req.query.assignedTo ? await customers.find(match).project({ _id: 1 }).toArray() : null;
      if (assigned && !assigned.length) return res.json({ contacts: [], total: 0, page: paging.page, limit: paging.limit, through: paging.through });
      const pipeline = [
        ...(assigned ? [{ $match: { customerId: { $in: assigned.map((row) => row._id) } } }] : []),
        { $sort: { contactedAt: -1, _id: -1 } },
        { $group: { _id: '$customerId', contact: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$contact' } },
        { $match: { nextContactDate: { $ne: null, $lte: paging.through } } },
        { $sort: { nextContactDate: 1, contactedAt: 1, _id: 1 } },
        { $facet: { count: [{ $count: 'total' }], rows: [{ $skip: (paging.page - 1) * paging.limit }, { $limit: paging.limit }] } },
      ];
      const [result] = await contacts.aggregate(pipeline).toArray();
      const rows = result?.rows ?? [];
      const customerRows = rows.length ? await customers.find({ _id: { $in: rows.map((row) => row.customerId) } })
        .project({ name: 1, phoneNumber: 1, address: 1, assignedTo: 1 }).toArray() : [];
      const byId = new Map(customerRows.map((row) => [row._id.toString(), row]));
      const items = await Promise.all(rows.map(async (row) => ({ ...await publicContact(row, payments, new Date(now())),
        customer: customerBrief(byId.get(row.customerId.toString())) })));
      return res.json({ contacts: items, total: result?.count?.[0]?.total ?? 0,
        page: paging.page, limit: paging.limit, through: paging.through });
    } catch (error) {
      logger.error('Keyingi aloqalarni olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/contacts/call-list', authenticate, async (req, res) => {
    if (!ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    let paging;
    try {
      paging = pagination(req.query, ['page', 'limit', 'status', 'from', 'to', 'assignedTo', 'outcome']);
      if (req.query.status !== undefined && !['due', 'upcoming', 'all'].includes(req.query.status)) throw new Error('status noto‘g‘ri.');
      if (req.query.from !== undefined && !validDay(req.query.from)) throw new Error('from YYYY-MM-DD formatida bo‘lishi kerak.');
      if (req.query.to !== undefined && !validDay(req.query.to)) throw new Error('to YYYY-MM-DD formatida bo‘lishi kerak.');
      if (req.query.from && req.query.to && req.query.from > req.query.to) throw new Error('from to sanasidan keyin bo‘lmasligi kerak.');
      if (req.query.assignedTo !== undefined && !/^[0-9a-fA-F]{24}$/.test(req.query.assignedTo)) throw new Error('assignedTo noto‘g‘ri.');
      if (req.query.outcome !== undefined && !['reached', 'no_answer'].includes(req.query.outcome)) throw new Error('outcome noto‘g‘ri.');
    } catch (error) { return res.status(400).json({ message: error.message }); }
    try {
      const status = req.query.status ?? 'due';
      const today = localDay(new Date(now()));
      const dateFilter = { $type: 'string' };
      if (status === 'due') dateFilter.$lte = today;
      if (status === 'upcoming') dateFilter.$gt = today;
      if (req.query.from) dateFilter.$gte = req.query.from;
      if (req.query.to && (!dateFilter.$lte || req.query.to < dateFilter.$lte)) dateFilter.$lte = req.query.to;
      const assigned = req.query.assignedTo
        ? await customers.find({ assignedTo: new ObjectId(req.query.assignedTo) }).project({ _id: 1 }).toArray() : null;
      const pipeline = [
        ...(assigned ? [{ $match: { customerId: { $in: assigned.map((row) => row._id) } } }] : []),
        { $sort: { contactedAt: -1, _id: -1 } },
        { $group: { _id: '$customerId', contact: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$contact' } },
        { $match: { nextContactDate: dateFilter, ...(req.query.outcome ? { outcome: req.query.outcome } : {}) } },
        { $sort: { nextContactDate: 1, contactedAt: 1, _id: 1 } },
        { $facet: { count: [{ $count: 'total' }], rows: [{ $skip: (paging.page - 1) * paging.limit }, { $limit: paging.limit }] } },
      ];
      const [result] = await contacts.aggregate(pipeline).toArray();
      const rows = result?.rows ?? [];
      const customerRows = rows.length ? await customers.find({ _id: { $in: rows.map((row) => row.customerId) } })
        .project({ name: 1, phoneNumber: 1, address: 1, assignedTo: 1 }).toArray() : [];
      const byId = new Map(customerRows.map((row) => [row._id.toString(), row]));
      const items = await Promise.all(rows.map(async (row) => ({ ...await publicContact(row, payments, new Date(now())),
        customer: customerBrief(byId.get(row.customerId.toString())) })));
      return res.json({ contacts: items, total: result?.count?.[0]?.total ?? 0,
        page: paging.page, limit: paging.limit, status, today });
    } catch (error) {
      logger.error('Qo‘ng‘iroqlar ro‘yxatini olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/contacts/broken-promises', authenticate, async (req, res) => {
    if (!ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    let paging;
    try {
      paging = pagination(req.query, ['page', 'limit', 'assignedTo']);
      if (req.query.assignedTo !== undefined && !/^[0-9a-fA-F]{24}$/.test(req.query.assignedTo)) throw new Error('assignedTo noto‘g‘ri.');
    } catch (error) { return res.status(400).json({ message: error.message }); }
    try {
      const nowDate = new Date(now());
      const filter = { promisedDate: { $lt: localDay(nowDate) } };
      if (req.query.assignedTo) {
        const assigned = await customers.find({ assignedTo: new ObjectId(req.query.assignedTo) }).project({ _id: 1 }).toArray();
        filter.customerId = { $in: assigned.map((row) => row._id) };
      }
      const cursor = contacts.find(filter).sort({ promisedDate: 1, _id: 1 });
      const rows = [];
      let total = 0;
      for await (const row of cursor) {
        const contact = await publicContact(row, payments, nowDate);
        if (contact.promiseStatus !== 'broken') continue;
        total++;
        if (total > (paging.page - 1) * paging.limit && rows.length < paging.limit) rows.push({ ...contact, customerId: row.customerId });
      }
      const customerRows = rows.length ? await customers.find({ _id: { $in: rows.map((row) => row.customerId) } })
        .project({ name: 1, phoneNumber: 1, address: 1, assignedTo: 1 }).toArray() : [];
      const byId = new Map(customerRows.map((row) => [row._id.toString(), row]));
      return res.json({ contacts: rows.map(({ customerId, ...contact }) => ({ ...contact, customer: customerBrief(byId.get(customerId.toString())) })),
        total, ...paging });
    } catch (error) {
      logger.error('Bajarilmagan va’dalarni olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });
}

function customerBrief(customer) {
  return customer ? { name: customer.name, phoneNumber: customer.phoneNumber,
    address: customer.address ?? null, assignedTo: customer.assignedTo?.toString() ?? null } : null;
}

module.exports = { registerContactRoutes, localDay, validDay, publicContact };
