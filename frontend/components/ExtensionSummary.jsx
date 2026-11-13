import { Crown } from 'lucide-react';
export const roundMoney = amount => Math.round((amount + Number.EPSILON) * 100) / 100;
const money = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
export function extensionPrice(booking, extraHours) {
  if (!booking) return { total: 0, extra: 0, extraBase: 0, extraDiscount: 0, discount: 0 };
  const hours = (Date.parse(booking.endAt) - Date.parse(booking.startAt)) / 3600000;
  const factor = (hours + extraHours) / hours;
  const fee = Number(booking.convenienceFee || 0);
  const total = roundMoney((Number(booking.total) - fee) * factor + fee), baseTotal = roundMoney(Number(booking.baseTotal ?? (booking.total - fee)) * factor);
  const extraBase = roundMoney(baseTotal - Number(booking.baseTotal ?? booking.total)), extra = roundMoney(total - Number(booking.total));
  return { total, extra, extraBase, extraDiscount: roundMoney(extraBase - extra), discount: roundMoney(baseTotal - (total - fee)) };
}
export default function ExtensionSummary({ booking, hours }) {
  const price = extensionPrice(booking, hours);
  return <><div className="summary-line already-paid"><span>Already paid · no need to pay again</span><strong>{money(booking.total)}</strong></div><div className="summary-line"><span>Extra time · before discount</span><strong>{money(price.extraBase)}</strong></div><div className="summary-line vip-price-row"><span>{booking.membershipTier === 'PREMIUM' && <Crown size={13} />} {booking.membershipTier === 'PREMIUM' ? 'VIP membership discount on extra time' : 'Membership discount on extra time'}</span><strong>−{money(price.extraDiscount)}</strong></div><div className="extension-pay-now"><div><span>Pay now for this extension</span><small>Only the additional time is charged.</small></div><strong>{money(price.extra)}</strong></div><div className="extension-combined"><span>Combined booking value after extension</span><strong>{money(price.total)}</strong><small>{money(booking.total)} already paid + {money(price.extra)} to pay now</small></div>{booking.membershipTier === 'PREMIUM' && <p className="extension-savings">Total membership savings after extension: <strong>{money(price.discount)}</strong></p>}</>;
}
