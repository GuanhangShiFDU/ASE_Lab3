const stateFields = 'a.id, a.display_name, s.online, s.order_id';
const joins = 'FROM driver_state s JOIN demo_accounts a ON a.id = s.driver_id';
const view = row => row ? {
  driverId: row.id,
  displayName: row.display_name,
  online: Boolean(row.online),
  available: Boolean(row.online) && row.order_id === null,
  currentOrderId: row.order_id,
} : null;

export async function initializeDriverStore(pool) {
  // Earlier development volumes loaded these UTF-8 literals through a latin1 client.
  // Repair only the exact old seed values, preserving any edited names.
  for (const [id, name] of [
    ['passenger-1', '乘客一'], ['passenger-2', '乘客二'],
    ['driver-1', '司机一'], ['driver-2', '司机二'],
  ]) {
    await pool.execute(
      'UPDATE demo_accounts SET display_name = ? WHERE id = ? AND BINARY display_name = BINARY CONVERT(CONVERT(? USING latin1) USING utf8mb4)',
      [name, id, Buffer.from(name, 'utf8')]);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_state (
      driver_id VARCHAR(32) PRIMARY KEY,
      online BOOLEAN NOT NULL DEFAULT FALSE,
      order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL UNIQUE,
      FOREIGN KEY (driver_id) REFERENCES demo_accounts(id)
    ) ENGINE=InnoDB`);
  await pool.query(`
    INSERT INTO driver_state (driver_id)
    SELECT id FROM demo_accounts WHERE role = 'driver'
    ON DUPLICATE KEY UPDATE driver_id = driver_state.driver_id`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_order_releases (
      driver_id VARCHAR(32) NOT NULL,
      order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      PRIMARY KEY (driver_id, order_id),
      FOREIGN KEY (driver_id) REFERENCES driver_state(driver_id)
    ) ENGINE=InnoDB`);
}

async function getDriver(db, id, locked = false) {
  const [[row]] = await db.execute(
    `SELECT ${stateFields} ${joins} WHERE s.driver_id = ?${locked ? ' FOR UPDATE' : ''}`, [id]);
  return view(row);
}

function stateWith(driver, online, currentOrderId) {
  return { ...driver, online, available: online && currentOrderId === null, currentOrderId };
}

export function createDriverStore(pool) {
  async function change(id, operation) {
    const db = await pool.getConnection();
    try {
      await db.beginTransaction();
      const driver = await getDriver(db, id, true);
      const result = driver ? await operation(db, driver) : null;
      await db.commit();
      return result;
    } catch (error) {
      await db.rollback();
      throw error;
    } finally {
      db.release();
    }
  }

  return {
    async account(id) {
      const [[row]] = await pool.execute(
        'SELECT id, role, display_name FROM demo_accounts WHERE id = ?', [id]);
      return row ? { id: row.id, role: row.role, displayName: row.display_name } : null;
    },
    get: id => getDriver(pool, id),
    async available() {
      const [rows] = await pool.query(
        `SELECT ${stateFields} ${joins} WHERE s.online AND s.order_id IS NULL ORDER BY s.driver_id`);
      return rows.map(view);
    },
    setOnline: (id, online) => change(id, async (db, driver) => {
      await db.execute('UPDATE driver_state SET online = ? WHERE driver_id = ?', [online, id]);
      return stateWith(driver, online, driver.currentOrderId);
    }),
    reserve: (id, orderId) => change(id, async (db, driver) => {
      if (driver.currentOrderId === orderId) return { driver };
      const [[released]] = await db.execute(
        'SELECT 1 AS found FROM driver_order_releases WHERE driver_id = ? AND order_id = ?', [id, orderId]);
      if (released) return { conflict: 'This reservation has already been released' };
      if (!driver.available) return { conflict: 'Driver is offline or already occupied' };
      try {
        await db.execute('UPDATE driver_state SET order_id = ? WHERE driver_id = ?', [orderId, id]);
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        return { conflict: 'Order already occupies another driver' };
      }
      return { driver: stateWith(driver, true, orderId) };
    }),
    release: (id, orderId) => change(id, async (db, driver) => {
      await db.execute(`
        INSERT INTO driver_order_releases (driver_id, order_id) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE order_id = driver_order_releases.order_id`, [id, orderId]);
      if (driver.currentOrderId !== orderId) return { released: false, driver };
      await db.execute('UPDATE driver_state SET order_id = NULL WHERE driver_id = ? AND order_id = ?', [id, orderId]);
      return { released: true, driver: stateWith(driver, driver.online, null) };
    }),
  };
}
