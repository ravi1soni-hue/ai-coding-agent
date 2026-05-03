import { getUserFromSessionToken, parseCookie } from '../auth/authService';

export async function requireUser(req: any, reply: any) {
  const cookies = parseCookie(req.headers.cookie);
  if (!cookies.sid) {
    reply.status(401).send({ error: 'Unauthorized' });
    return null;
  }
  const user = await getUserFromSessionToken(cookies.sid);
  if (!user) {
    reply.status(401).send({ error: 'Unauthorized' });
    return null;
  }
  return user;
}
