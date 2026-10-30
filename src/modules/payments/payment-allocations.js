const { localDate, installmentDueDate, monthlyExpected } = require('../reports/reports.service');

function allocatePayments(customer, payments) {
  const remaining = new Map();
  const created = localDate(customer.createdAt);
  for (let installment = 1; installment <= customer.termMonths; installment++) {
    const month = installmentDueDate(created, installment).slice(0, 7);
    const expected = monthlyExpected(customer, month);
    if (expected) remaining.set(month, expected.amount);
  }
  const months = [...remaining.keys()];
  const allocations = new Map();
  const active = payments.filter((payment) => payment.type === 'installment' && payment.status !== 'voided' &&
    Number.isSafeInteger(payment.amount) && payment.amount > 0);
  active.sort((a, b) => {
    if (!a.forMonth && b.forMonth) return 1;
    if (a.forMonth && !b.forMonth) return -1;
    const monthOrder = (a.forMonth || '').localeCompare(b.forMonth || '');
    return monthOrder || a.paidAt - b.paidAt || a._id.toString().localeCompare(b._id.toString());
  });
  for (const payment of active) {
    let left = payment.amount;
    const applied = [];
    for (const month of months) {
      if (payment.forMonth && month < payment.forMonth) continue;
      const used = Math.min(remaining.get(month), left);
      if (used > 0) {
        remaining.set(month, remaining.get(month) - used);
        applied.push({ month, amount: used });
        left -= used;
      }
      if (!left) break;
    }
    allocations.set(payment._id.toString(), applied);
  }
  return { remaining, allocations };
}

async function syncPaymentAllocations(customer, payments, step) {
  const rows = await payments.find({ customerId: customer._id, status: { $ne: 'voided' } }).toArray();
  const result = allocatePayments(customer, rows);
  for (const row of rows) {
    if (row.type !== 'installment') continue;
    const next = result.allocations.get(row._id.toString());
    if (!next) continue;
    if (JSON.stringify(row.allocations || []) === JSON.stringify(next)) continue;
    const old = row.allocations;
    const updated = await step(() => payments.updateOne({ _id: row._id, status: { $ne: 'voided' },
      amount: row.amount, forMonth: row.forMonth ?? null }, { $set: { allocations: next } }),
    () => payments.updateOne({ _id: row._id }, {
      ...(old !== undefined ? { $set: { allocations: old } } : { $unset: { allocations: '' } }),
    }));
    if (updated.matchedCount !== 1) {
      const error = new Error('To‘lov taqsimoti bir vaqtda o‘zgartirilgan.');
      error.status = 409;
      throw error;
    }
  }
  return result;
}

async function backfillPaymentAllocations(customers, payments) {
  const seen = new Set();
  const cursor = payments.find({ type: 'installment', allocations: { $exists: false } },
    { projection: { customerId: 1 } });
  for await (const payment of cursor) {
    if (!payment.customerId) continue;
    const id = payment.customerId.toString();
    if (seen.has(id)) continue;
    seen.add(id);
    const customer = await customers.findOne({ _id: payment.customerId });
    if (customer) await syncPaymentAllocations(customer, payments, async (write) => write());
  }
  return seen.size;
}

module.exports = { allocatePayments, syncPaymentAllocations, backfillPaymentAllocations };
