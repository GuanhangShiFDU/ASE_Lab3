class UpstreamError extends Error {
  constructor(status, resource) {
    super(`upstream ${resource} returned ${status}`);
    this.status = status;
  }
}

export function createPeers({ driverUrl, orderUrl, token }) {
  async function call(base, path, body, key) {
    const options = {
      signal: AbortSignal.timeout(1800),
      headers: { Authorization: `Bearer ${token}` },
    };
    if (body !== undefined) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      if (key) options.headers['Idempotency-Key'] = key;
      options.body = JSON.stringify(body);
    }
    const response = await fetch(new URL(path, base), options);
    if (!response.ok) throw new UpstreamError(response.status, path);
    return response.json();
  }
  const orderPath = id => `/internal/orders/${id}`;
  const driverPath = id => `/internal/drivers/${id}`;
  return {
    matching: cursor => call(orderUrl, `/internal/orders/matching?after=${cursor ?? ''}`),
    getOrder: id => call(orderUrl, orderPath(id)),
    candidates: async () => (await call(driverUrl, '/internal/drivers/available')).drivers,
    reserve: offer => call(driverUrl, `${driverPath(offer.driver_id)}/reserve`, { orderId: offer.order_id }),
    release: offer => call(driverUrl, `${driverPath(offer.driver_id)}/release`, { orderId: offer.order_id }),
    assign: offer => call(orderUrl, `${orderPath(offer.order_id)}/assign`,
      { driverId: offer.driver_id }, `dispatch:assign:${offer.id}`),
    fail: id => call(orderUrl, `${orderPath(id)}/match-failed`, {}, `dispatch:fail:${id}`),
  };
}

const confirmed = (order, offer) => order.driverId === offer.driver_id &&
  ['ASSIGNED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'].includes(order.status);

export function createMatcher({ store, peers, offerMs, matchMs, now = Date.now }) {
  let cursor = null;

  async function resolveUnmatched(offer, order) {
    if (confirmed(order, offer)) {
      await store.finishOffer(offer.id, 'ACCEPTED');
      return;
    }
    // A definitive non-matching snapshot proves this offer can no longer be assigned.
    await peers.release(offer);
    await store.finishOffer(offer.id, 'VOID');
  }

  async function accept(offer, order) {
    if (order.status !== 'MATCHING') return resolveUnmatched(offer, order);
    try {
      await peers.reserve(offer);
    } catch (error) {
      if (error.status !== 409) throw error;
      // An earlier confirmation may have succeeded before a process restart.
      const current = await peers.getOrder(offer.order_id);
      if (current.status !== 'MATCHING') return resolveUnmatched(offer, current);
      await store.finishOffer(offer.id, 'VOID');
      return;
    }
    try {
      await peers.assign(offer);
    } catch (error) {
      if (error.status !== 409) throw error;
      const current = await peers.getOrder(offer.order_id);
      // The 409 is definitive for this assignment. Release using the exact old order ID.
      return resolveUnmatched(offer, current);
    }
    await store.finishOffer(offer.id, 'ACCEPTED');
    await store.close(offer.order_id);
    console.info('[dispatch] accepted', offer.order_id, offer.driver_id, offer.id);
  }

  async function failMatch(id) {
    await store.markFailing(id);
    try {
      await peers.fail(id);
    } catch (error) {
      if (error.status !== 409 || (await peers.getOrder(id)).status === 'MATCHING') throw error;
    }
    await store.close(id);
    console.info('[dispatch] matching ended', id);
  }

  async function process(match) {
    const id = match.order_id;
    const order = await peers.getOrder(id);
    await store.expire(id, now());
    const offers = await store.offers(id);
    const accepting = offers.find(offer => offer.status === 'ACCEPTING');
    if (accepting) return accept(accepting, order);
    if (order.status !== 'MATCHING') return store.close(id);
    if (offers.some(offer => offer.status === 'PENDING')) return;
    if (match.phase === 'FAILING' || now() >= match.deadline) return failMatch(id);
    const attempted = new Set(offers.map(offer => offer.driver_id));
    const driver = (await peers.candidates()).find(candidate => !attempted.has(candidate.driverId));
    const time = now();
    if (!driver || time >= match.deadline) return failMatch(id);
    await store.sendOffer(order, driver.driverId, Math.min(time + offerMs, match.deadline));
    console.info('[dispatch] offered', id, driver.driverId);
  }

  return async function tick() {
    try {
      const page = await peers.matching(cursor);
      await store.discover(page.orders, matchMs);
      cursor = page.nextCursor;
    } catch (error) {
      console.warn('[dispatch] discovery deferred', error.message);
    }
    for (const match of await store.work()) {
      try {
        await process(match);
      } catch (error) {
        console.warn('[dispatch] retrying', match.order_id, error.message);
      }
    }
  };
}
