import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { publicUser } from './membership.js';

const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(5).max(50).default(10), q: z.string().trim().max(190).default(''), status: z.string().max(30).default('ALL'), role: z.string().max(20).default('ALL'), sort: z.enum(['newest', 'oldest', 'name', 'amount']).default('newest'), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), timezoneOffset: z.coerce.number().min(-840).max(840).default(0), userId: z.string().max(64).optional() });
const includes = (q, ...fields) => fields.some(v => String(v || '').toLowerCase().includes(q.toLowerCase()));
export function managementRoutes(app, { store, auth, hydrate, fail }) {
  app.get('/api/admin/overview', auth('ADMIN'), async (req, res) => {
    const [bookings, facilities, users, tickets] = await Promise.all(['bookings', 'facilities', 'users', 'supportTickets'].map(t => store.all(t)));
    res.json({ bookingValue: bookings.filter(b => b.status !== 'CANCELLED').reduce((n, b) => n + Number(b.total), 0), reservations: bookings.length, activeVehicles: bookings.filter(b => b.status === 'ACTIVE').length, facilities: facilities.length, pendingFacilities: facilities.filter(f => f.status === 'PENDING').length, users: users.length, suspendedUsers: users.filter(u => u.status === 'SUSPENDED').length, openTickets: tickets.filter(t => t.status === 'OPEN').length });
  });
  app.get('/api/admin/manage/:resource', auth('ADMIN'), async (req, res) => {
    const params = pageSchema.parse(req.query), { q, status, role, sort } = params;
    const resource = req.params.resource;
    const arrivalDate = value => new Date(Date.parse(value) - params.timezoneOffset * 60000).toISOString().slice(0, 10);
    if (!['reservations', 'facilities', 'people', 'support', 'audit'].includes(resource)) fail(404, 'Management view not found.');
    const [users, facilities] = await Promise.all([store.all('users'), store.all('facilities')]);
    let rows;
    if (resource === 'people') {
      const bookings = await store.all('bookings');
      rows = users.map(u => ({ ...publicUser(u), reservationCount: bookings.filter(b => b.userId === u.id).length, facilityCount: facilities.filter(f => f.operatorId === u.id).length })).filter(u => includes(q, u.name, u.email, u.id, u.vehicle) && (status === 'ALL' || u.status === status) && (role === 'ALL' || u.role === role));
    } else if (resource === 'facilities') rows = facilities.map(f => ({ ...f, operatorName: users.find(u => u.id === f.operatorId)?.name, operatorStatus: users.find(u => u.id === f.operatorId)?.status || 'ACTIVE' })).filter(f => includes(q, f.name, f.address, f.operatorName) && (status === 'ALL' || f.status === status));
    else if (resource === 'reservations') {
      rows = (await store.all('bookings')).map(b => ({ ...b, name: facilities.find(f => f.id === b.facilityId)?.name, driverName: users.find(u => u.id === b.userId)?.name, driverEmail: users.find(u => u.id === b.userId)?.email })).filter(b => includes(q, b.id, b.name, b.driverName, b.driverEmail, b.vehicle) && (status === 'ALL' || b.status === status) && (!params.userId || b.userId === params.userId) && (!params.from || arrivalDate(b.startAt) >= params.from) && (!params.to || arrivalDate(b.startAt) <= params.to));
    } else if (resource === 'support') rows = (await store.all('supportTickets')).map(t => ({ ...t, name: t.subject, driverName: users.find(u => u.id === t.userId)?.name })).filter(t => includes(q, t.id, t.subject, t.driverName, t.message) && (status === 'ALL' || t.status === status));
    else rows = (await store.all('auditLogs')).map(a => ({ ...a, actorName: users.find(u => u.id === a.actorId)?.name, targetName: users.find(u => u.id === a.targetId)?.name })).filter(a => includes(q, a.action, a.actorName, a.targetName, a.targetId));
    rows.sort((a, b) => resource === 'support' && sort === 'newest' ? Number(b.priority === 'PRIORITY') - Number(a.priority === 'PRIORITY') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id) : sort === 'name' ? String(a.name || a.id).localeCompare(String(b.name || b.id)) : sort === 'amount' ? Number(b.total || b.rate || 0) - Number(a.total || a.rate || 0) : (sort === 'oldest' ? 1 : -1) * (String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id)) || a.id.localeCompare(b.id)));
    const total = rows.length, pages = Math.max(1, Math.ceil(total / params.pageSize)), page = Math.min(params.page, pages);
    const items = rows.slice((page - 1) * params.pageSize, page * params.pageSize);
    res.json({ items: resource === 'reservations' ? await hydrate(items) : items, total, page, pages, pageSize: params.pageSize });
  });
  app.patch('/api/admin/users/:id', auth('ADMIN'), async (req, res) => {
    const body = z.object({ name: z.string().trim().min(2).max(100).optional(), email: z.email().max(190).transform(s => s.toLowerCase()).optional(), vehicle: z.string().trim().max(30).optional(), role: z.enum(['DRIVER', 'OPERATOR']).optional(), status: z.enum(['ACTIVE', 'SUSPENDED']).optional(), reason: z.string().trim().min(5).max(300) }).strict().parse(req.body);
    const result = await store.transaction({ table: 'users', id: req.params.id }, async tx => {
      const current = await tx.get('users', req.params.id);
      if (!current) fail(404, 'Account not found.');
      if (current.role === 'ADMIN' && (body.role || body.status)) fail(409, 'Administrator role and access cannot be changed here.');
      if (body.email && (await tx.all('users')).some(u => u.id !== current.id && u.email.toLowerCase() === body.email)) fail(409, 'This email is already registered.');
      if (body.role && body.role !== current.role) {
        if ((await tx.all('facilities')).some(f => f.operatorId === current.id)) fail(409, 'This operator owns facilities. Their role must stay operator.');
        if ((await tx.all('bookings')).some(b => b.userId === current.id && ['CONFIRMED', 'ACTIVE'].includes(b.status) && b.endAt > new Date().toISOString())) fail(409, 'Resolve this driver’s upcoming and active reservations before changing their role.');
      }
      const { reason, ...patch } = body;
      const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== (current[key] ?? (key === 'status' ? 'ACTIVE' : ''))));
      if (!Object.keys(changes).length) fail(400, 'No account changes were provided.');
      if (changes.role || changes.status || changes.email) changes.sessionVersion = Number(current.sessionVersion || 0) + 1;
      const user = await tx.update('users', current.id, changes);
      await tx.insert('auditLogs', { id: randomUUID(), actorId: req.user.id, targetId: current.id, action: changes.status ? `ACCOUNT_${changes.status}` : changes.role ? 'ACCOUNT_ROLE_CHANGED' : 'ACCOUNT_UPDATED', changes: JSON.stringify(Object.fromEntries(Object.entries(changes).filter(([key]) => key !== 'sessionVersion').map(([key, value]) => [key, { from: current[key] ?? null, to: value }]))), reason, createdAt: new Date().toISOString() });
      return publicUser(user);
    });
    res.json(result);
  });
}
