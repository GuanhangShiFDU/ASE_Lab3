import { createServer } from 'node:http';
import { checkDatabase, createDatabase } from '../shared/database.mjs';
import { issueUserToken, secretsMatch, verifyUserToken } from '../shared/jwt.mjs';
import { createDriverStore, initializeDriverStore } from './driver-store.mjs';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = message => new HttpError(400, 'INVALID_REQUEST', message);
const unauthorized = () => new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid credentials');
const notFound = resource => new HttpError(404, 'NOT_FOUND', `${resource} not found`);
const accountIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const orderIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const internalDriver = /^\/internal\/drivers\/([A-Za-z0-9_-]{1,32})(?:\/(reserve|release))?$/;
const signingKey = process.env.LAB3_AUTH_SIGNING_KEY;
const internalToken = process.env.LAB3_INTERNAL_TOKEN;
const port = Number(process.env.PORT ?? 3000);

if (!signingKey || !internalToken || signingKey === internalToken) {
  throw Error('Driver needs distinct LAB3_AUTH_SIGNING_KEY and LAB3_INTERNAL_TOKEN values');
}

const database = createDatabase();
await initializeDriverStore(database);
const drivers = createDriverStore(database);

function send(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 4096) {
      request.resume();
      throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 4 KiB');
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // Every malformed or non-object JSON body receives the same response.
  }
  throw badRequest('Expected a valid JSON object');
}

function bearer(request) {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
  if (!match) throw unauthorized();
  return match[1];
}

function driverIdentity(request) {
  const actor = verifyUserToken(bearer(request), signingKey);
  if (!actor) throw unauthorized();
  if (actor.role !== 'driver') throw new HttpError(403, 'FORBIDDEN', 'Driver identity required');
  return actor.id;
}

async function login(request) {
  const { accountId } = await readBody(request);
  if (typeof accountId !== 'string' || !accountIdPattern.test(accountId)) {
    throw badRequest('accountId is required');
  }
  const account = await drivers.account(accountId);
  if (!account) throw notFound('Demo account');
  const expiresIn = 8 * 60 * 60;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  return { token: issueUserToken(account, signingKey, expiresAt), tokenType: 'Bearer', expiresIn, account };
}

async function handleDriverStatus(request, response) {
  const id = driverIdentity(request);
  if (request.method === 'GET') {
    const driver = await drivers.get(id);
    if (!driver) throw notFound('Driver');
    return send(response, 200, driver);
  }
  const { online } = await readBody(request);
  if (typeof online !== 'boolean') throw badRequest('online must be a boolean');
  const driver = await drivers.setOnline(id, online);
  if (!driver) throw notFound('Driver');
  console.info('[driver] online status updated', id, online, driver.currentOrderId ?? '-');
  return send(response, 200, driver);
}

async function handleInternal(request, response, path) {
  if (!secretsMatch(bearer(request), internalToken)) throw unauthorized();
  if (request.method === 'GET' && path === '/internal/drivers/available') {
    return send(response, 200, { drivers: await drivers.available() });
  }
  const match = internalDriver.exec(path);
  if (!match) throw notFound('Route');
  const [, id, action] = match;
  if (!action && request.method === 'GET') {
    const driver = await drivers.get(id);
    if (!driver) throw notFound('Driver');
    return send(response, 200, driver);
  }
  if (!action || request.method !== 'POST') throw notFound('Route');
  const { orderId } = await readBody(request);
  if (typeof orderId !== 'string' || !orderIdPattern.test(orderId)) throw badRequest('Expected an order UUID');

  const result = await drivers[action](id, orderId);
  if (!result) throw notFound('Driver');
  if (result.conflict) throw new HttpError(409, 'STATE_CONFLICT', result.conflict);
  console.info('[driver]', action, id, orderId, result.released ?? 'reserved');
  return send(response, 200, action === 'reserve' ? result.driver : result);
}

createServer(async (request, response) => {
  const path = request.url.split('?')[0];
  try {
    if (request.method === 'GET' && path === '/health') {
      const ready = await checkDatabase(database);
      return send(response, ready ? 200 : 503, { status: ready ? 'ok' : 'unavailable', service: 'driver' });
    }
    if (request.method === 'POST' && path === '/auth/login') {
      return send(response, 200, await login(request));
    }
    if (['GET', 'PUT'].includes(request.method) && path === '/drivers/me/status') {
      return await handleDriverStatus(request, response);
    }
    if (path.startsWith('/internal/')) return await handleInternal(request, response, path);
    throw notFound('Route');
  } catch (error) {
    if (error instanceof HttpError) {
      return send(response, error.status, { error: { code: error.code, message: error.message } });
    }
    console.error('[driver]', request.method, path, error.code ?? error.name);
    return send(response, 503, { error: { code: 'UNAVAILABLE', message: 'Driver service temporarily unavailable' } });
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`[driver] listening on port ${port}`);
});
