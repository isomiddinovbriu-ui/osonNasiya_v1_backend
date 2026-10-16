require('dotenv').config();

const { MongoClient } = require('mongodb');
const { createApp } = require('./app');
const { seedSuperAdmin } = require('./modules/auth/auth.service');
const { readConfig } = require('./config/config');
const { createProductStorage } = require('./config/product-storage');
const { prepareCustomerIds } = require('./modules/customers/customer-id.service');
const { prepareProductIds } = require('./modules/catalog/product-id.service');
const { migratePayments } = require('./modules/payments/payments.migrate');
const { seedPaymentApps } = require('./modules/payments/payment-apps.seed');

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
    const counters = client.db().collection('counters');
    const productCategories = client.db().collection('product_categories');
    const products = client.db().collection('products');
    const payments = client.db().collection('payments');
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
    await customers.createIndex({ productId: 1 });
    await customers.createIndex({ lat: 1 });
    await prepareCustomerIds(customers, counters);
    await payments.createIndex({ customerId: 1, paidAt: 1 });
    await payments.createIndex({ forMonth: 1, customerId: 1 });
    await payments.createIndex({ paidAt: -1 });
    await migratePayments(customers, payments);
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
      payments,
      paymentApps,
      mongoClient: client,
      counters,
      productCategories,
      products,
      imageStorage,
      jwtSecret: config.jwtSecret,
    });
    const server = app.listen(config.port, '0.0.0.0', () => {
      console.log(`OsonNasiya API ${config.port}-portda ishlayapti. Swagger: http://localhost:${config.port}/docs`);
    });

    async function shutdown() {
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
