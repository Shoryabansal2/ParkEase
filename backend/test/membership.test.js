import { TEST_PAYMENT_DETAILS } from '../../shared/payment-validation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './test-store.js';
import { createApp } from '../src/app.js';
import { membership, cancellationDeadline } from '../src/membership.js';

test('membership policies, persistence, and demo services', async t => {
  const store = await createStore();
  const app = createApp(store, { secret: 'membership-test-only', demoMode: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, token, method = 'GET', body) {
    if (method === 'POST' && (path === '/bookings' || path === '/membership/activate' || /\/bookings\/[^/]+\/extend$/.test(path)) && body && body.payment === undefined) body = { ...body, payment: { method: 'CARD', outcome: 'SUCCESS', details: TEST_PAYMENT_DETAILS.CARD } };
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const driver = (await request('/auth/demo', null, 'POST', { role: 'DRIVER' })).data.token;
  const admin = (await request('/auth/login', null, 'POST', { email: 'admin@parkease.com', password: 'ParkEase@123' })).data.token;
  const operator = (await request('/auth/demo', null, 'POST', { role: 'OPERATOR' })).data.token;
  const at = hours => new Date(Date.now() + hours * 3600000).toISOString();
  const book = (slotId, startHours = 4, duration = 2, extras = {}) => request('/bookings', driver, 'POST', { slotId, vehicle: 'DL 01 VIP 1234', startAt: at(startHours), endAt: at(startHours + duration), ...extras });
  let standard, vipBooking, cancelledVip;
  await t.test('standard defaults and server enforcement resist client-supplied tier and price', async () => {
    assert.equal((await request('/auth/me', driver)).data.membership.tier, 'STANDARD');
    assert.equal((await book('cp-central-1', 25)).status, 400);
    const r = await book('cp-central-1', 4, 2, { membershipTier: 'PREMIUM', total: 1, discountAmount: 100 });
    assert.equal(r.status, 201); standard = r.data;
    assert.equal(standard.total, 90); assert.equal(standard.discountAmount, 0); assert.equal(standard.accessPass, 'STANDARD');
    assert.equal((await book('cp-central-35')).status, 403);
    assert.equal((await request('/membership/ev-alerts', driver, 'POST', { facilityId: 'cp-central', startAt: at(6), endAt: at(8) })).status, 403);
  });
  await t.test('activation is driver-only, bills one month, and cannot be stacked', async () => {
    assert.equal((await request('/membership/activate', operator, 'POST', {})).status, 403);
    const r = await request('/membership/activate', driver, 'POST', {});
    assert.equal(r.status, 200); assert.equal(r.data.payment, 'SIMULATED'); assert.equal(r.data.autoRenew, false);
    assert.equal(r.data.user.membership.tier, 'PREMIUM');
    assert.ok(Date.parse(r.data.user.membership.expiresAt) > Date.now() + 29 * 86400000);
    assert.equal((await request('/membership/activate', driver, 'POST', {})).status, 409);
    assert.equal((await request('/auth/me', driver)).data.membership.discountPercent, 20);
    const login = await request('/auth/login', null, 'POST', { email: 'driver@parkease.com', password: 'ParkEase@123' });
    assert.equal(login.data.user.membership.tier, 'PREMIUM');
  });
  await t.test('VIP receives seven-day bookings, 20 percent off and express pass; older bookings keep their policy', async () => {
    const r = await book('cp-central-2', 6 * 24);
    assert.equal(r.status, 201); vipBooking = r.data;
    assert.equal(vipBooking.total, 64); assert.equal(vipBooking.baseTotal, 80); assert.equal(vipBooking.discountAmount, 16); assert.equal(vipBooking.accessPass, 'EXPRESS');
    assert.equal((await book('cp-central-3', 169)).status, 400);
    const persisted = (await request('/bookings', driver)).data.find(b => b.id === standard.id);
    assert.equal(persisted.membershipTier, 'STANDARD');
    assert.equal(Date.parse(persisted.startAt) - Date.parse(persisted.cancellationDeadline), 120 * 60000);
  });
  await t.test('EV priority allocation and live in-app availability watches respect real reservations', async () => {
    const startAt = at(7), endAt = at(9);
    const params = new URLSearchParams({ startAt, endAt, vehicleType: 'EV' });
    const slots = (await request(`/facilities/cp-central/slots?${params}`, driver)).data;
    assert.equal(slots.filter(s => s.priority && s.status === 'AVAILABLE').length, 2);
    const publicSlots = (await request(`/facilities/cp-central/slots?${params}`)).data;
    assert.equal(publicSlots.filter(s => s.status === 'VIP_ONLY').length, 2);
    const body = { facilityId: 'cp-central', startAt, endAt };
    assert.equal((await request('/membership/ev-alerts', driver, 'POST', body)).status, 201);
    await request('/membership/ev-alerts', driver, 'POST', body);
    assert.equal((await request('/membership', driver)).data.alerts.length, 1);
    for (const slotId of ['cp-central-35', 'cp-central-36']) assert.equal((await book(slotId, 7, 2, { startAt, endAt })).status, 201);
    assert.equal((await request('/membership', driver)).data.alerts[0].available, 0);
    const ev = (await request('/bookings', driver)).data.find(b => b.slotId === 'cp-central-35');
    assert.equal((await request(`/bookings/${ev.id}/cancel`, driver, 'POST')).status, 200);
    assert.equal((await request('/membership', driver)).data.alerts[0].available, 1);
  });
  await t.test('cancellation cutoffs enforce standard two hours and VIP thirty minutes', async () => {
    assert.equal(Date.parse(vipBooking.startAt) - Date.parse(cancellationDeadline(vipBooking)), 30 * 60000);
    const earlyVip = (await book('cp-central-6', 1)).data;
    assert.equal((await request(`/bookings/${earlyVip.id}/cancel`, driver, 'POST')).status, 200); cancelledVip = earlyVip;
    const lateVip = (await book('cp-central-7', 0.25)).data;
    assert.equal((await request(`/bookings/${lateVip.id}/cancel`, driver, 'POST')).status, 409);
    const another = (await request('/auth/register', null, 'POST', { name: 'Standard Driver', email: 'standard@example.com', password: 'ExamplePass123' })).data.token;
    const close = await request('/bookings', another, 'POST', { slotId: 'cp-central-8', vehicle: 'DL 01 ABC 1234', startAt: at(1), endAt: at(3) });
    assert.equal(close.status, 201);
    assert.equal((await request(`/bookings/${close.data.id}/cancel`, another, 'POST')).status, 409);
  });
  await t.test('VIP extensions retain discounted price and savings ledger excludes cancelled reservations', async () => {
    const extended = await request(`/bookings/${vipBooking.id}/extend`, driver, 'POST', { hours: 1, expectedEndAt: vipBooking.endAt });
    assert.equal(extended.status, 200); assert.equal(extended.data.total, 96); assert.equal(extended.data.baseTotal, 120); assert.equal(extended.data.discountAmount, 24);
    const all = (await request('/bookings', driver)).data;
    const expected = all.filter(b => b.status !== 'CANCELLED').reduce((s, b) => s + b.discountAmount, 0);
    assert.equal((await request('/membership', driver)).data.savings, expected);
    assert.ok(all.find(b => b.id === cancelledVip.id).discountAmount > 0);
  });
  await t.test('support queue assigns VIP priority on server and is manageable only by admin', async () => {
    const r = await request('/support', driver, 'POST', { subject: 'Parking assistance', message: 'Please help with my booking.', priority: 'STANDARD' });
    assert.equal(r.status, 201); assert.equal(r.data.priority, 'PRIORITY');
    assert.equal((await request('/admin/support', driver)).status, 403);
    const queue = (await request('/admin/support', admin)).data;
    assert.equal(queue[0].id, r.data.id);
    assert.equal((await request(`/admin/support/${r.data.id}`, admin, 'PATCH', { status: 'RESOLVED' })).status, 200);
    assert.equal((await request('/membership', driver)).data.tickets[0].status, 'RESOLVED');
  });
  await t.test('expired subscriptions fall back to standard without changing existing VIP passes', async () => {
    await store.transaction(null, tx => tx.update('users', 'driver-demo', { membershipExpiresAt: new Date(Date.now() - 1000).toISOString() }));
    assert.equal((await request('/auth/me', driver)).data.membership.tier, 'STANDARD');
    assert.equal((await book('cp-central-9', 25)).status, 400);
    const current = (await request('/bookings', driver)).data.find(b => b.id === vipBooking.id);
    assert.equal(current.accessPass, 'EXPRESS'); assert.equal(current.membershipTier, 'PREMIUM');
    assert.equal(membership({ role: 'DRIVER', membershipTier: 'PREMIUM', membershipExpiresAt: new Date(1000).toISOString() }, 1000).tier, 'STANDARD');
  });
});
