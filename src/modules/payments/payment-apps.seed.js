const { PAYMENT_APP_DOCUMENTS } = require('./payment-apps.catalog');

async function seedPaymentApps(paymentApps) {
  await paymentApps.createIndex({ code: 1 }, { unique: true });
  for (const app of PAYMENT_APP_DOCUMENTS) {
    await paymentApps.updateOne({ code: app.code }, { $set: app }, { upsert: true });
  }
  return PAYMENT_APP_DOCUMENTS.length;
}

module.exports = { seedPaymentApps };
