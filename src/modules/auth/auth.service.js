const bcrypt = require('bcryptjs');

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

module.exports = { seedSuperAdmin };
