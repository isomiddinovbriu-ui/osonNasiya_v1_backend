const { MongoClient } = require('mongodb');
const { prepareProductIds } = require('../modules/catalog/product-id.service');

async function main() {
  require('dotenv').config();
  const mongoUri = process.env.MONGODB_URI?.trim();
  if (!mongoUri || !/^mongodb(\+srv)?:\/\//.test(mongoUri)) throw new Error('MONGODB_URI ni .env faylida sozlang.');
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db();
    const updated = await prepareProductIds(db.collection('products'), db.collection('counters'));
    console.log(`Mahsulot universalId tayyor: ${updated} ta eski mahsulot raqamlandi.`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Mahsulot ID migratsiyasi bajarilmadi:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
