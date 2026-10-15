const { MongoClient } = require('mongodb');
const { prepareCustomerIds } = require('../modules/customers/customer-id.service');

async function main() {
  require('dotenv').config();
  const mongoUri = process.env.MONGODB_URI?.trim();
  if (!mongoUri || !/^mongodb(\+srv)?:\/\//.test(mongoUri)) throw new Error('MONGODB_URI ni .env faylida sozlang.');
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db();
    const updated = await prepareCustomerIds(db.collection('customers'), db.collection('counters'));
    console.log(`mijoz_id tayyor: ${updated} ta eski mijoz raqamlandi.`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Mijoz ID migratsiyasi bajarilmadi:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
