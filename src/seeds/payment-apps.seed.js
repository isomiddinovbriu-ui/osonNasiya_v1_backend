require('dotenv').config();
const { MongoClient } = require('mongodb');
const { seedPaymentApps } = require('../modules/payments/payment-apps.seed');
const { PAYMENT_APP_DOCUMENTS } = require('../modules/payments/payment-apps.catalog');

async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri || !/^mongodb(\+srv)?:\/\//.test(uri)) throw new Error('MONGODB_URI ni .env faylida sozlang.');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const paymentApps = client.db().collection('payment_apps');
    const count = await seedPaymentApps(paymentApps);
    const rows = await paymentApps.find({ code: { $in: PAYMENT_APP_DOCUMENTS.map(({ code }) => code) } }).toArray();
    if (rows.length !== count || !rows.every((row) => PAYMENT_APP_DOCUMENTS.some((app) =>
      app.code === row.code && app.name === row.name && app.category === row.category &&
      app.categoryOrder === row.categoryOrder && app.itemOrder === row.itemOrder))) {
      throw new Error('payment_apps yozuvlarini tekshirish muvaffaqiyatsiz.');
    }
    console.log(`payment_apps collectionda ${count} ta ilova va 5 ta kategoriya tekshirildi.`);
  } finally {
    await client.close();
  }
}

if (require.main === module) main().catch((error) => {
  console.error('To‘lov ilovalari seed qilinmadi:', error.message);
  process.exitCode = 1;
});

module.exports = { main };
