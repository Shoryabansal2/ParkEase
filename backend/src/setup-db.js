import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { seedData } from './seed.js';
import { varyDemoCapacity } from './capacity.js';
const name = process.env.DB_NAME || 'parkease';
if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('DB_NAME may contain only letters, digits and underscores.');
const conn = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
try {
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
  await conn.changeUser({ database: name });
  for (const statement of (await readFile(new URL('./schema.sql', import.meta.url), 'utf8')).split(';').filter(s => s.trim())) await conn.query(statement);
  // Additive migration for existing installations. No users or bookings are reset.
  for (const [table, column, definition] of [
    ['facilities', 'capacityConfigured', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['facilities', 'removedAt', 'VARCHAR(30) NULL'],
    ['slots', 'retired', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['facilities', 'photoUrl', 'VARCHAR(255) NULL'],
    ['users', 'operatorTier', "VARCHAR(16) NOT NULL DEFAULT 'STANDARD'"],
    ['users', 'operatorExpiresAt', 'VARCHAR(30) NULL'],
    ['bookings', 'pricingSnapshot', 'TEXT NULL'],
    ['users', 'status', "VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'"],
    ['users', 'sessionVersion', 'INT NOT NULL DEFAULT 0'],
    ['users', 'createdAt', 'VARCHAR(30) NULL'],
    ['bookings', 'convenienceFee', 'DECIMAL(10,2) NOT NULL DEFAULT 0'],
    ['users', 'membershipTier', "VARCHAR(16) NOT NULL DEFAULT 'STANDARD'"],
    ['users', 'membershipExpiresAt', 'VARCHAR(30) NULL'],
    ['bookings', 'membershipTier', "VARCHAR(16) NOT NULL DEFAULT 'STANDARD'"],
    ['bookings', 'baseTotal', 'DECIMAL(10,2) NULL'],
    ['bookings', 'discountAmount', 'DECIMAL(10,2) NOT NULL DEFAULT 0']
  ]) {
    const [columns] = await conn.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
    if (!columns.length) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
  if (process.env.DEMO_MODE !== 'false') {
    const seed = await seedData();
    await conn.beginTransaction();
    try {
      for (const table of ['users', 'facilities', 'slots']) for (const row of seed[table]) {
        const keys = Object.keys(row);
        await conn.execute(`INSERT IGNORE INTO \`${table}\` (${keys.map(k => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(row));
      }
      const data = {};
      for (const table of ['facilities', 'slots', 'bookings']) data[table] = (await conn.query(`SELECT * FROM \`${table}\``))[0];
      const oldSlots = new Map(data.slots.map(s => [s.id, Number(s.retired || 0)])), configured = new Set(data.facilities.filter(f => f.capacityConfigured).map(f => f.id));
      varyDemoCapacity(data);
      for (const slot of data.slots) {
        if (!oldSlots.has(slot.id)) { const keys = Object.keys(slot); await conn.execute(`INSERT INTO slots (${keys.map(k => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(slot)); }
        else if (Number(slot.retired || 0) !== oldSlots.get(slot.id)) await conn.execute('UPDATE slots SET retired = ? WHERE id = ?', [slot.retired, slot.id]);
      }
      for (const f of data.facilities.filter(f => f.capacityConfigured && !configured.has(f.id))) await conn.execute('UPDATE facilities SET capacityConfigured = 1 WHERE id = ?', [f.id]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
  }
  console.log(`MySQL database ${name} is ready. Existing data was preserved.`);
} finally { await conn.end(); }
