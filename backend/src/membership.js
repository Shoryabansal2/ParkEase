import { operatorMembership } from './operator-policy.js';
export function membership(user, now = Date.now()) {
  const premium = user?.role === 'DRIVER' && user.membershipTier === 'PREMIUM' && Date.parse(user.membershipExpiresAt || '') > now;
  return { tier: premium ? 'PREMIUM' : 'STANDARD', expiresAt: user?.membershipExpiresAt || null, advanceHours: premium ? 168 : 24, discountPercent: premium ? 20 : 0, cancellationMinutes: premium ? 30 : 120, support: premium ? 'PRIORITY' : 'STANDARD' };
}
export function priorityEV(slot, facility) { return !!facility?.ev && slot.vehicleType === 'EV' && ['C-11', 'C-12'].includes(slot.label); }
export function cancellationDeadline(booking) { return new Date(Date.parse(booking.startAt) - (booking.membershipTier === 'PREMIUM' ? 30 : 120) * 60000).toISOString(); }
export const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, vehicle: u.vehicle, status: u.status || 'ACTIVE', createdAt: u.createdAt || null, membership: membership(u), operatorMembership: operatorMembership(u) });
