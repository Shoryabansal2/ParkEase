import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './test-store.js';
import { createApp } from '../src/app.js';
import { TEST_PAYMENT_DETAILS } from '../../shared/payment-validation.mjs';
import { reportWindow } from '../src/operator-analytics.js';

test('Operator Pro billing, pricing, analytics, alerts and report boundaries', async t => {
  const store = await createStore(), server = createApp(store, { secret: 'operator-pro-test' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function req(path, token, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const operator = (await req('/auth/demo', null, 'POST', { role: 'OPERATOR' })).data.token, driver = (await req('/auth/demo', null, 'POST', { role: 'DRIVER' })).data.token;
  const other = (await req('/auth/register', null, 'POST', { name: 'Another Operator', email: 'pro-other@example.com', password: 'ExamplePro123', role: 'OPERATOR' })).data;
  const paid = (amount, outcome = 'SUCCESS') => ({ method: 'UPI', outcome, expectedAmount: amount, details: TEST_PAYMENT_DETAILS.UPI });
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10), tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const startAt = new Date(`${tomorrow}T00:00:00+05:30`).toISOString(), endAt = new Date(Date.parse(startAt) + 2 * 3600000).toISOString();
  const window = new URLSearchParams({ startAt, endAt, vehicleType: 'CAR' });
  const fullDays = [0, 1, 2, 3, 4, 5, 6]; let rule, booking;
  await t.test('Pro features require an operator and an active subscription', async () => {
    assert.equal((await req('/operator/pro')).status, 401);
    assert.equal((await req('/operator/pro/activate', driver, 'POST', { payment: paid(1499) })).status, 403);
    for (const path of ['/operator/pro/analytics', '/operator/pro/alerts', '/operator/pro/reports/csv']) assert.equal((await req(path, operator)).status, 403);
    assert.equal((await req('/operator/pro', operator)).data.membership.price, 1499);
    assert.equal((await req('/operator/manage/facilities', operator)).status, 200);
  });
  await t.test('activation records one payment, rejects failures/tampering/concurrent duplicates, and keeps Driver VIP separate', async () => {
    assert.equal((await req('/operator/pro/activate', operator, 'POST', { payment: paid(1499, 'FAILED') })).status, 402);
    assert.equal((await req('/operator/pro/activate', operator, 'POST', { payment: paid(1) })).status, 409);
    assert.equal((await store.all('payments')).length, 0);
    const results = await Promise.all([req('/operator/pro/activate', operator, 'POST', { payment: paid(1499), price: 0 }), req('/operator/pro/activate', operator, 'POST', { payment: paid(1499) })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const user = results.find(r => r.status === 200).data.user;
    assert.equal(user.operatorMembership.tier, 'PRO'); assert.equal(user.operatorMembership.autoRenew, false); assert.equal(user.membership.tier, 'STANDARD');
    const receipts = (await store.all('payments')).filter(p => p.purpose === 'OPERATOR_PRO'); assert.equal(receipts.length, 1); assert.equal(receipts[0].amount, 1499);
    assert.equal((await req('/auth/me', driver)).data.membership.tier, 'STANDARD');
  });
  await t.test('schedule validation rejects overlaps and foreign ownership while allowing pause/edit/re-enable', async () => {
    await store.transaction(null, async tx => {
      await tx.insert('facilities', { ...(await tx.get('facilities', 'cp-central')), id: 'foreign-pro', operatorId: other.user.id, name: 'Hidden facility' });
    });
    const fields = { facilityId: 'cp-central', name: 'Midnight peak', days: fullDays, startTime: '00:30', endTime: '01:30', rate: 80, enabled: true };
    assert.equal((await req('/operator/pro/rules', operator, 'POST', { ...fields, facilityId: 'foreign-pro' })).status, 404);
    assert.equal((await req('/operator/pro/rules', operator, 'POST', { ...fields, days: [1, 1] })).status, 400);
    assert.equal((await req('/operator/pro/rules', operator, 'POST', { ...fields, startTime: '23:00', endTime: '01:00' })).status, 400);
    const created = await req('/operator/pro/rules', operator, 'POST', fields); assert.equal(created.status, 201); rule = created.data;
    assert.equal((await req('/operator/pro/rules', operator, 'POST', { ...fields, startTime: '00:45', endTime: '02:00' })).status, 409);
    assert.equal((await req(`/operator/pro/rules/${rule.id}`, operator, 'PATCH', { enabled: false })).data.enabled, false);
    assert.equal((await req(`/operator/pro/rules/${rule.id}`, operator, 'PATCH', { name: 'Renamed peak' })).data.enabled, false);
    assert.equal((await req(`/operator/pro/rules/${rule.id}`, operator, 'PATCH', { enabled: true })).status, 200);
    assert.equal((await req(`/operator/pro/rules/${rule.id}`, other.token, 'PATCH', { rate: 1 })).status, 403);
  });
  await t.test('driver quotes and checkout prorate mixed bands, apply bike rates/VIP, and reject stale amounts', async () => {
    const q = await req(`/facilities/cp-central/quote?${window}`);
    assert.equal(q.status, 200); assert.equal(q.data.baseTotal, 120); assert.equal(q.data.total, 130); assert.equal(q.data.scheduled, true); assert.equal(q.data.segments.length, 3);
    assert.equal(q.data.segments.reduce((n, s) => n + s.amount, 0), 120);
    const body = { slotId: 'cp-central-1', vehicle: 'DL TEST CAR', startAt, endAt };
    assert.equal((await req('/bookings', driver, 'POST', { ...body, payment: paid(90) })).status, 409);
    const r = await req('/bookings', driver, 'POST', { ...body, payment: paid(130) }); assert.equal(r.status, 201); booking = r.data;
    assert.equal(booking.total, 130); assert.equal(booking.convenienceFee, 10); assert.equal(JSON.parse(booking.pricingSnapshot)[1].rate, 80);
    const bikeWindow = new URLSearchParams({ startAt, endAt, vehicleType: 'BIKE' });
    assert.equal((await req(`/facilities/cp-central/quote?${bikeWindow}`)).data.baseTotal, 60);
    assert.equal((await req('/bookings', driver, 'POST', { ...body, slotId: 'cp-central-25', payment: paid(70) })).status, 201);
    assert.equal((await req('/membership/activate', driver, 'POST', { payment: paid(999) })).status, 200);
    assert.equal((await req(`/facilities/cp-central/quote?${window}`, driver)).data.total, 96);
    assert.equal((await req('/bookings', driver, 'POST', { ...body, slotId: 'cp-central-2', payment: paid(96) })).status, 201);
    const search = (await req(`/facilities?${window}`, driver)).data.find(f => f.id === 'cp-central'); assert.equal(search.quotedRate, 60); assert.equal(search.quote.total, 96);
  });
  await t.test('overnight date boundaries use IST weekdays and exact time-band boundaries', async () => {
    const day = new Date(Date.parse(startAt) + 330 * 60000).getUTCDay();
    const r = await req('/operator/pro/rules', operator, 'POST', { facilityId: 'palika', name: 'Late night', days: [(day + 6) % 7], startTime: '23:00', endTime: '24:00', rate: 90 }); assert.equal(r.status, 201);
    const query = new URLSearchParams({ startAt: new Date(Date.parse(startAt) - 30 * 60000).toISOString(), endAt: new Date(Date.parse(startAt) + 30 * 60000).toISOString(), vehicleType: 'CAR' });
    const q = (await req(`/facilities/palika/quote?${query}`)).data; assert.equal(q.baseTotal, 60); assert.equal(q.segments.length, 2); assert.equal(q.segments[0].rate, 90); assert.equal(q.segments[1].rate, 30);
  });
  await t.test('analytics separates fees, arrivals, collections, cancellations, capacity, and foreign data', async () => {
    const past = new Date(Date.now() - 3600000).toISOString(), ended = new Date(Date.now() - 10 * 60000).toISOString();
    await store.transaction(null, async tx => {
      const base = { ...(await tx.get('bookings', booking.id)), startAt: past, endAt: ended, createdAt: past, total: 50, baseTotal: 40, convenienceFee: 10, discountAmount: 0, pricingSnapshot: null };
      await tx.insert('bookings', { ...base, id: 'PE-OVERSTAY', slotId: 'cp-central-3', status: 'ACTIVE', checkedInAt: past, vehicle: '=SUM(1,1)' });
      await tx.insert('bookings', { ...base, id: 'PE-CANCELLED', slotId: 'cp-central-4', status: 'CANCELLED' });
      await tx.insert('bookings', { ...base, id: 'PE-FOREIGN-PRO', facilityId: 'foreign-pro', status: 'ACTIVE', total: 9999 });
    });
    const range = new URLSearchParams({ from: today, to: tomorrow, facilityId: 'cp-central' });
    const a = await req(`/operator/pro/analytics?${range}`, operator); assert.equal(a.status, 200);
    assert.equal(a.data.summary.reservations, 5); assert.equal(a.data.summary.cancelled, 1);
    assert.equal(a.data.daily.reduce((total, day) => total + day.cancellations, 0), a.data.summary.cancelled);
    assert.equal(a.data.daily.find(day => day.date === today).cancellations, 1);
    assert.equal(a.data.daily.find(day => day.date === tomorrow).cancellations, 0);
    assert.equal(a.data.summary.parkingValue, 316); assert.equal(a.data.summary.convenienceFees, 30); assert.equal(a.data.summary.bookingValue, 346); assert.equal(a.data.summary.collectionValue, 296);
    assert.ok(a.data.summary.occupancy >= 0 && a.data.summary.occupancy <= 100); assert.equal(a.data.daily.length, 2); assert.equal(a.data.vehicleMix.find(v => v.type === 'BIKE').bookings, 1);
    assert.equal(a.data.bookings, undefined); assert.ok(!JSON.stringify(a.data).includes('Hidden facility'));
    assert.equal((await req('/operator/pro/analytics?facilityId=foreign-pro', operator)).status, 404);
    assert.throws(() => reportWindow({ from: '2026-02-31', to: '2026-03-04' }));
    assert.equal((await req('/operator/pro/analytics?from=2026-01-01&to=2026-12-31', operator)).status, 400);
  });
  await t.test('live overstay alerts are scoped, paginated, and clear after checkout', async () => {
    const alerts = await req('/operator/pro/alerts?pageSize=5', operator); assert.equal(alerts.data.total, 1); assert.equal(alerts.data.items[0].id, 'PE-OVERSTAY'); assert.ok(alerts.data.items[0].overdueMinutes >= 10);
    assert.equal((await req('/operator/pro/alerts?facilityId=foreign-pro', operator)).status, 404);
    assert.equal((await req('/bookings/PE-OVERSTAY/check-out', operator, 'POST')).status, 200);
    assert.equal((await req('/operator/pro/alerts', operator)).data.total, 0);
  });
  await t.test('CSV and actual PDF exports include only scoped records and neutralise spreadsheet formulas', async () => {
    const range = new URLSearchParams({ from: today, to: tomorrow, facilityId: 'cp-central' });
    const csv = await fetch(`${base}/operator/pro/reports/csv?${range}`, { headers: { Authorization: `Bearer ${operator}` } }); assert.equal(csv.status, 200); assert.match(csv.headers.get('content-disposition'), /attachment/);
    const text = await csv.text(); assert.ok(text.includes('PE-OVERSTAY')); assert.ok(text.includes("'=SUM(1,1)")); assert.ok(!text.includes('PE-FOREIGN-PRO')); assert.ok(text.includes('Convenience fee INR'));
    const pdf = await fetch(`${base}/operator/pro/reports/pdf?${range}`, { headers: { Authorization: `Bearer ${operator}` } }); assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    const bytes = Buffer.from(await pdf.arrayBuffer()); assert.ok(bytes.length > 1000); assert.equal(bytes.subarray(0, 4).toString(), '%PDF'); assert.ok(bytes.toString().includes('%%EOF'));
  });
  await t.test('expiry stops Pro access/schedules without changing existing reservations or extension pricing', async () => {
    await store.transaction(null, async tx => { await tx.update('users', 'operator-demo', { operatorExpiresAt: new Date(Date.now() - 1000).toISOString() }); await tx.update('facilities', 'cp-central', { rate: 100 }); });
    for (const path of ['/operator/pro/analytics', '/operator/pro/alerts', '/operator/pro/reports/csv']) assert.equal((await req(path, operator)).status, 403);
    assert.equal((await req(`/operator/pro/rules/${rule.id}`, operator, 'PATCH', { rate: 160 })).status, 403);
    assert.equal((await req(`/facilities/cp-central/quote?${window}`)).data.baseTotal, 200);
    const unchanged = await store.get('bookings', booking.id); assert.equal(unchanged.total, 130); assert.equal(unchanged.baseTotal, 120);
    const extended = await req(`/bookings/${booking.id}/extend`, driver, 'POST', { hours: 0.5, expectedEndAt: booking.endAt, payment: paid(30) }); assert.equal(extended.status, 200); assert.equal(extended.data.total, 160); assert.equal(extended.data.convenienceFee, 10);
    assert.equal((await req('/operator/manage/facilities', operator)).status, 200); assert.equal((await req('/operator/pro', operator)).data.membership.tier, 'STANDARD');
    assert.equal((await req('/operator/pro/activate', operator, 'POST', { payment: paid(1499) })).status, 200);
  });
});
