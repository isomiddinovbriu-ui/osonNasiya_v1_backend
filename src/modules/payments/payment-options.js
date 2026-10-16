const METHODS = Object.freeze([
  { id: 'cash', label: 'Naqd' },
  { id: 'transfer', label: 'O‘tkazma (eski tur)' },
  { id: 'card', label: 'Bank kartasi' },
  { id: 'payment_app', label: 'To‘lov ilovasi' },
]);

const methodIds = new Set(METHODS.map(({ id }) => id));
const legacyProviderIds = new Set(['humans_pay', 'paylov', 'hamkor_mobile']);
function validProviderCode(value) { return typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value); }

function lastFour(cardNumber) {
  if (typeof cardNumber !== 'string' || !/^[\d -]+$/.test(cardNumber)) {
    throw new Error('Karta raqamini to‘g‘ri kiriting.');
  }
  const digits = cardNumber.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(digits)) throw new Error('Karta raqami 13–19 ta raqamdan iborat bo‘lishi kerak.');
  return digits.slice(-4);
}

async function paymentDetails({ method, cardNumber, provider, providerName }, paymentApps) {
  if (!methodIds.has(method)) throw new Error('To‘lov turi noto‘g‘ri.');
  if (method === 'card') {
    if (provider !== undefined || providerName !== undefined) throw new Error('Ilova faqat payment_app turi uchun yuboriladi.');
    return { cardLast4: lastFour(cardNumber), provider: null, providerName: null };
  }
  if (method === 'payment_app') {
    const cardLast4 = lastFour(cardNumber);
    if (!validProviderCode(provider)) throw new Error('To‘lov ilovasini GET /payments/options ro‘yxatidan tanlang.');
    if (provider === 'other') {
      const name = typeof providerName === 'string' ? providerName.trim() : '';
      if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Boshqa ilova nomini kiriting.');
      return { cardLast4, provider, providerName: name };
    }
    if (providerName !== undefined) throw new Error('providerName faqat other uchun yuboriladi.');
    if (!legacyProviderIds.has(provider) && !await paymentApps.findOne({ code: provider })) {
      throw new Error('To‘lov ilovasini GET /payments/options ro‘yxatidan tanlang.');
    }
    return { cardLast4, provider, providerName: null };
  }
  if (cardNumber !== undefined) throw new Error('Karta raqami faqat card yoki payment_app turi uchun yuboriladi.');
  if (provider !== undefined || providerName !== undefined) throw new Error('Ilova nomi faqat payment_app turi uchun yuboriladi.');
  return { cardLast4: null, provider: null, providerName: null };
}

module.exports = { METHODS, methodIds, validProviderCode, paymentDetails };
