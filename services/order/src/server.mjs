import { createServer } from 'node:http';
import { checkDatabase, createDatabase } from '../shared/database.mjs';
import { createOrderService } from './application/order-service.mjs';
import { initializeOrderStore, createOrderStore } from './infrastructure/order-store.mjs';
import { createAuthenticator } from './interface/auth.mjs';
import { startOrderWorkers } from './infrastructure/order-workers.mjs';
import { createOrderHandler } from './interface/http.mjs';

const port = Number(process.env.PORT ?? 3000);
const authenticate = createAuthenticator({
  signingKey: process.env.LAB3_AUTH_SIGNING_KEY,
  internalToken: process.env.LAB3_INTERNAL_TOKEN,
});
const database = createDatabase();
await initializeOrderStore(database);

const handler = createOrderHandler({
  orders: createOrderService(createOrderStore(database)),
  authenticate,
  isReady: () => checkDatabase(database),
});
createServer(handler).listen(port, '0.0.0.0', () => {
  console.log(`[order] listening on port ${port}`);
  startOrderWorkers(database, process.env);
});
