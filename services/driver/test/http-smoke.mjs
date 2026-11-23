import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const driver = process.env.DRIVER_BASE_URL ?? 'http://127.0.0.1:18103';
const order = process.env.ORDER_BASE_URL ?? 'http://127.0.0.1:18101';
const internal = process.env.LAB3_INTERNAL_TOKEN ?? 'lab3-dev-internal-token';
const heldOrder = 'f1ab1b7c-4126-4ee9-bf91-131a60049173';

async function call(base, path, { method = 'GET', token, data } = {}, expected = 200) {
  const headers = { 'Idempotency-Key': randomUUID() };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, {
    method, headers, body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  if (expected !== null) assert.equal(response.status, expected, JSON.stringify(body));
  return { status: response.status, body };
}

const login = async id => (await call(driver, '/auth/login', {
  method: 'POST', data: { accountId: id },
})).body;
const reserve = (id, orderId, expected) => call(driver, `/internal/drivers/${id}/reserve`, {
  method: 'POST', token: internal, data: { orderId },
}, expected);
const release = (id, orderId) => call(driver, `/internal/drivers/${id}/release`, {
  method: 'POST', token: internal, data: { orderId },
});
const get = id => call(driver, `/internal/drivers/${id}`, { token: internal });
const available = async () => (await call(driver, '/internal/drivers/available', {
  token: internal,
})).body.drivers.map(item => item.driverId);
const status = (token, online, expected) => call(driver, '/drivers/me/status', {
  method: 'PUT', token, data: { online },
}, expected);

if (process.argv.includes('--after-restart')) {
  const state = (await get('driver-2')).body;
  assert.equal(state.online, false);
  assert.equal(state.displayName, '司机二');
  assert.equal(state.currentOrderId, heldOrder);
  assert.equal((await release('driver-2', heldOrder)).body.released, true);
  assert.equal((await get('driver-2')).body.available, false);
  await reserve('driver-2', heldOrder, 409);
  console.log('PASS Driver state, reservation and release persisted after restart');
} else {
  const [p1, p2, d1, d2] = await Promise.all([
    login('passenger-1'), login('passenger-2'), login('driver-1'), login('driver-2'),
  ]);
  assert.deepEqual([p1, p2, d1, d2].map(value => value.account.role), ['passenger', 'passenger', 'driver', 'driver']);
  assert.equal(d1.account.displayName, '司机一');
  assert.equal(d1.tokenType, 'Bearer');
  await call(driver, '/auth/login', { method: 'POST', data: { accountId: 'unknown' } }, 404);
  await status(p1.token, true, 403);
  await status(d1.token, 'true', 400);
  await call(driver, '/internal/drivers/available', { token: d1.token }, 401);
  assert.deepEqual(await available(), []);
  await reserve('driver-1', randomUUID(), 409);
  await status(d1.token, true);
  await status(d2.token, true);
  assert.deepEqual(await available(), ['driver-1', 'driver-2']);

  const ride = {
    pickup: { label: '人民广场', longitude: 121.475, latitude: 31.23 },
    dropoff: { label: '虹桥站', longitude: 121.327, latitude: 31.197 },
  };
  const created = (await call(order, '/orders', { method: 'POST', token: p1.token, data: ride }, 201)).body;
  const first = await Promise.all([
    reserve('driver-1', created.orderId, null), reserve('driver-2', created.orderId, null),
  ]);
  assert.deepEqual(first.map(response => response.status).sort(), [200, 409]);
  const winner = first.find(response => response.status === 200).body.driverId;
  const winnerToken = winner === 'driver-1' ? d1.token : d2.token;
  const idle = winner === 'driver-1' ? 'driver-2' : 'driver-1';
  await call(order, `/internal/orders/${created.orderId}/assign`, {
    method: 'POST', token: internal, data: { driverId: winner },
  });
  await status(winnerToken, false);
  assert.equal((await reserve(winner, created.orderId)).body.online, false);
  assert.equal((await get(winner)).body.currentOrderId, created.orderId);
  assert.deepEqual(await available(), [idle]);
  for (const action of ['arrive', 'start', 'finish']) {
    await call(order, `/orders/${created.orderId}/${action}`, { method: 'POST', token: winnerToken });
  }
  assert.equal((await release(winner, created.orderId)).body.released, true);
  assert.equal((await get(winner)).body.available, false);

  const competitors = [randomUUID(), randomUUID()];
  const races = await Promise.all(competitors.map(id => reserve(idle, id, null)));
  assert.deepEqual(races.map(response => response.status).sort(), [200, 409]);
  const firstId = races.find(response => response.status === 200).body.currentOrderId;
  const nextId = competitors.find(id => id !== firstId);
  assert.equal((await release(idle, firstId)).body.released, true);
  assert.equal((await get(idle)).body.available, true);
  await reserve(idle, nextId);
  assert.equal((await release(idle, firstId)).body.released, false);
  assert.equal((await get(idle)).body.currentOrderId, nextId);
  await release(idle, nextId);
  await reserve(idle, firstId, 409);

  // Leave a known active reservation and offline status for the restart check.
  await status(d2.token, true);
  await reserve('driver-2', heldOrder);
  await status(d2.token, false);
  console.log('PASS Driver HTTP: demo logins, real Order JWT, availability, races, offline trip, late release and delayed reserve');
}
