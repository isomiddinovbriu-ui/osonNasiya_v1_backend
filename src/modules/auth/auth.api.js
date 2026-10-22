const bcrypt = require('bcryptjs');
const { ROLES } = require('../../constants/roles');
const { publicUser } = require('../users/users.presenter');
const {
  ACCESS_SECONDS, COOKIE_NAME, signAccessToken, refreshCookie,
  createSession, rotateSession, revokeSession,
} = require('./session.service');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

function registerAuthRoutes(app, { users, loginRequests, refreshSessions, jwtSecret, authenticate, logger, now }) {
  const attempts = new Map();

  function cookieToken(req) {
    const part = req.get('Cookie')?.split(';').map((value) => value.trim())
      .find((value) => value.startsWith(`${COOKIE_NAME}=`));
    return part?.slice(COOKIE_NAME.length + 1) || null;
  }

  function tokenResponse(res, user, session, refreshToken) {
    const accessToken = signAccessToken(user, session._id, jwtSecret);
    res.set('Cache-Control', 'no-store');
    if (session.clientType === 'web') res.set('Set-Cookie', refreshCookie(refreshToken));
    return res.json({
      token: accessToken, accessToken, expiresIn: ACCESS_SECONDS,
      refreshExpiresAt: session.expiresAt,
      ...(session.clientType === 'mobile' && { refreshToken }),
      user: publicUser(user),
    });
  }

  app.post('/auth/login', async (req, res) => {
    const login = typeof req.body?.login === 'string' ? req.body.login.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const clientType = req.body?.clientType ?? 'mobile';
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
    if (!login || !password || login.length > 100 || password.length > 1024 ||
        !['mobile', 'web'].includes(clientType)) {
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
      const valid = user && !user.deletedAt && ROLES.has(user.role) && await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        const current = attempts.get(key);
        attempts.set(key, current && current.until > now()
          ? { count: current.count + 1, until: current.until }
          : { count: 1, until: now() + WINDOW_MS });
        await record(401);
        return res.status(401).json({ message: 'Login yoki parol noto‘g‘ri.' });
      }

      attempts.delete(key);
      const { refreshToken, session } = await createSession(refreshSessions, user, clientType, now);
      await record(200, user._id);
      return tokenResponse(res, user, session, refreshToken);
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

  app.post('/auth/refresh', async (req, res) => {
    const fromCookie = cookieToken(req);
    const refreshToken = fromCookie || req.body?.refreshToken;
    if (!refreshToken) return res.status(401).json({ message: 'Sessiya tugadi.' });
    try {
      const rotated = await rotateSession(refreshSessions, users, refreshToken, now);
      if (!rotated) return res.status(401).json({ message: 'Sessiya tugadi.' });
      return tokenResponse(res, rotated.user, rotated.session, rotated.refreshToken);
    } catch (error) {
      logger.error('Sessiyani yangilashda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.post('/auth/logout', async (req, res) => {
    const fromCookie = cookieToken(req);
    try {
      await revokeSession(refreshSessions, fromCookie || req.body?.refreshToken, now);
      res.set('Cache-Control', 'no-store');
      if (fromCookie) res.set('Set-Cookie', refreshCookie('', { maxAge: 0 }));
      return res.sendStatus(204);
    } catch (error) {
      logger.error('Sessiyadan chiqishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/auth/me', authenticate, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({ user: publicUser(res.locals.currentUser) });
  });
}

module.exports = { registerAuthRoutes };
