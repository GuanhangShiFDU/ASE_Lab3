import { verifyUserToken } from '../shared/jwt.mjs';

const idPattern = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const detailPath = new RegExp(`^/orders/(${idPattern})$`);
const cursorPattern = new RegExp(`^(-?[0-9]{1,16}):(${idPattern})$`);

function send(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

const fail = (response, status, code, message) => send(response, status, { error: { code, message } });

export function createDriverLookup({ url, token }) {
  return async driverId => {
    try {
      const response = await fetch(new URL(`/internal/drivers/${encodeURIComponent(driverId)}`, url), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1200),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const driver = await response.json();
      return driver.driverId === driverId && typeof driver.displayName === 'string'
        ? { driverId, displayName: driver.displayName } : null;
    } catch {
      return null;
    }
  };
}

export function createReadHandler({ model, lookupDriver, signingKey }) {
  async function combine(order) {
    if (!order) return null;
    if (!order.driverId) return { ...order, driver: null, driverProfileStatus: 'NOT_ASSIGNED' };
    const driver = await lookupDriver(order.driverId);
    return { ...order, driver, driverProfileStatus: driver ? 'AVAILABLE' : 'UNAVAILABLE' };
  }

  return async (request, response) => {
    let url;
    try {
      url = new URL(request.url, 'http://order-query');
    } catch {
      return fail(response, 400, 'INVALID_REQUEST', 'Invalid URL');
    }
    const path = url.pathname;
    const detail = detailPath.exec(path);
    const history = path === '/orders/history';
    const currentRole = path === '/orders/current' ? 'passenger'
      : path === '/drivers/me/order' ? 'driver' : null;
    if (request.method !== 'GET' || (!detail && !history && !currentRole)) {
      return fail(response, 404, 'NOT_FOUND', 'Route not found');
    }
    const token = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1];
    const actor = token && verifyUserToken(token, signingKey);
    if (!actor) return fail(response, 401, 'UNAUTHORIZED', 'Missing or invalid credentials');
    const requiredRole = history ? 'passenger' : currentRole;
    if (requiredRole && requiredRole !== actor.role) return fail(response, 403, 'FORBIDDEN', 'Wrong account role');

    try {
      if (history) {
        const limitRaw = url.searchParams.get('limit') ?? '50';
        const limit = Number(limitRaw);
        const raw = url.searchParams.get('before');
        const cursor = raw === null ? null : cursorPattern.exec(raw);
        if (!/^\d{1,3}$/.test(limitRaw) || limit < 1 || limit > 100 ||
            (raw !== null && (!cursor || !Number.isSafeInteger(Number(cursor[1]))))) {
          return fail(response, 400, 'INVALID_REQUEST', 'Invalid history limit or cursor');
        }
        const before = cursor ? { time: Number(cursor[1]), id: cursor[2] } : null;
        return send(response, 200, await model.history(actor.id, limit, before));
      }
      if (currentRole) {
        return send(response, 200, { order: await combine(await model.current(actor.role, actor.id)) });
      }
      const order = await model.find(detail[1]);
      if (!order) return fail(response, 404, 'NOT_FOUND', 'Order is not present in the read model');
      const ownerId = actor.role === 'passenger' ? order.passengerId : order.driverId;
      if (ownerId !== actor.id) return fail(response, 403, 'FORBIDDEN', 'Actor does not own this order');
      return send(response, 200, await combine(order));
    } catch (error) {
      console.error('[order-query]', path, error.code ?? error.name);
      return fail(response, 503, 'UNAVAILABLE', 'Read model temporarily unavailable');
    }
  };
}
