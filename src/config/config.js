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

  const minioEndPoint = env.MINIO_END_POINT?.trim();
  const minioPort = Number(env.MINIO_PORT || 9000);
  const minioAccessKey = env.MINIO_ACCESS_KEY?.trim();
  const minioSecretKey = env.MINIO_SECRET_KEY?.trim();
  const minioBucket = env.MINIO_BUCKET?.trim() || 'osonnasiya-products';
  if (!minioEndPoint || !minioAccessKey || !minioSecretKey ||
      minioAccessKey.startsWith('replace-with-') || minioSecretKey.startsWith('replace-with-') ||
      !Number.isInteger(minioPort) || minioPort < 1 || minioPort > 65535 ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(minioBucket)) {
    throw new Error('MINIO_END_POINT, MINIO_PORT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY va MINIO_BUCKET ni sozlang.');
  }
  if (env.MINIO_USE_SSL && !['true', 'false'].includes(env.MINIO_USE_SSL)) {
    throw new Error('MINIO_USE_SSL true yoki false bo‘lishi kerak.');
  }

  return {
    port,
    mongoUri,
    jwtSecret,
    minioEndPoint,
    minioPort,
    minioAccessKey,
    minioSecretKey,
    minioBucket,
    minioUseSsl: env.MINIO_USE_SSL === 'true',
    superAdminLogin: env.SUPER_ADMIN_LOGIN?.trim().toLowerCase(),
    superAdminPassword: env.SUPER_ADMIN_PASSWORD,
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
  };
}

module.exports = { readConfig };
