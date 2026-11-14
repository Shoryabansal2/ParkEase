import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './test-store.js';
import { createApp } from '../src/app.js';
import { varyDemoCapacity } from '../src/capacity.js';
import { makeSlots } from '../src/catalog.js';
import { TEST_PAYMENT_DETAILS } from '../../shared/payment-validation.mjs';

test('custom facility capacity, reservation protection, removal and restoration', async t => {
  const store = await createStore(), server = createApp(store, { secret: 'capacity-integration-secret' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const req = async (path, token, method = 'GET', body) => { const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; };
  const operator = (await req('/auth/demo', null, 'POST', { role: 'OPERATOR' })).data.token, driver = (await req('/auth/demo', null, 'POST', { role: 'DRIVER' })).data.token;
  const admin = (await req('/auth/login', null, 'POST', { email: 'admin@parkease.com', password: 'ParkEase@123' })).data.token;
  const foreign = (await req('/auth/register', null, 'POST', { name: 'Capacity Operator', email: 'capacity.other@example.com', password: 'CapacityTest123', role: 'OPERATOR' })).data.token;
  const fields = { name: 'Custom Capacity Parking', address: 'College Avenue, New Delhi 110001', lat: 28.6, lng: 77.2, rate: 40, covered: true, ev: true };
  const startAt = new Date(Date.now() + 3600000).toISOString(), endAt = new Date(Date.now() + 7200000).toISOString(), window = new URLSearchParams({ startAt, endAt, vehicleType: 'CAR' });
  const pay = { method: 'UPI', outcome: 'SUCCESS', expectedAmount: 50, details: TEST_PAYMENT_DETAILS.UPI };
  let facility, bookedSlot, booking;
  await t.test('creation validates explicit per-type counts and exposes the right inventory', async () => {
    for (const capacity of [{ CAR: 0, BIKE: 0, EV: 0 }, { CAR: -1, BIKE: 2, EV: 1 }, { CAR: 1.5, BIKE: 2, EV: 1 }, { CAR: 500, BIKE: 1, EV: 0 }]) assert.equal((await req('/manage/facilities', operator, 'POST', { ...fields, capacity })).status, 400);
    const created = await req('/manage/facilities', operator, 'POST', { ...fields, capacity: { CAR: 3, BIKE: 2, EV: 1 } }); assert.equal(created.status, 201); facility = created.data;
    const row = (await req('/operator/manage/facilities?q=Custom%20Capacity', operator)).data.items[0]; assert.equal(row.bayCount, 6); assert.deepEqual(row.capacity, { CAR: 3, BIKE: 2, EV: 1 });
    assert.equal((await req(`/manage/facilities/${facility.id}`, admin, 'PATCH', { status: 'APPROVED' })).status, 200);
    const slots = (await req(`/facilities/${facility.id}/slots?${window}`)).data; assert.equal(slots.length, 3); bookedSlot = slots[0];
    booking = (await req('/bookings', driver, 'POST', { slotId: bookedSlot.id, vehicle: 'DL TEST 1234', startAt, endAt, payment: pay })).data; assert.ok(booking.id);
  });
  await t.test('growth adds real bays, reductions preserve reservations and validate ownership', async () => {
    const path = `/manage/facilities/${facility.id}`;
    assert.equal((await req(path, foreign, 'PATCH', { capacity: { CAR: 9, BIKE: 0, EV: 0 } })).status, 403);
    assert.equal((await req(path, operator, 'PATCH', { capacity: { CAR: 5, BIKE: 2, EV: 1 } })).status, 200);
    assert.equal((await req(`/facilities/${facility.id}/slots?${window}`)).data.length, 5);
    assert.equal((await req(path, operator, 'PATCH', { capacity: { CAR: 0, BIKE: 2, EV: 1 } })).status, 409);
    assert.equal((await req(path, operator, 'PATCH', { capacity: { CAR: 1, BIKE: 2, EV: 1 } })).status, 200);
    const left = (await req(`/facilities/${facility.id}/slots?${window}`)).data; assert.equal(left.length, 1); assert.equal(left[0].id, bookedSlot.id);
    const retired = (await store.all('slots')).find(s => s.facilityId === facility.id && s.retired);
    assert.equal((await req('/bookings', driver, 'POST', { slotId: retired.id, vehicle: 'DL TEST 9999', startAt, endAt, payment: pay })).status, 409);
  });
  await t.test('listing removal checks permissions, typed confirmation and live reservations', async () => {
    const path = `/manage/facilities/${facility.id}/remove`;
    assert.equal((await req(path, driver, 'POST', { confirmName: facility.name })).status, 403);
    assert.equal((await req(path, foreign, 'POST', { confirmName: facility.name })).status, 404);
    assert.equal((await req(path, operator, 'POST', { confirmName: 'wrong' })).status, 400);
    assert.equal((await req(path, operator, 'POST', { confirmName: facility.name })).status, 409);
    assert.equal((await req(`/bookings/${booking.id}/check-in`, operator, 'POST')).status, 200);
    assert.equal((await req(path, operator, 'POST', { confirmName: facility.name })).status, 409);
    assert.equal((await req(`/bookings/${booking.id}/check-out`, operator, 'POST')).status, 200);
    assert.equal((await req(path, operator, 'POST', { confirmName: facility.name })).status, 200);
    assert.ok(!(await req(`/facilities?${window}`)).data.some(f => f.id === facility.id));
    assert.equal((await req(`/facilities/${facility.id}/slots?${window}`)).status, 404);
    assert.equal((await req(`/facilities/${facility.id}/quote?${window}`)).status, 404);
    assert.ok((await req('/bookings', driver)).data.some(b => b.id === booking.id && b.slot.id === bookedSlot.id));
    const removed = (await req('/operator/manage/facilities?status=REMOVED', operator)).data.items.find(f => f.id === facility.id); assert.equal(removed.status, 'REMOVED');
    assert.equal((await req(`/manage/facilities/${facility.id}`, operator, 'PATCH', { rate: 20 })).status, 409);
  });
  await t.test('restoration requires new approval and retains historical slot records', async () => {
    const restored = await req(`/manage/facilities/${facility.id}/restore`, operator, 'POST'); assert.equal(restored.status, 200); assert.equal(restored.data.status, 'PENDING');
    assert.equal((await req(`/facilities/${facility.id}/slots?${window}`)).status, 404);
    assert.equal((await req(`/manage/facilities/${facility.id}`, operator, 'PATCH', { capacity: { CAR: 0, BIKE: 1, EV: 0 } })).status, 200);
    assert.equal((await store.get('slots', bookedSlot.id)).retired, 1); assert.ok(await store.get('bookings', booking.id));
  });
  await t.test('concurrent removal and checkout cannot both succeed', async () => {
    const f = (await req('/manage/facilities', operator, 'POST', { ...fields, name: 'Concurrent Capacity Parking', capacity: { CAR: 1, BIKE: 0, EV: 0 } })).data;
    await req(`/manage/facilities/${f.id}`, admin, 'PATCH', { status: 'APPROVED' });
    const slot = (await req(`/facilities/${f.id}/slots?${window}`)).data[0];
    const [purchase, removal] = await Promise.all([req('/bookings', driver, 'POST', { slotId: slot.id, vehicle: 'DL RACE 1234', startAt, endAt, payment: pay }), req(`/manage/facilities/${f.id}/remove`, operator, 'POST', { confirmName: f.name })]);
    assert.ok((purchase.status === 201 && removal.status === 409) || (purchase.status === 409 && removal.status === 200));
  });
});

test('demo variation preserves booked bays, names and statuses and runs once', () => {
  const facility = { id: 'palika', operatorId: 'operator-demo', name: 'My renamed parking', status: 'SUSPENDED' };
  const data = { facilities: [facility], slots: makeSlots([facility]), bookings: [{ slotId: 'palika-36', status: 'CONFIRMED' }] };
  varyDemoCapacity(data); assert.equal(data.slots.find(s => s.id === 'palika-36').retired, undefined); assert.equal(facility.name, 'My renamed parking'); assert.equal(facility.status, 'SUSPENDED');
  const snapshot = JSON.stringify(data); varyDemoCapacity(data); assert.equal(JSON.stringify(data), snapshot);
});
