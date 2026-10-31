const { localDate, validDate, installmentDueDate } = require('../reports/reports.service');
const { allocatePayments } = require('../payments/payment-allocations');

const TIMEZONE = 'Asia/Tashkent';

function monthRange(month) {
  const [year, number] = month.split('-').map(Number);
  const next = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
  return { start: new Date(`${month}-01T00:00:00+05:00`), end: new Date(`${next}-01T00:00:00+05:00`) };
}

function dayRange(date) {
  const start = new Date(`${date}T00:00:00+05:00`);
  return { start, end: new Date(start.getTime() + 86400000) };
}

function parsePeriod(query, now) {
  if (Object.values(query).some((value) => typeof value !== 'string')) throw new Error('Takrorlangan parametr.');
  const date = query.date ?? localDate(new Date(now()));
  const month = query.month ?? date.slice(0, 7);
  if (!validDate(date) || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error('date YYYY-MM-DD, month YYYY-MM formatida bo‘lishi kerak.');
  }
  return { date, month, day: dayRange(date), monthDates: monthRange(month) };
}

function outstandingByMonth(customer, payments) {
  return allocatePayments(customer, payments).remaining;
}

function dueForPeriod(customer, month, cutoffDate, outstanding) {
  const unpaid = outstanding.get(month) ?? 0;
  if (!unpaid) return 0;
  const created = localDate(customer.createdAt);
  const installment = (Number(month.slice(0, 4)) - Number(created.slice(0, 4))) * 12 +
    Number(month.slice(5, 7)) - Number(created.slice(5, 7));
  if (installmentDueDate(created, installment) > cutoffDate) return 0;
  return unpaid;
}

function addPayment(bucket, payment) {
  bucket.amount += payment.amount;
  bucket.paymentCount++;
  bucket.customers.add(payment.customerId.toString());
  if (payment.type === 'initial') bucket.initialAmount += payment.amount;
  if (payment.type === 'installment') bucket.installmentAmount += payment.amount;
}

function newSalesPeriod(key, value) {
  return { [key]: value, dueRemainingAmount: 0, dueCustomerCount: 0,
    paidAmount: 0, paidCustomerCount: 0,
    initialPaidAmount: 0, initialPaidCustomerCount: 0,
    otherMonthPaidAmount: 0, otherMonthPaidCustomerCount: 0,
    unassignedPaidAmount: 0, unassignedPaidCustomerCount: 0 };
}

function addSalesPayment(period, customerSets, payment, month, customerId) {
  let amountKey;
  let countKey;
  if (payment.type === 'initial') {
    amountKey = 'initialPaidAmount';
    countKey = 'initialPaidCustomerCount';
  } else if (payment.type === 'installment' && payment.forMonth === month) {
    amountKey = 'paidAmount';
    countKey = 'paidCustomerCount';
  } else if (payment.type === 'installment' && payment.forMonth) {
    amountKey = 'otherMonthPaidAmount';
    countKey = 'otherMonthPaidCustomerCount';
  } else {
    amountKey = 'unassignedPaidAmount';
    countKey = 'unassignedPaidCustomerCount';
  }
  period[amountKey] += payment.amount;
  customerSets[countKey].add(customerId);
}

function newSalesCustomerSets() {
  return Object.fromEntries(['paidCustomerCount', 'initialPaidCustomerCount',
    'otherMonthPaidCustomerCount', 'unassignedPaidCustomerCount'].map((key) => [key, new Set()]));
}

function finishSalesPeriod(period, customerSets) {
  for (const [key, customers] of Object.entries(customerSets)) period[key] = customers.size;
}

function newBucket() {
  return { amount: 0, paymentCount: 0, customers: new Set(), initialAmount: 0, installmentAmount: 0 };
}

function publicBucket(bucket) {
  return { amount: bucket.amount, paymentCount: bucket.paymentCount,
    customerCount: bucket.customers.size, initialAmount: bucket.initialAmount,
    installmentAmount: bucket.installmentAmount };
}

module.exports = { TIMEZONE, parsePeriod, outstandingByMonth, dueForPeriod, addPayment, newBucket, publicBucket,
  newSalesPeriod, addSalesPayment, newSalesCustomerSets, finishSalesPeriod };
