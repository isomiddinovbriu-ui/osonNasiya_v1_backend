const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

const ACCESS_SECONDS = 15 * 60;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'osonnasiya_refresh';

function newRefreshToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashRefreshToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function validRefreshToken(token) { return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token); }

function signAccessToken(user, sessionId, jwtSecret) {
  return jwt.sign({ role: user.role, sid: sessionId.toString() }, jwtSecret, {
    subject: user._id.toString(), expiresIn: ACCESS_SECONDS, issuer: 'osonnasiya',
  });
}

function refreshCookie(token, { secure = true, maxAge = REFRESH_MS } = {}) {
  const parts = [`${COOKIE_NAME}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/auth', `Max-Age=${Math.floor(maxAge / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

async function createSession(refreshSessions, user, clientType, now) {
  const refreshToken = newRefreshToken();
  const createdAt = new Date(now());
  const expiresAt = new Date(createdAt.getTime() + REFRESH_MS);
  const session = {
    _id: new ObjectId(), userId: user._id, role: user.role, clientType,
    tokenHash: hashRefreshToken(refreshToken), createdAt, lastUsedAt: createdAt,
    expiresAt, revokedAt: null,
  };
  await refreshSessions.insertOne(session);
  return { refreshToken, session };
}

async function rotateSession(refreshSessions, users, refreshToken, now) {
  if (!validRefreshToken(refreshToken)) return null;
  const oldHash = hashRefreshToken(refreshToken);
  const currentTime = new Date(now());
  const replacement = newRefreshToken();
  const expiresAt = new Date(currentTime.getTime() + REFRESH_MS);
  const session = await refreshSessions.findOneAndUpdate(
    { tokenHash: oldHash, revokedAt: null, expiresAt: { $gt: currentTime } },
    { $set: { tokenHash: hashRefreshToken(replacement), lastUsedAt: currentTime, expiresAt } },
    { returnDocument: 'after' },
  );
  if (!session) return null;
  const user = await users.findOne({ _id: session.userId });
  if (!user || user.role !== session.role) {
    await refreshSessions.updateOne({ _id: session._id }, { $set: { revokedAt: currentTime } });
    return null;
  }
  return { refreshToken: replacement, session, user };
}

async function revokeSession(refreshSessions, refreshToken, now) {
  if (!validRefreshToken(refreshToken)) return;
  await refreshSessions.updateOne(
    { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    { $set: { revokedAt: new Date(now()) } },
  );
}

module.exports = {
  ACCESS_SECONDS, REFRESH_MS, COOKIE_NAME, hashRefreshToken, signAccessToken,
  refreshCookie, createSession, rotateSession, revokeSession,
};
