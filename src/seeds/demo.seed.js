const { randomInt } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
const { seedSuperAdmin } = require('../modules/auth/auth.service');
const { nextCustomerId, prepareCustomerIds } = require('../modules/customers/customer-id.service');
const { balanceSnapshot, paymentSnapshot, auditEntry } = require('../modules/payments/payment-audit');
const { seedPaymentApps } = require('../modules/payments/payment-apps.seed');
const { localDate } = require('../modules/reports/reports.service');
const { seedRegions } = require('./regions.seed');
const { seedCatalog } = require('./catalog.seed');

const DEMO_TAG = 'osonnasiya-demo-v1';
const firstNames = ['Aziz', 'Dilshod', 'Jasur', 'Sardor', 'Sherzod', 'Malika', 'Dilnoza', 'Madina', 'Gulnoza', 'Sevara'];
const lastNames = ['Karimov', 'Tursunov', 'Qodirov', 'Aliyev', 'Rasulov', 'Ismoilova', 'Saidova', 'Rahimova'];
const staffSpecs = [
  { login: 'test12', role: 'product_creator', name: 'Demo katalog xodimi' },
  { login: 'demo_sotuvchi', role: 'sotuvchi', name: 'Demo sotuvchi' },
  { login: 'demo_yiguvchi', role: 'yiguvchi', name: 'Demo yig‘uvchi' },
];

function pick(items) { return items[randomInt(items.length)]; }
function localMonthOffset(base, offset, day = 10) {
  const [year, monthNumber] = localDate(base).slice(0, 7).split('-').map(Number);
  const month = monthNumber - 1 + offset;
  return new Date(Date.UTC(year, month, day, 7)); // 12:00 Asia/Tashkent
}
function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function seedStaff(users, admin) {
  const staff = {};
  const credentials = [];
  for (const spec of staffSpecs) {
    let user = await users.findOne({ login: spec.login });
    if (user && user.role !== spec.role) throw new Error(`${spec.login} loginli foydalanuvchi roli ${spec.role} bo‘lishi kerak.`);
    if (!user) {
      const password = String(randomInt(10000, 100000));
      const document = { ...spec, passwordHash: await bcrypt.hash(password, 12),
        description: 'Demo seed xodimi', createdBy: admin._id, createdAt: new Date(), demoSeed: DEMO_TAG };
      const result = await users.insertOne(document);
      user = { ...document, _id: result.insertedId };
      credentials.push({ login: spec.login, password });
    }
    staff[spec.role] = user;
  }
  return { staff, credentials };
}

function makePayment(customer, actor, type, amount, paidAt, forMonth, method) {
  const details = method === 'card' ? { cardLast4: '4242', provider: null, providerName: null } :
    method === 'payment_app' ? { cardLast4: '5678', provider: 'click', providerName: null } :
      { cardLast4: null, provider: null, providerName: null };
  return { _id: new ObjectId(), customerId: customer._id, mijoz_id: customer.mijoz_id,
    type, amount, method, receivedBy: actor._id, paidAt, forMonth, status: 'active', ...details, demoSeed: DEMO_TAG };
}

function makeCustomer(index, base, regions, products, sections, staff) {
  const product = pick(products);
  const section = sections.get(product.categoryId.toString());
  if (!section?.parentId) throw new Error('Mahsulot bo‘limi topilmadi.');
  const createdAt = localMonthOffset(base, -randomInt(1, 9));
  const totalPrice = Math.round((product.originalPrice ?? 1000000) * (1 + randomInt(0, 21) / 100) / 1000) * 1000;
  const downPayment = Math.round(totalPrice * 0.2 / 1000) * 1000;
  const actor = index % 4 === 0 ? staff.yiguvchi : staff.sotuvchi;
  const region = pick(regions);
  const customer = {
    _id: new ObjectId(), demoSeedKey: `${DEMO_TAG}:customer:${index}`, demoSeed: DEMO_TAG,
    name: `${pick(firstNames)} ${pick(lastNames)}`,
    phoneNumber: `+998 00 000 ${String(index).padStart(4, '0')}`,
    addPhoneNumber: null, productName: product.name,
    groupId: section.parentId, sectionId: section._id, productId: product._id, regionId: region._id,
    lat: 41.2 + randomInt(0, 1200) / 10000, long: 69.1 + randomInt(0, 1200) / 10000,
    totalPrice, downPayment, termMonths: pick([6, 12, 18]),
    totalPaid: downPayment, remainingBalance: totalPrice - downPayment,
    description: 'Avtomatik yaratilgan namunaviy mijoz', createdBy: actor._id,
    createdByRole: actor.role, createdAt,
  };
  return { customer, actor };
}

function makeHistory(customer, actor, collector, admin, base, index) {
  const payments = [];
  const audits = [auditEntry({ action: 'customer.created', customer, actor, createdAt: customer.createdAt,
    after: { balance: balanceSnapshot(customer) } })];
  let paid = 0;
  function add(type, amount, date, month, method, receiver = collector, voided = false) {
    const before = { downPayment: type === 'initial' ? 0 : customer.downPayment,
      totalPaid: paid, remainingBalance: customer.totalPrice - paid };
    const payment = makePayment(customer, receiver, type, amount, date, month, method);
    paid += amount;
    const after = { downPayment: customer.downPayment, totalPaid: paid, remainingBalance: customer.totalPrice - paid };
    audits.push(auditEntry({ action: 'payment.created', customer, payment, actor: receiver, createdAt: date,
      before: { balance: before }, after: { payment: paymentSnapshot(payment), balance: after } }));
    if (voided) {
      const original = { ...payment };
      payment.status = 'voided';
      payment.voidedAt = new Date(date.getTime() + 3600000);
      payment.voidedBy = admin._id;
      payment.voidReason = 'Demo: noto‘g‘ri kiritilgan to‘lov';
      paid -= amount;
      audits.push(auditEntry({ action: 'payment.voided', customer, payment: original,
        actor: admin, createdAt: payment.voidedAt, reason: payment.voidReason,
        before: { payment: paymentSnapshot(original), balance: after },
        after: { payment: paymentSnapshot(payment), balance: { ...before, downPayment: customer.downPayment } } }));
    }
    payments.push(payment);
  }
  add('initial', customer.downPayment, customer.createdAt, null, 'cash', actor);
  const financed = customer.totalPrice - customer.downPayment;
  const createdMonth = customer.createdAt.getUTCFullYear() * 12 + customer.createdAt.getUTCMonth();
  const [currentYear, currentMonthNumber] = localDate(base).slice(0, 7).split('-').map(Number);
  const currentMonth = currentYear * 12 + currentMonthNumber - 1;
  const elapsed = Math.min(customer.termMonths, currentMonth - createdMonth);
  const scenario = index % 5; // 0: to‘liq, 1: kam, 2: kechikkan, 3: qisman, 4: bekor qilingan
  for (let installment = 1; installment <= elapsed; installment++) {
    if (scenario === 2 && installment >= Math.max(1, elapsed - 1)) break;
    const due = localMonthOffset(customer.createdAt, installment, 15);
    if (due > base) break;
    const expected = Math.floor(financed * installment / customer.termMonths) -
      Math.floor(financed * (installment - 1) / customer.termMonths);
    let amount = expected;
    if ((scenario === 1 || scenario === 3 || scenario === 4) && installment === elapsed) {
      amount = Math.max(1, Math.floor(expected / 3));
    }
    if (scenario === 0 && installment === 1) amount = financed;
    amount = Math.min(amount, customer.totalPrice - paid);
    if (amount <= 0) break;
    add('installment', amount, due, monthKey(due), pick(['cash', 'card', 'payment_app']), collector,
      scenario === 4 && installment === elapsed);
    if (scenario === 0) break;
  }
  customer.totalPaid = paid;
  customer.remainingBalance = customer.totalPrice - paid;
  for (const audit of audits) audit.demoSeed = DEMO_TAG;
  return { payments, audits };
}

async function seedDemo(db, client, count = 40, now = new Date()) {
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('count 1–500 orasida bo‘lishi kerak.');
  const users = db.collection('users');
  const admin = await users.findOne({ role: 'super_admin' });
  if (!admin) throw new Error('super_admin topilmadi. Avval serverni ishga tushiring.');
  const { staff, credentials } = await seedStaff(users, admin);
  await seedRegions(db);
  await seedCatalog(db);
  await seedPaymentApps(db.collection('payment_apps'));
  const customers = db.collection('customers');
  const payments = db.collection('payments');
  const auditLogs = db.collection('audit_logs');
  const counters = db.collection('counters');
  await prepareCustomerIds(customers, counters);
  await customers.createIndex({ demoSeedKey: 1 }, { unique: true, sparse: true });
  const [regions, products, categories] = await Promise.all([
    db.collection('regions').find({}).toArray(),
    db.collection('products').find({ createdBy: staff.product_creator._id }).toArray(),
    db.collection('product_categories').find({}).toArray(),
  ]);
  if (!regions.length || !products.length) throw new Error('Hududlar yoki demo mahsulotlar topilmadi.');
  const sections = new Map(categories.map((category) => [category._id.toString(), category]));
  const hello = await db.admin().command({ hello: 1 });
  const supportsTransactions = Boolean(hello.setName || hello.msg === 'isdbgrid');
  let inserted = 0;
  for (let index = 1; index <= count; index++) {
    if (await customers.findOne({ demoSeedKey: `${DEMO_TAG}:customer:${index}` }, { projection: { _id: 1 } })) continue;
    const { customer, actor } = makeCustomer(index, now, regions, products, sections, staff);
    customer.mijoz_id = await nextCustomerId(counters);
    const history = makeHistory(customer, actor, staff.yiguvchi, admin, now, index);
    if (supportsTransactions) {
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          await customers.insertOne(customer, { session });
          await payments.insertMany(history.payments, { session });
          await auditLogs.insertMany(history.audits, { session });
        });
      } finally { await session.endSession(); }
    } else {
      // Lokal standalone MongoDB ham demo ma’lumotlarni qabul qila oladi.
      try {
        await customers.insertOne(customer);
        await payments.insertMany(history.payments);
        await auditLogs.insertMany(history.audits);
      } catch (error) {
        const cleanup = await Promise.allSettled([
          auditLogs.deleteMany({ customerId: customer._id }),
          payments.deleteMany({ customerId: customer._id }),
          customers.deleteOne({ _id: customer._id, demoSeedKey: customer.demoSeedKey }),
        ]);
        const failed = cleanup.filter((item) => item.status === 'rejected');
        if (failed.length) throw new AggregateError([error, ...failed.map((item) => item.reason)],
          `Demo mijoz ${customer.demoSeedKey} ni tozalashda xatolik.`);
        throw error;
      }
    }
    inserted++;
  }
  return { requested: count, inserted, credentials };
}

async function main() {
  require('dotenv').config({ quiet: true });
  const args = process.argv.slice(2);
  const countArg = args.find((arg) => arg.startsWith('--count='));
  const count = countArg ? Number(countArg.slice(8)) : 40;
  if (!args.includes('--apply') || args.some((arg) => arg !== '--apply' && arg !== countArg)) {
    throw new Error('Ishga tushirish: npm run seed:demo -- --apply [--count=40]');
  }
  const mongoUri = process.env.MONGODB_URI?.trim();
  if (!mongoUri || !/^mongodb(\+srv)?:\/\//.test(mongoUri)) throw new Error('MONGODB_URI ni .env faylida sozlang.');
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    await seedSuperAdmin(client.db().collection('users'), {
      superAdminLogin: process.env.SUPER_ADMIN_LOGIN?.trim().toLowerCase(),
      superAdminPassword: process.env.SUPER_ADMIN_PASSWORD,
    });
    const result = await seedDemo(client.db(), client, count);
    console.log(`Demo tayyor: ${result.inserted} yangi mijoz, ${result.requested} ta slot tekshirildi.`);
    for (const item of result.credentials) console.log(`Yangi xodim: ${item.login}, parol: ${item.password}`);
    if (result.credentials.length) console.log('Bu parollar qayta ko‘rsatilmaydi; xavfsiz joyga saqlang.');
  } finally { await client.close(); }
}

if (require.main === module) main().catch((error) => {
  console.error('Demo seed bajarilmadi:', error.message);
  process.exitCode = 1;
});

module.exports = { seedDemo, makeCustomer, makeHistory, DEMO_TAG };
