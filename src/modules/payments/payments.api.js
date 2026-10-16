const { METHODS } = require('./payment-options');

function registerPaymentRoutes(app, { authenticate, paymentApps, logger }) {
  app.get('/payments/options', authenticate, async (_req, res) => {
    try {
      const apps = await paymentApps.find({}).sort({ categoryOrder: 1, itemOrder: 1 }).toArray();
      const categories = [];
      for (const app of apps) {
        let group = categories.at(-1);
        if (!group || group.category !== app.category) {
          group = { category: app.category, apps: [] };
          categories.push(group);
        }
        group.apps.push({ id: app.code, label: app.name });
      }
      res.json({
        methods: METHODS,
        providers: [...apps.map(({ code, name, category }) => ({ id: code, label: name, category })),
          { id: 'other', label: 'Boshqa ilova', category: null }],
        categories,
      });
    } catch (error) {
      logger.error('To‘lov ilovalarini olishda xatolik:', error);
      res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });
}

module.exports = { registerPaymentRoutes };
