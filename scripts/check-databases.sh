#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."

for service in order order-query driver dispatch; do
  docker compose exec -T "$service" node --input-type=module - <<'NODE'
import { createDatabase } from './shared/database.mjs';

const database = createDatabase();
const own = process.env.DB_NAME;
const schemas = ['lab3_order', 'lab3_order_query', 'lab3_driver', 'lab3_dispatch'];

try {
  const [[row]] = await database.query('SELECT DATABASE() AS name');
  if (row.name !== own) throw new Error(`Expected database ${own}, got ${row.name}`);

  for (const other of schemas.filter(schema => schema !== own)) {
    try {
      await database.query('USE ??', [other]);
      throw new Error(`${own} must not be granted access to ${other}`);
    } catch (error) {
      if (error.code !== 'ER_DBACCESS_DENIED_ERROR') throw error;
    }
  }

  if (own === 'lab3_driver') {
    const [rows] = await database.query('SELECT id, role FROM demo_accounts ORDER BY id');
    const accounts = new Map(rows.map(({ id, role }) => [id, role]));
    for (const role of ['passenger', 'driver']) {
      for (const number of [1, 2]) {
        const id = `${role}-${number}`;
        if (accounts.get(id) !== role) throw new Error(`Missing demo account ${id}`);
      }
    }
  }
  console.log(`OK ${own}`);
} finally {
  await database.end();
}
NODE
done
