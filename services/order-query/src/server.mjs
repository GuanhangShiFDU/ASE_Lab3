import { createServer } from 'node:http';
import { checkDatabase, createDatabase } from '../shared/database.mjs';
import { createInboxHandler, initializeInbox } from './inbox.mjs';
import { createReadModel, initializeReadModel, startProjector } from './read-model.mjs';
import { createDriverLookup, createReadHandler } from './http.mjs';

const service = 'order-query';
const port = Number(process.env.PORT ?? 3000);
const token = process.env.LAB3_INTERNAL_TOKEN;
const signingKey = process.env.LAB3_AUTH_SIGNING_KEY;
if (!token || !signingKey || token === signingKey) throw Error('Order Query needs distinct service and user credentials');

const database = createDatabase();
await initializeInbox(database);
await initializeReadModel(database);
const receiveEvent = createInboxHandler(database, token);
const read = createReadHandler({
  model: createReadModel(database), signingKey,
  lookupDriver: createDriverLookup({ url: process.env.DRIVER_URL ?? 'http://driver:3000', token }),
});

createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/internal/order-events') {
    return receiveEvent(request, response);
  }
  if (request.method === 'GET' && request.url === '/health') {
    const ready = await checkDatabase(database);
    response.writeHead(ready ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    });
    return response.end(JSON.stringify({ status: ready ? 'ok' : 'unavailable', service }));
  }
  return read(request, response);
}).listen(port, '0.0.0.0', () => {
  console.log(`[${service}] listening on port ${port}`);
  startProjector(database);
});
