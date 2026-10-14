const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ROLES } = require('../../constants/roles');
const { publicUser } = require('../users/users.presenter');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

function registerAuthRoutes(app, { users, loginRequests, jwtSecret, authenticate, logger, now }) {
  const attempts = new Map();
  app.post('/auth/login', async (req, res) => {
    const login = typeof req.body?.login === 'string' ? req.body.login.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    let recordAttempted = false;
    const record = async (status, userId = null) => {
      recordAttempted = true;
      await loginRequests.insertOne({
        createdAt: new Date(now()),
        login,
        ip: req.ip,
        userAgent: req.get('User-Agent') || null,
        status,
        userId,
      });
    };
    if (!login || !password || login.length > 100 || password.length > 1024) {
      await record(400);
      return res.status(400).json({ message: 'Login va parolni kiriting.' });
    }

    const key = `${req.ip}:${login}`;
    const previous = attempts.get(key);
    if (previous && previous.until > now() && previous.count >= MAX_FAILURES) {
      await record(429);
      return res.status(429).json({ message: 'Urinishlar ko‘payib ketdi. 15 daqiqadan keyin qayta urinib ko‘ring.' });
    }

    try {
      const user = await users.findOne({ login });
      const valid = user && ROLES.has(user.role) && await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        const current = attempts.get(key);
        attempts.set(key, current && current.until > now()
          ? { count: current.count + 1, until: current.until }
          : { count: 1, until: now() + WINDOW_MS });
        await record(401);
        return res.status(401).json({ message: 'Login yoki parol noto‘g‘ri.' });
      }

      attempts.delete(key);
      const token = jwt.sign({ role: user.role }, jwtSecret, {
        subject: user._id.toString(),
        expiresIn: '12h',
        issuer: 'osonnasiya',
      });
      await record(200, user._id);
      res.set('Cache-Control', 'no-store');
      return res.json({ token, user: publicUser(user) });
    } catch (error) {
      logger.error('Login xatosi:', error);
      if (!recordAttempted) {
        try {
          await record(500);
        } catch (logError) {
          logger.error('Login so‘rovini yozishda xatolik:', logError);
        }
      }
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/auth/me', authenticate, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({ user: publicUser(res.locals.currentUser) });
  });
}

module.exports = { registerAuthRoutes };
