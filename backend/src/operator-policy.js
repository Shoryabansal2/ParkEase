export const OPERATOR_PRO_PRICE = 1499;
export function operatorMembership(user, now = Date.now()) {
  const pro = user?.role === 'OPERATOR' && user.status !== 'SUSPENDED' && user.operatorTier === 'PRO' && Date.parse(user.operatorExpiresAt || '') > now;
  return { tier: pro ? 'PRO' : 'STANDARD', expiresAt: user?.role === 'OPERATOR' ? user.operatorExpiresAt || null : null, price: OPERATOR_PRO_PRICE, billingPeriod: 'MONTH', autoRenew: false };
}
