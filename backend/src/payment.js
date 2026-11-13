import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { paymentErrors } from '../../shared/payment-validation.mjs';
export const VIP_MONTHLY_PRICE = 999;
export const STANDARD_CONVENIENCE_FEE = 10;
export const money = amount => Math.round((amount + Number.EPSILON) * 100) / 100;
export const paymentSchema = z.object({ method: z.enum(['UPI', 'CARD']), outcome: z.enum(['SUCCESS', 'FAILED']), expectedAmount: z.number().nonnegative().optional(), details: z.object({ upi: z.string().max(325).optional(), number: z.string().max(30).optional(), holder: z.string().max(100).optional(), expiry: z.string().max(5).optional(), cvv: z.string().max(4).optional() }) }).superRefine((payment, ctx) => {
  for (const [field, message] of Object.entries(paymentErrors(payment.method, payment.details))) ctx.addIssue({ code: 'custom', path: ['details', field], message });
}).transform(({ details, ...safe }) => safe);
export async function recordPayment(tx, { payment, userId, purpose, amount, bookingId = null }) {
  if (payment.outcome !== 'SUCCESS') { const e = new Error('Demo payment failed. Nothing was charged or reserved. Try another payment method.'); e.status = 402; throw e; }
  if (payment.expectedAmount !== undefined && Math.abs(payment.expectedAmount - amount) > 0.005) { const e = new Error('The price has changed. Review your reservation and try again.'); e.status = 409; throw e; }
  return tx.insert('payments', { id: `PAY-${randomUUID().slice(0, 12).toUpperCase()}`, userId, purpose, amount, method: payment.method, status: 'SIMULATED_PAID', bookingId, createdAt: new Date().toISOString() });
}
export function nextBillingMonth(now = new Date()) {
  const next = new Date(now), day = next.getUTCDate();
  next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next.toISOString();
}
