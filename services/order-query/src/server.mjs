import { createServer } from 'node:http';
import { checkDatabase, createDatabase } from '../shared/database.mjs';

const service = 'order-query';
const port = Number(process.env.PORT ?? 3000);

const database = createDatabase();

const server = createServer(async (request, response) => {
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
