const express = require('express');
const { createAuthMiddleware } = require('./middleware/auth.middleware');
const { registerAuthRoutes } = require('./modules/auth/auth.api');
const { registerUserRoutes } = require('./modules/users/users.api');
const { registerRegionRoutes } = require('./modules/regions/regions.api');
const { registerCustomerRoutes } = require('./modules/customers/customers.api');
const { registerCatalogRoutes } = require('./modules/catalog/catalog.api');
const openapi = require('./openapi.json');

const docsHtml = `<!doctype html>
<html lang="uz">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OsonNasiya API — Swagger</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.0/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.0/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      persistAuthorization: false
    });
  </script>
</body>
</html>`;

function createApp({ users, loginRequests, regions, customers, counters, productCategories, products, imageStorage, jwtSecret, corsOrigins = [], logger = console, now = Date.now }) {
  if (!users || !loginRequests || !regions || !customers || !jwtSecret) throw new Error('users, loginRequests, regions, customers va jwtSecret kerak.');

  const app = express();
  const allowedOrigins = new Set(corsOrigins);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin && allowedOrigins.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/openapi.json', (_req, res) => res.json(openapi));
  app.get('/docs', (_req, res) => res.type('html').send(docsHtml));

  const { authenticate, requireSuperAdmin } = createAuthMiddleware({ users, jwtSecret, logger });
  registerAuthRoutes(app, { users, loginRequests, jwtSecret, authenticate, logger, now });
  registerUserRoutes(app, { users, authenticate, requireSuperAdmin, logger, now });
  registerRegionRoutes(app, { regions, customers, authenticate, logger, now });
  registerCustomerRoutes(app, { authenticate, customers, counters, regions, productCategories, products, logger, now });
  if (productCategories && products && imageStorage) {
    registerCatalogRoutes(app, { authenticate, productCategories, products, customers, counters, imageStorage, logger, now });
  }

  app.use((_req, res) => res.status(404).json({ message: 'Manzil topilmadi.' }));
  app.use(async (error, req, res, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      if (req.method === 'POST' && req.path === '/auth/login') {
        try {
          await loginRequests.insertOne({
            createdAt: new Date(now()),
            login: '',
            ip: req.ip,
            userAgent: req.get('User-Agent') || null,
            status: 400,
            userId: null,
          });
        } catch (logError) {
          logger.error('Login so‘rovini yozishda xatolik:', logError);
          return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
        }
      }
      return res.status(400).json({ message: 'So‘rov formati noto‘g‘ri.' });
    }
    logger.error('So‘rov xatosi:', error);
    return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
  });

  return app;
}

module.exports = { createApp };
