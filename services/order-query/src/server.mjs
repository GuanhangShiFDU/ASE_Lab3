import { createServer } from 'node:http';

const service = 'order-query';
const port = Number(process.env.PORT ?? 3000);

const server = createServer((request, response) => {
  const healthy = request.method === 'GET' && request.url === '/health';
  response.writeHead(healthy ? 200 : 404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(healthy
    ? { status: 'ok', service }
    : { error: { code: 'NOT_FOUND', message: 'Route not found' } }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[${service}] listening on port ${port}`);
});
