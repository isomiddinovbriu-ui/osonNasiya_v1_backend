const { MongoClient } = require('mongodb');

const regionNames = [
  'Toshkent — Chilonzor',
  'Toshkent — Yunusobod',
  'Toshkent — Mirzo Ulug‘bek',
  'Toshkent — Yakkasaroy',
  'Toshkent — Shayxontohur',
  'Toshkent — Olmazor',
  'Toshkent — Uchtepa',
  'Toshkent — Sergeli',
  'Toshkent — Yashnobod',
  'Toshkent — Mirobod',
  'Toshkent — Bektemir',
  'Toshkent — Yangihayot',
  'Samarqand shahri',
  'Buxoro shahri',
  'Andijon shahri',
  'Farg‘ona shahri',
  'Namangan shahri',
  'Qarshi shahri',
  'Nukus shahri',
  'Urganch shahri',
];

async function seedRegions(db) {
  const admin = await db.collection('users').findOne({ role: 'super_admin' });
  if (!admin) throw new Error('super_admin topilmadi. Avval serverni ishga tushiring.');

  const regions = db.collection('regions');
  let inserted = 0;
  for (const name of regionNames) {
    const result = await regions.updateOne(
      { nameKey: name.toLocaleLowerCase('uz') },
      { $setOnInsert: {
        name,
        nameKey: name.toLocaleLowerCase('uz'),
        description: `${name} uchun namunaviy savdo hududi`,
        createdBy: admin._id,
        createdAt: new Date(),
      } },
      { upsert: true },
    );
    inserted += result.upsertedCount;
  }
  return { total: regionNames.length, inserted };
}

async function main() {
  require('dotenv').config();
  const mongoUri = process.env.MONGODB_URI?.trim();
  if (!mongoUri || !/^mongodb(\+srv)?:\/\//.test(mongoUri)) throw new Error('MONGODB_URI ni .env faylida sozlang.');
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const result = await seedRegions(client.db());
    console.log(`Hududlar tayyor: ${result.total} ta, yangi qo‘shilgan: ${result.inserted} ta.`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Hudud seedi bajarilmadi:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { regionNames, seedRegions };
