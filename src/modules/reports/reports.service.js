const TASHKENT = 'Asia/Tashkent';
const dayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TASHKENT, year: 'numeric', month: '2-digit', day: '2-digit',
});

function localDate(date) {
  const parts = Object.fromEntries(dayFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateRange(query, now) {
  const today = localDate(new Date(now()));
  const from = query.from ?? today;
  const to = query.to ?? today;
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('from va to YYYY-MM-DD formatida bo‘lishi, from to dan keyin bo‘lmasligi kerak.');
  const fromDate = new Date(`${from}T00:00:00+05:00`);
  const toExclusive = new Date(new Date(`${to}T00:00:00+05:00`).getTime() + 86400000);
  if ((toExclusive - fromDate) / 86400000 > 3660) throw new Error('Hisobot oralig‘i 3660 kundan oshmasligi kerak.');
  return { from, to, fromDate, toExclusive };
}

function dueMonths(createdDate, asOfDate, termMonths) {
  const [year, month] = createdDate.split('-').map(Number);
  const [asYear, asMonth] = asOfDate.split('-').map(Number);
  const months = Math.min(termMonths, (asYear - year) * 12 + asMonth - month);
  if (months <= 0) return 0;
  return installmentDueDate(createdDate, months) <= asOfDate ? months : months - 1;
}

function installmentDueDate(createdDate, installment) {
  const [year, month, day] = createdDate.split('-').map(Number);
  const index = year * 12 + month - 1 + installment;
  const dueYear = Math.floor(index / 12);
  const dueMonth = index % 12 + 1;
  const lastDay = new Date(Date.UTC(dueYear, dueMonth, 0)).getUTCDate();
  return `${dueYear}-${String(dueMonth).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function overdueAmount(customer, asOfDate) {
  if (!Number.isSafeInteger(customer.totalPrice) || !Number.isSafeInteger(customer.downPayment) ||
      !Number.isSafeInteger(customer.totalPaid) || !Number.isSafeInteger(customer.remainingBalance) ||
      !Number.isInteger(customer.termMonths) || customer.termMonths < 1 || customer.termMonths > 120 ||
      !(customer.createdAt instanceof Date) || Number.isNaN(customer.createdAt.getTime()) ||
      customer.downPayment < 0 || customer.downPayment > customer.totalPrice ||
      customer.totalPaid < customer.downPayment || customer.remainingBalance < 0 ||
      customer.totalPaid + customer.remainingBalance !== customer.totalPrice) return null;
  const financed = customer.totalPrice - customer.downPayment;
  const elapsed = dueMonths(localDate(customer.createdAt), asOfDate, customer.termMonths);
  const scheduled = Number(BigInt(financed) * BigInt(elapsed) / BigInt(customer.termMonths));
  return Math.min(customer.remainingBalance, Math.max(0, scheduled - (customer.totalPaid - customer.downPayment)));
}

function monthlyExpected(customer, month) {
  if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) ||
      !Number.isSafeInteger(customer.totalPrice) || !Number.isSafeInteger(customer.downPayment) ||
      !Number.isSafeInteger(customer.totalPaid) || !Number.isSafeInteger(customer.remainingBalance) ||
      !Number.isInteger(customer.termMonths) || customer.termMonths < 1 || customer.termMonths > 120 ||
      !(customer.createdAt instanceof Date) || Number.isNaN(customer.createdAt.getTime()) ||
      customer.downPayment < 0 || customer.downPayment > customer.totalPrice ||
      customer.totalPaid < customer.downPayment || customer.totalPaid + customer.remainingBalance !== customer.totalPrice) return null;
  const createdMonth = localDate(customer.createdAt).slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const [createdYear, createdMonthNumber] = createdMonth.split('-').map(Number);
  const installment = (year - createdYear) * 12 + monthNumber - createdMonthNumber;
  if (installment < 1 || installment > customer.termMonths) return null;
  const financed = BigInt(customer.totalPrice - customer.downPayment);
  const term = BigInt(customer.termMonths);
  const throughMonth = Number(financed * BigInt(installment) / term);
  const throughPrevious = Number(financed * BigInt(installment - 1) / term);
  return { amount: throughMonth - throughPrevious, throughMonth };
}

function collectionWorkItem(customer, asOfDate) {
  const overdue = overdueAmount(customer, asOfDate);
  if (overdue === null || customer.remainingBalance <= 0) return null;
  const financed = customer.totalPrice - customer.downPayment;
  const installmentPaid = customer.totalPaid - customer.downPayment;
  if (financed <= 0 || installmentPaid >= financed) return null;
  const createdDate = localDate(customer.createdAt);
  let dueDate = null;
  for (let month = 1; month <= customer.termMonths; month++) {
    const cumulative = Number(BigInt(financed) * BigInt(month) / BigInt(customer.termMonths));
    if (cumulative > installmentPaid) {
      dueDate = installmentDueDate(createdDate, month);
      break;
    }
  }
  if (!dueDate || dueDate > asOfDate) return null;
  const daysOverdue = Math.round((Date.parse(`${asOfDate}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86400000);
  return { dueDate, daysOverdue, dueAmount: overdue, noInstallmentPaid: installmentPaid === 0 };
}

function csvCell(value) {
  const string = String(value ?? '');
  const safe = /^\s*[=+@-]/.test(string) || /^[\t\r\n]/.test(string) ? `'${string}` : string;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csv(columns, rows) {
  return `\uFEFF${[columns.map(([header]) => csvCell(header)).join(','),
    ...rows.map((row) => columns.map(([, key]) => csvCell(row[key])).join(','))].join('\r\n')}\r\n`;
}

module.exports = { localDate, dateRange, overdueAmount, monthlyExpected, installmentDueDate, collectionWorkItem, csv };
