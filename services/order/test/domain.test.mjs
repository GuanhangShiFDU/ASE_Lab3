import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceOrder, estimate, newOrder, parsePlace } from '../src/domain/order.mjs';
import { createOrderService } from '../src/application/order-service.mjs';

const time = '2026-11-23T02:00:00.000Z';
const later = '2026-11-23T02:01:00.000Z';
const pickup = { label: '人民广场', longitude: 121.475, latitude: 31.23 };
const dropoff = { label: '虹桥火车站', longitude: 121.327, latitude: 31.197 };
const passenger = { id: 'passenger-1', role: 'passenger' };
const driver = { id: 'driver-1', role: 'driver' };
const dispatch = { id: 'lab3-internal', role: 'internal' };
const newRide = () => newOrder({ orderId: 'example', passengerId: passenger.id, pickup, dropoff, now: time });
const assign = ride => advanceOrder(ride, 'assign', dispatch, { driverId: driver.id }, time);
const arrive = ride => advanceOrder(ride, 'arrive', driver, {}, time);
const start = ride => advanceOrder(ride, 'start', driver, {}, time);

test('estimate returns integer meters/cents and rejects unusable places', () => {
  const result = estimate(pickup, dropoff);
  assert.ok(Number.isInteger(result.estimatedDistanceMeters) && result.estimatedDistanceMeters > 0);
  assert.ok(Number.isInteger(result.estimatedFareCents) && result.estimatedFareCents > 1200);
  assert.throws(() => estimate(pickup, pickup), { status: 400 });
  assert.throws(() => parsePlace({ ...pickup, latitude: 90 }), { status: 400 });
});

test('rejects a different driver, an early start, and cancellation after boarding', () => {
  const assigned = assign(newRide());
  assert.throws(() => advanceOrder(assigned, 'arrive', { ...driver, id: 'driver-2' }, {}, time), { status: 403 });
  assert.throws(() => start(assigned), { status: 409 });
  assert.throws(() => advanceOrder(start(arrive(assigned)), 'cancel', passenger, {}, time), { status: 409 });
});

test('a canceled ride cannot be assigned or started later', () => {
  const canceled = advanceOrder(arrive(assign(newRide())), 'cancel', passenger, {}, time);
  assert.throws(() => start(canceled), { status: 409 });
  assert.throws(() => assign(canceled), { status: 409 });
});

test('finish keeps the first effective timestamp and fare on retries', () => {
  const completed = advanceOrder(start(arrive(assign(newRide()))), 'finish', driver, {}, time);
  const duplicate = advanceOrder(completed, 'finish', driver, {}, later);
  assert.equal(duplicate, completed);
  assert.equal(completed.finishedAt, time);
  assert.equal(completed.fareCents, completed.estimatedFareCents);
  assert.equal(completed.orderVersion, 5);
});

test('application validates idempotency keys and blocks drivers from creating an order', async () => {
  const service = createOrderService({ runCommand: () => assert.fail('invalid input should not touch store') });
  const input = { command: 'create', payload: { pickup, dropoff } };
  await assert.rejects(service.execute({ ...input, actor: driver, key: 'k' }), { status: 403 });
  await assert.rejects(service.execute({ ...input, actor: passenger }), { status: 400 });
});
