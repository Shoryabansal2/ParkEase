import { z } from 'zod';
import PDFDocument from 'pdfkit';
import { money } from './payment.js';
import { IST_OFFSET } from './pricing.js';
const dayKey = value => new Date(Date.parse(value) + IST_OFFSET).toISOString().slice(0, 10);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function reportWindow(input = {}, now = Date.now()) {
  const today = dayKey(new Date(now).toISOString());
  const query = z.object({ from: z.string().regex(datePattern).default(dayKey(new Date(now - 29 * 86400000).toISOString())), to: z.string().regex(datePattern).default(today), facilityId: z.string().max(64).optional() }).parse(input);
  const fromUTC = Date.parse(`${query.from}T00:00:00Z`), toUTC = Date.parse(`${query.to}T00:00:00Z`);
  if (!Number.isFinite(fromUTC) || !Number.isFinite(toUTC) || new Date(fromUTC).toISOString().slice(0, 10) !== query.from || new Date(toUTC).toISOString().slice(0, 10) !== query.to || toUTC < fromUTC || (toUTC - fromUTC) / 86400000 >= 90) { const e = new Error('Choose a valid date range of 1 to 90 days.'); e.status = 400; throw e; }
  return { ...query, start: fromUTC - IST_OFFSET, end: toUTC + 86400000 - IST_OFFSET, timezone: 'Asia/Kolkata' };
}
const percent = (a, b) => b ? Math.min(100, money(a / b * 100)) : 0;
export async function operatorAnalytics(store, userId, input) {
  const window = reportWindow(input);
  const [allFacilities, slots, allBookings, users, payments] = await Promise.all(['facilities', 'slots', 'bookings', 'users', 'payments'].map(t => store.all(t)));
  const owned = allFacilities.filter(f => f.operatorId === userId);
  if (window.facilityId && !owned.some(f => f.id === window.facilityId)) { const e = new Error('Facility not found.'); e.status = 404; throw e; }
  const facilities = owned.filter(f => !window.facilityId || f.id === window.facilityId), ids = new Set(facilities.map(f => f.id));
  const facilityMap = new Map(facilities.map(f => [f.id, f])), slotMap = new Map(slots.map(s => [s.id, s])), userMap = new Map(users.map(u => [u.id, u]));
  const ownedBookings = allBookings.filter(b => ids.has(b.facilityId));
  const bookings = ownedBookings.filter(b => Date.parse(b.startAt) >= window.start && Date.parse(b.startAt) < window.end).sort((a, b) => a.startAt.localeCompare(b.startAt)).map(b => ({ ...b, facilityName: facilityMap.get(b.facilityId)?.name, driverName: userMap.get(b.userId)?.name || 'Driver', bay: slotMap.get(b.slotId)?.label, vehicleType: slotMap.get(b.slotId)?.vehicleType || 'CAR' }));
  const valid = bookings.filter(b => b.status !== 'CANCELLED');
  const parkingValue = b => Math.max(0, Number(b.total) - Number(b.convenienceFee || 0));
  const serviceable = slots.filter(s => ids.has(s.facilityId) && !s.blocked), serviceIds = new Set(serviceable.map(s => s.id));
  const overlapping = ownedBookings.filter(b => b.status !== 'CANCELLED' && serviceIds.has(b.slotId) && Date.parse(b.startAt) < window.end && Date.parse(b.endAt) > window.start);
  const reservedMs = (start, end) => overlapping.reduce((n, b) => n + Math.max(0, Math.min(end, Date.parse(b.endAt)) - Math.max(start, Date.parse(b.startAt))), 0);
  const daily = [];
  for (let at = window.start; at < window.end; at += 86400000) {
    const key = dayKey(new Date(at).toISOString()), arrivals = valid.filter(b => dayKey(b.startAt) === key);
    const cancellations = bookings.filter(b => b.status === 'CANCELLED' && dayKey(b.startAt) === key).length;
    daily.push({ date: key, bookings: arrivals.length, cancellations, parkingValue: money(arrivals.reduce((n, b) => n + parkingValue(b), 0)), occupancy: percent(reservedMs(at, at + 86400000), serviceable.length * 86400000) });
  }
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, bookings: valid.filter(b => new Date(Date.parse(b.startAt) + IST_OFFSET).getUTCHours() === hour).length }));
  const vehicleMix = ['CAR', 'BIKE', 'EV'].map(type => ({ type, bookings: valid.filter(b => b.vehicleType === type).length }));
  const ownedBookingIds = new Set(ownedBookings.map(b => b.id));
  const collectionValue = payments.filter(p => ownedBookingIds.has(p.bookingId) && p.status === 'SIMULATED_PAID' && Date.parse(p.createdAt) >= window.start && Date.parse(p.createdAt) < window.end).reduce((n, p) => n + Number(p.amount), 0);
  return { window, generatedAt: new Date().toISOString(), facilities: facilities.map(({ id, name }) => ({ id, name })), summary: { reservations: bookings.length, cancelled: bookings.length - valid.length, parkingValue: money(valid.reduce((n, b) => n + parkingValue(b), 0)), convenienceFees: money(valid.reduce((n, b) => n + Number(b.convenienceFee || 0), 0)), bookingValue: money(valid.reduce((n, b) => n + Number(b.total), 0)), collectionValue: money(collectionValue), serviceableBays: serviceable.length, occupancy: percent(reservedMs(window.start, window.end), serviceable.length * (window.end - window.start)), peakHour: valid.length ? hourly.reduce((a, b) => b.bookings > a.bookings ? b : a).hour : null }, daily, hourly, vehicleMix, bookings };
}
const ist = value => value ? new Date(Date.parse(value) + IST_OFFSET).toISOString().slice(0, 19).replace('T', ' ') : '';
const csvCell = value => { let text = String(value ?? ''); if (/^\s*[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
export function reportCSV(data) {
  const rows = [['Booking ID', 'Facility', 'Driver', 'Vehicle', 'Type', 'Bay', 'Arrival IST', 'Departure IST', 'Status', 'Parking before discount INR', 'Discount INR', 'Convenience fee INR', 'Booking total INR', 'Checked in IST', 'Checked out IST'], ...data.bookings.map(b => [b.id, b.facilityName, b.driverName, b.vehicle, b.vehicleType, b.bay, ist(b.startAt), ist(b.endAt), b.status, b.baseTotal ?? b.total, b.discountAmount || 0, b.convenienceFee || 0, b.total, ist(b.checkedInAt), ist(b.checkedOutAt)])];
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
export function reportPDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: 'ParkEase Operator Pro Report' } }), chunks = [];
    doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const text = value => String(value || '').normalize('NFKD').replace(/[^\x20-\x7E\n]/g, '?');
    doc.fillColor('#254b37').font('Helvetica-Bold').fontSize(21).text('ParkEase | Operator Pro');
    doc.fillColor('#23352b').fontSize(12).text('Parking activity report');
    doc.font('Helvetica').fontSize(10).text(`${data.window.from} to ${data.window.to} | India Standard Time`);
    doc.text(text(data.facilities.map(f => f.name).join(', ') || 'No facilities')); doc.moveDown();
    const s = data.summary;
    for (const line of [`Reservations: ${s.reservations} | Cancelled: ${s.cancelled}`, `Parking booking value: INR ${s.parkingValue.toFixed(2)}`, `Convenience fees: INR ${s.convenienceFees.toFixed(2)} | Total booking value: INR ${s.bookingValue.toFixed(2)}`, `Collections recorded in this period: INR ${s.collectionValue.toFixed(2)}`, `Reserved bay utilisation: ${s.occupancy}% | Current serviceable bays: ${s.serviceableBays}`]) doc.text(line);
    doc.moveDown().fontSize(8).fillColor('#65765b').text('Simulated payments. Booking rows use arrival dates; collections use receipt dates. Utilisation uses booked time and current non-maintenance capacity, not sensor readings. Cancelled bookings are excluded from value and utilisation.');
    doc.moveDown().fillColor('#23352b').font('Helvetica-Bold').fontSize(12).text('Reservations'); doc.moveDown(.5);
    if (!data.bookings.length) doc.font('Helvetica').fontSize(10).text('No reservations for this period.');
    for (const b of data.bookings) {
      if (doc.y > 710) { doc.addPage(); doc.font('Helvetica-Bold').fontSize(12).text('ParkEase | Reservations continued'); doc.moveDown(); }
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#254b37').text(`${text(b.id)} | ${text(b.facilityName)} | ${b.status} | INR ${Number(b.total).toFixed(2)}`);
      doc.font('Helvetica').fontSize(8).fillColor('#526146').text(`${text(b.driverName)} | ${text(b.vehicle)} | ${b.vehicleType} | Bay ${text(b.bay)}`);
      doc.text(`${ist(b.startAt)} to ${ist(b.endAt)} IST`);
      doc.text(`Before discount: INR ${Number(b.baseTotal ?? b.total).toFixed(2)} | Discount: INR ${Number(b.discountAmount || 0).toFixed(2)} | Convenience fee: INR ${Number(b.convenienceFee || 0).toFixed(2)}`);
      doc.text(`Checked in: ${ist(b.checkedInAt) || '-'} | Checked out: ${ist(b.checkedOutAt) || '-'} IST`); doc.moveDown(.8);
    }
    doc.end();
  });
}
