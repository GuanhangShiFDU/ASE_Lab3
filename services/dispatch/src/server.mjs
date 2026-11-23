import { createServer } from 'node:http';
import { checkDatabase, createDatabase } from '../shared/database.mjs';
import { verifyUserToken } from '../shared/jwt.mjs';
import { createMatcher, createPeers } from './matching.mjs';
import { createStore, initialize, packOffer } from './store.mjs';

const {
  LAB3_AUTH_SIGNING_KEY: signingKey, LAB3_INTERNAL_TOKEN: token,
  DRIVER_URL: driverUrl, ORDER_URL: orderUrl, PORT = '3000',
} = process.env;

function milliseconds(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 100) throw Error(`Invalid ${name}`);
  return value;
}

const offerMs = milliseconds('DISPATCH_OFFER_MS', 15000);
const matchMs = milliseconds('DISPATCH_MATCH_MS', 60000);
const tickMs = milliseconds('DISPATCH_POLL_MS', 500);
if (!signingKey || !token || signingKey === token || !driverUrl || !orderUrl || offerMs > matchMs) {
  throw Error('Dispatch requires valid service URLs, distinct auth keys and timers');
}

const database = createDatabase();
await initialize(database);
const store = createStore(database);
const peers = createPeers({ driverUrl, orderUrl, token });
const tick = createMatcher({ store, peers, offerMs, matchMs });

const offerRoute = /^\/offers\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/(accept|reject))?$/;
function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
const error = (response, status, code, message) => send(response, status, { error: { code, message } });

function displayOffer(row, now) {
  const result = packOffer(row);
  return result.status === 'PENDING' && row.expires_at <= now ? { ...result, status: 'EXPIRED' } : result;
}

createServer(async (request, response) => {
  const path = request.url.split('?')[0];
  const method = request.method;
  try {
    if (method === 'GET' && path === '/health') {
      const ready = await checkDatabase(database);
      return send(response, ready ? 200 : 503, { status: ready ? 'ok' : 'unavailable', service: 'dispatch' });
    }
    const match = offerRoute.exec(path);
    const inbox = method === 'GET' && path === '/drivers/me/offers';
    if (!inbox && (!match || (match[2] ? method !== 'POST' : method !== 'GET'))) {
      return error(response, 404, 'NOT_FOUND', 'Route not found');
    }

    const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
    const actor = bearer && verifyUserToken(bearer[1], signingKey);
    if (!actor) return error(response, 401, 'UNAUTHORIZED', 'Missing or invalid credentials');
    if (actor.role !== 'driver') return error(response, 403, 'FORBIDDEN', 'Driver identity required');
    if (inbox) return send(response, 200, { offers: await store.inbox(actor.id, Date.now()) });

    const [, id, action] = match;
    const row = action ? await store.respond(id, actor.id, action) : await store.find(id);
    if (!row) return error(response, 404, 'NOT_FOUND', 'Offer not found');
    if (row.driver_id !== actor.id) return error(response, 403, 'FORBIDDEN', 'This offer belongs to another driver');
    const offer = displayOffer(row, Date.now());
    if (!action) return send(response, 200, offer);
    if (action === 'accept' && offer.status === 'ACCEPTING') return send(response, 202, offer);
    if ((action === 'accept' && offer.status === 'ACCEPTED') ||
        (action === 'reject' && offer.status === 'REJECTED')) return send(response, 200, offer);
    return error(response, 409, 'STATE_CONFLICT', `Offer is ${offer.status}`);
  } catch (cause) {
    console.error('[dispatch]', method, path, cause.code ?? cause.name);
    return error(response, 503, 'UNAVAILABLE', 'Dispatch service temporarily unavailable');
  }
}).listen(Number(PORT), '0.0.0.0', async () => {
  console.info('[dispatch] listening on port', PORT);
  async function run() {
    try {
      await tick();
    } catch (cause) {
      console.warn('[dispatch] worker deferred', cause.code ?? cause.name);
    } finally {
      setTimeout(run, tickMs);
    }
  }
  await run();
});
