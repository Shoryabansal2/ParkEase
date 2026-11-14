import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { seedData } from '../src/seed.js';
import { bookingBounds, clampWindow } from '../../frontend/components/booking-window.mjs';

test('booking calendar bounds reflect the tier and clamp the last-day time', () => {
  const now = new Date(2026, 10, 13, 12, 0, 0).getTime();
  const standard = bookingBounds(24, now), vip = bookingBounds(168, now);
  assert.equal(standard.minDate, '2026-11-13'); assert.equal(standard.maxDate, '2026-11-14');
  assert.equal(vip.maxDate, '2026-11-20');
  assert.deepEqual(clampWindow('2026-11-20', '18:00', 24, now), { date: '2026-11-14', time: '12:00' });
  assert.deepEqual(clampWindow('2026-11-20', '18:00', 168, now), { date: '2026-11-20', time: '12:00' });
  assert.deepEqual(clampWindow('2026-11-13', '10:00', 24, now), { date: '2026-11-13', time: '12:00' });
  assert.deepEqual(clampWindow('2026-11-19', '23:00', 168, now), { date: '2026-11-19', time: '23:00' });
});

test('operator registration and facility approval preserve access boundaries', async t => {
  const store = await createStore();
  const server = createApp(store, { secret: 'operator-test-only' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function req(path, method = 'GET', body, token) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const fields = { name: 'Test Facility Operator', email: 'owner@example.com', password: 'OperatorTest123', role: 'OPERATOR' };
  const registered = await req('/auth/register', 'POST', fields);
  assert.equal(registered.status, 201); assert.equal(registered.data.user.role, 'OPERATOR');
  const operator = registered.data.token;
  assert.equal((await req('/auth/login', 'POST', { email: fields.email, password: fields.password, role: 'OPERATOR' })).status, 200);
  assert.equal((await req('/auth/login', 'POST', { email: fields.email, password: fields.password, role: 'DRIVER' })).status, 403);
  assert.equal((await req('/admin/users', 'GET', null, operator)).status, 403);
  assert.deepEqual((await req('/manage/facilities', 'GET', null, operator)).data, []);
  const facility = await req('/manage/facilities', 'POST', { name: 'Green Park Demo Facility', address: 'Green Park Extension, New Delhi 110016', lat: 28.558, lng: 77.206, rate: 45, covered: true, ev: true, status: 'APPROVED', operatorId: 'operator-demo' }, operator);
  assert.equal(facility.status, 201); assert.equal(facility.data.status, 'PENDING'); assert.equal(facility.data.operatorId, registered.data.user.id);
  const id = facility.data.id;
  const query = new URLSearchParams({ startAt: new Date(Date.now() + 3 * 3600000).toISOString(), endAt: new Date(Date.now() + 5 * 3600000).toISOString() });
  assert.ok(!(await req(`/facilities?${query}`)).data.some(f => f.id === id));
  assert.equal((await req(`/manage/facilities/${id}`, 'PATCH', { status: 'APPROVED' }, operator)).status, 403);
  assert.equal((await req('/manage/facilities/cp-central', 'PATCH', { rate: 5 }, operator)).status, 403);
  const admin = (await req('/auth/login', 'POST', { email: 'admin@parkease.com', password: 'ParkEase@123' })).data.token;
  assert.equal((await req(`/manage/facilities/${id}`, 'PATCH', { status: 'APPROVED' }, admin)).status, 200);
  assert.ok((await req(`/facilities?${query}`)).data.some(f => f.id === id));
  assert.equal((await req(`/facilities/${id}/slots?${query}`)).data.length, 20);
  assert.equal((await req(`/manage/facilities/${id}`, 'PATCH', { rate: 50 }, operator)).status, 200);
  assert.equal((await req('/manage/facilities', 'GET', null, operator)).data.length, 1);
  assert.deepEqual((await req('/bookings', 'GET', null, operator)).data, []);
});

test('new demo locations merge without resetting previous bookings and prices', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'parkease-catalog-'));
  const file = join(dir, 'demo.json');
  t.after(async () => { await unlink(file); await rmdir(dir); });
  const data = await seedData();
  const originalIds = new Set(['cp-central', 'palika', 'janpath', 'shivaji', 'saket']);
  data.facilities = data.facilities.filter(f => originalIds.has(f.id));
  data.slots = data.slots.filter(s => originalIds.has(s.facilityId));
  data.facilities[0].rate = 99;
  data.bookings = [{ id: 'preserved-booking', userId: 'driver-demo', facilityId: 'cp-central', slotId: 'cp-central-1', status: 'CONFIRMED' }];
  await writeFile(file, JSON.stringify(data));
  const store = await createStore({ file });
  assert.equal((await store.all('facilities')).filter(f => f.status === 'APPROVED').length, 12);
  assert.equal((await store.get('facilities', 'cp-central')).rate, 99);
  assert.equal((await store.get('bookings', 'preserved-booking')).status, 'CONFIRMED');
  const slotCount = (await store.all('slots')).length;
  assert.equal((await store.all('slots')).filter(s => s.facilityId === 'cp-central' && !s.retired).length, 58);
  assert.equal((await store.all('slots')).filter(s => s.facilityId === 'palika' && !s.retired).length, 78);
  const reopened = await createStore({ file });
  assert.equal((await reopened.all('facilities')).length, 13);
  assert.equal((await reopened.all('slots')).length, slotCount);
});
