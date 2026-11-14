import { TEST_PAYMENT_DETAILS } from '../../shared/payment-validation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './test-store.js';
import { createApp } from '../src/app.js';

test('ParkEase reservation lifecycle and access boundaries', async t => {
  const store = await createStore();
  const server = createApp(store, { secret: 'integration-test-secret', demoMode: true }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, { token, body, method = 'GET' } = {}) {
    if (method === 'POST' && (path === '/bookings' || path === '/membership/activate' || /\/bookings\/[^/]+\/extend$/.test(path)) && body && body.payment === undefined) body = { ...body, payment: { method: 'CARD', outcome: 'SUCCESS', details: TEST_PAYMENT_DETAILS.CARD } };
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const login = async role => (await request(role === 'ADMIN' ? '/auth/login' : '/auth/demo', { method: 'POST', body: role === 'ADMIN' ? { email: 'admin@parkease.com', password: 'ParkEase@123' } : { role } })).data.token;
  const driver = await login('DRIVER'), operator = await login('OPERATOR'), admin = await login('ADMIN');
  const startAt = new Date(Date.now() + 3 * 3600000).toISOString(), endAt = new Date(Date.now() + 5 * 3600000).toISOString();
  const window = new URLSearchParams({ startAt, endAt, vehicleType: 'CAR' });
  const body = { slotId: 'cp-central-1', vehicle: 'DL 01 AB 1234', startAt, endAt, total: 1 };
  let booking;

  await t.test('public search hides pending facilities and respects vehicle compatibility', async () => {
    const r = await request(`/facilities?${window}`);
    assert.equal(r.status, 200); assert.equal(r.data.length, 12);
    assert.ok(r.data.every(f => f.status === 'APPROVED'));
    assert.equal(r.data.find(f => f.id === 'cp-central').available, 38);
    const ev = await request(`/facilities/cp-central/slots?${new URLSearchParams({ startAt, endAt, vehicleType: 'EV' })}`);
    assert.equal(ev.data.length, 6); assert.ok(ev.data.every(s => s.vehicleType === 'EV'));
  });
  await t.test('unauthenticated and operator accounts cannot book', async () => {
    assert.equal((await request('/bookings', { method: 'POST', body })).status, 401);
    assert.equal((await request('/bookings', { method: 'POST', token: operator, body })).status, 403);
  });
  await t.test('concurrent conflicting reservations have exactly one winner, price is server-calculated', async () => {
    const results = await Promise.all([request('/bookings', { method: 'POST', token: driver, body }), request('/bookings', { method: 'POST', token: driver, body })]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    booking = results.find(r => r.status === 201).data;
    assert.equal(booking.total, 90); assert.equal(booking.status, 'CONFIRMED'); assert.equal(booking.paymentStatus, 'SIMULATED');
    const slots = await request(`/facilities/cp-central/slots?${window}`);
    assert.equal(slots.data.find(s => s.id === body.slotId).status, 'RESERVED');
  });
  await t.test('booking ownership, role gates, and facility ownership are enforced', async () => {
    assert.equal((await request('/auth/register', { method: 'POST', body: { name: 'Bad Admin', email: 'badadmin@example.com', password: 'ExamplePass123', role: 'ADMIN' } })).status, 400);
    const r = await request('/auth/register', { method: 'POST', body: { name: 'Another Driver', email: 'other@example.com', password: 'ExamplePass123', role: 'DRIVER' } });
    assert.equal(r.status, 201); assert.equal(r.data.user.role, 'DRIVER');
    assert.equal((await request(`/bookings/${booking.id}/cancel`, { method: 'POST', token: r.data.token })).status, 403);
    assert.equal((await request(`/bookings/${booking.id}/check-in`, { method: 'POST', token: driver })).status, 403);
    assert.equal((await request('/admin/users', { token: driver })).status, 403);
    assert.equal((await request('/manage/facilities/cp-central', { method: 'PATCH', token: operator, body: { status: 'SUSPENDED' } })).status, 403);
    assert.equal((await request('/bookings', { token: r.data.token })).data.length, 0);
    assert.equal((await request('/manage/slots/cp-central-1', { method: 'PATCH', token: operator, body: { blocked: true } })).status, 409);
  });
  await t.test('gate lifecycle rejects duplicate transitions and releases the bay on checkout', async () => {
    assert.equal((await request(`/bookings/${booking.id}/check-out`, { method: 'POST', token: operator })).status, 409);
    const checkedIn = await request(`/bookings/${booking.id}/check-in`, { method: 'POST', token: operator });
    assert.equal(checkedIn.data.status, 'ACTIVE'); assert.ok(checkedIn.data.checkedInAt);
    assert.equal((await request(`/bookings/${booking.id}/check-in`, { method: 'POST', token: operator })).status, 409);
    assert.equal((await request(`/bookings/${booking.id}/cancel`, { method: 'POST', token: driver })).status, 409);
    assert.equal((await request(`/bookings/${booking.id}/check-out`, { method: 'POST', token: operator })).data.status, 'COMPLETED');
    const slots = await request(`/facilities/cp-central/slots?${window}`);
    assert.equal(slots.data.find(s => s.id === body.slotId).status, 'AVAILABLE');
  });
  await t.test('extensions preserve pricing, reject overlaps, and protect against duplicate requests', async () => {
    const original = (await request('/bookings', { method: 'POST', token: driver, body: { ...body, slotId: 'cp-central-2' } })).data;
    const nextStart = new Date(Date.parse(endAt) + 3600000).toISOString();
    assert.equal((await request('/bookings', { method: 'POST', token: driver, body: { ...body, slotId: original.slotId, startAt: nextStart, endAt: new Date(Date.parse(nextStart) + 3600000).toISOString() } })).status, 201);
    const extendBody = { hours: 2, expectedEndAt: original.endAt };
    assert.equal((await request(`/bookings/${original.id}/extend`, { method: 'POST', token: driver, body: extendBody })).status, 409);
    assert.equal((await store.get('bookings', original.id)).endAt, original.endAt);
    assert.equal((await store.get('bookings', original.id)).total, 90);
    await request('/manage/facilities/cp-central', { method: 'PATCH', token: operator, body: { rate: 100 } });
    const results = await Promise.all([1, 2].map(() => request(`/bookings/${original.id}/extend`, { method: 'POST', token: driver, body: { hours: 1, expectedEndAt: original.endAt } })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const updated = results.find(r => r.status === 200).data;
    assert.equal(updated.endAt, nextStart); assert.equal(updated.total, 130); assert.equal(updated.id, original.id); assert.equal(updated.status, 'CONFIRMED');
    const addedWindow = new URLSearchParams({ startAt: original.endAt, endAt: nextStart, vehicleType: 'CAR' });
    assert.equal((await request(`/facilities/cp-central/slots?${addedWindow}`)).data.find(s => s.id === original.slotId).status, 'RESERVED');
    await request('/manage/facilities/cp-central', { method: 'PATCH', token: operator, body: { rate: 40 } });
  });
  await t.test('extension ownership, lifecycle, expiry, and maximum duration are enforced', async () => {
    const original = (await request('/bookings', { method: 'POST', token: driver, body: { ...body, slotId: 'cp-central-3' } })).data;
    const extendBody = { hours: 1, expectedEndAt: original.endAt };
    const other = (await request('/auth/login', { method: 'POST', body: { email: 'other@example.com', password: 'ExamplePass123' } })).data.token;
    assert.equal((await request(`/bookings/${original.id}/extend`, { method: 'POST', token: other, body: extendBody })).status, 403);
    assert.equal((await request(`/bookings/${original.id}/extend`, { method: 'POST', token: operator, body: extendBody })).status, 403);
    assert.equal((await request(`/bookings/${original.id}/extend`, { method: 'POST', token: driver, body: { ...extendBody, hours: -1 } })).status, 400);
    await request(`/bookings/${original.id}/check-in`, { method: 'POST', token: operator });
    const active = await request(`/bookings/${original.id}/extend`, { method: 'POST', token: driver, body: extendBody });
    assert.equal(active.status, 200); assert.equal(active.data.status, 'ACTIVE');
    await request(`/bookings/${original.id}/check-out`, { method: 'POST', token: operator });
    assert.equal((await request(`/bookings/${original.id}/extend`, { method: 'POST', token: driver, body: { hours: 1, expectedEndAt: active.data.endAt } })).status, 409);
    const maxEnd = new Date(Date.parse(startAt) + 23 * 3600000).toISOString();
    const long = (await request('/bookings', { method: 'POST', token: driver, body: { ...body, slotId: 'cp-central-4', endAt: maxEnd } })).data;
    assert.equal((await request(`/bookings/${long.id}/extend`, { method: 'POST', token: driver, body: { hours: 2, expectedEndAt: long.endAt } })).status, 400);
    await store.transaction(long.slotId, tx => tx.update('bookings', long.id, { endAt: new Date(Date.now() - 1000).toISOString() }));
    const expired = await store.get('bookings', long.id);
    assert.equal((await request(`/bookings/${long.id}/extend`, { method: 'POST', token: driver, body: { hours: 1, expectedEndAt: expired.endAt } })).status, 409);
  });
  await t.test('cancellation voids simulated payment and makes the space available', async () => {
    const r = await request('/bookings', { method: 'POST', token: driver, body });
    assert.equal(r.status, 201);
    const cancel = await request(`/bookings/${r.data.id}/cancel`, { method: 'POST', token: driver });
    assert.equal(cancel.data.status, 'CANCELLED'); assert.equal(cancel.data.paymentStatus, 'VOIDED');
    assert.equal((await request(`/facilities/cp-central/slots?${window}`)).data.find(s => s.id === body.slotId).status, 'AVAILABLE');
  });
  await t.test('invalid time windows, maintenance bays, and pending facilities cannot be booked', async () => {
    assert.equal((await request('/bookings', { method: 'POST', token: driver, body: { ...body, endAt: startAt } })).status, 400);
    assert.equal((await request('/bookings', { method: 'POST', token: driver, body: { ...body, startAt: 'bad-date' } })).status, 400);
    assert.equal((await request('/bookings', { method: 'POST', token: driver, body: { ...body, slotId: 'cp-central-5' } })).status, 409);
    assert.equal((await request('/bookings', { method: 'POST', token: driver, body: { ...body, slotId: 'saket-1' } })).status, 409);
  });
  await t.test('admin approval makes a facility discoverable', async () => {
    assert.equal((await request('/manage/facilities/saket', { method: 'PATCH', token: admin, body: { status: 'APPROVED' } })).status, 200);
    assert.equal((await request(`/facilities?${window}` )).data.length, 13);
    const u = await request('/admin/users', { token: admin });
    assert.ok(u.data.every(user => !('passwordHash' in user)));
  });
});
