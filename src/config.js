function readConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT 1 dan 65535 gacha bo\'lgan butun son bo\'lishi kerak.');
  }

  const mongoUri = env.MONGODB_URI?.trim();
  if (!mongoUri || !/^mongodb(\+srv)?:\/\//.test(mongoUri) || mongoUri.includes('USER:PASSWORD@HOST')) {
    throw new Error('MONGODB_URI ni .env faylida sozlang.');
  }

  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.startsWith('replace-with-')) {
    throw new Error('JWT_SECRET kamida 32 belgili tasodifiy qiymat bo\'lishi kerak.');
  }

  return {
    port,
    mongoUri,
    jwtSecret,
    superAdminLogin: env.SUPER_ADMIN_LOGIN?.trim().toLowerCase(),
    superAdminPassword: env.SUPER_ADMIN_PASSWORD,
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
  };
}

module.exports = { readConfig };
