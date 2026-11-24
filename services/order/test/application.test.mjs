import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderService } from '../src/application/order-service.mjs';

const date = '2026-11-23T10:00:00.000Z';
const rider = { id: 'passenger-2', role: 'passenger' };
const driver = { id: 'driver-2', role: 'driver' };
const route = {
  pickup: { label: ' 人民广场 ', longitude: 121.475, latitude: 31.23 },
  dropoff: { label: '虹桥站', longitude: 121.327, latitude: 31.197 },
};

test('creating uses only the authenticated passenger and normalizes locations', async () => {
  const calls = [];
  const service = createOrderService({
    runCommand: async (request, action) => {
      calls.push(request);
      return action({ save: order => calls.push(order) });
    },
  }, () => date);
  const result = await service.execute({
    actor: rider, key: 'create-1', command: 'create',
    payload: { ...route, passengerId: 'someone-else', status: 'COMPLETED' },
  });
  assert.equal(result.status, 201);
  assert.equal(calls[0].actor, rider);
  assert.equal(calls[0].key, 'create-1');
  assert.equal(calls[1], result.body);
  assert.equal(result.body.passengerId, rider.id);
  assert.equal(result.body.status, 'MATCHING');
  assert.equal(result.body.orderVersion, 1);
  assert.equal(result.body.pickup.label, '人民广场');
  assert.equal(result.body.createdAt, date);
});

test('repeated start returns the existing snapshot without another write', async () => {
  const existing = { orderId: 'order-1', driverId: driver.id, status: 'IN_PROGRESS',
    startedAt: '2026-11-23T09:59:00.000Z', orderVersion: 4 };
  const service = createOrderService({
    runCommand: (_, action) => action({
      findForUpdate: id => {
        assert.equal(id, existing.orderId);
        return existing;
      },
      save: () => assert.fail('duplicate start should not write'),
    }),
  }, () => date);
  const result = await service.execute({
    actor: driver, key: 'second-start-key', command: 'start', orderId: existing.orderId, payload: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.body, existing);
});

test('an unknown order returns 404 before attempting a write', async () => {
  const service = createOrderService({
    runCommand: (_, action) => action({
      findForUpdate: () => undefined,
      save: () => assert.fail('unknown order should not write'),
    }),
  });
  await assert.rejects(service.execute({
    actor: rider, key: 'unknown-order', command: 'cancel', orderId: 'unknown', payload: {},
  }), { status: 404, code: 'NOT_FOUND' });
});
