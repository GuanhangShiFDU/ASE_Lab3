import { secretsMatch, verifyUserToken } from '../../shared/jwt.mjs';
import { OrderError } from '../domain/order.mjs';

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
      if (!secretsMatch(token, internalToken)) throw unauthorized();
      return { id: 'lab3-internal', role: 'internal' };
    }

    const actor = verifyUserToken(token, signingKey);
    if (!actor) throw unauthorized();
    return actor;
  };
}
