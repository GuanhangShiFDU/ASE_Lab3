import assert from 'node:assert/strict';
import test from 'node:test';
import { orderActions, reconcileOrder } from '../src/state.js';

test('a delayed or missing projection preserves the latest successful order write', () => {
  const current = { orderId: 'a', orderVersion: 3, status: 'ARRIVED' };
  assert.equal(reconcileOrder(current, null), current);
  assert.equal(reconcileOrder(current, { orderId: 'a', orderVersion: 2, status: 'ASSIGNED' }), current);
  assert.deepEqual(reconcileOrder(current, { orderId: 'a', orderVersion: 3, driver: { displayName: '司机一' } }),
    { ...current, driver: { displayName: '司机一' } });
});

test('rebooking accepts a new order ID, even with a smaller version number', () => {
  const second = { orderId: 'b', orderVersion: 1, status: 'MATCHING' };
  assert.equal(reconcileOrder({ orderId: 'a', orderVersion: 5, status: 'CANCELED' }, second), second);
});

test('drivers can progress the trip and passengers cannot cancel after boarding', () => {
  assert.equal(orderActions('driver', 'ASSIGNED')[0][0], 'arrive');
  assert.equal(orderActions('driver', 'ARRIVED')[0][0], 'start');
  assert.equal(orderActions('driver', 'IN_PROGRESS')[0][0], 'finish');
  assert.deepEqual(orderActions('passenger', 'IN_PROGRESS'), []);
  assert.equal(orderActions('passenger', 'ARRIVED')[0][0], 'cancel');
});
