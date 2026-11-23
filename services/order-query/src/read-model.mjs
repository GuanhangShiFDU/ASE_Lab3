const active = "('MATCHING','ASSIGNED','ARRIVED','IN_PROGRESS')";
const terminal = "('COMPLETED','CANCELED','MATCH_FAILED')";

export async function initializeReadModel(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_read_model (
      order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      order_version INT UNSIGNED NOT NULL,
      passenger_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      driver_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
      status VARCHAR(16) NOT NULL,
      updated_ms BIGINT NOT NULL,
      snapshot JSON NOT NULL,
      KEY passenger_orders (passenger_id, updated_ms DESC, order_id DESC),
      KEY driver_orders (driver_id, updated_ms DESC, order_id DESC)
    ) ENGINE=InnoDB`);
}

async function projectOne(pool, sequence) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[row]] = await connection.execute(`
      SELECT order_id, order_version, payload FROM order_event_inbox
      WHERE sequence = ? AND processed_at IS NULL FOR UPDATE`, [sequence]);
    if (row) {
      const snapshot = row.payload.snapshot;
      await connection.execute(`
        INSERT INTO order_read_model
          (order_id, passenger_id, driver_id, status, updated_ms, snapshot, order_version)
        VALUES (?, ?, ?, ?, ?, ?, ?) AS incoming
        ON DUPLICATE KEY UPDATE
          passenger_id = IF(incoming.order_version > order_read_model.order_version, incoming.passenger_id, order_read_model.passenger_id),
          driver_id = IF(incoming.order_version > order_read_model.order_version, incoming.driver_id, order_read_model.driver_id),
          status = IF(incoming.order_version > order_read_model.order_version, incoming.status, order_read_model.status),
          updated_ms = IF(incoming.order_version > order_read_model.order_version, incoming.updated_ms, order_read_model.updated_ms),
          snapshot = IF(incoming.order_version > order_read_model.order_version, incoming.snapshot, order_read_model.snapshot),
          order_version = GREATEST(incoming.order_version, order_read_model.order_version)`,
      [row.order_id, snapshot.passengerId, snapshot.driverId, snapshot.status,
        Date.parse(row.payload.occurredAt), JSON.stringify(snapshot), row.order_version]);
      await connection.execute(
        'UPDATE order_event_inbox SET processed_at = UTC_TIMESTAMP(3) WHERE sequence = ?', [sequence]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export function startProjector(pool) {
  let cursor = 0;
  async function tick() {
    try {
      const [rows] = await pool.execute(`
        SELECT sequence FROM order_event_inbox
        WHERE processed_at IS NULL AND sequence > ? ORDER BY sequence LIMIT 20`, [cursor]);
      for (const { sequence } of rows) {
        try {
          await projectOne(pool, sequence);
        } catch (error) {
          console.warn('[order-query] projection deferred', sequence, error.code ?? error.name);
        }
        cursor = sequence;
      }
      if (rows.length < 20) cursor = 0;
    } catch (error) {
      console.error('[order-query] projector deferred', error.code ?? error.name);
    } finally {
      setTimeout(tick, 250);
    }
  }
  void tick();
}

export function createReadModel(pool) {
  return {
    async find(id) {
      const [[row]] = await pool.execute('SELECT snapshot FROM order_read_model WHERE order_id = ?', [id]);
      return row?.snapshot ?? null;
    },
    async current(role, id) {
      const key = role === 'driver' ? 'driver_id' : 'passenger_id';
      const [[row]] = await pool.execute(`
        SELECT snapshot FROM order_read_model WHERE ${key} = ? AND status IN ${active}
        ORDER BY updated_ms DESC, order_id DESC LIMIT 1`, [id]);
      return row?.snapshot ?? null;
    },
    async history(id, limit, before) {
      const beforeClause = before ? 'AND (updated_ms < ? OR (updated_ms = ? AND order_id < ?))' : '';
      const [rows] = await pool.execute(`
        SELECT order_id, updated_ms, snapshot FROM order_read_model
        WHERE passenger_id = ? AND status IN ${terminal} ${beforeClause}
        ORDER BY updated_ms DESC, order_id DESC LIMIT ?`,
      before ? [id, before.time, before.time, before.id, limit + 1] : [id, limit + 1]);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        orders: page.map(row => row.snapshot),
        nextCursor: rows.length > limit ? `${last.updated_ms}:${last.order_id}` : null,
      };
    },
  };
}
