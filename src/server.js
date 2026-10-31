require('dotenv').config();

const { MongoClient } = require('mongodb');
const { createApp } = require('./app');
const { seedSuperAdmin } = require('./modules/auth/auth.service');
const { readConfig } = require('./config/config');
const { createProductStorage } = require('./config/product-storage');
const { prepareCustomerIds } = require('./modules/customers/customer-id.service');
const { prepareProductIds } = require('./modules/catalog/product-id.service');
const { migratePayments } = require('./modules/payments/payments.migrate');
const { backfillPaymentAllocations } = require('./modules/payments/payment-allocations');
const { seedPaymentApps } = require('./modules/payments/payment-apps.seed');
const { closeExpiredPlans } = require('./modules/collections/daily-plans.api');

async function start() {
  const config = readConfig();
  const client = new MongoClient(config.mongoUri);
  try {
    await client.connect();
    const users = client.db().collection('users');
    const loginRequests = client.db().collection('login_requests');
    const refreshSessions = client.db().collection('refresh_sessions');
    const regions = client.db().collection('regions');
    const customers = client.db().collection('customers');
    const contacts = client.db().collection('contact_events');
    const counters = client.db().collection('counters');
    const productCategories = client.db().collection('product_categories');
    const products = client.db().collection('products');
    const payments = client.db().collection('payments');
    const paymentRequests = client.db().collection('payment_requests');
    const paymentVoidRequests = client.db().collection('payment_void_requests');
    const paymentEditNotifications = client.db().collection('payment_edit_notifications');
    const dailyPlans = client.db().collection('daily_plans');
    const auditLogs = client.db().collection('audit_logs');
    const paymentApps = client.db().collection('payment_apps');
    const imageStorage = createProductStorage(config);
    await seedSuperAdmin(users, config);
    await users.createIndex({ login: 1 }, { unique: true });
    await loginRequests.createIndex({ createdAt: -1 });
    await refreshSessions.createIndex({ tokenHash: 1 }, { unique: true });
    await refreshSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await refreshSessions.createIndex({ userId: 1, revokedAt: 1 });
    await regions.createIndex({ nameKey: 1 }, { unique: true });
    await customers.createIndex({ regionId: 1, createdAt: -1 });
    await customers.createIndex({ assignedTo: 1, createdAt: -1 });
    await customers.createIndex({ assignedTo: 1, remainingBalance: 1, mijoz_id: 1 });
    await customers.createIndex({ createdBy: 1, regionId: 1 });
    await contacts.createIndex({ customerId: 1, contactedAt: -1, _id: -1 });
    await contacts.createIndex({ contactedAt: -1, _id: -1 });
    await contacts.createIndex({ promisedDate: 1, customerId: 1 });
    await customers.createIndex({ productId: 1 });
    await customers.createIndex({ createdAt: 1 });
    await customers.createIndex({ remainingBalance: 1 });
    await customers.createIndex({ lat: 1 });
    await prepareCustomerIds(customers, counters);
    await payments.createIndex({ customerId: 1, paidAt: 1 });
    await payments.createIndex({ forMonth: 1, customerId: 1 });
    await payments.createIndex({ paidAt: -1 });
    await payments.createIndex({ receivedBy: 1, paidAt: 1, status: 1 });
    await paymentRequests.createIndex({ actorId: 1, key: 1 }, { unique: true });
    await paymentVoidRequests.createIndex({ paymentId: 1 },
      { unique: true, partialFilterExpression: { status: 'pending' } });
    await dailyPlans.createIndex({ ownerId: 1, date: -1, regionId: 1 });
    await dailyPlans.createIndex({ regionDateKey: 1 },
      { unique: true, partialFilterExpression: { regionDateKey: { $exists: true } } });
    await payments.createIndex({ dailyPlanId: 1, paidAt: 1 });
    await closeExpiredPlans(dailyPlans, new Date());
    await auditLogs.createIndex({ mijoz_id: 1, createdAt: -1, _id: -1 });
    await auditLogs.createIndex({ entityType: 1, entityId: 1, createdAt: -1 });
    await paymentEditNotifications.createIndex({ createdAt: -1, _id: -1 });
    await paymentEditNotifications.createIndex({ is_read: 1, createdAt: -1, _id: -1 });
    await migratePayments(customers, payments);
    await backfillPaymentAllocations(customers, payments);
    await seedPaymentApps(paymentApps);
    await productCategories.createIndex({ parentId: 1, nameKey: 1 }, { unique: true });
    await products.createIndex({ categoryId: 1, createdAt: -1 });
    await prepareProductIds(products, counters);

    const app = createApp({
      users,
      loginRequests,
      refreshSessions,
      regions,
      customers,
      contacts,
      payments,
      paymentRequests,
      paymentVoidRequests,
      paymentEditNotifications,
      dailyPlans,
      auditLogs,
      paymentApps,
      counters,
      productCategories,
      products,
      imageStorage,
      jwtSecret: config.jwtSecret,
    });
    const server = app.listen(config.port, '0.0.0.0', () => {
      console.log(`OsonNasiya API ${config.port}-portda ishlayapti. Swagger: http://localhost:${config.port}/docs`);
    });
    const dayCloseTimer = setInterval(() => closeExpiredPlans(dailyPlans, new Date()).catch((error) =>
      console.error('Kunlik rejalarni yopishda xatolik:', error)), 60_000);
    dayCloseTimer.unref();

    async function shutdown() {
      clearInterval(dayCloseTimer);
      server.close();
      await client.close();
    }
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return server;
  } catch (error) {
    await client.close();
    throw error;
  }
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Server ishga tushmadi:', error);
    process.exitCode = 1;
  });
}

module.exports = { start, seedSuperAdmin };
