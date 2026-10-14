const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { ROLES } = require('../constants/roles');

function createAuthMiddleware({ users, jwtSecret, logger }) {
  async function authenticate(req, res, next) {
    const token = req.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return res.status(401).json({ message: 'Sessiya topilmadi.' });

    try {
      const payload = jwt.verify(token, jwtSecret, { issuer: 'osonnasiya' });
      if (typeof payload === 'string' || !ObjectId.isValid(payload.sub)) {
        return res.status(401).json({ message: 'Sessiya tugadi.' });
      }
      const user = await users.findOne({ _id: new ObjectId(payload.sub) });
      if (!user || !ROLES.has(user.role) || user.role !== payload.role) {
        return res.status(401).json({ message: 'Sessiya tugadi.' });
      }
      res.locals.currentUser = user;
      return next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
        return res.status(401).json({ message: 'Sessiya tugadi.' });
      }
      logger.error('Autentifikatsiya xatosi:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  }

  function requireSuperAdmin(_req, res, next) {
    if (res.locals.currentUser.role !== 'super_admin') {
      return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    }
    return next();
  }

  return { authenticate, requireSuperAdmin };
}

module.exports = { createAuthMiddleware };
