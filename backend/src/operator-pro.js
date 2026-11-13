import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operatorMembership, OPERATOR_PRO_PRICE } from './operator-policy.js';
import { publicUser } from './membership.js';
import { paymentSchema, recordPayment, nextBillingMonth } from './payment.js';
import { operatorAnalytics, reportCSV, reportPDF } from './operator-analytics.js';
const timeString = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const ruleSchema = z.object({ facilityId: z.string().max(64), name: z.string().trim().min(3).max(80), days: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(days => new Set(days).size === days.length, 'Choose each day once.'), startTime: timeString, endTime: z.union([timeString, z.literal('24:00')]), rate: z.number().min(5).max(1000), enabled: z.boolean().default(true) }).strict();
const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const publicRule = r => ({ ...r, days: JSON.parse(r.days), startTime: clock(Number(r.startMinute)), endTime: clock(Number(r.endMinute)), enabled: !!r.enabled, rate: Number(r.rate) });
export function operatorProRoutes(app, { store, auth, fail, demoMode, hydrate }) {
  const requirePro = user => { if (operatorMembership(user).tier !== 'PRO') fail(403, 'An active Operator Pro membership is required for this feature.'); };
  app.get('/api/operator/pro', auth('OPERATOR'), async (req, res) => {
    const receipts = (await store.all('payments')).filter(p => p.userId === req.user.id && p.purpose === 'OPERATOR_PRO').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
    res.json({ membership: operatorMembership(req.user), receipts, payments: 'SIMULATED' });
  });
  app.post('/api/operator/pro/activate', auth('OPERATOR'), async (req, res) => {
    if (!demoMode) fail(403, 'Operator Pro checkout is available only in the college demo until a payment provider is configured.');
    const payment = paymentSchema.parse(req.body.payment);
    const user = await store.transaction({ table: 'users', id: req.user.id }, async tx => {
      const current = await tx.get('users', req.user.id);
      if (operatorMembership(current).tier === 'PRO') fail(409, 'Your Operator Pro membership is already active.');
      await recordPayment(tx, { payment, userId: current.id, purpose: 'OPERATOR_PRO', amount: OPERATOR_PRO_PRICE });
      return tx.update('users', current.id, { operatorTier: 'PRO', operatorExpiresAt: nextBillingMonth() });
    });
    res.json({ user: publicUser(user), membership: operatorMembership(user), payment: 'SIMULATED', price: OPERATOR_PRO_PRICE });
  });
  app.get('/api/operator/pro/analytics', auth('OPERATOR'), async (req, res) => {
    requirePro(req.user); const { bookings, ...analytics } = await operatorAnalytics(store, req.user.id, req.query); res.json(analytics);
  });
  app.get('/api/operator/pro/alerts', auth('OPERATOR'), async (req, res) => {
    requirePro(req.user);
    const params = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(5).max(50).default(10), facilityId: z.string().max(64).optional() }).parse(req.query);
    const owned = (await store.all('facilities')).filter(f => f.operatorId === req.user.id);
    if (params.facilityId && !owned.some(f => f.id === params.facilityId)) fail(404, 'Facility not found.');
    const ids = new Set(owned.filter(f => !params.facilityId || f.id === params.facilityId).map(f => f.id));
    const now = Date.now(), rows = (await store.all('bookings')).filter(b => ids.has(b.facilityId) && b.status === 'ACTIVE' && Date.parse(b.endAt) < now).sort((a, b) => a.endAt.localeCompare(b.endAt));
    const total = rows.length, pages = Math.max(1, Math.ceil(total / params.pageSize)), page = Math.min(params.page, pages);
    res.json({ items: (await hydrate(rows.slice((page - 1) * params.pageSize, page * params.pageSize))).map(b => ({ ...b, overdueMinutes: Math.ceil((now - Date.parse(b.endAt)) / 60000) })), total, page, pages, pageSize: params.pageSize, generatedAt: new Date(now).toISOString() });
  });
  app.get('/api/operator/pro/rules', auth('OPERATOR'), async (req, res) => {
    const owned = (await store.all('facilities')).filter(f => f.operatorId === req.user.id), ids = new Set(owned.map(f => f.id));
    res.json((await store.all('pricingRules')).filter(r => ids.has(r.facilityId)).map(r => ({ ...publicRule(r), facilityName: owned.find(f => f.id === r.facilityId)?.name })).sort((a, b) => a.facilityName.localeCompare(b.facilityName) || a.startMinute - b.startMinute));
  });
  async function saveRule(req, res) {
    requirePro(req.user);
    const editing = !!req.params.id;
    const input = (editing ? ruleSchema.partial().extend({ enabled: z.boolean().optional() }) : ruleSchema).parse(req.body);
    const saved = await store.transaction({ table: 'users', id: req.user.id }, async tx => {
      requirePro(await tx.get('users', req.user.id));
      const old = editing ? await tx.get('pricingRules', req.params.id) : null;
      if (editing && !old) fail(404, 'Pricing rule not found.');
      if (old && (await tx.get('facilities', old.facilityId))?.operatorId !== req.user.id) fail(404, 'Pricing rule not found.');
      const base = old ? { facilityId: old.facilityId, name: old.name, days: JSON.parse(old.days), startTime: clock(Number(old.startMinute)), endTime: clock(Number(old.endMinute)), rate: Number(old.rate), enabled: !!old.enabled } : {};
      const full = ruleSchema.parse({ ...base, ...input });
      const facility = await tx.get('facilities', full.facilityId);
      if (!facility || facility.operatorId !== req.user.id) fail(404, 'Facility not found.');
      const startMinute = minutes(full.startTime), endMinute = minutes(full.endTime);
      if (endMinute - startMinute < 15) fail(400, 'Choose a time band of at least 15 minutes. Split overnight schedules into two rules.');
      const rules = (await tx.all('pricingRules')).filter(r => r.facilityId === full.facilityId && r.id !== old?.id);
      if ((!editing || old.facilityId !== full.facilityId) && rules.length >= 50) fail(409, 'A facility supports up to 50 pricing rules. Edit an existing rule.');
      if (full.enabled && rules.some(r => r.enabled && JSON.parse(r.days).some(d => full.days.includes(d)) && Number(r.startMinute) < endMinute && Number(r.endMinute) > startMinute)) fail(409, 'This time band overlaps another enabled rule at this facility.');
      const row = { facilityId: full.facilityId, name: full.name, days: JSON.stringify(full.days), startMinute, endMinute, rate: full.rate, enabled: Number(full.enabled) };
      return editing ? tx.update('pricingRules', old.id, row) : tx.insert('pricingRules', { ...row, id: randomUUID(), createdAt: new Date().toISOString() });
    });
    res.status(editing ? 200 : 201).json(publicRule(saved));
  }
  app.post('/api/operator/pro/rules', auth('OPERATOR'), saveRule);
  app.patch('/api/operator/pro/rules/:id', auth('OPERATOR'), saveRule);
  app.get('/api/operator/pro/reports/:format', auth('OPERATOR'), async (req, res) => {
    requirePro(req.user);
    const format = z.enum(['csv', 'pdf']).parse(req.params.format);
    const data = await operatorAnalytics(store, req.user.id, req.query);
    if (data.bookings.length > 10000) fail(413, 'Narrow the date range to export at most 10,000 reservations.');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `attachment; filename="parkease-${data.window.from}-${data.window.to}.${format}"`);
    res.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf').send(format === 'csv' ? reportCSV(data) : await reportPDF(data));
  });
}
