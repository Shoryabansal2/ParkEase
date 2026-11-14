import { createHash } from 'node:crypto';
import { z } from 'zod';

const when = value => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export async function notificationFeed(store, user, now = Date.now()) {
  const [bookings, facilities, slots, payments, reads, tickets] = await Promise.all(['bookings', 'facilities', 'slots', 'payments', 'notificationReads', 'supportTickets'].map(t => store.all(t)));
  const seen = new Map(reads.filter(r => r.userId === user.id).map(r => [r.id, r.readAt])), events = [];
  const add = (key, kind, title, message, createdAt, extra = {}) => {
    if (!Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) < now - 90 * 86400000 || Date.parse(createdAt) > now) return;
    const id = createHash('sha256').update(`${user.id}:${key}`).digest('hex');
    events.push({ id, kind, title, message, createdAt, readAt: seen.get(id) || null, ...extra });
  };
  const owned = new Set(facilities.filter(f => f.operatorId === user.id).map(f => f.id));
  const relevant = bookings.filter(b => user.role === 'DRIVER' ? b.userId === user.id : user.role === 'OPERATOR' ? owned.has(b.facilityId) : false);
  for (const b of relevant) {
    const name = facilities.find(f => f.id === b.facilityId)?.name || 'Parking facility', bay = slots.find(s => s.id === b.slotId)?.label || 'your bay';
    const extra = { bookingId: b.id };
    add(`confirmed:${b.id}`, 'booking', 'Reservation confirmed', `${name} · Bay ${bay} · ${when(b.startAt)} IST.`, b.createdAt, extra);
    if (b.status === 'CANCELLED') add(`cancelled:${b.id}`, 'cancellation', 'Reservation cancelled', `${name} · Bay ${bay}. Your reservation is no longer active.`, b.cancelledAt || b.createdAt, extra);
    if (b.checkedInAt) add(`entry:${b.id}`, 'entry', 'Vehicle checked in', `${b.vehicle} · ${name} · Bay ${bay}.`, b.checkedInAt, extra);
    if (b.checkedOutAt) add(`exit:${b.id}`, 'exit', 'Parking visit completed', `${name} · ${b.vehicle} has checked out.`, b.checkedOutAt, extra);
    if (b.status === 'CONFIRMED' && Date.parse(b.startAt) > now && Date.parse(b.startAt) - now <= 3600000) add(`arrival:${b.id}:${b.startAt}`, 'reminder', 'Your parking starts soon', `${name} · Bay ${bay} · Arrival ${when(b.startAt)} IST.`, new Date(Date.parse(b.startAt) - 3600000).toISOString(), extra);
    if (b.status === 'ACTIVE') {
      const remaining = Date.parse(b.endAt) - now;
      if (remaining > 0 && remaining <= 1800000) add(`departure:${b.id}:${b.endAt}`, 'reminder', 'Your parking ends soon', `${name} · Departure ${when(b.endAt)} IST. Extend your booking if you need more time.`, new Date(Date.parse(b.endAt) - 1800000).toISOString(), extra);
      if (remaining <= 0) add(`overdue:${b.id}:${b.endAt}`, 'reminder', 'Reserved departure has passed', `${name} · Bay ${bay}. Contact the parking operator to arrange departure.`, b.endAt, extra);
    }
    for (const payment of payments.filter(p => p.bookingId === b.id && p.purpose === 'EXTENSION' && p.status !== 'SIMULATED_VOIDED')) add(`extension:${payment.id}`, 'extension', 'Parking time extended', `${name} · Additional parking time payment of ₹${Number(payment.amount).toFixed(2)} recorded.`, payment.createdAt, extra);
  }
  for (const [tier, expiresAt, plan, href] of [[user.membershipTier, user.membershipExpiresAt, 'Premium VIP', '/membership'], [user.operatorTier, user.operatorExpiresAt, 'Operator Pro', '/operator/pro']]) {
    if (!expiresAt || !['PREMIUM', 'PRO'].includes(tier)) continue;
    const remaining = Date.parse(expiresAt) - now;
    if (remaining <= 0) add(`expired:${plan}:${expiresAt}`, 'membership', `${plan} has expired`, 'Your standard features remain available. Renew to regain membership benefits.', expiresAt, { href });
    else if (remaining <= 3 * 86400000) add(`expiring:${plan}:${expiresAt}`, 'membership', `${plan} expires soon`, `Membership ends ${when(expiresAt)} IST. There is no automatic renewal.`, new Date(Date.parse(expiresAt) - 3 * 86400000).toISOString(), { href });
  }
  for (const payment of payments.filter(p => p.userId === user.id && ['MEMBERSHIP', 'OPERATOR_PRO'].includes(p.purpose) && p.status === 'SIMULATED_PAID')) add(`membership:${payment.id}`, 'membership', `${payment.purpose === 'OPERATOR_PRO' ? 'Operator Pro' : 'Premium VIP'} payment confirmed`, `₹${Number(payment.amount).toFixed(2)} membership payment recorded.`, payment.createdAt, { href: payment.purpose === 'OPERATOR_PRO' ? '/operator/pro' : '/membership' });
  if (user.role === 'ADMIN') {
    for (const t of tickets.filter(t => t.status === 'OPEN')) add(`support:${t.id}`, 'support', 'Support request received', t.subject, t.createdAt, { href: '/admin' });
  }
  return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 200);
}

export function driverToolsRoutes(app, { store, auth, hydrate, fail }) {
  app.get('/api/notifications', auth(), async (req, res) => {
    const { page, pageSize, unread } = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(5).max(25).default(10), unread: z.enum(['true', 'false']).default('false') }).parse(req.query);
    const feed = await notificationFeed(store, req.user), unreadCount = feed.filter(n => !n.readAt).length;
    const rows = unread === 'true' ? feed.filter(n => !n.readAt) : feed, pages = Math.max(1, Math.ceil(rows.length / pageSize)), current = Math.min(page, pages);
    res.json({ items: rows.slice((current - 1) * pageSize, current * pageSize), unreadCount, total: rows.length, page: current, pages, generatedAt: new Date().toISOString() });
  });
  app.post('/api/notifications/read-all', auth(), async (req, res) => {
    await store.transaction({ table: 'users', id: req.user.id }, async tx => {
      for (const item of (await notificationFeed(tx, req.user)).filter(n => !n.readAt)) if (!await tx.get('notificationReads', item.id)) await tx.insert('notificationReads', { id: item.id, userId: req.user.id, readAt: new Date().toISOString() });
    });
    res.json({ success: true });
  });
  app.post('/api/notifications/:id/read', auth(), async (req, res) => {
    await store.transaction({ table: 'users', id: req.user.id }, async tx => {
      const item = (await notificationFeed(tx, req.user)).find(n => n.id === req.params.id);
      if (!item) fail(404, 'Notification not found.');
      if (!await tx.get('notificationReads', item.id)) await tx.insert('notificationReads', { id: item.id, userId: req.user.id, readAt: new Date().toISOString() });
    });
    res.json({ success: true });
  });
  async function accessible(req) {
    const b = await store.get('bookings', req.params.id);
    if (!b) fail(404, 'Booking not found.');
    const f = await store.get('facilities', b.facilityId);
    if (req.user.id !== b.userId && req.user.role !== 'ADMIN' && !(req.user.role === 'OPERATOR' && f?.operatorId === req.user.id)) fail(403, 'This reservation belongs to another account.');
    return b;
  }
  app.get('/api/bookings/:id', auth(), async (req, res) => res.json((await hydrate([await accessible(req)]))[0]));
  app.get('/api/bookings/:id/location', auth(), async (req, res) => {
    const booking = await accessible(req);
    if (booking.status === 'CANCELLED') fail(409, 'Cancelled reservations do not have an active parking location.');
    const b = (await hydrate([booking]))[0], all = await store.all('slots');
    const zone = b.slot.label.split('-')[0];
    const bays = all.filter(s => s.facilityId === b.facilityId && s.label.split('-')[0] === zone && (!s.retired || s.id === b.slotId)).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })).map(({ id, label, vehicleType }) => ({ id, label, vehicleType }));
    res.json({ booking: b, zone, bays, note: await store.get('parkingNotes', b.id) || { floor: '', landmark: '' }, schematic: true });
  });
  app.put('/api/bookings/:id/location', auth('DRIVER'), async (req, res) => {
    const body = z.object({ floor: z.string().trim().max(60), landmark: z.string().trim().max(200) }).strict().parse(req.body);
    const b = await accessible(req);
    if (b.status === 'CANCELLED') fail(409, 'This reservation is cancelled.');
    const note = await store.transaction({ table: 'bookings', id: b.id }, async tx => {
      if ((await tx.get('bookings', b.id)).status === 'CANCELLED') fail(409, 'This reservation is cancelled.');
      const row = { ...body, userId: req.user.id, updatedAt: new Date().toISOString() };
      return await tx.get('parkingNotes', b.id) ? tx.update('parkingNotes', b.id, row) : tx.insert('parkingNotes', { id: b.id, ...row });
    });
    res.json(note);
  });
}
