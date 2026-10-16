// Safe to rerun: existing payment IDs are reused, then the embedded copy is removed.
async function migratePayments(customers, payments) {
  let moved = 0;
  const cursor = customers.find({ 'payments.0': { $exists: true } }, { projection: { _id: 1, mijoz_id: 1, payments: 1 } });
  for await (const customer of cursor) {
    for (const payment of customer.payments) {
      await payments.updateOne(
        { _id: payment._id },
        { $setOnInsert: { ...payment, customerId: customer._id, mijoz_id: customer.mijoz_id } },
        { upsert: true },
      );
      moved++;
    }
    await customers.updateOne({ _id: customer._id }, { $unset: { payments: '' } });
  }
  return moved;
}

module.exports = { migratePayments };
