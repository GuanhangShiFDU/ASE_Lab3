import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const order = process.env.ORDER_BASE_URL ?? 'http://127.0.0.1:18101';
const driver = process.env.DRIVER_BASE_URL ?? 'http://127.0.0.1:18103';
const query = process.env.ORDER_QUERY_BASE_URL ?? 'http://127.0.0.1:18102';
const internal = process.env.LAB3_INTERNAL_TOKEN ?? 'lab3-dev-internal-token';
if (!process.env.COMPOSE_PROJECT_NAME || !process.argv.includes('--isolated-test-project')) {
  throw Error('Run in an isolated Compose project with COMPOSE_PROJECT_NAME and --isolated-test-project');
}

async function call(base, path, { token, method = 'GET', body, expected = 200 } = {}) {
  const headers = { 'Idempotency-Key': randomUUID(), Connection: 'close' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(4500),
  });
  const text = await response.text();
  assert.ok([expected].flat().includes(response.status), `${path} got ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function until(read, ok, label) {
  const deadline = Date.now() + 22000;
  while (Date.now() < deadline) {
    const result = await read();
    if (ok(result)) return result;
    await sleep(150);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function compose(...args) {
  execFileSync('docker', ['compose', ...args], { stdio: 'ignore' });
}
function projectionProcessed(eventId) {
  const result = execFileSync('docker', [
    'compose', 'exec', '-T', 'order-query', 'node', '--input-type=module', '-', eventId,
  ], { encoding: 'utf8', input: `
    import { createDatabase } from './shared/database.mjs';
    const db = createDatabase();
    try {
      const [[row]] = await db.execute('SELECT processed_at FROM order_event_inbox WHERE event_id = ?', [process.argv[2]]);
      console.log(Boolean(row?.processed_at));
    } finally { await db.end(); }
  ` });
  return result.trim() === 'true';
}

const login = async id => (await call(driver, '/auth/login', { method: 'POST', body: { accountId: id } })).token;
const [p1, p2, d1, d2] = await Promise.all(['passenger-1', 'passenger-2', 'driver-1', 'driver-2'].map(login));
const route = {
  pickup: { label: '人民广场', longitude: 121.475, latitude: 31.23 },
  dropoff: { label: '虹桥站', longitude: 121.327, latitude: 31.197 },
};
const create = () => call(order, '/orders', { method: 'POST', token: p1, body: route, expected: 201 });
const sendEvent = event => call(query, '/internal/order-events', { method: 'POST', token: internal, body: event, expected: 204 });
const expectState = (id, state, token = p1) => until(
  () => call(query, `/orders/${id}`, { token, expected: [200, 404] }), result => result?.status === state, state);

await call(query, '/orders/history', { expected: 401 });
await call(query, '/orders/history', { token: d1, expected: 403 });
await call(query, '/drivers/me/order', { token: p1, expected: 403 });
await call(query, '/orders/history?limit=101', { token: p1, expected: 400 });
assert.equal((await call(query, '/orders/current', { token: p1 })).order, null);

const created = await create();
assert.equal((await expectState(created.orderId, 'MATCHING')).driverProfileStatus, 'NOT_ASSIGNED');
assert.equal((await call(query, '/orders/current', { token: p1 })).order.orderId, created.orderId);
await call(driver, '/drivers/me/status', { method: 'PUT', token: d1, body: { online: true } });
await call(driver, '/internal/drivers/driver-1/reserve', {
  method: 'POST', token: internal, body: { orderId: created.orderId },
});
await call(order, `/internal/orders/${created.orderId}/assign`, {
  method: 'POST', token: internal, body: { driverId: 'driver-1' },
});
const assigned = await expectState(created.orderId, 'ASSIGNED');
assert.deepEqual(assigned.driver, { driverId: 'driver-1', displayName: '司机一' });
assert.equal(assigned.driverProfileStatus, 'AVAILABLE');
assert.equal((await call(query, '/drivers/me/order', { token: d1 })).order.orderId, created.orderId);
assert.equal((await call(query, '/drivers/me/order', { token: d2 })).order, null);
await call(query, `/orders/${created.orderId}`, { token: p2, expected: 403 });
await call(query, `/orders/${created.orderId}`, { token: d2, expected: 403 });

compose('stop', 'driver');
const partial = await expectState(created.orderId, 'ASSIGNED');
assert.equal(partial.driverProfileStatus, 'UNAVAILABLE');
assert.equal(partial.driver, null);
assert.equal(partial.driverId, 'driver-1');
compose('stop', 'order-query');
for (const command of ['arrive', 'start']) {
  await call(order, `/orders/${created.orderId}/${command}`, { method: 'POST', token: d1 });
}
compose('up', '-d', '--wait', '--wait-timeout', '40', 'driver', 'order-query');
const started = await expectState(created.orderId, 'IN_PROGRESS');
assert.equal(started.driver?.displayName, '司机一');

const old = {
  eventId: randomUUID(), type: 'OrderSnapshotChanged', schemaVersion: 1,
  orderId: created.orderId, orderVersion: created.orderVersion, occurredAt: created.updatedAt,
  snapshot: created,
};
await sendEvent(old);
await sendEvent(old);
await until(() => projectionProcessed(old.eventId), Boolean, 'late event processed');
const retained = await expectState(created.orderId, 'IN_PROGRESS');
assert.equal(retained.orderVersion, started.orderVersion);

await call(order, `/orders/${created.orderId}/finish`, { method: 'POST', token: d1 });
const completed = await expectState(created.orderId, 'COMPLETED');
assert.equal(completed.fareCents, completed.estimatedFareCents);
assert.equal((await call(query, '/drivers/me/order', { token: d1 })).order, null);
const next = await create();
await call(order, `/orders/${next.orderId}/cancel`, { method: 'POST', token: p1 });
await expectState(next.orderId, 'CANCELED');
const firstPage = await call(query, '/orders/history?limit=1', { token: p1 });
assert.equal(firstPage.orders[0].orderId, next.orderId);
assert.ok(firstPage.nextCursor);
const secondPage = await call(query, `/orders/history?limit=1&before=${encodeURIComponent(firstPage.nextCursor)}`, { token: p1 });
assert.equal(secondPage.orders[0].orderId, created.orderId);
assert.equal(secondPage.nextCursor, null);
assert.deepEqual((await call(query, '/orders/history', { token: p2 })).orders, []);

compose('stop', 'order');
compose('restart', 'order-query');
compose('up', '-d', '--no-recreate', '--wait', '--wait-timeout', '40', 'order-query');
assert.equal((await expectState(created.orderId, 'COMPLETED')).orderVersion, completed.orderVersion);
console.log('PASS CQRS: persisted projection, identity scope, composition, Driver outage, Query catch-up, duplicate and stale events, history pagination, reads independent of Order');
