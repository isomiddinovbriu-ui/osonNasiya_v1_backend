require('dotenv').config();

const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');
const { createApp } = require('./app');
const { readConfig } = require('./config');

async function seedSuperAdmin(users, config) {
  await users.createIndex({ role: 1 }, {
    unique: true,
    partialFilterExpression: { role: 'super_admin' },
  });

  const existing = await users.findOne({ role: 'super_admin' });
  if (existing) return;

  if (!config.superAdminLogin || config.superAdminLogin.length > 100 ||
      !config.superAdminPassword || config.superAdminPassword.length < 12 ||
      config.superAdminPassword.startsWith('replace-with-')) {
    throw new Error('Birinchi ishga tushirish uchun SUPER_ADMIN_LOGIN va kamida 12 belgili SUPER_ADMIN_PASSWORD kerak.');
  }

  await users.insertOne({
    login: config.superAdminLogin,
    passwordHash: await bcrypt.hash(config.superAdminPassword, 12),
    role: 'super_admin',
    createdAt: new Date(),
  });
  console.log('Birinchi super_admin yaratildi.');
}

async function start() {
  const config = readConfig();
  const client = new MongoClient(config.mongoUri);
  try {
    await client.connect();
    const users = client.db().collection('users');
    await seedSuperAdmin(users, config);

    const app = createApp({
      users,
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
