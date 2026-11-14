import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { seedData } from './seed.js';
import { extraFacilities, makeSlots } from './catalog.js';
import { varyDemoCapacity } from './capacity.js';

const tables = new Set(['users', 'facilities', 'slots', 'bookings', 'evAlerts', 'supportTickets', 'payments', 'auditLogs', 'pricingRules']);
const checkTable = name => { if (!tables.has(name)) throw new Error('Unknown table'); return name; };
export async function createStore({ driver = 'demo', file = null } = {}) {
  if (file instanceof URL) file = fileURLToPath(file);
  if (driver === 'mysql') {
    const pool = mysql.createPool({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'parkease', connectionLimit: 10, decimalNumbers: true });
    await pool.query('SELECT 1');
    const repo = conn => ({
      async all(table) { return (await conn.query(`SELECT * FROM \`${checkTable(table)}\``))[0]; },
      async get(table, id) { return (await conn.execute(`SELECT * FROM \`${checkTable(table)}\` WHERE id = ?`, [id]))[0][0]; },
      async insert(table, row) { const keys = Object.keys(row); await conn.execute(`INSERT INTO \`${checkTable(table)}\` (${keys.map(k => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(row)); return row; },
      async update(table, id, patch) { const keys = Object.keys(patch); await conn.execute(`UPDATE \`${checkTable(table)}\` SET ${keys.map(k => `\`${k}\` = ?`).join(',')} WHERE id = ?`, [...Object.values(patch), id]); return this.get(table, id); }
    });
    return { ...repo(pool), driver, async transaction(slotId, action) { const conn = await pool.getConnection(); try { await conn.beginTransaction(); if (slotId) { const lock = typeof slotId === 'object' ? slotId : { table: 'slots', id: slotId }; await conn.execute(`SELECT id FROM \`${checkTable(lock.table)}\` WHERE id = ? FOR UPDATE`, [lock.id]); } const result = await action(repo(conn)); await conn.commit(); return result; } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); } }, close: () => pool.end() };
  }
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (file && e.code !== 'ENOENT') throw e; data = await seedData(); }
  let queue = Promise.resolve();
  data.evAlerts ||= [];
  data.supportTickets ||= [];
  data.payments ||= [];
  data.auditLogs ||= [];
  data.pricingRules ||= [];
  // Add new demo locations without overwriting existing facility states or bookings.
  if (data.users.some(u => u.id === 'operator-demo')) {
    for (const f of extraFacilities) if (!data.facilities.some(existing => existing.id === f.id)) data.facilities.push(structuredClone(f));
    for (const s of makeSlots(extraFacilities)) if (!data.slots.some(existing => existing.id === s.id)) data.slots.push(s);
  }
  varyDemoCapacity(data);
  const persist = async () => { if (file) { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2)); await rename(`${file}.tmp`, file); } };
  await persist();
  const repo = {
    async all(table) { return structuredClone(data[checkTable(table)]); },
    async get(table, id) { return structuredClone(data[checkTable(table)].find(r => r.id === id)); },
    async insert(table, row) { data[checkTable(table)].push(structuredClone(row)); return structuredClone(row); },
    async update(table, id, patch) { const row = data[checkTable(table)].find(r => r.id === id); if (!row) return undefined; Object.assign(row, patch); return structuredClone(row); }
  };
  return { ...repo, driver, transaction(slotId, action) { const next = queue.then(async () => { const backup = structuredClone(data); try { const result = await action(repo); await persist(); return result; } catch (e) { data = backup; throw e; } }); queue = next.catch(() => {}); return next; }, async close() {} };
}
