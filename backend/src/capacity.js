import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export const capacitySchema = z.object({ CAR: z.number().int().min(0).max(500), BIKE: z.number().int().min(0).max(500), EV: z.number().int().min(0).max(500) }).strict().refine(c => c.CAR + c.BIKE + c.EV >= 1 && c.CAR + c.BIKE + c.EV <= 500, 'Choose between 1 and 500 total spaces.');
export const slotCapacity = slots => Object.fromEntries(['CAR', 'BIKE', 'EV'].map(type => [type, slots.filter(s => !s.retired && s.vehicleType === type).length]));
export const demoCapacities = {
  'cp-central': { CAR: 40, BIKE: 12, EV: 6 }, palika: { CAR: 60, BIKE: 18, EV: 0 }, janpath: { CAR: 18, BIKE: 12, EV: 4 }, shivaji: { CAR: 32, BIKE: 14, EV: 0 }, saket: { CAR: 48, BIKE: 16, EV: 8 },
  'india-gate': { CAR: 45, BIKE: 20, EV: 6 }, 'khan-market': { CAR: 20, BIKE: 10, EV: 4 }, 'karol-bagh': { CAR: 36, BIKE: 24, EV: 0 }, 'nehru-place': { CAR: 55, BIKE: 20, EV: 8 }, aerocity: { CAR: 90, BIKE: 20, EV: 12 }, 'cyber-hub': { CAR: 75, BIKE: 18, EV: 10 }, 'noida-sector18': { CAR: 65, BIKE: 24, EV: 8 }, 'rajouri-garden': { CAR: 28, BIKE: 18, EV: 0 }
};
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
export function planCapacity(facility, slots, bookings, capacity, { preserveReservations = false } = {}) {
  const updates = [], inserts = [], protectedIds = new Set(bookings.filter(b => ['CONFIRMED', 'ACTIVE'].includes(b.status)).map(b => b.slotId));
  for (const type of ['CAR', 'BIKE', 'EV']) {
    const all = slots.filter(s => s.facilityId === facility.id && s.vehicleType === type), current = all.filter(s => !s.retired);
    const protectedCount = current.filter(s => protectedIds.has(s.id)).length;
    const desired = preserveReservations ? Math.max(capacity[type], protectedCount) : capacity[type];
    if (desired < protectedCount) fail(`${type}: ${protectedCount} spaces have confirmed or checked-in reservations. Resolve these reservations before reducing capacity further.`);
    if (desired < current.length) {
      const candidates = current.filter(s => !protectedIds.has(s.id)).reverse();
      for (const slot of candidates.slice(0, current.length - desired)) updates.push({ id: slot.id, retired: 1 });
    } else {
      let needed = desired - current.length;
      for (const slot of all.filter(s => s.retired && !protectedIds.has(s.id)).slice(0, needed)) { updates.push({ id: slot.id, retired: 0 }); needed--; }
      const prefix = type === 'CAR' ? 'P' : type === 'BIKE' ? 'M' : 'E', labels = new Set(slots.map(s => s.label));
      let number = 1;
      while (needed-- > 0) {
        while (labels.has(`${prefix}-${String(number).padStart(3, '0')}`)) number++;
        const label = `${prefix}-${String(number++).padStart(3, '0')}`; labels.add(label);
        inserts.push({ id: randomUUID(), facilityId: facility.id, label, vehicleType: type, blocked: 0, retired: 0 });
      }
    }
  }
  return { updates, inserts };
}
export async function applyCapacity(tx, facility, capacity) {
  const plan = planCapacity(facility, await tx.all('slots'), await tx.all('bookings'), capacity);
  for (const { id, ...patch } of plan.updates) await tx.update('slots', id, patch);
  for (const slot of plan.inserts) await tx.insert('slots', slot);
  await tx.update('facilities', facility.id, { capacityConfigured: 1 });
  return slotCapacity((await tx.all('slots')).filter(s => s.facilityId === facility.id));
}
export function varyDemoCapacity(data) {
  for (const [id, capacity] of Object.entries(demoCapacities)) {
    const facility = data.facilities.find(f => f.id === id && f.operatorId === 'operator-demo');
    if (!facility || facility.capacityConfigured) continue;
    const plan = planCapacity(facility, data.slots, data.bookings || [], capacity, { preserveReservations: true });
    for (const patch of plan.updates) Object.assign(data.slots.find(s => s.id === patch.id), patch);
    data.slots.push(...plan.inserts); facility.capacityConfigured = 1;
  }
}
