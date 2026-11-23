const releaseTasks = {
  kind: 'release',
  select: `
    SELECT j.order_id AS id, j.order_id, j.driver_id, COALESCE(r.attempts, 0) AS attempts
    FROM order_driver_releases j
    LEFT JOIN order_background_retries r ON r.task_type = 'release' AND r.task_id = j.order_id
    WHERE j.completed_at IS NULL AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= UTC_TIMESTAMP(3))
    ORDER BY j.order_id LIMIT 20`,
  acknowledge: 'UPDATE order_driver_releases SET completed_at = UTC_TIMESTAMP(3) WHERE order_id = ?',
  path: task => `/internal/drivers/${task.driver_id}/release`,
  payload: task => ({ orderId: task.order_id }),
};

const deliveryTasks = {
  kind: 'delivery',
  select: `
    SELECT o.event_id AS id, o.order_id, o.payload, COALESCE(r.attempts, 0) AS attempts
    FROM order_outbox o
    LEFT JOIN order_background_retries r ON r.task_type = 'delivery' AND r.task_id = o.event_id
    WHERE o.published_at IS NULL AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= UTC_TIMESTAMP(3))
    ORDER BY o.sequence LIMIT 20`,
  acknowledge: 'UPDATE order_outbox SET published_at = UTC_TIMESTAMP(3) WHERE event_id = ?',
  path: () => '/internal/order-events',
  payload: task => task.payload,
};

async function attempt(database, config, endpoint, token, task) {
  try {
    const response = await fetch(new URL(config.path(task), endpoint), {
      method: 'POST',
      signal: AbortSignal.timeout(1500),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(config.payload(task)),
    });
    await response.body?.cancel();
    if (!response.ok) throw Error(`HTTP_${response.status}`);
    // A crash before this write simply replays the same idempotent request.
    await database.execute(config.acknowledge, [task.id]);
    await database.execute('DELETE FROM order_background_retries WHERE task_type = ? AND task_id = ?',
      [config.kind, task.id]);
    console.info('[order-worker]', config.kind, 'done', task.order_id, task.id);
  } catch (cause) {
    const attempts = task.attempts + 1;
    const seconds = Math.min(30, 2 ** Math.min(attempts - 1, 5));
    const reason = String(cause.code ?? (cause.message?.startsWith('HTTP_') ? cause.message : cause.name)).slice(0, 64);
    await database.execute(`
      INSERT INTO order_background_retries (task_type, task_id, attempts, next_attempt_at, last_error)
      VALUES (?, ?, ?, TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3)), ?)
      AS retry ON DUPLICATE KEY UPDATE attempts = retry.attempts,
        next_attempt_at = retry.next_attempt_at, last_error = retry.last_error`,
    [config.kind, task.id, attempts, seconds, reason]);
    console.warn('[order-worker]', config.kind, 'retry', task.order_id, task.id, attempts, reason);
  }
}

function launch(database, config, endpoint, token) {
  async function tick() {
    try {
      const [tasks] = await database.query(config.select);
      // Bounded parallelism prevents slow requests from holding an entire batch.
      for (let i = 0; i < tasks.length; i += 5) {
        const outcomes = await Promise.allSettled(
          tasks.slice(i, i + 5).map(task => attempt(database, config, endpoint, token, task)));
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') console.error('[order-worker]', config.kind, outcome.reason.code ?? outcome.reason.name);
        }
      }
    } catch (cause) {
      console.error('[order-worker]', config.kind, cause.code ?? cause.name);
    } finally {
      setTimeout(tick, 500);
    }
  }
  void tick();
}

export function startOrderWorkers(database, environment) {
  const token = environment.LAB3_INTERNAL_TOKEN;
  launch(database, releaseTasks, environment.DRIVER_URL ?? 'http://driver:3000', token);
  launch(database, deliveryTasks, environment.ORDER_QUERY_URL ?? 'http://order-query:3000', token);
}
