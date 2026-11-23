import { createHmac, timingSafeEqual } from 'node:crypto';
import { OrderError } from '../domain/order.mjs';

function same(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const unauthorized = () => new OrderError(401, 'UNAUTHORIZED', 'Missing or invalid credentials');

export function createAuthenticator({ signingKey, internalToken }) {
  if (!signingKey || !internalToken || signingKey === internalToken) {
    throw Error('Order needs distinct LAB3_AUTH_SIGNING_KEY and LAB3_INTERNAL_TOKEN values');
  }
  return (request, internal) => {
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
    if (!match) throw unauthorized();
    const token = match[1];
    if (internal) {
      if (!same(token, internalToken)) throw unauthorized();
      return { id: 'lab3-internal', role: 'internal' };
    }

    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[a-zA-Z0-9_-]+$/.test(part))) throw unauthorized();
    const [head, body, signature] = parts;
    const expected = createHmac('sha256', signingKey).update(`${head}.${body}`).digest('base64url');
    if (!same(signature, expected)) throw unauthorized();
    try {
      const header = JSON.parse(Buffer.from(head, 'base64url'));
      const claims = JSON.parse(Buffer.from(body, 'base64url'));
      if (header.alg !== 'HS256' || !['passenger', 'driver'].includes(claims.role) ||
          typeof claims.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(claims.sub) ||
          !Number.isInteger(claims.exp) || claims.exp <= Date.now() / 1000) throw unauthorized();
      return { id: claims.sub, role: claims.role };
    } catch {
      throw unauthorized();
    }
  };
}
