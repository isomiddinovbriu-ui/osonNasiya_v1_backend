const express = require('express');
const { createAuthMiddleware } = require('./middleware/auth.middleware');
const { registerAuthRoutes } = require('./modules/auth/auth.api');
const { registerUserRoutes } = require('./modules/users/users.api');
const { registerRegionRoutes } = require('./modules/regions/regions.api');
const { registerCustomerRoutes } = require('./modules/customers/customers.api');
const { registerContactRoutes } = require('./modules/contacts/contacts.api');
const { registerWorklistRoutes } = require('./modules/collections/worklist.api');
const { registerDailyPlanRoutes } = require('./modules/collections/daily-plans.api');
const { registerCatalogRoutes } = require('./modules/catalog/catalog.api');
const { registerPaymentRoutes } = require('./modules/payments/payments.api');
const { registerPaymentEditNotificationRoutes } = require('./modules/payments/payment-edit-notifications.api');
const { registerVoidRequestRoutes } = require('./modules/payments/void-requests.api');
const { registerReportRoutes } = require('./modules/reports/reports.api');
const { registerDashboardRoutes } = require('./modules/dashboard/dashboard.api');
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

function createApp({ users, loginRequests, refreshSessions, regions, customers, contacts, payments, paymentApps, paymentRequests, paymentVoidRequests, paymentEditNotifications, dailyPlans, auditLogs, counters, productCategories, products, imageStorage, jwtSecret, logger = console, now = Date.now }) {
  if (!users || !loginRequests || !refreshSessions || !regions || !customers || !payments || !paymentApps || !paymentRequests || !auditLogs || !jwtSecret) throw new Error('users, loginRequests, refreshSessions, regions, customers, payments, paymentApps, paymentRequests, auditLogs va jwtSecret kerak.');

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
      res.set('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/openapi.json', (_req, res) => res.json(openapi));
  app.get('/docs', (_req, res) => res.type('html').send(docsHtml));

  const { authenticate, requireSuperAdmin } = createAuthMiddleware({ users, refreshSessions, jwtSecret, logger, now });
  registerAuthRoutes(app, { users, loginRequests, refreshSessions, jwtSecret, authenticate, logger, now });
  registerUserRoutes(app, { users, customers, authenticate, requireSuperAdmin, imageStorage, logger, now });
  registerRegionRoutes(app, { regions, customers, dailyPlans, authenticate, logger, now });
  registerCustomerRoutes(app, { authenticate, users, customers, payments, paymentApps, paymentRequests, paymentVoidRequests, paymentEditNotifications, dailyPlans, auditLogs, counters, regions, productCategories, products, jwtSecret, logger, now });
  if (contacts) registerContactRoutes(app, { authenticate, customers, contacts, payments, logger, now });
  registerWorklistRoutes(app, { authenticate, customers, logger, now });
  if (dailyPlans) registerDailyPlanRoutes(app, { authenticate, dailyPlans, regions, customers, logger, now });
  registerPaymentRoutes(app, { authenticate, paymentApps, logger });
  if (paymentEditNotifications) registerPaymentEditNotificationRoutes(app, { authenticate, requireSuperAdmin, paymentEditNotifications, logger, now });
  if (paymentVoidRequests && dailyPlans) registerVoidRequestRoutes(app, { authenticate, paymentVoidRequests, payments, dailyPlans, logger, now });
  registerReportRoutes(app, { authenticate, customers, payments, regions, users, logger, now });
  registerDashboardRoutes(app, { authenticate, customers, payments, logger, now });
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
