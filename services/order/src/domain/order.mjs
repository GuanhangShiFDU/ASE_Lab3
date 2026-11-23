export class OrderError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const invalid = message => new OrderError(400, 'INVALID_REQUEST', message);
export const conflict = message => new OrderError(409, 'STATE_CONFLICT', message);
export const forbidden = () => new OrderError(403, 'FORBIDDEN', 'Actor does not own this order');
export const isActive = order => !['COMPLETED', 'CANCELED', 'MATCH_FAILED'].includes(order.status);

export function parsePlace(value) {
  if (!value || typeof value.label !== 'string' || !value.label.trim() ||
      value.label.trim().length > 120 || !Number.isFinite(value.longitude) ||
      !Number.isFinite(value.latitude) || value.longitude < 120.8 ||
      value.longitude > 122.2 || value.latitude < 30.6 || value.latitude > 31.9) {
    throw invalid('Location requires a label and coordinates in the Shanghai demo area');
  }
  return { label: value.label.trim(), longitude: value.longitude, latitude: value.latitude };
}

export function estimate(pickup, dropoff) {
  const rad = degrees => degrees * Math.PI / 180;
  const dy = rad(dropoff.latitude - pickup.latitude);
  const dx = rad(dropoff.longitude - pickup.longitude);
  const squaredHalfChord = Math.sin(dy / 2) ** 2 +
    Math.cos(rad(pickup.latitude)) * Math.cos(rad(dropoff.latitude)) * Math.sin(dx / 2) ** 2;
  const estimatedDistanceMeters = Math.round(12742000 * Math.asin(Math.sqrt(squaredHalfChord)));
  if (estimatedDistanceMeters === 0) throw invalid('Pickup and dropoff must differ');
  return {
    estimatedDistanceMeters,
    estimatedFareCents: 1200 + Math.round(250 * estimatedDistanceMeters / 1000),
  };
}

export function newOrder({ orderId, passengerId, pickup, dropoff, now }) {
  return {
    orderId, passengerId, driverId: null, pickup, dropoff, ...estimate(pickup, dropoff),
    status: 'MATCHING', orderVersion: 1, createdAt: now, updatedAt: now,
    assignedAt: null, arrivedAt: null, startedAt: null, finishedAt: null,
    canceledAt: null, matchFailedAt: null, distanceMeters: null, fareCents: null,
  };
}

const transitions = {
  assign: { from: ['MATCHING'], to: 'ASSIGNED', time: 'assignedAt' },
  'match-failed': { from: ['MATCHING'], to: 'MATCH_FAILED', time: 'matchFailedAt' },
  cancel: { from: ['MATCHING', 'ASSIGNED', 'ARRIVED'], to: 'CANCELED', time: 'canceledAt' },
  arrive: { from: ['ASSIGNED'], to: 'ARRIVED', time: 'arrivedAt' },
  start: { from: ['ARRIVED'], to: 'IN_PROGRESS', time: 'startedAt' },
  finish: { from: ['IN_PROGRESS'], to: 'COMPLETED', time: 'finishedAt' },
};

export function advanceOrder(order, command, actor, data, now) {
  const rule = transitions[command];

  if (command === 'assign' || command === 'match-failed') {
    if (actor.role !== 'internal') throw forbidden();
  } else if (command === 'cancel') {
    if (actor.role !== 'passenger' || actor.id !== order.passengerId) throw forbidden();
  } else if (actor.role !== 'driver' || actor.id !== order.driverId) {
    throw forbidden();
  }

  // A repeated action with a new key keeps the original state transition and timestamp.
  if (command === 'assign' && order.driverId === data.driverId &&
      ['ASSIGNED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'].includes(order.status)) return order;
  if (command !== 'assign' && order[rule.time] &&
      !(['arrive', 'start'].includes(command) && order.status === 'CANCELED')) return order;

  if (!rule.from.includes(order.status)) throw conflict(`Cannot ${command} while ${order.status}`);

  const next = {
    ...order, status: rule.to, [rule.time]: now, updatedAt: now, orderVersion: order.orderVersion + 1,
  };
  if (command === 'assign') next.driverId = data.driverId;
  if (command === 'finish') {
    next.distanceMeters = order.estimatedDistanceMeters;
    next.fareCents = order.estimatedFareCents;
  }
  return next;
}
