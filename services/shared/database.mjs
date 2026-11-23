import mysql from 'mysql2/promise';

export function createDatabase() {
  return mysql.createPool({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectTimeout: 2000,
    connectionLimit: 5,
  });
}

export async function checkDatabase(database) {
  try {
    await database.query({ sql: 'SELECT 1', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}
