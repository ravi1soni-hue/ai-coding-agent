"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCookie = parseCookie;
exports.buildSessionCookie = buildSessionCookie;
exports.buildClearedSessionCookie = buildClearedSessionCookie;
exports.createUser = createUser;
exports.authenticateUser = authenticateUser;
exports.createSession = createSession;
exports.getUserFromSessionToken = getUserFromSessionToken;
exports.revokeSession = revokeSession;
exports.getOrCreateActiveProjectSession = getOrCreateActiveProjectSession;
exports.createProjectSession = createProjectSession;
exports.isProjectOwnedByUser = isProjectOwnedByUser;
exports.touchProjectSession = touchProjectSession;
const crypto_1 = __importDefault(require("crypto"));
const postgres_1 = require("../db/postgres");
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
function nowPlusSeconds(seconds) {
    return new Date(Date.now() + seconds * 1000).toISOString();
}
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
function hashToken(token) {
    return crypto_1.default.createHash('sha256').update(token).digest('hex');
}
function hashPassword(password, salt) {
    const pwdSalt = salt ?? crypto_1.default.randomBytes(16).toString('hex');
    const derived = crypto_1.default.scryptSync(password, pwdSalt, 64).toString('hex');
    return `${pwdSalt}:${derived}`;
}
function verifyPassword(password, storedHash) {
    const [salt, expected] = storedHash.split(':');
    if (!salt || !expected)
        return false;
    const derived = crypto_1.default.scryptSync(password, salt, 64).toString('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(derived, 'hex');
    if (expectedBuf.length !== actualBuf.length)
        return false;
    return crypto_1.default.timingSafeEqual(expectedBuf, actualBuf);
}
function parseCookie(cookieHeader) {
    if (!cookieHeader)
        return {};
    return cookieHeader
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((acc, part) => {
        const idx = part.indexOf('=');
        if (idx <= 0)
            return acc;
        const k = decodeURIComponent(part.slice(0, idx));
        const v = decodeURIComponent(part.slice(idx + 1));
        acc[k] = v;
        return acc;
    }, {});
}
function buildSessionCookie(token, isSecure) {
    const parts = [
        `sid=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    ];
    if (isSecure)
        parts.push('Secure');
    return parts.join('; ');
}
function buildClearedSessionCookie(isSecure) {
    const parts = ['sid=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (isSecure)
        parts.push('Secure');
    return parts.join('; ');
}
async function createUser(input) {
    const name = input.name.trim();
    const email = normalizeEmail(input.email);
    const passwordHash = hashPassword(input.password);
    const rows = await (0, postgres_1.pgQuery)(`INSERT INTO users (id, name, email, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, created_at`, [crypto_1.default.randomUUID(), name, email, passwordHash]);
    return rows[0];
}
async function authenticateUser(email, password) {
    const rows = await (0, postgres_1.pgQuery)(`SELECT id, name, email, password_hash, created_at FROM users WHERE email = $1 LIMIT 1`, [normalizeEmail(email)]);
    const user = rows[0];
    if (!user)
        return null;
    if (!verifyPassword(password, user.password_hash))
        return null;
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        created_at: user.created_at,
    };
}
async function createSession(input) {
    const token = crypto_1.default.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    await (0, postgres_1.pgQuery)(`INSERT INTO auth_sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`, [crypto_1.default.randomUUID(), input.userId, tokenHash, input.ip ?? null, input.userAgent ?? null, nowPlusSeconds(SESSION_MAX_AGE_SECONDS)]);
    return token;
}
async function getUserFromSessionToken(token) {
    const tokenHash = hashToken(token);
    const rows = await (0, postgres_1.pgQuery)(`SELECT u.id, u.name, u.email, u.created_at
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
     LIMIT 1`, [tokenHash]);
    return rows[0] ?? null;
}
async function revokeSession(token) {
    const tokenHash = hashToken(token);
    await (0, postgres_1.pgQuery)(`UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = $1`, [tokenHash]);
}
async function getOrCreateActiveProjectSession(userId) {
    const existing = await (0, postgres_1.pgQuery)(`SELECT id FROM project_sessions
     WHERE user_id = $1 AND status = 'active'
     ORDER BY last_active_at DESC
     LIMIT 1`, [userId]);
    if (existing[0]?.id) {
        await touchProjectSession(userId, existing[0].id);
        return existing[0].id;
    }
    return createProjectSession(userId);
}
async function createProjectSession(userId) {
    const id = crypto_1.default.randomUUID();
    await (0, postgres_1.pgQuery)(`INSERT INTO project_sessions (id, user_id, status) VALUES ($1, $2, 'active')`, [id, userId]);
    return id;
}
async function isProjectOwnedByUser(userId, projectId) {
    const rows = await (0, postgres_1.pgQuery)(`SELECT EXISTS (
      SELECT 1 FROM project_sessions WHERE id = $1 AND user_id = $2
    ) AS found`, [projectId, userId]);
    return rows[0]?.found === true;
}
async function touchProjectSession(userId, projectId) {
    await (0, postgres_1.pgQuery)(`UPDATE project_sessions
     SET last_active_at = NOW()
     WHERE id = $1 AND user_id = $2`, [projectId, userId]);
}
