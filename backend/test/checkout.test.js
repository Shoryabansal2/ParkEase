import { TEST_PAYMENT_DETAILS } from '../../shared/payment-validation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { nextBillingMonth } from '../src/payment.js';

test('minute-based bookings and atomic simulated checkout', async t => {
  const store = await createStore();
  const server = createApp(store, { secret: 'checkout-test-secret', demoMode: true }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const driver = (await (await fetch(`${base}/auth/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'DRIVER' }) })).json()).token;
  async function request(path, body, method = 'POST') {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${driver}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const startAt = new Date(Date.now() + 4 * 3600000).toISOString();
  const endAt = new Date(Date.parse(startAt) + 30 * 60000).toISOString();
  const body = { slotId: 'cp-central-1', vehicle: 'DL 01 TEST 1234', startAt, endAt };
  const paid = (amount, method = 'UPI') => ({ method, outcome: 'SUCCESS', expectedAmount: amount, details: TEST_PAYMENT_DETAILS[method] });
  let booking;
  await t.test('missing, failed, and price-mismatched payments create neither bookings nor receipts', async () => {
    assert.equal((await request('/bookings', body)).status, 400);
    assert.equal((await request('/bookings', { ...body, payment: { method: 'UPI', outcome: 'FAILED', expectedAmount: 30, details: TEST_PAYMENT_DETAILS.UPI } })).status, 402);
    assert.equal((await request('/bookings', { ...body, payment: paid(1) })).status, 409);
    assert.equal((await store.all('bookings')).length, 0);
    assert.equal((await store.all('payments')).length, 0);
  });
  await t.test('a 30-minute booking is prorated and stores the selected payment method', async () => {
    const r = await request('/bookings', { ...body, payment: paid(30, 'CARD') });
    assert.equal(r.status, 201); booking = r.data;
    assert.equal(booking.baseTotal, 20); assert.equal(booking.total, 30);
    assert.equal(booking.payments[0].method, 'CARD'); assert.equal(booking.payments[0].amount, 30);
    const overlap = new URLSearchParams({ startAt: new Date(Date.parse(startAt) + 15 * 60000).toISOString(), endAt: new Date(Date.parse(startAt) + 45 * 60000).toISOString(), vehicleType: 'CAR' });
    const slots = (await request(`/facilities/cp-central/slots?${overlap}`, null, 'GET')).data;
    assert.equal(slots.find(s => s.id === body.slotId).status, 'RESERVED');
    const adjacent = { ...body, startAt: endAt, endAt: new Date(Date.parse(endAt) + 30 * 60000).toISOString() };
    assert.equal((await request('/bookings', { ...adjacent, payment: paid(30) })).status, 201);
    assert.equal((await request('/bookings', { ...body, slotId: 'cp-central-2', endAt: new Date(Date.parse(startAt) + 10 * 60000).toISOString(), payment: paid(10) })).status, 400);
  });
  await t.test('VIP costs 999 per calendar month and activates only after successful checkout', async () => {
    assert.equal((await request('/membership/activate', {})).status, 400);
    assert.equal((await request('/membership/activate', { payment: { method: 'UPI', outcome: 'FAILED', expectedAmount: 999, details: TEST_PAYMENT_DETAILS.UPI } })).status, 402);
    assert.equal((await request('/auth/me', null, 'GET')).data.membership.tier, 'STANDARD');
    assert.equal((await request('/membership/activate', { payment: paid(0) })).status, 409);
    const r = await request('/membership/activate', { payment: paid(999), price: 0 });
    assert.equal(r.status, 200); assert.equal(r.data.price, 999); assert.equal(r.data.billingPeriod, 'MONTH');
    assert.equal((await store.all('payments')).find(p => p.purpose === 'MEMBERSHIP').amount, 999);
    assert.equal(nextBillingMonth(new Date('2027-01-31T09:30:00.000Z')), '2027-02-28T09:30:00.000Z');
    assert.equal(nextBillingMonth(new Date('2028-01-31T09:30:00.000Z')), '2028-02-29T09:30:00.000Z');
  });
  await t.test('VIP discount and payment amounts remain correct for 30-minute extensions', async () => {
    const vip = (await request('/bookings', { ...body, slotId: 'cp-central-3', payment: paid(16) })).data;
    assert.equal(vip.total, 16); assert.equal(vip.discountAmount, 4);
    const extend = { hours: 0.5, expectedEndAt: vip.endAt };
    const before = (await store.all('payments')).length;
    assert.equal((await request(`/bookings/${vip.id}/extend`, { ...extend, payment: { method: 'CARD', outcome: 'FAILED', details: TEST_PAYMENT_DETAILS.CARD } })).status, 402);
    assert.equal((await store.get('bookings', vip.id)).endAt, vip.endAt);
    assert.equal((await store.all('payments')).length, before);
    const success = await request(`/bookings/${vip.id}/extend`, { ...extend, payment: paid(16) });
    assert.equal(success.status, 200); assert.equal(success.data.total, 32); assert.equal(success.data.baseTotal, 40); assert.equal(success.data.discountAmount, 8);
    assert.equal(success.data.payments.find(p => p.purpose === 'EXTENSION').amount, 16);
    const cancelled = await request(`/bookings/${vip.id}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.ok(cancelled.data.payments.every(p => p.status === 'SIMULATED_VOIDED'));
  });
  await t.test('two simultaneous checkouts cannot double-book or create duplicate payments', async () => {
    const next = { ...body, slotId: 'cp-central-4', payment: paid(16) };
    const before = (await store.all('payments')).length;
    const results = await Promise.all([request('/bookings', next), request('/bookings', next)]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal((await store.all('payments')).length, before + 1);
  });
});
