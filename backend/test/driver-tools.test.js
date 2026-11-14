import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './test-store.js';
import { createApp } from '../src/app.js';
import { TEST_PAYMENT_DETAILS } from '../../shared/payment-validation.mjs';

test('notifications and Find My Car follow bookings and account boundaries', async t => {
  const store = await createStore(), server = createApp(store, { secret: 'driver-tools-integration' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const req = async (path, token, method = 'GET', body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, data: await r.json() }; };
  const driver = (await req('/auth/demo', null, 'POST', { role: 'DRIVER' })).data.token;
  const operator = (await req('/auth/demo', null, 'POST', { role: 'OPERATOR' })).data.token;
  const foreign = (await req('/auth/register', null, 'POST', { name: 'Other Driver', email: 'other.tools@example.com', password: 'DriverTools123' })).data.token;
  const startAt = new Date(Date.now() + 4 * 3600000).toISOString(), endAt = new Date(Date.now() + 5 * 3600000).toISOString();
  const booking = (await req('/bookings', driver, 'POST', { slotId: 'cp-central-1', vehicle: 'DL TOOLS 1234', startAt, endAt, payment: { method: 'UPI', outcome: 'SUCCESS', expectedAmount: 50, details: TEST_PAYMENT_DETAILS.UPI } })).data;
  assert.ok(booking.id);
  await t.test('booking updates have stable IDs, are private, and persist read state', async () => {
    assert.equal((await req('/notifications')).status, 401);
    const a = (await req('/notifications', driver)).data, b = (await req('/notifications', driver)).data;
    assert.equal(a.items.length, 1); assert.equal(a.unreadCount, 1); assert.equal(a.items[0].id, b.items[0].id); assert.equal(a.items[0].bookingId, booking.id);
    assert.equal((await req('/notifications', foreign)).data.items.length, 0);
    assert.equal((await req(`/notifications/${a.items[0].id}/read`, foreign, 'POST')).status, 404);
    const results = await Promise.all([req(`/notifications/${a.items[0].id}/read`, driver, 'POST'), req(`/notifications/${a.items[0].id}/read`, driver, 'POST')]); assert.ok(results.every(r => r.status === 200));
    assert.equal((await store.all('notificationReads')).length, 1);
    assert.equal((await req('/notifications?unread=true', driver)).data.items.length, 0);
    assert.equal((await req('/notifications', operator)).data.items[0].bookingId, booking.id);
  });
  await t.test('Find My Car highlights the real bay and saves private floor/landmark notes', async () => {
    const found = await req(`/bookings/${booking.id}/location`, driver); assert.equal(found.status, 200); assert.equal(found.data.schematic, true); assert.ok(found.data.bays.some(b => b.id === booking.slotId)); assert.equal(found.data.zone, 'A');
    assert.equal((await req(`/bookings/${booking.id}/location`, foreign)).status, 403);
    assert.equal((await req(`/bookings/${booking.id}`, foreign)).status, 403);
    const saved = await req(`/bookings/${booking.id}/location`, driver, 'PUT', { floor: 'Basement 1', landmark: 'Near lift B' }); assert.equal(saved.status, 200);
    assert.equal((await req(`/bookings/${booking.id}/location`, driver)).data.note.landmark, 'Near lift B');
    assert.equal((await store.get('parkingNotes', booking.id)).floor, 'Basement 1');
    assert.equal((await req(`/bookings/${booking.id}/location`, foreign, 'PUT', { floor: 'Other', landmark: '' })).status, 403);
    assert.equal((await req(`/bookings/${booking.id}/location`, operator, 'PUT', { floor: 'Other', landmark: '' })).status, 403);
    assert.equal((await req(`/bookings/${booking.id}/location`, driver, 'PUT', { floor: 'x'.repeat(61), landmark: '' })).status, 400);
  });
  await t.test('reminders follow current arrival/departure and membership expiry', async () => {
    await store.transaction(null, tx => tx.update('bookings', booking.id, { startAt: new Date(Date.now() + 15 * 60000).toISOString() }));
    assert.ok((await req('/notifications', driver)).data.items.some(n => n.title === 'Your parking starts soon'));
    await store.transaction(null, tx => tx.update('bookings', booking.id, { status: 'ACTIVE', checkedInAt: new Date().toISOString(), endAt: new Date(Date.now() + 10 * 60000).toISOString() }));
    let feed = (await req('/notifications', driver)).data.items; assert.ok(feed.some(n => n.title === 'Your parking ends soon')); assert.ok(!feed.some(n => n.title === 'Your parking starts soon'));
    await store.transaction(null, tx => tx.update('bookings', booking.id, { endAt: new Date(Date.now() - 60000).toISOString() }));
    feed = (await req('/notifications', driver)).data.items; assert.ok(feed.some(n => n.title === 'Reserved departure has passed')); assert.ok(!feed.some(n => n.title === 'Your parking ends soon'));
    await store.transaction(null, tx => tx.update('users', 'driver-demo', { membershipTier: 'PREMIUM', membershipExpiresAt: new Date(Date.now() + 2 * 86400000).toISOString() }));
    assert.ok((await req('/notifications', driver)).data.items.some(n => n.title === 'Premium VIP expires soon'));
    await store.transaction(null, tx => tx.update('users', 'driver-demo', { membershipExpiresAt: new Date(Date.now() - 86400000).toISOString() }));
    assert.ok((await req('/notifications', driver)).data.items.some(n => n.title === 'Premium VIP has expired'));
    assert.equal((await req('/auth/me', driver)).data.membership.tier, 'STANDARD');
    await req('/notifications/read-all', driver, 'POST'); assert.equal((await req('/notifications', driver)).data.unreadCount, 0);
  });
  await t.test('cancelled reservations generate a cancellation update and disable location editing', async () => {
    await store.transaction(null, tx => tx.update('bookings', booking.id, { status: 'CONFIRMED', startAt, endAt }));
    assert.equal((await req(`/bookings/${booking.id}/cancel`, driver, 'POST')).status, 200);
    assert.ok((await req('/notifications', driver)).data.items.some(n => n.kind === 'cancellation'));
    assert.equal((await req(`/bookings/${booking.id}/location`, driver)).status, 409);
    assert.equal((await req(`/bookings/${booking.id}/location`, driver, 'PUT', { floor: '', landmark: '' })).status, 409);
  });
});
