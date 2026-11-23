import { randomUUID } from 'node:crypto';

export async function initialize(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_matches (
      order_id CHAR(36) PRIMARY KEY,
      deadline BIGINT NOT NULL,
      phase ENUM('OPEN','FAILING','CLOSED') NOT NULL DEFAULT 'OPEN',
      KEY open_matches (phase, deadline)
    ) ENGINE=InnoDB`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_offers (
      id CHAR(36) PRIMARY KEY,
      order_id CHAR(36) NOT NULL,
      driver_id VARCHAR(32) NOT NULL,
      expires_at BIGINT NOT NULL,
      snapshot JSON NOT NULL,
      status ENUM('PENDING','ACCEPTING','ACCEPTED','REJECTED','EXPIRED','VOID') NOT NULL,
      active_order CHAR(36) AS (IF(status IN ('PENDING','ACCEPTING'),order_id,NULL)) STORED UNIQUE,
      UNIQUE KEY attempted_driver (order_id, driver_id),
      KEY driver_inbox (driver_id, status, expires_at),
      FOREIGN KEY (order_id) REFERENCES dispatch_matches(order_id)
    ) ENGINE=InnoDB`);
}

export const packOffer = row => ({
  offerId: row.id, orderId: row.order_id, driverId: row.driver_id,
  expiresAt: new Date(row.expires_at).toISOString(), status: row.status,
  pickup: row.snapshot.pickup, dropoff: row.snapshot.dropoff,
  estimatedFareCents: row.snapshot.estimatedFareCents,
});

export function createStore(pool) {
  return {
    async discover(orders, matchMs) {
      for (const order of orders) {
        await pool.execute(
          'INSERT INTO dispatch_matches (order_id, deadline) VALUES (?, ?) ON DUPLICATE KEY UPDATE order_id = order_id',
          [order.orderId, new Date(order.createdAt).getTime() + matchMs]);
      }
    },
    async work() {
      // Open matches are few in the lab. Reading the whole work set avoids starving later IDs.
      const [rows] = await pool.query("SELECT * FROM dispatch_matches WHERE phase != 'CLOSED' ORDER BY deadline, order_id");
      return rows;
    },
    async offers(orderId) {
      const [rows] = await pool.execute('SELECT * FROM dispatch_offers WHERE order_id = ?', [orderId]);
      return rows;
    },
    async sendOffer(order, driverId, expiry) {
      await pool.execute(`
        INSERT INTO dispatch_offers (id, order_id, driver_id, expires_at, snapshot, status)
        VALUES (?, ?, ?, ?, ?, 'PENDING') ON DUPLICATE KEY UPDATE id = id`,
      [randomUUID(), order.orderId, driverId, expiry, JSON.stringify(order)]);
    },
    async expire(orderId, now) {
      await pool.execute(`
        UPDATE dispatch_offers SET status = 'EXPIRED'
        WHERE order_id = ? AND status = 'PENDING' AND expires_at <= ?`, [orderId, now]);
    },
    async finishOffer(id, status) {
      await pool.execute("UPDATE dispatch_offers SET status = ? WHERE id = ? AND status = 'ACCEPTING'", [status, id]);
    },
    async markFailing(id) {
      await pool.execute("UPDATE dispatch_matches SET phase = 'FAILING' WHERE order_id = ? AND phase = 'OPEN'", [id]);
    },
    async close(id) {
      // Do not overwrite ongoing acceptance: its reservation must be reconciled first.
      await pool.execute("UPDATE dispatch_offers SET status = 'VOID' WHERE order_id = ? AND status = 'PENDING'", [id]);
      await pool.execute(`
        UPDATE dispatch_matches SET phase = 'CLOSED' WHERE order_id = ?
        AND NOT EXISTS (SELECT 1 FROM dispatch_offers WHERE order_id = ? AND status = 'ACCEPTING')`, [id, id]);
    },
    async inbox(driverId, now) {
      const [rows] = await pool.execute(`
        SELECT * FROM dispatch_offers WHERE driver_id = ?
        AND (status = 'ACCEPTING' OR (status = 'PENDING' AND expires_at > ?))
        ORDER BY expires_at, id`, [driverId, now]);
      return rows.map(packOffer);
    },
    async find(id) {
      const [[row]] = await pool.execute('SELECT * FROM dispatch_offers WHERE id = ?', [id]);
      return row;
    },
    async respond(id, driverId, action) {
      await pool.execute(`
        UPDATE dispatch_offers SET status = ? WHERE id = ? AND driver_id = ?
        AND status = 'PENDING' AND expires_at > UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000`,
      [action === 'accept' ? 'ACCEPTING' : 'REJECTED', id, driverId]);
      const [[row]] = await pool.execute('SELECT * FROM dispatch_offers WHERE id = ?', [id]);
      return row;
    },
  };
}
