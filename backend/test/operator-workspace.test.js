import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createApp } from '../src/app.js';

test('operator workspace pagination, filters, gate lookup, and private inventory', async t => {
  const store = await createStore();
  const server = createApp(store, { secret: 'operator-workspace-tests' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, token, method = 'GET', body) {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() };
  }
  const login = async role => (await request('/auth/demo', null, 'POST', { role })).data.token;
  const operator = await login('OPERATOR'), driver = await login('DRIVER');
  const another = await request('/auth/register', null, 'POST', { name: 'Other Operator', email: 'other.op@example.com', password: 'OperatorTest123', role: 'OPERATOR' });
  const foreign = another.data.token;
  await store.transaction(null, async tx => {
    for (let i = 0; i < 250; i++) await tx.insert('bookings', { id: `PE-WORK${String(i).padStart(4, '0')}`, userId: 'driver-demo', facilityId: i % 2 ? 'palika' : 'cp-central', slotId: i % 2 ? 'palika-25' : 'cp-central-1', vehicle: `DL TEST ${i}`, status: i % 3 ? 'COMPLETED' : 'CANCELLED', startAt: '2026-01-02T01:00:00.000Z', endAt: '2026-01-02T02:00:00.000Z', total: i, baseTotal: i, membershipTier: 'STANDARD', paymentStatus: 'SIMULATED', createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
    await tx.insert('facilities', { ...(await tx.get('facilities', 'cp-central')), id: 'foreign-lot', name: 'Other Owner Facility', operatorId: another.data.user.id });
    await tx.insert('bookings', { id: 'PE-FOREIGN', userId: 'driver-demo', facilityId: 'foreign-lot', slotId: 'cp-central-2', vehicle: 'FOREIGN CAR', status: 'COMPLETED', startAt: '2026-01-02T01:00:00.000Z', endAt: '2026-01-02T02:00:00.000Z', total: 9999, baseTotal: 9999, paymentStatus: 'SIMULATED', createdAt: '2026-01-03T01:00:00.000Z' });
  });
  await t.test('only operators can access scoped views and cannot access admin resources', async () => {
    assert.equal((await request('/operator/overview')).status, 401);
    assert.equal((await request('/operator/manage/facilities', driver)).status, 403);
    assert.equal((await request('/operator/manage/people', operator)).status, 403);
    assert.equal((await request('/admin/manage/reservations', operator)).status, 403);
    assert.equal((await request('/operator/manage/reservations?pageSize=1000', operator)).status, 400);
  });
  await t.test('250 reservations are paginated without duplicates or foreign data', async () => {
    const first = (await request('/operator/manage/reservations?pageSize=10&sort=amount', operator)).data;
    const second = (await request('/operator/manage/reservations?page=2&pageSize=10&sort=amount', operator)).data;
    assert.equal(first.total, 250); assert.equal(first.pages, 25); assert.equal(first.items.length, 10); assert.equal(first.items[0].total, 249);
    assert.ok(second.items.every(row => !first.items.some(other => other.id === row.id)));
    assert.ok(first.items.every(row => row.id !== 'PE-FOREIGN'));
    const other = (await request('/operator/manage/reservations', foreign)).data;
    assert.equal(other.total, 1); assert.equal(other.items[0].id, 'PE-FOREIGN');
    assert.equal((await request('/operator/manage/reservations?facilityId=foreign-lot', operator)).data.total, 0);
  });
  await t.test('status, facility, vehicle, search, and local date filters work together', async () => {
    const bike = (await request('/operator/manage/reservations?vehicleType=BIKE&facilityId=palika&q=WORK&from=2026-01-02&to=2026-01-02&timezoneOffset=-330&pageSize=25', operator)).data;
    assert.equal(bike.total, 125); assert.equal(bike.items.length, 25); assert.ok(bike.items.every(row => row.slot.vehicleType === 'BIKE' && row.facilityId === 'palika'));
    assert.equal((await request('/operator/manage/reservations?vehicleType=EV', operator)).data.total, 0);
    assert.equal((await request('/operator/manage/reservations?q=WORK0001&status=COMPLETED', operator)).data.total, 1);
    assert.equal((await request('/operator/manage/reservations?from=2026-01-03', operator)).data.total, 0);
  });
  await t.test('overview, options, and gate lookup include only owned records', async () => {
    const overview = (await request('/operator/overview', operator)).data;
    assert.equal(overview.reservations, 250); assert.equal(overview.facilities, 13); assert.equal(overview.approvedFacilities, 12);
    const facilities = (await request('/operator/facility-options', operator)).data;
    assert.equal(facilities.length, 13); assert.ok(facilities.every(f => Object.keys(f).sort().join(',') === 'id,name'));
    assert.equal((await request('/operator/reservations/pe-work0001', operator)).status, 200);
    assert.equal((await request('/operator/reservations/PE-FOREIGN', operator)).status, 404);
    assert.equal((await request('/operator/reservations/PE-WORK0001', foreign)).status, 404);
    const rows = (await request('/operator/manage/facilities?pageSize=5', operator)).data;
    assert.equal(rows.total, 13); assert.equal(rows.items.length, 5); assert.ok(rows.items.every(f => f.bayCount === 36));
  });
  await t.test('private inventory supports pending facilities and correct vehicle types while protecting ownership', async () => {
    const bikes = await request('/manage/facilities/cp-central/slots?vehicleType=BIKE', operator);
    assert.equal(bikes.status, 200); assert.equal(bikes.data.length, 8); assert.ok(bikes.data.every(s => s.vehicleType === 'BIKE'));
    assert.equal((await request('/manage/facilities/saket/slots?vehicleType=EV', operator)).data.length, 4);
    assert.equal((await request('/manage/facilities/cp-central/slots', foreign)).status, 404);
    assert.equal((await request('/manage/facilities/cp-central/slots', driver)).status, 403);
    assert.equal((await request('/manage/facilities/cp-central/slots?vehicleType=TRUCK', operator)).status, 400);
  });
  await t.test('occupied and future-reserved bays cannot be marked for maintenance', async () => {
    await store.transaction(null, async tx => {
      await tx.insert('bookings', { id: 'PE-OCCUPIED', userId: 'driver-demo', facilityId: 'cp-central', slotId: 'cp-central-25', vehicle: 'TEST BIKE', status: 'ACTIVE', startAt: '2026-01-02T01:00:00.000Z', endAt: '2026-01-02T02:00:00.000Z', total: 20, paymentStatus: 'SIMULATED', createdAt: '2026-01-01T00:00:00.000Z' });
      await tx.insert('bookings', { id: 'PE-FUTURE', userId: 'driver-demo', facilityId: 'cp-central', slotId: 'cp-central-26', vehicle: 'TEST BIKE', status: 'CONFIRMED', startAt: new Date(Date.now() + 3600000).toISOString(), endAt: new Date(Date.now() + 7200000).toISOString(), total: 20, paymentStatus: 'SIMULATED', createdAt: new Date().toISOString() });
    });
    const bikes = (await request('/manage/facilities/cp-central/slots?vehicleType=BIKE', operator)).data;
    assert.equal(bikes.find(s => s.id === 'cp-central-25').status, 'RESERVED');
    assert.equal(bikes.find(s => s.id === 'cp-central-26').status, 'RESERVED');
    assert.equal((await request('/manage/slots/cp-central-25', operator, 'PATCH', { blocked: true })).status, 409);
    assert.equal((await request('/manage/slots/cp-central-26', operator, 'PATCH', { blocked: true })).status, 409);
    assert.equal((await request('/manage/slots/cp-central-27', operator, 'PATCH', { blocked: true })).status, 200);
    assert.equal((await request('/manage/slots/cp-central-27', operator, 'PATCH', { blocked: false })).status, 200);
    assert.equal((await request('/manage/slots/cp-central-27', foreign, 'PATCH', { blocked: true })).status, 403);
  });
});
