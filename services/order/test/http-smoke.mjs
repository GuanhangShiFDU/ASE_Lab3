import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

const base = process.env.ORDER_BASE_URL ?? 'http://127.0.0.1:18101';
const signingKey = process.env.LAB3_AUTH_SIGNING_KEY ?? 'lab3-dev-user-signing-key';
const internal = process.env.LAB3_INTERNAL_TOKEN ?? 'lab3-dev-internal-token';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function identity(role, n) {
  const part = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: `${role}-${n}`, role, exp: Math.floor(Date.now() / 1000) + 120,
  })}`;
  return `${part}.${createHmac('sha256', signingKey).update(part).digest('base64url')}`;
}

const p1 = identity('passenger', 1);
const p2 = identity('passenger', 2);
const d1 = identity('driver', 1);
const d2 = identity('driver', 2);
const ride = {
  pickup: { label: '人民广场', longitude: 121.475, latitude: 31.23 },
  dropoff: { label: '虹桥火车站', longitude: 121.327, latitude: 31.197 },
};
async function call(path, token, payload, key = randomUUID(), method = 'POST') {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}
function verify(result, code) {
  assert.equal(result.status, code, JSON.stringify(result.body));
  return result.body;
}

const key = randomUUID();
verify(await call('/orders', 'forged', ride), 401);
verify(await call('/orders/estimate', p1, ride), 200);
const duplicates = await Promise.all([call('/orders', p1, ride, key), call('/orders', p1, ride, key)]);
const a = verify(duplicates[0], 201);
assert.deepEqual(verify(duplicates[1], 201), a);
verify(await call('/orders', p1, { ...ride, dropoff: { ...ride.dropoff, label: 'different' } }, key), 409);
const b = verify(await call('/orders', p2, ride), 201);
const assign = order => call(`/internal/orders/${order.orderId}/assign`, internal, { driverId: 'driver-1' });
const results = await Promise.all([assign(a), assign(b)]);
assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
const winner = results.find(r => r.status === 200).body;
const loser = winner.orderId === a.orderId ? b : a;
const owner = winner.orderId === a.orderId ? p1 : p2;
const other = owner === p1 ? p2 : p1;
const path = `/orders/${winner.orderId}`;
verify(await call(`${path}/arrive`, d2), 403);
verify(await call(`${path}/cancel`, other), 403);
verify(await call(`${path}/start`, d1), 409);
verify(await call(`${path}/arrive`, d1), 200);
const raced = await Promise.all([call(`${path}/cancel`, owner), call(`${path}/start`, d1)]);
assert.deepEqual(raced.map(r => r.status).sort(), [200, 409]);
if (raced[1].status === 200) {
  const completed = verify(await call(`${path}/finish`, d1), 200);
  assert.equal(completed.status, 'COMPLETED');
  assert.ok(Number.isInteger(completed.fareCents));
  assert.deepEqual(verify(await call(`${path}/finish`, d1), 200), completed);
} else {
  assert.equal(raced[0].body.status, 'CANCELED');
}
verify(await assign(loser), 200);
const loserPath = `/orders/${loser.orderId}`;
verify(await call(`${loserPath}/cancel`, other), 200);
verify(await assign(loser), 409);
const fresh = verify(await call('/orders', other, ride), 201);
assert.notEqual(fresh.orderId, loser.orderId);
verify(await call(`/internal/orders/${fresh.orderId}/match-failed`, internal), 200);
const finalRide = verify(await call('/orders', owner, ride), 201);
verify(await assign(finalRide), 200);
const finalPath = `/orders/${finalRide.orderId}`;
verify(await call(`${finalPath}/arrive`, d1), 200);
verify(await call(`${finalPath}/start`, d1), 200);
verify(await call(`${finalPath}/cancel`, owner), 409);
const completed = verify(await call(`${finalPath}/finish`, d1), 200);
assert.equal(completed.status, 'COMPLETED');
assert.equal(completed.distanceMeters, completed.estimatedDistanceMeters);
assert.equal(completed.fareCents, completed.estimatedFareCents);
assert.deepEqual(verify(await call(`${finalPath}/finish`, d1), 200), completed);
const detail = verify(await call(`/internal/orders/${winner.orderId}`, internal, undefined, undefined, 'GET'), 200);
assert.ok(['COMPLETED', 'CANCELED'].includes(detail.status));
console.log(`PASS Order HTTP: auth, estimation, idempotency, shared-driver race, cancel/start race, release of Order slot, rebooking, match failure and completion; verified ${winner.orderId}`);
