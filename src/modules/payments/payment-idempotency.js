const { createHmac } = require('node:crypto');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function paymentRequestHash(secret, mijozId, body) {
  return createHmac('sha256', secret)
    .update(canonicalJson({ mijozId, body }))
    .digest('hex');
}

function validIdempotencyKey(key) {
  return typeof key === 'string' && key.length >= 8 && key.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(key);
}

module.exports = { paymentRequestHash, validIdempotencyKey };
