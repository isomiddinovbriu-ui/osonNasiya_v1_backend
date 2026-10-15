const COUNTER_ID = 'customers';

async function nextCustomerId(counters) {
  const counter = await counters.findOneAndUpdate(
    { _id: COUNTER_ID },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  if (!Number.isSafeInteger(counter?.seq) || counter.seq < 1) {
    throw new Error('Mijoz ID hisoblagichi noto‘g‘ri qiymat qaytardi.');
  }
  return counter.seq;
}

async function prepareCustomerIds(customers, counters) {
  await customers.createIndex({ mijoz_id: 1 }, { unique: true, sparse: true });
  const [latest] = await customers.find({ mijoz_id: { $type: 'number' } })
    .sort({ mijoz_id: -1 }).limit(1).toArray();
  const maximum = latest?.mijoz_id ?? 0;
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new Error('Mavjud mijoz_id qiymati noto‘g‘ri.');
  }
  await counters.updateOne({ _id: COUNTER_ID }, { $max: { seq: maximum } }, { upsert: true });

  let updated = 0;
  const missing = customers.find({ mijoz_id: { $exists: false } }, { projection: { _id: 1 } })
    .sort({ createdAt: 1, _id: 1 });
  for await (const customer of missing) {
    const mijoz_id = await nextCustomerId(counters);
    const result = await customers.updateOne(
      { _id: customer._id, mijoz_id: { $exists: false } },
      { $set: { mijoz_id } },
    );
    updated += result.modifiedCount;
  }
  return updated;
}

module.exports = { nextCustomerId, prepareCustomerIds };
