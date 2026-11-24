import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { checkDatabase, createDatabase } from '../shared/database.mjs';
import { issueUserToken } from '../shared/jwt.mjs';
import { createOrderService } from '../src/application/order-service.mjs';
import { createOrderStore, initializeOrderStore } from '../src/infrastructure/order-store.mjs';
import { createAuthenticator } from '../src/interface/auth.mjs';
import { createOrderHandler } from '../src/interface/http.mjs';

const signingKey = 'order-component-test-signing-key';
const internal = 'order-component-test-internal-token';
const jwt = (role, number) => issueUserToken(
  { id: `${role}-${number}`, role }, signingKey, Math.floor(Date.now() / 1000) + 3600);
const route = {
  pickup: { label: '人民广场', longitude: 121.475, latitude: 31.23 },
  dropoff: { label: '虹桥站', longitude: 121.327, latitude: 31.197 },
};
let db;
let server;
let base;

async function start() {
  server = createServer(createOrderHandler({
    orders: createOrderService(createOrderStore(db)),
    authenticate: createAuthenticator({ signingKey, internalToken: internal }),
    isReady: () => checkDatabase(db),
  })).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stop() {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

before(async () => {
  assert.equal(process.env.DB_NAME, 'lab3_order_test', 'Use the dedicated test database');
  db = createDatabase();
  const [[database]] = await db.query('SELECT DATABASE() AS name');
  assert.equal(database.name, 'lab3_order_test');
  await initializeOrderStore(db);
  await start();
});
after(async () => {
  await stop();
  await db?.end();
});

async function http(path, { method = 'GET', token, data, key = randomUUID() } = {}) {
  const headers = { 'Idempotency-Key': key, Connection: 'close' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, {
    method, headers, body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(3500),
  });
  return { status: response.status, body: await response.json() };
}
function expectStatus(result, code) {
  assert.equal(result.status, code, JSON.stringify(result.body));
  return result.body;
}
const post = (path, token, data, key) => http(path, { method: 'POST', token, data, key });
const create = (token, key, data = route) => post('/orders', token, data, key);
const assign = (ride, id) => post(`/internal/orders/${ride.orderId}/assign`, internal, { driverId: id });
const command = (ride, verb, token, key) => post(`/orders/${ride.orderId}/${verb}`, token, undefined, key);
const snapshot = async id => (await db.execute('SELECT snapshot FROM orders WHERE id = ?', [id]))[0][0].snapshot;
const events = async id => (await db.execute(
  'SELECT order_version, payload FROM order_outbox WHERE order_id = ? ORDER BY order_version', [id]))[0];

test('HTTP health, estimate validation and user/service authentication', async () => {
  assert.equal(expectStatus(await http('/health'), 200).service, 'order');
  const passenger = jwt('passenger', 1);
  const estimate = expectStatus(await post('/orders/estimate', passenger, route), 200);
  assert.ok(Number.isInteger(estimate.estimatedDistanceMeters) && estimate.estimatedDistanceMeters > 0);
  assert.ok(Number.isInteger(estimate.estimatedFareCents) && estimate.estimatedFareCents > 0);
  expectStatus(await post('/orders/estimate', passenger, { ...route, pickup: route.dropoff }), 400);
  expectStatus(await create('invalid'), 401);
  expectStatus(await create(jwt('driver', 1)), 403);
  expectStatus(await create(passenger, 'bad key'), 400);
  expectStatus(await http('/internal/orders/matching', { token: passenger }), 401);
});

test('full lifecycle persists ordered versions, one fare and a release job', async () => {
  const passenger = jwt('passenger', 1);
  const driver = jwt('driver', 1);
  let ride = expectStatus(await create(passenger), 201);
  ride = expectStatus(await assign(ride, 'driver-1'), 200);
  expectStatus(await command(ride, 'arrive', jwt('driver', 9)), 403);
  expectStatus(await command(ride, 'cancel', jwt('passenger', 9)), 403);
  expectStatus(await command(ride, 'start', driver), 409);
  expectStatus(await command(ride, 'arrive', driver), 200);
  const started = expectStatus(await command(ride, 'start', driver), 200);
  expectStatus(await command(ride, 'cancel', passenger), 409);
  const completed = expectStatus(await command(ride, 'finish', driver), 200);
  assert.deepEqual(expectStatus(await command(ride, 'finish', driver), 200), completed);
  assert.deepEqual(expectStatus(await command(ride, 'start', driver), 200), completed);
  assert.equal(completed.startedAt, started.startedAt);
  assert.equal(completed.fareCents, completed.estimatedFareCents);
  assert.deepEqual(await snapshot(ride.orderId), completed);
  const timeline = await events(ride.orderId);
  assert.deepEqual(timeline.map(event => event.order_version), [1, 2, 3, 4, 5]);
  assert.deepEqual(timeline.at(-1).payload.snapshot, completed);
  const [[release]] = await db.execute(
    'SELECT driver_id, completed_at FROM order_driver_releases WHERE order_id = ?', [ride.orderId]);
  assert.deepEqual(release, { driver_id: 'driver-1', completed_at: null });
});

test('concurrent same-key creation and replay after restarting HTTP use one persisted order', async () => {
  const passenger = jwt('passenger', 2);
  const key = randomUUID();
  const [first, replay] = await Promise.all([create(passenger, key), create(passenger, key)]);
  const ride = expectStatus(first, 201);
  assert.deepEqual(expectStatus(replay, 201), ride);
  expectStatus(await create(passenger, key, { ...route, dropoff: { ...route.dropoff, label: 'new name' } }), 409);
  expectStatus(await create(passenger), 409);
  await stop();
  await start();
  assert.deepEqual(expectStatus(await create(passenger, key), 201), ride);
  assert.equal((await events(ride.orderId)).length, 1);
  const [[count]] = await db.query("SELECT COUNT(*) AS n FROM orders WHERE snapshot->>'$.passengerId' = 'passenger-2'");
  assert.equal(count.n, 1);
  expectStatus(await command(ride, 'cancel', passenger), 200);
  const fresh = expectStatus(await create(passenger), 201);
  assert.notEqual(fresh.orderId, ride.orderId);
});

test('two concurrent assignments to one driver leave exactly one successful binding', async () => {
  const first = expectStatus(await create(jwt('passenger', 3)), 201);
  const second = expectStatus(await create(jwt('passenger', 4)), 201);
  const results = await Promise.all([assign(first, 'driver-2'), assign(second, 'driver-2')]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.find(result => result.status === 200).body;
  const loser = winner.orderId === first.orderId ? second : first;
  assert.equal((await snapshot(winner.orderId)).driverId, 'driver-2');
  assert.equal((await snapshot(loser.orderId)).status, 'MATCHING');
  assert.equal((await events(winner.orderId)).length, 2);
  assert.equal((await events(loser.orderId)).length, 1);
});

test('cancel and boarding compete on the same order without two successful transitions', async () => {
  const passenger = jwt('passenger', 5);
  const driver = jwt('driver', 3);
  const ride = expectStatus(await create(passenger), 201);
  expectStatus(await assign(ride, 'driver-3'), 200);
  expectStatus(await command(ride, 'arrive', driver), 200);
  const results = await Promise.all([command(ride, 'cancel', passenger), command(ride, 'start', driver)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const result = results.find(item => item.status === 200).body;
  assert.ok(['CANCELED', 'IN_PROGRESS'].includes(result.status));
  assert.deepEqual(await snapshot(ride.orderId), result);
  const timeline = await events(ride.orderId);
  assert.equal(timeline.length, 4);
  assert.equal(timeline.at(-1).payload.snapshot.status, result.status);
});

test('failure to write an outbox event rolls back the cancel, idempotency key and release job', async () => {
  const passenger = jwt('passenger', 6);
  const ride = expectStatus(await create(passenger), 201);
  const assigned = expectStatus(await assign(ride, 'driver-4'), 200);
  const key = 'cancel-after-database-recovery';

  // Occupy the next event version so MySQL's unique constraint rejects a real outbox write.
  const fixtureEventId = randomUUID();
  await db.execute(
    'INSERT INTO order_outbox (event_id, order_id, order_version, payload) VALUES (?, ?, ?, ?)',
    [fixtureEventId, ride.orderId, assigned.orderVersion + 1, JSON.stringify({ fixture: true })]);
  const priorEvents = await events(ride.orderId);
  try {
    expectStatus(await command(ride, 'cancel', passenger, key), 503);
    assert.deepEqual(await snapshot(ride.orderId), assigned);
    assert.deepEqual(await events(ride.orderId), priorEvents);
    const [[release]] = await db.execute(
      'SELECT COUNT(*) AS n FROM order_driver_releases WHERE order_id = ?', [ride.orderId]);
    assert.equal(release.n, 0);
    const [[request]] = await db.execute(
      'SELECT COUNT(*) AS n FROM order_requests WHERE actor_id = ? AND request_key = ?', ['passenger-6', key]);
    assert.equal(request.n, 0);
  } finally {
    await db.execute('DELETE FROM order_outbox WHERE event_id = ?', [fixtureEventId]);
  }

  const canceled = expectStatus(await command(ride, 'cancel', passenger, key), 200);
  assert.equal(canceled.status, 'CANCELED');
  assert.deepEqual(await snapshot(ride.orderId), canceled);
  const timeline = await events(ride.orderId);
  assert.equal(timeline.length, 3);
  assert.deepEqual(timeline.at(-1).payload.snapshot, canceled);
  const [[release]] = await db.execute('SELECT driver_id FROM order_driver_releases WHERE order_id = ?', [ride.orderId]);
  assert.equal(release.driver_id, 'driver-4');
});
