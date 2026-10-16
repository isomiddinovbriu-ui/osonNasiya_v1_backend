const { MongoClient } = require('mongodb');
const { migratePayments } = require('../modules/payments/payments.migrate');

async function main() {
  require('dotenv').config();
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri || !/^mongodb(\+srv)?:\/\//.test(uri)) throw new Error('MONGODB_URI ni .env faylida sozlang.');
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    const payments = db.collection('payments');
    await payments.createIndex({ customerId: 1, paidAt: 1 });
    await payments.createIndex({ forMonth: 1, customerId: 1 });
    const moved = await migratePayments(db.collection('customers'), payments);
    console.log(`${moved} ta to‘lov tekshirildi va payments collectionga ko‘chirildi.`);
  } finally {
    await client.close();
  }
}

if (require.main === module) main().catch((error) => {
  console.error('To‘lov migratsiyasi bajarilmadi:', error);
  process.exitCode = 1;
});

module.exports = { main };
