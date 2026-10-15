require('dotenv').config();

const { MongoClient } = require('mongodb');
const { createApp } = require('./app');
const { seedSuperAdmin } = require('./modules/auth/auth.service');
const { readConfig } = require('./config/config');
const { createProductStorage } = require('./config/product-storage');
const { prepareCustomerIds } = require('./modules/customers/customer-id.service');
const { prepareProductIds } = require('./modules/catalog/product-id.service');

async function start() {
  const config = readConfig();
  const client = new MongoClient(config.mongoUri);
  try {
    await client.connect();
    const users = client.db().collection('users');
    const loginRequests = client.db().collection('login_requests');
    const regions = client.db().collection('regions');
    const customers = client.db().collection('customers');
    const counters = client.db().collection('counters');
    const productCategories = client.db().collection('product_categories');
    const products = client.db().collection('products');
    const imageStorage = createProductStorage(config);
    await seedSuperAdmin(users, config);
    await users.createIndex({ login: 1 }, { unique: true });
    await loginRequests.createIndex({ createdAt: -1 });
    await regions.createIndex({ nameKey: 1 }, { unique: true });
    await customers.createIndex({ regionId: 1, createdAt: -1 });
    await customers.createIndex({ productId: 1 });
    await prepareCustomerIds(customers, counters);
    await productCategories.createIndex({ parentId: 1, nameKey: 1 }, { unique: true });
    await products.createIndex({ categoryId: 1, createdAt: -1 });
    await prepareProductIds(products, counters);

    const app = createApp({
      users,
      loginRequests,
      regions,
      customers,
      counters,
      productCategories,
      products,
      imageStorage,
      jwtSecret: config.jwtSecret,
      corsOrigins: config.corsOrigins,
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
