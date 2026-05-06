import crypto from 'crypto';
import { pgQuery } from '../db/postgres';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  created_at: string;
};

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function nowPlusSeconds(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password: string, salt?: string) {
  const pwdSalt = salt ?? crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, pwdSalt, 64).toString('hex');
  return `${pwdSalt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string) {
  const normalizedStoredHash = String(storedHash ?? '').trim();
  if (!normalizedStoredHash) return false;

  const parts = normalizedStoredHash.split(':');
  if (parts.length === 2) {
    const [salt, expected] = parts;
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(derived, 'hex');
    if (expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return true;
    }
  }

  // Backward compatibility for legacy accounts that may have been stored in plaintext
  // before the current scrypt-based password hashing was introduced.
  return password === normalizedStoredHash;
}

export function parseCookie(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const idx = part.indexOf('=');
      if (idx <= 0) return acc;
      const k = decodeURIComponent(part.slice(0, idx));
      const v = decodeURIComponent(part.slice(idx + 1));
      acc[k] = v;
      return acc;
    }, {} as Record<string, string>);
}

export function buildSessionCookie(token: string, isSecure: boolean) {
  const parts = [
    `sid=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${isSecure ? 'None' : 'Lax'}`,
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearedSessionCookie(isSecure: boolean) {
  const parts = ['sid=', 'Path=/', 'HttpOnly', `SameSite=${isSecure ? 'None' : 'Lax'}`, 'Max-Age=0'];
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

export async function createUser(input: { name: string; email: string; password: string }): Promise<AuthUser> {
  const name = input.name.trim();
  const email = normalizeEmail(input.email);
  const passwordHash = hashPassword(input.password);

  const rows = await pgQuery<AuthUser>(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, created_at`,
    [crypto.randomUUID(), name, email, passwordHash],
  );

  return rows[0];
}

export async function authenticateUser(email: string, password: string): Promise<AuthUser | null> {
  const rows = await pgQuery<Array<AuthUser & { password_hash: string }>[number]>(
    `SELECT id, name, email, password_hash, created_at FROM users WHERE email = $1 LIMIT 1`,
    [normalizeEmail(email)],
  );

  const user = rows[0] as (AuthUser & { password_hash: string }) | undefined;
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    created_at: user.created_at,
  };
}

export async function createSession(input: {
  userId: string;
  ip?: string;
  userAgent?: string;
}): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  await pgQuery(
    `INSERT INTO auth_sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [crypto.randomUUID(), input.userId, tokenHash, input.ip ?? null, input.userAgent ?? null, nowPlusSeconds(SESSION_MAX_AGE_SECONDS)],
  );
  return token;
}

export async function getUserFromSessionToken(token: string): Promise<AuthUser | null> {
  const tokenHash = hashToken(token);
  const rows = await pgQuery<AuthUser>(
    `SELECT u.id, u.name, u.email, u.created_at
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
     LIMIT 1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function revokeSession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await pgQuery(`UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = $1`, [tokenHash]);
}

export async function getOrCreateActiveProjectSession(userId: string): Promise<string> {
  const existing = await pgQuery<{ id: string }>(
    `SELECT id FROM project_sessions
     WHERE user_id = $1 AND status = 'active'
     ORDER BY last_active_at DESC
     LIMIT 1`,
    [userId],
  );

  if (existing[0]?.id) {
    await touchProjectSession(userId, existing[0].id);
    return existing[0].id;
  }

  return createProjectSession(userId);
}

export async function createProjectSession(userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pgQuery(
    `INSERT INTO project_sessions (id, user_id, status) VALUES ($1, $2, 'active')`,
    [id, userId],
  );
  return id;
}

export async function isProjectOwnedByUser(userId: string, projectId: string): Promise<boolean> {
  const rows = await pgQuery<{ found: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM project_sessions WHERE id = $1 AND user_id = $2
    ) AS found`,
    [projectId, userId],
  );
  return rows[0]?.found === true;
}

export async function touchProjectSession(userId: string, projectId: string): Promise<void> {
  await pgQuery(
    `UPDATE project_sessions
     SET last_active_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [projectId, userId],
  );
}
