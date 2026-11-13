export function paymentErrors(method, details = {}, now = new Date()) {
  const errors = {};
  if (method === 'UPI') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/.test(String(details.upi || '').trim())) errors.upi = 'Enter a valid UPI ID, such as name@bank.';
  } else if (method === 'CARD') {
    const number = String(details.number || '').replace(/\s/g, '');
    let sum = 0;
    for (let i = number.length - 1, double = false; i >= 0; i--, double = !double) { let n = Number(number[i]); if (double) { n *= 2; if (n > 9) n -= 9; } sum += n; }
    if (!/^\d{13,19}$/.test(number) || /^(\d)\1+$/.test(number) || sum % 10 !== 0) errors.number = 'Enter a valid card number (checksum required).';
    if (!/^[\p{L}][\p{L} .'-]{1,99}$/u.test(String(details.holder || '').trim())) errors.holder = 'Enter the cardholder’s name.';
    const match = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(details.expiry || '');
    if (!match || new Date(2000 + Number(match?.[2]), Number(match?.[1]), 1) <= now) errors.expiry = 'Enter a current or future expiry in MM/YY format.';
    if (!/^\d{3,4}$/.test(details.cvv || '')) errors.cvv = 'Enter a 3 or 4 digit security code.';
  } else errors.method = 'Choose UPI or card.';
  return errors;
}
export const TEST_PAYMENT_DETAILS = {
  UPI: { upi: 'parkease.demo@upi' },
  CARD: { number: '4242 4242 4242 4242', holder: 'ParkEase Demo', expiry: '12/39', cvv: '123' }
};
