import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { membership, priorityEV, cancellationDeadline, publicUser } from './membership.js';
import { paymentSchema, recordPayment, money, VIP_MONTHLY_PRICE, nextBillingMonth } from './payment.js';
import { applyCapacity, capacitySchema } from './capacity.js';
import { managementRoutes } from './management.js';
import { operatorProRoutes } from './operator-pro.js';
import { parkingQuote } from './pricing.js';
import { fileURLToPath } from 'node:url';
import { defaultPhotoDirectory, PHOTO_BODY_LIMIT, saveFacilityPhoto } from './facility-photos.js';

const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const overlaps = (b, start, end) => ['CONFIRMED', 'ACTIVE'].includes(b.status) && b.startAt < end && b.endAt > start;
const windowSchema = z.object({ startAt: z.iso.datetime({ offset: true }), endAt: z.iso.datetime({ offset: true }) });
function parseWindow(input) {
  const w = windowSchema.parse(input);
  const startAt = new Date(w.startAt).toISOString(), endAt = new Date(w.endAt).toISOString();
  const hours = (Date.parse(endAt) - Date.parse(startAt)) / 3600000;
  if (hours < 0.25 || hours > 24) fail(400, 'Choose a parking duration between 15 minutes and 24 hours.');
  return { startAt, endAt, hours };
}
export function createApp(store, { secret, demoMode = true, photoDirectory = defaultPhotoDirectory } = {}) {
  if (!secret) throw new Error('JWT secret is required.');
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: (process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:3000').split(',') }));
  photoDirectory = photoDirectory instanceof URL ? fileURLToPath(photoDirectory) : photoDirectory;
  const smallJSON = express.json({ limit: '20kb' }), photoJSON = express.json({ limit: PHOTO_BODY_LIMIT });
  app.use((req, res, next) => ['POST', 'PATCH'].includes(req.method) && /^\/api\/manage\/facilities(?:\/[^/]+)?\/?$/.test(req.path) ? next() : smallJSON(req, res, next));
  app.use('/api/uploads/facilities', (req, res, next) => {
    if (!/^\/[a-f0-9-]{36}\.webp$/.test(req.path)) return res.status(404).json({ error: 'Photo not found.' });
    res.set('X-Content-Type-Options', 'nosniff'); next();
  }, express.static(photoDirectory, { dotfiles: 'deny', index: false, maxAge: '1y', immutable: true }));
  const session = u => ({ user: publicUser(u), token: jwt.sign({ sub: u.id, version: u.sessionVersion || 0 }, secret, { expiresIn: '12h' }) });
  const auth = (...roles) => async (req, res, next) => {
    try {
      let payload;
      try { payload = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), secret); } catch { fail(401, 'Please sign in to continue.'); }
      req.user = await store.get('users', payload.sub);
      if (!req.user) fail(401, 'Your account could not be found.');
      if (req.user.status === 'SUSPENDED') fail(403, 'Your account is suspended. Contact platform support.');
      if ((payload.version || 0) !== (req.user.sessionVersion || 0)) fail(401, 'Your account access changed. Please sign in again.');
      if (roles.length && !roles.includes(req.user.role)) fail(403, 'This action is not available for your role.');
      next();
    } catch (e) { next(e); }
  };
  const hydrate = async bookings => {
    const [facilities, slots, users, payments] = await Promise.all([store.all('facilities'), store.all('slots'), store.all('users'), store.all('payments')]);
    return bookings.map(b => ({ ...b, payments: payments.filter(p => p.bookingId === b.id).map(({ userId, bookingId, ...p }) => p), membershipTier: b.membershipTier || 'STANDARD', baseTotal: Number(b.baseTotal ?? b.total), discountAmount: Number(b.discountAmount || 0), cancellationDeadline: cancellationDeadline(b), accessPass: b.membershipTier === 'PREMIUM' ? 'EXPRESS' : 'STANDARD', facility: facilities.find(f => f.id === b.facilityId), slot: slots.find(s => s.id === b.slotId), driverName: users.find(u => u.id === b.userId)?.name }));
  };
  const viewer = async req => { try { const token = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), secret); const u = await store.get('users', token.sub); return u?.status !== 'SUSPENDED' && (token.version || 0) === (u?.sessionVersion || 0) ? u : null; } catch { return null; } };
  app.get('/api/health', (req, res) => res.json({ status: 'ok', storage: store.driver, demoMode, payments: 'simulated' }));
  app.post('/api/auth/demo', async (req, res) => {
    if (!demoMode) fail(404, 'Demo sign-in is disabled.');
    const role = z.enum(['DRIVER', 'OPERATOR', 'ADMIN']).parse(req.body.role);
    if (role === 'ADMIN') fail(403, 'Administrators must sign in with email and password.');
    const u = (await store.all('users')).find(u => u.id === `${role.toLowerCase()}-demo`);
    if (!u) fail(404, 'Demo users are not seeded. Run database setup.');
    if (u.status === 'SUSPENDED') fail(403, 'This account is suspended.');
    res.json(session(u));
  });
  app.post('/api/auth/register', async (req, res) => {
    const body = z.object({ name: z.string().trim().min(2).max(100), email: z.email().max(190), password: z.string().min(8).max(72), vehicle: z.string().trim().max(30).default(''), role: z.enum(['DRIVER', 'OPERATOR']).default('DRIVER') }).parse(req.body);
    const user = { id: randomUUID(), name: body.name, email: body.email.toLowerCase(), passwordHash: await bcrypt.hash(body.password, 10), vehicle: body.vehicle, role: body.role, status: 'ACTIVE', sessionVersion: 0, createdAt: new Date().toISOString() };
    await store.transaction(null, async tx => { if ((await tx.all('users')).some(u => u.email === user.email)) fail(409, 'This email is already registered.'); await tx.insert('users', user); });
    res.status(201).json(session(user));
  });
  app.post('/api/auth/login', async (req, res) => {
    const body = z.object({ email: z.email(), password: z.string().max(100), role: z.enum(['DRIVER', 'OPERATOR', 'ADMIN']).optional() }).parse(req.body);
    const u = (await store.all('users')).find(u => u.email === body.email.toLowerCase());
    if (!u || !await bcrypt.compare(body.password, u.passwordHash)) fail(401, 'Email or password is incorrect.');
    if (u.status === 'SUSPENDED') fail(403, 'Your account is suspended. Contact platform support.');
    if (body.role && body.role !== u.role) fail(403, `This is a ${u.role.toLowerCase()} account. Choose the matching sign-in option.`);
    res.json(session(u));
  });
  app.get('/api/auth/me', auth(), (req, res) => res.json(publicUser(req.user)));
  app.post('/api/membership/activate', auth('DRIVER'), async (req, res) => {
    if (!demoMode) fail(403, 'Membership checkout is available only in the college demo until a payment provider is configured.');
    const payment = paymentSchema.parse(req.body.payment);
    const user = await store.transaction({ table: 'users', id: req.user.id }, async tx => {
      const current = await tx.get('users', req.user.id);
      if (membership(current).tier === 'PREMIUM') fail(409, 'Your Premium VIP membership is already active.');
      await recordPayment(tx, { payment, userId: current.id, purpose: 'MEMBERSHIP', amount: VIP_MONTHLY_PRICE });
      return tx.update('users', current.id, { membershipTier: 'PREMIUM', membershipExpiresAt: nextBillingMonth() });
    });
    res.json({ user: publicUser(user), payment: 'SIMULATED', price: VIP_MONTHLY_PRICE, billingPeriod: 'MONTH', autoRenew: false });
  });
  app.get('/api/membership', auth('DRIVER'), async (req, res) => {
    const benefits = membership(req.user);
    const [allBookings, allSlots, facilities, watches, tickets] = await Promise.all(['bookings', 'slots', 'facilities', 'evAlerts', 'supportTickets'].map(t => store.all(t)));
    const vipBookings = allBookings.filter(b => b.userId === req.user.id && b.membershipTier === 'PREMIUM' && b.status !== 'CANCELLED');
    const alerts = watches.filter(a => a.userId === req.user.id && a.startAt > new Date().toISOString()).map(a => {
      const facility = facilities.find(f => f.id === a.facilityId);
      const count = benefits.tier === 'PREMIUM' && !facility?.removedAt && facility?.status === 'APPROVED' ? allSlots.filter(s => !s.retired && s.facilityId === a.facilityId && priorityEV(s, facility) && !s.blocked && !allBookings.some(b => b.slotId === s.id && overlaps(b, a.startAt, a.endAt))).length : 0;
      return { ...a, facilityName: facility?.name, available: count, message: benefits.tier !== 'PREMIUM' ? 'VIP membership is required to use this alert.' : count ? `${count} priority EV ${count === 1 ? 'bay is' : 'bays are'} available now.` : 'Watching for an available priority EV bay.' };
    });
    res.json({ membership: benefits, savings: vipBookings.reduce((s, b) => s + Number(b.discountAmount || 0), 0), vipBookings: vipBookings.length, alerts, tickets: tickets.filter(t => t.userId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  });
  app.post('/api/membership/ev-alerts', auth('DRIVER'), async (req, res) => {
    if (membership(req.user).tier !== 'PREMIUM') fail(403, 'Priority EV alerts are a Premium VIP benefit.');
    const body = z.object({ facilityId: z.string().max(64), startAt: z.string(), endAt: z.string() }).parse(req.body);
    const w = parseWindow(body);
    if (Date.parse(w.startAt) <= Date.now() || Date.parse(w.startAt) > Date.now() + 7 * 86400000) fail(400, 'Choose a future arrival within seven days.');
    const f = await store.get('facilities', body.facilityId);
    if (!f?.ev || (f.removedAt || f.status !== 'APPROVED')) fail(400, 'Choose an approved facility with EV charging.');
    const alert = await store.transaction(null, async tx => {
      const existing = (await tx.all('evAlerts')).find(a => a.userId === req.user.id && a.facilityId === f.id && a.startAt === w.startAt && a.endAt === w.endAt);
      if (existing) return existing;
      return tx.insert('evAlerts', { id: randomUUID(), userId: req.user.id, facilityId: f.id, startAt: w.startAt, endAt: w.endAt, createdAt: new Date().toISOString() });
    });
    res.status(201).json(alert);
  });
  app.post('/api/support', auth('DRIVER'), async (req, res) => {
    const body = z.object({ subject: z.string().trim().min(3).max(120), message: z.string().trim().min(10).max(2000) }).parse(req.body);
    const ticket = await store.transaction(null, tx => tx.insert('supportTickets', { id: `HELP-${randomUUID().slice(0, 8).toUpperCase()}`, userId: req.user.id, ...body, priority: membership(req.user).support, status: 'OPEN', createdAt: new Date().toISOString() }));
    res.status(201).json(ticket);
  });
  app.get('/api/admin/support', auth('ADMIN'), async (req, res) => {
    const users = await store.all('users');
    res.json((await store.all('supportTickets')).map(t => ({ ...t, driverName: users.find(u => u.id === t.userId)?.name })).sort((a, b) => Number(b.priority === 'PRIORITY') - Number(a.priority === 'PRIORITY') || a.createdAt.localeCompare(b.createdAt)));
  });
  app.patch('/api/admin/support/:id', auth('ADMIN'), async (req, res) => {
    const body = z.object({ status: z.enum(['OPEN', 'RESOLVED']) }).parse(req.body);
    if (!await store.get('supportTickets', req.params.id)) fail(404, 'Support request not found.');
    res.json(await store.transaction(null, tx => tx.update('supportTickets', req.params.id, body)));
  });
  app.put('/api/auth/profile', auth(), async (req, res) => {
    const body = z.object({ name: z.string().trim().min(2).max(100), vehicle: z.string().trim().max(30) }).parse(req.body);
    const u = await store.transaction(null, tx => tx.update('users', req.user.id, body));
    res.json(publicUser(u));
  });
  app.get('/api/facilities', async (req, res) => {
    const benefits = membership(await viewer(req)), vip = benefits.tier === 'PREMIUM';
    const w = parseWindow(req.query);
    const [facilities, slots, bookings, owners, rules] = await Promise.all([store.all('facilities'), store.all('slots'), store.all('bookings'), store.all('users'), store.all('pricingRules')]);
    const vehicleType = req.query.vehicleType || 'CAR';
    const search = String(req.query.search || '').toLowerCase();
    res.json(facilities.filter(f => !f.removedAt && f.status === 'APPROVED' && owners.find(u => u.id === f.operatorId)?.status !== 'SUSPENDED' && `${f.name} ${f.address}`.toLowerCase().includes(search)).map(f => {
      const compatible = slots.filter(s => !s.retired && s.facilityId === f.id && s.vehicleType === vehicleType);
      const quote = parkingQuote(f, owners.find(u => u.id === f.operatorId), rules, w, vehicleType, benefits);
      return { ...f, quotedRate: money(quote.baseTotal / w.hours), quote, available: compatible.filter(s => !s.blocked && (vip || !priorityEV(s, f)) && !bookings.some(b => b.slotId === s.id && overlaps(b, w.startAt, w.endAt))).length, capacity: compatible.length };
    }));
  });
  app.get('/api/facilities/:id/quote', async (req, res) => {
    const w = parseWindow(req.query), vehicleType = z.enum(['CAR', 'BIKE', 'EV']).default('CAR').parse(req.query.vehicleType);
    const facility = await store.get('facilities', req.params.id), owner = facility && await store.get('users', facility.operatorId);
    if (!facility || (facility.removedAt || facility.status !== 'APPROVED') || owner?.status === 'SUSPENDED') fail(404, 'Parking facility is unavailable.');
    res.json(parkingQuote(facility, owner, await store.all('pricingRules'), w, vehicleType, membership(await viewer(req))));
  });
  app.get('/api/facilities/:id/slots', async (req, res) => {
    const vip = membership(await viewer(req)).tier === 'PREMIUM';
    const w = parseWindow(req.query);
    const f = await store.get('facilities', req.params.id);
    if (!f || (f.removedAt || f.status !== 'APPROVED')) fail(404, 'Parking facility is unavailable.');
    if ((await store.get('users', f.operatorId))?.status === 'SUSPENDED') fail(404, 'Parking facility is unavailable.');
    const bookings = await store.all('bookings');
    res.json((await store.all('slots')).filter(s => !s.retired && s.facilityId === f.id && s.vehicleType === (req.query.vehicleType || 'CAR')).map(s => ({ ...s, priority: priorityEV(s, f), status: s.blocked ? 'BLOCKED' : bookings.some(b => b.slotId === s.id && overlaps(b, w.startAt, w.endAt)) ? 'RESERVED' : priorityEV(s, f) && !vip ? 'VIP_ONLY' : 'AVAILABLE' })));
  });
  app.post('/api/bookings', auth('DRIVER'), async (req, res) => {
    const body = z.object({ slotId: z.string().max(64), vehicle: z.string().trim().min(4).max(30), startAt: z.string(), endAt: z.string(), payment: paymentSchema }).parse(req.body);
    const w = parseWindow(body);
    if (Date.parse(w.startAt) < Date.now() - 60000) fail(400, 'Choose a start time in the future.');
    const benefits = membership(req.user);
    if (Date.parse(w.startAt) > Date.now() + benefits.advanceHours * 3600000) fail(400, benefits.tier === 'PREMIUM' ? 'Premium VIP can reserve up to seven days ahead.' : 'Standard members can reserve up to 24 hours ahead. Upgrade to Premium VIP for seven days.');
    const requestedSlot = await store.get('slots', body.slotId);
    if (!requestedSlot) fail(409, 'This space is unavailable. Please choose another.');
    const booking = await store.transaction({ table: 'facilities', id: requestedSlot.facilityId }, async tx => {
      const slot = await tx.get('slots', body.slotId);
      if (!slot || slot.retired || slot.blocked) fail(409, 'This space is unavailable. Please choose another.');
      const f = await tx.get('facilities', slot.facilityId);
      if ((f.removedAt || f.status !== 'APPROVED')) fail(409, 'This facility is unavailable.');
      if ((await tx.get('users', f.operatorId))?.status === 'SUSPENDED') fail(409, 'This facility is unavailable.');
      if (priorityEV(slot, f) && benefits.tier !== 'PREMIUM') fail(403, 'This priority EV bay is reserved for Premium VIP members.');
      if ((await tx.all('bookings')).some(b => b.slotId === slot.id && overlaps(b, w.startAt, w.endAt))) fail(409, 'This space was just reserved. Please choose another.');
      const quote = parkingQuote(f, await tx.get('users', f.operatorId), await tx.all('pricingRules'), w, slot.vehicleType, benefits);
      const { baseTotal, convenienceFee, total, discountAmount } = quote;
      const id = `PE-${randomUUID().slice(0, 8).toUpperCase()}`;
      await recordPayment(tx, { payment: body.payment, userId: req.user.id, purpose: 'BOOKING', amount: total, bookingId: id });
      return tx.insert('bookings', { id, userId: req.user.id, facilityId: f.id, slotId: slot.id, vehicle: body.vehicle.toUpperCase(), startAt: w.startAt, endAt: w.endAt, total, baseTotal, convenienceFee, discountAmount, pricingSnapshot: JSON.stringify(quote.segments), membershipTier: benefits.tier, status: 'CONFIRMED', paymentStatus: 'SIMULATED', createdAt: new Date().toISOString(), checkedInAt: null, checkedOutAt: null });
    });
    res.status(201).json((await hydrate([booking]))[0]);
  });
  app.get('/api/bookings', auth(), async (req, res) => {
    const facilities = await store.all('facilities');
    const bookings = (await store.all('bookings')).filter(b => req.user.role === 'ADMIN' || (req.user.role === 'OPERATOR' ? facilities.some(f => f.id === b.facilityId && f.operatorId === req.user.id) : b.userId === req.user.id));
    res.json(await hydrate(bookings.sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
  });
  app.post('/api/bookings/:id/extend', auth('DRIVER', 'ADMIN'), async (req, res) => {
    const body = z.object({ hours: z.number().min(0.25).max(12), expectedEndAt: z.iso.datetime({ offset: true }), payment: paymentSchema }).parse(req.body);
    const current = await store.get('bookings', req.params.id);
    if (!current) fail(404, 'Booking not found.');
    if (current.userId !== req.user.id && req.user.role !== 'ADMIN') fail(403, 'Only the booking owner or administrator can extend.');
    const result = await store.transaction({ table: 'facilities', id: current.facilityId }, async tx => {
      const booking = await tx.get('bookings', current.id);
      if (!['CONFIRMED', 'ACTIVE'].includes(booking.status)) fail(409, 'Only confirmed or active reservations can be extended.');
      if (Date.parse(booking.endAt) <= Date.now()) fail(409, 'This reservation has already ended. Please make a new booking.');
      if (booking.endAt !== new Date(body.expectedEndAt).toISOString()) fail(409, 'This reservation has changed. Refresh your bookings and try again.');
      const slot = await tx.get('slots', booking.slotId);
      const facility = await tx.get('facilities', booking.facilityId);
      if (slot.retired || slot.blocked || (facility.removedAt || facility.status !== 'APPROVED')) fail(409, 'This space is unavailable for an extension.');
      const endAt = new Date(Date.parse(booking.endAt) + body.hours * 3600000).toISOString();
      const originalHours = (Date.parse(booking.endAt) - Date.parse(booking.startAt)) / 3600000;
      if (originalHours + body.hours > 24) fail(400, 'A reservation can be at most 24 hours in total.');
      if ((await tx.all('bookings')).some(b => b.id !== booking.id && b.slotId === booking.slotId && overlaps(b, booking.endAt, endAt))) fail(409, 'Another driver has reserved this bay during the extra time. Try a shorter extension.');
      // Preserve the booking's agreed rate even if facility pricing changes later.
      const convenienceFee = Number(booking.convenienceFee || 0);
      const total = money((Number(booking.total) - convenienceFee) * (originalHours + body.hours) / originalHours + convenienceFee);
      const baseTotal = money(Number(booking.baseTotal ?? booking.total) * (originalHours + body.hours) / originalHours);
      await recordPayment(tx, { payment: body.payment, userId: req.user.id, purpose: 'EXTENSION', amount: money(total - Number(booking.total)), bookingId: booking.id });
      return tx.update('bookings', booking.id, { endAt, total, baseTotal, discountAmount: money(baseTotal - (total - convenienceFee)) });
    });
    res.json((await hydrate([result]))[0]);
  });
  app.post('/api/bookings/:id/:action', auth(), async (req, res) => {
    const current = await store.get('bookings', req.params.id);
    if (!current) fail(404, 'Booking not found.');
    const f = await store.get('facilities', current.facilityId);
    const { action } = req.params;
    if (!['cancel', 'check-in', 'check-out'].includes(action)) fail(404, 'Unknown booking action.');
    if (action === 'cancel') { if (req.user.id !== current.userId && req.user.role !== 'ADMIN') fail(403, 'Only the booking owner or administrator can cancel.'); }
    else if (req.user.role !== 'ADMIN' && !(req.user.role === 'OPERATOR' && f.operatorId === req.user.id)) fail(403, 'Only the facility operator can check vehicles in or out.');
    const result = await store.transaction({ table: 'facilities', id: current.facilityId }, async tx => {
      const booking = await tx.get('bookings', current.id);
      const from = action === 'check-out' ? 'ACTIVE' : 'CONFIRMED';
      if (booking.status !== from) fail(409, `This booking must be ${from.toLowerCase()} for this action.`);
      if (action === 'cancel' && req.user.role !== 'ADMIN' && Date.now() > Date.parse(cancellationDeadline(booking))) fail(409, `Free cancellation closed at ${cancellationDeadline(booking)}. ${booking.membershipTier === 'PREMIUM' ? 'VIP cancellation closes 30 minutes' : 'Standard cancellation closes two hours'} before arrival. Contact support for help.`);
      if (action === 'check-in' && !demoMode && (Date.now() < Date.parse(booking.startAt) - 15 * 60000 || Date.now() >= Date.parse(booking.endAt))) fail(400, 'Check-in opens 15 minutes before your booking and closes at its end.');
      const patch = { status: action === 'cancel' ? 'CANCELLED' : action === 'check-in' ? 'ACTIVE' : 'COMPLETED' };
      if (action === 'cancel') { patch.paymentStatus = 'VOIDED'; for (const payment of (await tx.all('payments')).filter(p => p.bookingId === booking.id)) await tx.update('payments', payment.id, { status: 'SIMULATED_VOIDED' }); }
      if (action === 'check-in') patch.checkedInAt = new Date().toISOString();
      if (action === 'check-out') patch.checkedOutAt = new Date().toISOString();
      return tx.update('bookings', booking.id, patch);
    });
    res.json((await hydrate([result]))[0]);
  });
  app.get('/api/manage/facilities', auth('OPERATOR', 'ADMIN'), async (req, res) => res.json((await store.all('facilities')).filter(f => req.user.role === 'ADMIN' || f.operatorId === req.user.id)));
  app.post('/api/manage/facilities', auth('OPERATOR'), photoJSON, async (req, res) => {
    const { photo, capacity, ...body } = z.object({ name: z.string().trim().min(3).max(150), address: z.string().trim().min(10).max(255), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), rate: z.number().min(5).max(1000), covered: z.boolean(), ev: z.boolean(), capacity: capacitySchema.optional(), photo: z.string().max(2800000).optional() }).parse(req.body);
    const facility = { ...body, id: `lot-${randomUUID().slice(0, 12)}`, operatorId: req.user.id, status: 'PENDING', covered: Number(body.covered), ev: Number(body.ev), rating: 0, tag: 'New facility', distance: '0', image: 'garage' };
    const upload = photo ? await saveFacilityPhoto(photo, photoDirectory) : null;
    if (upload) facility.photoUrl = upload.photoUrl;
    try { await store.transaction(null, async tx => { await tx.insert('facilities', facility); await applyCapacity(tx, facility, capacity || { CAR: 20, BIKE: 8, EV: body.ev ? 4 : 0 }); }); }
    catch (e) { await upload?.discard(); throw e; }
    res.status(201).json(facility);
  });
  app.patch('/api/manage/facilities/:id', auth('OPERATOR', 'ADMIN'), photoJSON, async (req, res) => {
    const { photo, capacity, ...body } = z.object({ rate: z.number().min(5).max(1000).optional(), status: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED']).optional(), capacity: capacitySchema.optional(), photo: z.string().min(1).max(2800000).nullable().optional() }).parse(req.body);
    if (!Object.keys(body).length && photo === undefined && !capacity) fail(400, 'Choose a rate, capacity, status, or photo to update.');
    const f = await store.get('facilities', req.params.id);
    if (!f) fail(404, 'Facility not found.');
    if (f.removedAt) fail(409, 'Restore this removed listing before editing it.');
    if (req.user.role !== 'ADMIN' && (body.status || f.operatorId !== req.user.id)) fail(403, 'You cannot update this facility.');
    const upload = photo ? await saveFacilityPhoto(photo, photoDirectory) : null;
    if (photo !== undefined) body.photoUrl = upload?.photoUrl || null;
    try { res.json(await store.transaction({ table: 'facilities', id: f.id }, async tx => {
      const current = await tx.get('facilities', f.id);
      if (current.removedAt) fail(409, 'Restore this removed listing before editing it.');
      if (capacity) await applyCapacity(tx, current, capacity);
      return tx.update('facilities', f.id, body);
    })); }
    catch (e) { await upload?.discard(); throw e; }
  });
  app.get('/api/manage/facilities/:id/slots', auth('OPERATOR', 'ADMIN'), async (req, res) => {
    const vehicleType = z.enum(['CAR', 'BIKE', 'EV']).default('CAR').parse(req.query.vehicleType);
    const facility = await store.get('facilities', req.params.id);
    if (!facility || (req.user.role !== 'ADMIN' && facility.operatorId !== req.user.id)) fail(404, 'Facility not found.');
    const bookings = await store.all('bookings');
    const now = new Date().toISOString();
    res.json((await store.all('slots')).filter(s => !s.retired && s.facilityId === facility.id && s.vehicleType === vehicleType).map(s => ({ ...s, status: s.blocked ? 'BLOCKED' : bookings.some(b => b.slotId === s.id && (b.status === 'ACTIVE' || (b.status === 'CONFIRMED' && b.endAt > now))) ? 'RESERVED' : 'AVAILABLE' })));
  });
  app.post('/api/manage/facilities/:id/remove', auth('OPERATOR', 'ADMIN'), async (req, res) => {
    const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body);
    res.json(await store.transaction({ table: 'facilities', id: req.params.id }, async tx => {
      const facility = await tx.get('facilities', req.params.id);
      if (!facility || (req.user.role !== 'ADMIN' && facility.operatorId !== req.user.id)) fail(404, 'Facility not found.');
      if (confirmName !== facility.name) fail(400, 'Type the facility name exactly to confirm removal.');
      if (facility.removedAt) fail(409, 'This listing is already removed.');
      if ((await tx.all('bookings')).some(b => b.facilityId === facility.id && ['CONFIRMED', 'ACTIVE'].includes(b.status))) fail(409, 'Resolve all confirmed and checked-in reservations before removing this listing.');
      return tx.update('facilities', facility.id, { removedAt: new Date().toISOString() });
    }));
  });
  app.post('/api/manage/facilities/:id/restore', auth('OPERATOR', 'ADMIN'), async (req, res) => {
    res.json(await store.transaction({ table: 'facilities', id: req.params.id }, async tx => {
      const facility = await tx.get('facilities', req.params.id);
      if (!facility || (req.user.role !== 'ADMIN' && facility.operatorId !== req.user.id)) fail(404, 'Facility not found.');
      if (!facility.removedAt) fail(409, 'This listing has not been removed.');
      return tx.update('facilities', facility.id, { removedAt: null, status: 'PENDING' });
    }));
  });
  app.patch('/api/manage/slots/:id', auth('OPERATOR', 'ADMIN'), async (req, res) => {
    const { blocked } = z.object({ blocked: z.boolean() }).parse(req.body);
    const slot = await store.get('slots', req.params.id);
    if (!slot) fail(404, 'Slot not found.');
    const f = await store.get('facilities', slot.facilityId);
    if (req.user.role !== 'ADMIN' && f.operatorId !== req.user.id) fail(403, 'You cannot update this space.');
    res.json(await store.transaction({ table: 'facilities', id: slot.facilityId }, async tx => {
      if ((await tx.get('slots', slot.id))?.retired) fail(409, 'This space has been removed from capacity.');
      if (blocked && (await tx.all('bookings')).some(b => b.slotId === slot.id && (b.status === 'ACTIVE' || (b.status === 'CONFIRMED' && b.endAt > new Date().toISOString())))) fail(409, 'A reserved space cannot be blocked.');
      return tx.update('slots', slot.id, { blocked: blocked ? 1 : 0 });
    }));
  });
  app.get('/api/admin/users', auth('ADMIN'), async (req, res) => res.json((await store.all('users')).map(publicUser)));
  managementRoutes(app, { store, auth, hydrate, fail });
  operatorProRoutes(app, { store, auth, hydrate, fail, demoMode });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((e, req, res, next) => {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This record already exists.' });
    if (!e.status || e.status >= 500) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong. Please try again.' });
  });
  return app;
}
