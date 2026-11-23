import { invalid, OrderError } from '../domain/order.mjs';

const orderId = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const publicCommand = new RegExp(`^/orders/${orderId}/(cancel|arrive|start|finish)$`);
const internalCommand = new RegExp(`^/internal/orders/${orderId}/(assign|match-failed)$`);
const internalQuery = new RegExp(`^/internal/orders/${orderId}$`);

function send(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16_384) {
      request.resume();
      throw new OrderError(413, 'BODY_TOO_LARGE', 'Request body exceeds 16 KiB');
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new OrderError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
  }
  try {
    const payload = JSON.parse(Buffer.concat(chunks));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('Expected an object');
    return payload;
  } catch {
    throw invalid('Expected a valid JSON object');
  }
}

export function createOrderHandler({ orders, authenticate, isReady }) {
  return async (request, response) => {
    const path = request.url.split('?')[0];
    try {
      if (request.method === 'GET' && path === '/health') {
        const ready = await isReady();
        return send(response, ready ? 200 : 503, { status: ready ? 'ok' : 'unavailable', service: 'order' });
      }
      const internal = path.startsWith('/internal/');
      if (request.method === 'GET') {
        if (path === '/internal/orders/matching') {
          authenticate(request, true);
          const after = new URLSearchParams(request.url.split('?')[1]).get('after') ?? '';
          if (after && !new RegExp(`^${orderId}$`).test(after)) throw invalid('Invalid matching cursor');
          return send(response, 200, await orders.matching(after));
        }
        const lookup = internalQuery.exec(path);
        if (lookup) {
          authenticate(request, true);
          return send(response, 200, await orders.getInternal(lookup[1]));
        }
      }
      if (request.method === 'POST') {
        const match = (internal ? internalCommand : publicCommand).exec(path);
        const command = path === '/orders' ? 'create' : match?.[2];
        if (command || path === '/orders/estimate') {
          const actor = authenticate(request, internal);
          const payload = await readBody(request);
          if (!command) return send(response, 200, orders.estimate(actor, payload));
          const result = await orders.execute({
            actor, key: request.headers['idempotency-key'], command, orderId: match?.[1], payload,
          });
          return send(response, result.status, result.body);
        }
      }
      throw new OrderError(404, 'NOT_FOUND', 'Route not found');
    } catch (error) {
      if (error instanceof OrderError) {
        return send(response, error.status, { error: { code: error.code, message: error.message } });
      }
      console.error('[order]', request.method, path, error.code ?? error.name);
      return send(response, 503, { error: { code: 'UNAVAILABLE', message: 'Order service temporarily unavailable' } });
    }
  };
}
