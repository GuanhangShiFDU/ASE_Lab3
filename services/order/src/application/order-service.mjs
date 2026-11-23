import { createHash, randomUUID } from 'node:crypto';
import { advanceOrder, estimate, forbidden, invalid, newOrder, OrderError, parsePlace } from '../domain/order.mjs';

const actorIdPattern = /^[a-zA-Z0-9_-]{1,32}$/;

export function estimateOrder(actor, data) {
  if (actor.role !== 'passenger') throw forbidden();
  return estimate(parsePlace(data.pickup), parsePlace(data.dropoff));
}

function commandData(command, payload) {
  if (command === 'create') {
    return { pickup: parsePlace(payload.pickup), dropoff: parsePlace(payload.dropoff) };
  }
  if (command === 'assign') {
    if (typeof payload.driverId !== 'string' || !actorIdPattern.test(payload.driverId)) {
      throw invalid('driverId is required');
    }
    return { driverId: payload.driverId };
  }
  return {};
}

export function createOrderService(store, clock = () => new Date().toISOString()) {
  return {
    estimate: estimateOrder,
    matching: after => store.matching(after),
    async getInternal(orderId) {
      const order = await store.find(orderId);
      if (!order) throw new OrderError(404, 'NOT_FOUND', 'Order not found');
      return order;
    },
    async execute({ actor, key, command, orderId = null, payload }) {
      if (command === 'create' && actor.role !== 'passenger') throw forbidden();
      if (typeof key !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) {
        throw invalid('Idempotency-Key must contain 1–128 ASCII letters, digits or . _ : -');
      }
      const data = commandData(command, payload);
      const hash = createHash('sha256').update(JSON.stringify([command, orderId, data])).digest('hex');
      return store.runCommand({ actor, key, hash }, async transaction => {
        const now = clock();
        if (command === 'create') {
          const order = newOrder({ ...data, orderId: randomUUID(), passengerId: actor.id, now });
          await transaction.save(order);
          return { status: 201, body: order };
        }

        const previous = await transaction.findForUpdate(orderId);
        if (!previous) throw new OrderError(404, 'NOT_FOUND', 'Order not found');

        const order = advanceOrder(previous, command, actor, data, now);
        if (order !== previous) await transaction.save(order, previous);
        return { status: 200, body: order };
      });
    },
  };
}
