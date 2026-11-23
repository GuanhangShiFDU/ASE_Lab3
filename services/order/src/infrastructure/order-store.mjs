import { randomUUID } from 'node:crypto';
import { conflict, isActive } from '../domain/order.mjs';

export async function initializeOrderStore(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id CHAR(36) PRIMARY KEY,
      active_passenger_id VARCHAR(32) COLLATE utf8mb4_bin NULL UNIQUE,
      active_driver_id VARCHAR(32) COLLATE utf8mb4_bin NULL UNIQUE,
      snapshot JSON NOT NULL
    ) ENGINE=InnoDB`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_requests (
      actor_role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      actor_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_hash CHAR(64) CHARACTER SET ascii NOT NULL,
      response JSON NULL,
      PRIMARY KEY(actor_role, actor_id, request_key)
    ) ENGINE=InnoDB`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_outbox (
      sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      event_id CHAR(36) NOT NULL UNIQUE,
      order_id CHAR(36) NOT NULL,
      order_version INT UNSIGNED NOT NULL,
      payload JSON NOT NULL,
      published_at DATETIME(3) NULL,
      UNIQUE KEY order_version_unique (order_id, order_version),
      KEY pending_events (published_at, sequence)
    ) ENGINE=InnoDB`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_driver_releases (
      order_id CHAR(36) PRIMARY KEY,
      driver_id VARCHAR(32) NOT NULL,
      completed_at DATETIME(3) NULL,
      KEY pending_releases (completed_at, order_id)
    ) ENGINE=InnoDB`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_background_retries (
      task_type ENUM('release','delivery') NOT NULL,
      task_id CHAR(36) NOT NULL,
      attempts INT UNSIGNED NOT NULL,
      next_attempt_at DATETIME(3) NOT NULL,
      last_error VARCHAR(64) NOT NULL,
      PRIMARY KEY (task_type, task_id)
    ) ENGINE=InnoDB`);
  // Reconcile terminal orders written before automatic release existed.
  await pool.query(`
    INSERT INTO order_driver_releases (order_id, driver_id)
    SELECT id, JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.driverId')) FROM orders
    WHERE JSON_TYPE(JSON_EXTRACT(snapshot, '$.driverId')) = 'STRING'
      AND JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.status')) IN ('CANCELED','COMPLETED')
    ON DUPLICATE KEY UPDATE order_id = order_driver_releases.order_id`);
}

async function findOrder(connection, orderId, locked) {
  const [[row]] = await connection.execute(
    `SELECT snapshot FROM orders WHERE id = ?${locked ? ' FOR UPDATE' : ''}`, [orderId]);
  return row?.snapshot;
}

async function saveOrder(connection, order, previous) {
  const snapshot = JSON.stringify(order);
  const active = isActive(order);
  const passenger = active ? order.passengerId : null;
  const driver = active ? order.driverId : null;

  try {
    if (previous) {
      await connection.execute(
        'UPDATE orders SET snapshot = ?, active_passenger_id = ?, active_driver_id = ? WHERE id = ?',
        [snapshot, passenger, driver, order.orderId]);
    } else {
      await connection.execute(
        'INSERT INTO orders (snapshot, active_passenger_id, active_driver_id, id) VALUES (?, ?, ?, ?)',
        [snapshot, passenger, driver, order.orderId]);
    }
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw conflict('Passenger or driver already has an active order');
    throw error;
  }

  const event = {
    eventId: randomUUID(), type: 'OrderSnapshotChanged', schemaVersion: 1,
    orderId: order.orderId, orderVersion: order.orderVersion, occurredAt: order.updatedAt,
    snapshot: order,
  };
  await connection.execute(
    'INSERT INTO order_outbox (event_id, order_id, order_version, payload) VALUES (?, ?, ?, ?)',
    [event.eventId, event.orderId, event.orderVersion, JSON.stringify(event)]);

  if (order.driverId && ['CANCELED', 'COMPLETED'].includes(order.status)) {
    await connection.execute(
      'INSERT INTO order_driver_releases (order_id, driver_id) VALUES (?, ?)',
      [order.orderId, order.driverId]);
  }
}

export function createOrderStore(pool) {
  return {
    find: id => findOrder(pool, id, false),
    async matching(after) {
      const [rows] = await pool.execute(
        `SELECT id, snapshot FROM orders
         WHERE id > ? AND JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.status')) = 'MATCHING'
         ORDER BY id LIMIT 100`, [after]);
      return { orders: rows.map(row => row.snapshot), nextCursor: rows.length === 100 ? rows.at(-1).id : null };
    },
    async runCommand({ actor, key, hash }, operation) {
      const connection = await pool.getConnection();
      const identity = [actor.role, actor.id, key];
      try {
        await connection.beginTransaction();
        await connection.execute(`
          INSERT INTO order_requests (actor_role, actor_id, request_key, request_hash)
          VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE request_key = request_key`,
        [...identity, hash]);
        const [[request]] = await connection.execute(`
          SELECT request_hash, response FROM order_requests
          WHERE actor_role = ? AND actor_id = ? AND request_key = ? FOR UPDATE`, identity);
        if (request.request_hash !== hash) throw conflict('Idempotency-Key already used for another request');

        let result = request.response;
        if (!result) {
          result = await operation({
            findForUpdate: id => findOrder(connection, id, true),
            save: (order, previous) => saveOrder(connection, order, previous),
          });
          await connection.execute(`
            UPDATE order_requests SET response = ?
            WHERE actor_role = ? AND actor_id = ? AND request_key = ?`,
          [JSON.stringify(result), ...identity]);
        }
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
