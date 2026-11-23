import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const order = process.env.ORDER_BASE_URL ?? 'http://127.0.0.1:18101';
const query = process.env.ORDER_QUERY_BASE_URL ?? 'http://127.0.0.1:18102';
const driver = process.env.DRIVER_BASE_URL ?? 'http://127.0.0.1:18103';
const internal = process.env.LAB3_INTERNAL_TOKEN ?? 'lab3-dev-internal-token';
const route = {
  pickup: { label: '人民广场', longitude: 121.475, latitude: 31.23 },
  dropoff: { label: '虹桥站', longitude: 121.327, latitude: 31.197 },
};

if (!process.env.COMPOSE_PROJECT_NAME || !process.argv.includes('--isolated-test-project')) {
  throw Error('Run in an isolated Compose project with COMPOSE_PROJECT_NAME and --isolated-test-project');
}

async function call(base, path, { method = 'GET', token, data } = {}, expected = 200) {
  const headers = { 'Idempotency-Key': randomUUID() };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, {
    method, headers, body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(4000),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const doPost = (base, path, token, data, expected) => call(base, path, { method: 'POST', token, data }, expected);
const login = async id => (await doPost(driver, '/auth/login', null, { accountId: id })).token;
const getDriver = () => call(driver, '/internal/drivers/driver-1', { token: internal });

function compose(...args) {
  execFileSync('docker', ['compose', ...args], { stdio: 'ignore' });
}

function db(service, sql, values = []) {
  const result = execFileSync('docker', [
    'compose', 'exec', '-T', service, 'node', '--input-type=module', '-',
    JSON.stringify([sql, values]),
  ], { input: `
    import { createDatabase } from './shared/database.mjs';
    const db = createDatabase();
    try {
      const [sql, values] = JSON.parse(process.argv[2]);
      const [rows] = await db.execute(sql, values);
      console.log(JSON.stringify(rows));
    } finally {
      await db.end();
    }
  `, encoding: 'utf8' });
  return JSON.parse(result);
}

async function waitFor(read, ok, label) {
  const deadline = Date.now() + 22000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ok(value)) return value;
    await sleep(180);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

const [passenger, driverToken] = await Promise.all([login('passenger-1'), login('driver-1')]);
await call(driver, '/drivers/me/status', { method: 'PUT', token: driverToken, data: { online: true } });
async function createAndAssign() {
  const ride = await doPost(order, '/orders', passenger, route, 201);
  await doPost(driver, '/internal/drivers/driver-1/reserve', internal, { orderId: ride.orderId });
  return doPost(order, `/internal/orders/${ride.orderId}/assign`, internal, { driverId: 'driver-1' });
}
const first = await createAndAssign();
assert.equal((await getDriver()).currentOrderId, first.orderId);

compose('stop', 'driver', 'order-query');
const canceled = await doPost(order, `/orders/${first.orderId}/cancel`, passenger);
assert.equal(canceled.status, 'CANCELED');
const terminal = db('order',
  'SELECT event_id FROM order_outbox WHERE order_id = ? AND order_version = ?', [first.orderId, canceled.orderVersion])[0];
const counts = () => db('order', `
  SELECT task_type, attempts FROM order_background_retries
  WHERE (task_type='release' AND task_id=?) OR (task_type='delivery' AND task_id=?)
`, [first.orderId, terminal.event_id]);
await waitFor(counts, jobs => jobs.length === 2 && jobs.every(job => job.attempts >= 1), 'durable retry counters');
assert.equal(db('order', 'SELECT completed_at FROM order_driver_releases WHERE order_id = ?', [first.orderId])[0].completed_at, null);
assert.equal(db('order', 'SELECT published_at FROM order_outbox WHERE event_id = ?', [terminal.event_id])[0].published_at, null);

compose('restart', 'order');
compose('up', '-d', '--no-recreate', '--wait', '--wait-timeout', '40', 'order');
assert.equal(counts().length, 2);
compose('up', '-d', '--wait', '--wait-timeout', '40', 'driver', 'order-query');
await waitFor(getDriver, state => state.currentOrderId === null && state.available, 'release after outage and restart');
await waitFor(() => db('order', 'SELECT published_at FROM order_outbox WHERE event_id = ?', [terminal.event_id])[0],
  event => event.published_at, 'outbox acknowledgment');
const terminalPayload = db('order-query',
  'SELECT payload FROM order_event_inbox WHERE event_id = ?', [terminal.event_id])[0].payload;
assert.equal(terminalPayload.snapshot.status, 'CANCELED');

await doPost(query, '/internal/order-events', passenger, terminalPayload, 401);
await doPost(query, '/internal/order-events', internal, { ...terminalPayload, schemaVersion: 2 }, 400);
await doPost(query, '/internal/order-events', internal, terminalPayload, 204);
await doPost(query, '/internal/order-events', internal, {
  ...terminalPayload, snapshot: { ...terminalPayload.snapshot, status: 'COMPLETED' },
}, 409);
assert.equal(db('order-query', 'SELECT COUNT(*) AS n FROM order_event_inbox WHERE event_id = ?', [terminal.event_id])[0].n, 1);

const second = await createAndAssign();
// Replay completed work as if the acknowledgments had been lost.
db('order', 'UPDATE order_driver_releases SET completed_at = NULL WHERE order_id = ?', [first.orderId]);
db('order', 'UPDATE order_outbox SET published_at = NULL WHERE event_id = ?', [terminal.event_id]);
await waitFor(() => db('order', 'SELECT completed_at FROM order_driver_releases WHERE order_id = ?', [first.orderId])[0],
  job => job.completed_at, 'late old release replay');
await waitFor(() => db('order', 'SELECT published_at FROM order_outbox WHERE event_id = ?', [terminal.event_id])[0],
  event => event.published_at, 'delivery replay');
assert.equal((await getDriver()).currentOrderId, second.orderId);
assert.equal(db('order-query', 'SELECT COUNT(*) AS n FROM order_event_inbox WHERE event_id = ?', [terminal.event_id])[0].n, 1);

for (const command of ['arrive', 'start', 'finish']) {
  await doPost(order, `/orders/${second.orderId}/${command}`, driverToken);
}
await waitFor(getDriver, state => state.available && state.currentOrderId === null, 'automatic completion release');
console.log('PASS recovery: failed release and delivery persisted, Order restart resumed both, event replay deduplicated, old release preserved new reservation, completion released automatically');
