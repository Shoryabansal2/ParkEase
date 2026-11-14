import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore, testMysqlConfig } from './test-store.js';

test('MySQL additive setup preserves data and can run twice', { skip: process.env.PARKEASE_TEST_MYSQL !== 'true' }, async t => {
  const store = await createStore(), config = await testMysqlConfig();
  t.after(() => store.close());
  const conn = await mysql.createConnection({ ...config, database: store.testDatabase });
  try { await conn.query('DROP TABLE notificationReads'); await conn.query('DROP TABLE parkingNotes'); await conn.query('ALTER TABLE bookings DROP COLUMN cancelledAt'); } finally { await conn.end(); }
  await store.transaction(null, tx => tx.update('facilities', 'cp-central', { rate: 73 }));
  const before = (await store.all('slots')).length;
  for (let i = 0; i < 2; i++) {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../src/setup-db.js', import.meta.url))], { env: { ...process.env, DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user, DB_PASSWORD: config.password, DB_NAME: store.testDatabase, DEMO_MODE: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = ''; child.stdout.on('data', d => text += d); child.stderr.on('data', d => text += d); child.on('error', reject); child.on('exit', code => code === 0 ? resolve(text) : reject(new Error(`Setup failed (${code}): ${text}`)));
    });
    assert.match(output, /Existing data was preserved/);
  }
  assert.equal((await store.get('facilities', 'cp-central')).rate, 73);
  assert.equal((await store.all('slots')).length, before);
  assert.deepEqual(await store.all('notificationReads'), []); assert.deepEqual(await store.all('parkingNotes'), []);
});
