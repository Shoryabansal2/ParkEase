import { money, STANDARD_CONVENIENCE_FEE } from './payment.js';
import { operatorMembership } from './operator-policy.js';
export const IST_OFFSET = 330 * 60000;
export function parkingQuote(facility, owner, rules, window, vehicleType, benefits) {
  const start = Date.parse(window.startAt), end = Date.parse(window.endAt);
  const active = operatorMembership(owner).tier === 'PRO' ? rules.filter(r => r.facilityId === facility.id && Number(r.enabled)) : [];
  const cuts = new Set([start, end]);
  for (let day = Math.floor((start + IST_OFFSET) / 86400000) * 86400000 - IST_OFFSET; day < end; day += 86400000) {
    const weekday = new Date(day + IST_OFFSET).getUTCDay();
    if (day > start) cuts.add(day);
    for (const rule of active) if (JSON.parse(rule.days).includes(weekday)) for (const minute of [rule.startMinute, rule.endMinute]) {
      const boundary = day + Number(minute) * 60000;
      if (boundary > start && boundary < end) cuts.add(boundary);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b), segments = [];
  let raw = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1], local = new Date((a + b) / 2 + IST_OFFSET);
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    const rule = active.find(r => JSON.parse(r.days).includes(local.getUTCDay()) && minute >= r.startMinute && minute < r.endMinute);
    const baseRate = Number(rule?.rate ?? facility.rate), rate = vehicleType === 'BIKE' ? Math.round(baseRate * 0.5) : baseRate;
    const amount = rate * (b - a) / 3600000; raw += amount;
    const prior = segments.at(-1);
    if (prior && prior.rate === rate && prior.ruleId === (rule?.id || null)) { prior.endAt = new Date(b).toISOString(); prior.amount += amount; }
    else segments.push({ startAt: new Date(a).toISOString(), endAt: new Date(b).toISOString(), rate, amount, name: rule?.name || 'Standard rate', ruleId: rule?.id || null });
  }
  const baseTotal = money(raw);
  segments.forEach(s => { s.amount = money(s.amount); });
  if (segments.length) segments.at(-1).amount = money(segments.at(-1).amount + baseTotal - segments.reduce((n, s) => n + s.amount, 0));
  const parkingTotal = money(baseTotal * (1 - benefits.discountPercent / 100)), convenienceFee = benefits.tier === 'PREMIUM' ? 0 : STANDARD_CONVENIENCE_FEE;
  return { baseTotal, discountAmount: money(baseTotal - parkingTotal), convenienceFee, total: money(parkingTotal + convenienceFee), scheduled: segments.some(s => s.ruleId), segments, timezone: 'Asia/Kolkata' };
}
