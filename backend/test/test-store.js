import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createStore as createStorage } from '../src/store.js';
import { seedData } from '../src/seed.js';

export async function testMysqlConfig() {
  if (process.env.PARKEASE_MYSQL_TEST_CONFIG) return JSON.parse(await readFile(process.env.PARKEASE_MYSQL_TEST_CONFIG, 'utf8'));
  return { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' };
}
export async function createStore(options = {}) {
  if (process.env.PARKEASE_TEST_MYSQL !== 'true' || options.file) return createStorage(options);
  const config = await testMysqlConfig(), database = `parkease_verify_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const control = await mysql.createConnection(config);
  await control.query(`CREATE DATABASE \`${database}\``);
  await control.changeUser({ database });
  try {
    for (const statement of (await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8')).split(';').filter(s => s.trim())) await control.query(statement);
    const seed = await seedData();
    for (const table of ['users', 'facilities', 'slots']) for (const row of seed[table]) {
      const keys = Object.keys(row); await control.execute(`INSERT INTO \`${table}\` (${keys.map(k => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(row));
    }
    const store = await createStorage({ driver: 'mysql', mysqlConfig: { ...config, database } });
    let closed = false;
    return { ...store, testDatabase: database, async close() { if (closed) return; closed = true; await store.close(); if (!/^parkease_verify_[a-f0-9]{18}$/.test(database)) throw new Error('Unsafe test database name.'); await control.query(`DROP DATABASE \`${database}\``); await control.end(); } };
  } catch (e) { await control.query(`DROP DATABASE \`${database}\``); await control.end(); throw e; }
}
