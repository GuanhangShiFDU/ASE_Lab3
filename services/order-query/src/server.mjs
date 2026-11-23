import { createServer } from 'node:http';
import { checkDatabase, createDatabase } from '../shared/database.mjs';
import { createInboxHandler, initializeInbox } from './inbox.mjs';

const service = 'order-query';
const port = Number(process.env.PORT ?? 3000);

const token = process.env.LAB3_INTERNAL_TOKEN;
if (!token) throw Error('Order Query needs LAB3_INTERNAL_TOKEN');
const database = createDatabase();
await initializeInbox(database);
const receiveEvent = createInboxHandler(database, token);

const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/internal/order-events') {
    return receiveEvent(request, response);
  }
  const healthRequest = request.method === 'GET' && request.url === '/health';
  const ready = healthRequest && await checkDatabase(database);
  response.writeHead(healthRequest ? (ready ? 200 : 503) : 404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(healthRequest
    ? { status: ready ? 'ok' : 'unavailable', service }
    : { error: { code: 'NOT_FOUND', message: 'Route not found' } }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[${service}] listening on port ${port}`);
});
