const PRODUCT_ID_PATTERN = /^UD-(\d{6})(\d{3,})$/;

function productDateCode(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('Mahsulot sanasi noto‘g‘ri.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tashkent', year: '2-digit', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}${part('month')}${part('day')}`;
}

async function nextProductUniversalId(counters, date = new Date()) {
  const day = productDateCode(date);
  const counter = await counters.findOneAndUpdate(
    { _id: `products:${day}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  if (!Number.isSafeInteger(counter?.seq) || counter.seq < 1) {
    throw new Error('Mahsulot ID hisoblagichi noto‘g‘ri qiymat qaytardi.');
  }
  return `UD-${day}${String(counter.seq).padStart(3, '0')}`;
}

async function prepareProductIds(products, counters) {
  await products.createIndex({ universalId: 1 }, { unique: true, sparse: true });
  const existing = products.find({ universalId: { $exists: true } }, { projection: { universalId: 1 } });
  const maximumByDay = new Map();
  for await (const product of existing) {
    const match = PRODUCT_ID_PATTERN.exec(product.universalId);
    if (!match) throw new Error(`Mahsulot universalId formati noto‘g‘ri: ${product.universalId}`);
    const sequence = Number(match[2]);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Mahsulot tartib raqami noto‘g‘ri.');
    maximumByDay.set(match[1], Math.max(maximumByDay.get(match[1]) || 0, sequence));
  }
  for (const [day, sequence] of maximumByDay) {
    await counters.updateOne({ _id: `products:${day}` }, { $max: { seq: sequence } }, { upsert: true });
  }

  let updated = 0;
  const missing = products.find({ universalId: { $exists: false } }, { projection: { _id: 1, createdAt: 1 } })
    .sort({ createdAt: 1, _id: 1 });
  for await (const product of missing) {
    const universalId = await nextProductUniversalId(counters, product.createdAt || new Date());
    const result = await products.updateOne(
      { _id: product._id, universalId: { $exists: false } },
      { $set: { universalId } },
    );
    updated += result.modifiedCount;
  }
  return updated;
}

module.exports = { productDateCode, nextProductUniversalId, prepareProductIds };
