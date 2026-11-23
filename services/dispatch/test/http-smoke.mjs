import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const dispatch = process.env.DISPATCH_BASE_URL ?? 'http://127.0.0.1:18104';
const driver = process.env.DRIVER_BASE_URL ?? 'http://127.0.0.1:18103';
const order = process.env.ORDER_BASE_URL ?? 'http://127.0.0.1:18101';
const internal = process.env.LAB3_INTERNAL_TOKEN ?? 'lab3-dev-internal-token';

async function call(base, path, method, token, body, expected = 200) {
  const headers = { 'Idempotency-Key': randomUUID() };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  const value = await response.json();
  assert.ok([expected].flat().includes(response.status), JSON.stringify({ path, status: response.status, value }));
  return value;
}

async function until(read, predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await read();
    if (predicate(result)) return result;
    await sleep(120);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

const login = async id => (await call(driver, '/auth/login', 'POST', null, { accountId: id })).token;
const [passenger, first, second] = await Promise.all([
  login('passenger-1'), login('driver-1'), login('driver-2'),
]);
const route = {
  pickup: { label: '人民广场', longitude: 121.475, latitude: 31.23 },
  dropoff: { label: '虹桥站', longitude: 121.327, latitude: 31.197 },
};
const create = () => call(order, '/orders', 'POST', passenger, route, 201);
const cancel = id => call(order, `/orders/${id}/cancel`, 'POST', passenger);
const detail = id => call(order, `/internal/orders/${id}`, 'GET', internal);
const waitStatus = (id, status) => until(() => detail(id), value => value.status === status, status);
const setOnline = (token, online) => call(driver, '/drivers/me/status', 'PUT', token, { online });
const inbox = token => call(dispatch, '/drivers/me/offers', 'GET', token);
const waitOffer = (token, id) => until(async () => (await inbox(token)).offers.find(value => value.orderId === id),
  Boolean, `offer for ${id}`);
const readOffer = (token, offer) => call(dispatch, `/offers/${offer.offerId}`, 'GET', token);
const action = (token, offer, verb, status) =>
  call(dispatch, `/offers/${offer.offerId}/${verb}`, 'POST', token, undefined, status);

await call(dispatch, '/drivers/me/offers', 'GET', passenger, undefined, 403);
await call(order, '/internal/orders/matching', 'GET', passenger, undefined, 401);
await waitStatus((await create()).orderId, 'MATCH_FAILED');

await setOnline(first, true);
await setOnline(second, true);
const rejected = await create();
const firstOffer = await waitOffer(first, rejected.orderId);
await action(second, firstOffer, 'accept', 403);
await action(first, firstOffer, 'reject', 200);
await action(first, firstOffer, 'reject', 200);
const secondOffer = await waitOffer(second, rejected.orderId);
await action(first, firstOffer, 'accept', 409);
await action(second, secondOffer, 'accept', [200, 202]);
await until(() => readOffer(second, secondOffer), value => value.status === 'ACCEPTED', 'acceptance');
assert.equal((await waitStatus(rejected.orderId, 'ASSIGNED')).driverId, 'driver-2');
await action(second, secondOffer, 'accept', 200);
await cancel(rejected.orderId);
// The recovery card will automate this release.
await call(driver, '/internal/drivers/driver-2/release', 'POST', internal, { orderId: rejected.orderId });

const canceled = await create();
const pending = await waitOffer(first, canceled.orderId);
await cancel(canceled.orderId);
await until(() => readOffer(first, pending), value => value.status === 'VOID', 'canceled invite');
await action(first, pending, 'accept', 409);

const offline = await create();
const offlineOffer = await waitOffer(first, offline.orderId);
await setOnline(first, false);
await action(first, offlineOffer, 'accept', [200, 202]);
await until(() => readOffer(first, offlineOffer), value => value.status === 'VOID', 'offline invite');
const newOffer = await waitOffer(second, offline.orderId);
await action(second, newOffer, 'reject', 200);
await waitStatus(offline.orderId, 'MATCH_FAILED');
await setOnline(first, true);

const restarted = await create();
const timed = await waitOffer(first, restarted.orderId);
execFileSync('docker', ['compose', 'stop', 'dispatch'], { stdio: 'ignore' });
await sleep(Math.max(0, Date.parse(timed.expiresAt) - Date.now()) + 100);
execFileSync('docker', ['compose', 'up', '-d', '--wait', '--wait-timeout', '35', 'dispatch'], { stdio: 'ignore' });
await action(first, timed, 'accept', 409);
assert.equal((await readOffer(first, timed)).status, 'EXPIRED');
const reassigned = await waitOffer(second, restarted.orderId);
await action(second, reassigned, 'reject', 200);
await waitStatus(restarted.orderId, 'MATCH_FAILED');
console.log('PASS Dispatch HTTP: no driver, offer ownership, reject/accept, cancellation, offline race, persisted timeout and reoffer after restart');
