import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './test-store.js';
import { createApp } from '../src/app.js';
import { TEST_PAYMENT_DETAILS, paymentErrors } from '../../shared/payment-validation.mjs';

test('administration, validated checkout, and fee accounting', async t => {
  const store = await createStore();
  const server = createApp(store, { secret: 'admin-console-tests' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, method = 'GET', body, token) {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() };
  }
  const signIn = async (email, password = 'ParkEase@123') => request('/auth/login', 'POST', { email, password });
  const admin = (await signIn('admin@parkease.com')).data.token;
  const driver = (await signIn('driver@parkease.com')).data.token;
  const pay = (expectedAmount, method = 'UPI', details = TEST_PAYMENT_DETAILS[method]) => ({ method, outcome: 'SUCCESS', expectedAmount, details });
  const startAt = new Date(Date.now() + 5 * 3600000).toISOString(), endAt = new Date(Date.parse(startAt) + 3600000).toISOString();
  const bookingBody = { slotId: 'cp-central-1', vehicle: 'DL 01 AB 1234', startAt, endAt };
  let booking;
  await t.test('admin requires credentials, is not self-registerable, and management endpoints are protected', async () => {
    assert.equal((await request('/auth/demo', 'POST', { role: 'ADMIN' })).status, 403);
    assert.equal((await signIn('admin@parkease.com', 'wrongpassword')).status, 401);
    assert.equal((await request('/auth/register', 'POST', { name: 'Another Admin', email: 'bad@example.com', password: 'Password123', role: 'ADMIN' })).status, 400);
    assert.equal((await request('/admin/overview')).status, 401);
    assert.equal((await request('/admin/manage/people', 'GET', null, driver)).status, 403);
    assert.equal((await request('/admin/users/driver-demo', 'PATCH', { status: 'SUSPENDED', reason: 'Invalid access' }, driver)).status, 403);
  });
  await t.test('malformed UPI/cards are rejected by the server without persisting instruments', async () => {
    for (const payment of [pay(50, 'UPI', { upi: 'invalid' }), pay(50, 'CARD', { ...TEST_PAYMENT_DETAILS.CARD, number: '4242 4242 4242 4241' }), pay(50, 'CARD', { ...TEST_PAYMENT_DETAILS.CARD, expiry: '01/20' }), pay(50, 'CARD', { ...TEST_PAYMENT_DETAILS.CARD, cvv: 'a12' })]) {
      assert.equal((await request('/bookings', 'POST', { ...bookingBody, payment }, driver)).status, 400);
    }
    assert.equal((await store.all('payments')).length, 0);
    assert.deepEqual(paymentErrors('UPI', TEST_PAYMENT_DETAILS.UPI), {});
    assert.deepEqual(paymentErrors('CARD', TEST_PAYMENT_DETAILS.CARD), {});
    const r = await request('/bookings', 'POST', { ...bookingBody, payment: pay(50, 'CARD'), convenienceFee: 0 }, driver);
    assert.equal(r.status, 201); booking = r.data;
    assert.equal(booking.baseTotal, 40); assert.equal(booking.convenienceFee, 10); assert.equal(booking.total, 50); assert.equal(booking.discountAmount, 0);
    const stored = JSON.stringify(await store.all('payments'));
    assert.ok(!stored.includes('4242')); assert.ok(!stored.includes('cvv')); assert.ok(!stored.includes('holder')); assert.ok(!stored.includes('upi'));
  });
  await t.test('Standard extensions charge parking only, keeping the original fee once', async () => {
    const r = await request(`/bookings/${booking.id}/extend`, 'POST', { hours: 0.5, expectedEndAt: booking.endAt, payment: pay(20) }, driver);
    assert.equal(r.status, 200); assert.equal(r.data.total, 70); assert.equal(r.data.baseTotal, 60); assert.equal(r.data.convenienceFee, 10); assert.equal(r.data.discountAmount, 0);
    assert.equal(r.data.payments.find(p => p.purpose === 'EXTENSION').amount, 20);
  });
  await t.test('server pagination remains bounded with 250 reservations and supports search/filter/sort', async () => {
    await store.transaction(null, async tx => { for (let i = 0; i < 250; i++) await tx.insert('bookings', { ...(await tx.get('bookings', booking.id)), id: `TEST-${String(i).padStart(4, '0')}`, status: i % 2 ? 'CANCELLED' : 'COMPLETED', total: i, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }); });
    const first = (await request('/admin/manage/reservations?page=1&pageSize=10&q=TEST&sort=amount', 'GET', null, admin)).data;
    const second = (await request('/admin/manage/reservations?page=2&pageSize=10&q=TEST&sort=amount', 'GET', null, admin)).data;
    assert.equal(first.total, 250); assert.equal(first.pages, 25); assert.equal(first.items.length, 10); assert.equal(first.items[0].total, 249);
    assert.ok(second.items.every(b => !first.items.some(a => a.id === b.id)));
    const filtered = (await request('/admin/manage/reservations?pageSize=5&q=TEST&status=COMPLETED', 'GET', null, admin)).data;
    assert.equal(filtered.total, 125); assert.equal(filtered.items.length, 5); assert.ok(filtered.items.every(b => b.status === 'COMPLETED'));
    assert.equal((await request('/admin/manage/reservations?pageSize=200', 'GET', null, admin)).status, 400);
    const people = (await request('/admin/manage/people?q=driver%40parkease&role=DRIVER', 'GET', null, admin)).data;
    assert.equal(people.total, 1); assert.ok(!JSON.stringify(people).includes('passwordHash'));
    assert.equal((await request('/admin/overview', 'GET', null, admin)).data.reservations, 251);
  });
  await t.test('account editing checks unique emails, role invariants, admin protection, and records audit', async () => {
    const patch = body => request('/admin/users/driver-demo', 'PATCH', { reason: 'Account maintenance test', ...body }, admin);
    assert.equal((await patch({ email: 'operator@parkease.com' })).status, 409);
    assert.equal((await patch({ role: 'OPERATOR' })).status, 409);
    assert.equal((await patch({ role: 'ADMIN' })).status, 400);
    assert.equal((await request('/admin/users/admin-demo', 'PATCH', { status: 'SUSPENDED', reason: 'Prevent access' }, admin)).status, 409);
    assert.equal((await request('/admin/users/operator-demo', 'PATCH', { role: 'DRIVER', reason: 'Change account role' }, admin)).status, 409);
    const edited = await patch({ name: 'Updated Driver' }); assert.equal(edited.status, 200); assert.equal(edited.data.name, 'Updated Driver');
    const audit = (await request('/admin/manage/audit?q=driver-demo', 'GET', null, admin)).data;
    assert.equal(audit.total, 1); assert.equal(audit.items[0].actorId, 'admin-demo'); assert.ok(audit.items[0].changes.includes('Updated Driver'));
  });
  await t.test('suspension blocks current sessions and login; restoration requires fresh credentials', async () => {
    assert.equal((await request('/admin/users/driver-demo', 'PATCH', { status: 'SUSPENDED', reason: 'Account access review' }, admin)).status, 200);
    assert.equal((await request('/auth/me', 'GET', null, driver)).status, 403);
    assert.equal((await signIn('driver@parkease.com')).status, 403);
    assert.equal((await request('/auth/demo', 'POST', { role: 'DRIVER' })).status, 403);
    assert.equal((await request('/admin/users/driver-demo', 'PATCH', { status: 'ACTIVE', reason: 'Account review complete' }, admin)).status, 200);
    assert.equal((await request('/auth/me', 'GET', null, driver)).status, 401);
    const fresh = (await signIn('driver@parkease.com')).data.token;
    assert.equal((await request('/auth/me', 'GET', null, fresh)).status, 200);
    assert.equal((await store.all('bookings')).length, 251);
    assert.equal((await request('/admin/manage/audit?status=ALL', 'GET', null, admin)).data.total, 3);
  });
  await t.test('suspended operators are hidden from discovery without deleting facilities or reservations', async () => {
    const query = new URLSearchParams({ startAt, endAt });
    assert.equal((await request('/admin/users/operator-demo', 'PATCH', { status: 'SUSPENDED', reason: 'Facility operator review' }, admin)).status, 200);
    assert.equal((await request(`/facilities?${query}`)).data.length, 0);
    assert.equal((await request(`/facilities/cp-central/slots?${query}`)).status, 404);
    assert.equal((await store.all('facilities')).length, 13);
    assert.equal((await request('/admin/users/operator-demo', 'PATCH', { status: 'ACTIVE', reason: 'Operator review complete' }, admin)).status, 200);
    assert.equal((await request(`/facilities?${query}`)).data.length, 12);
  });
});
