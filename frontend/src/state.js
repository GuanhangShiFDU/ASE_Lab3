export const terminal = status => ['COMPLETED', 'CANCELED', 'MATCH_FAILED'].includes(status);

export function reconcileOrder(previous, incoming) {
  if (!incoming) return previous;
  if (!previous || incoming.orderId !== previous.orderId) return incoming;
  if (incoming.orderVersion < previous.orderVersion) return previous;
  return { ...previous, ...incoming };
}

export function orderActions(role, status) {
  if (role === 'passenger' && ['MATCHING', 'ASSIGNED', 'ARRIVED'].includes(status)) {
    return [['cancel', '取消订单']];
  }
  if (role === 'driver') {
    if (status === 'ASSIGNED') return [['arrive', '已到达上车点']];
    if (status === 'ARRIVED') return [['start', '乘客已上车，开始行程']];
    if (status === 'IN_PROGRESS') return [['finish', '结束行程']];
  }
  return [];
}
