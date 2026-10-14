const STAFF_ROLES = new Set(['yiguvchi', 'sotuvchi', 'product_creator']);
const ROLES = new Set(['super_admin', ...STAFF_ROLES]);

module.exports = { STAFF_ROLES, ROLES };
