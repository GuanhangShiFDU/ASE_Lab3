import { createHmac, timingSafeEqual } from 'node:crypto';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const sign = (message, key) => createHmac('sha256', key).update(message).digest('base64url');

export function secretsMatch(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function issueUserToken({ id, role }, key, expiresAt) {
  const message = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, role, exp: expiresAt })}`;
  return `${message}.${sign(message, key)}`;
}

export function verifyUserToken(token, key) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[a-zA-Z0-9_-]+$/.test(part))) return null;

  const [head, body, signature] = parts;
  if (!secretsMatch(signature, sign(`${head}.${body}`, key))) return null;

  try {
    const header = JSON.parse(Buffer.from(head, 'base64url'));
    const claims = JSON.parse(Buffer.from(body, 'base64url'));
    if (header.alg !== 'HS256' || !['passenger', 'driver'].includes(claims.role) ||
        typeof claims.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(claims.sub) ||
        !Number.isInteger(claims.exp) || claims.exp <= Date.now() / 1000) return null;
    return { id: claims.sub, role: claims.role };
  } catch {
    return null;
  }
}
