'use client';
import { useState } from 'react';
import { ArrowRight, Check, CreditCard, LoaderCircle, ShieldCheck, Smartphone } from 'lucide-react';
import { paymentErrors, TEST_PAYMENT_DETAILS } from '../../shared/payment-validation.mjs';
const money = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
export default function PaymentCheckout({ amount, title = 'Complete your payment', description, onPay, onCancel, embedded = false }) {
  const [method, setMethod] = useState('UPI'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [details, setDetails] = useState({ upi: '', number: '', holder: '', expiry: '', cvv: '' }), [touched, setTouched] = useState({});
  const errors = paymentErrors(method, details), valid = Object.keys(errors).length === 0;
  function change(field, value) { setDetails(d => ({ ...d, [field]: value })); setError(''); }
  async function pay(outcome = 'SUCCESS') {
    setTouched(Object.fromEntries(Object.keys(errors).map(key => [key, true])));
    if (!valid) { setError('Check the highlighted payment details before continuing.'); return; }
    setBusy(true); setError('');
    try { await onPay({ method, outcome, expectedAmount: amount, details: method === 'UPI' ? { upi: details.upi.trim() } : { number: details.number, holder: details.holder.trim(), expiry: details.expiry, cvv: details.cvv } }); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function field(name, label, props = {}) {
    const hasError = touched[name] && errors[name];
    return <label className={hasError ? 'payment-field invalid' : 'payment-field'}>{label}<input {...props} name={`demo-${name}`} value={details[name]} disabled={busy} autoComplete="off" required aria-invalid={!!hasError} aria-describedby={hasError ? `payment-${name}-error` : undefined} onChange={e => change(name, e.target.value)} onBlur={() => setTouched(t => ({ ...t, [name]: true }))} />{hasError && <small className="field-error" id={`payment-${name}-error`}>{errors[name]}</small>}</label>;
  }
  return <section className={`payment-checkout ${embedded ? 'embedded-checkout' : ''}`} aria-label="Payment checkout">
    <div className="eyebrow"><ShieldCheck size={14} /> PARKEASE CHECKOUT</div><h2 id={embedded ? undefined : 'dialog-title'}>{title}</h2><p className="dialog-description">{description}</p>
    <div className="checkout-amount"><span>Amount to pay</span><strong>{money(amount)}</strong><small>INR · simulated transaction</small></div>
    <form noValidate onSubmit={e => { e.preventDefault(); pay(); }}>
      <fieldset className="payment-methods"><legend>Choose a payment method</legend>{[{ id: 'UPI', icon: Smartphone, label: 'UPI', text: 'Enter a UPI ID' }, { id: 'CARD', icon: CreditCard, label: 'Debit / credit card', text: 'Enter card details' }].map(({ id, icon: Icon, label, text }) => <label className={method === id ? 'chosen' : ''} key={id}><input type="radio" name="payment-method" value={id} checked={method === id} disabled={busy} onChange={() => { setMethod(id); setError(''); setTouched({}); }} /><span className="payment-method-icon"><Icon size={22} /></span><span><strong>{label}</strong><small>{text}</small></span>{method === id && <Check size={17} />}</label>)}</fieldset>
      <div className="payment-details"><div className="payment-details-heading"><h3>{method === 'UPI' ? 'UPI details' : 'Card details'}</h3><button type="button" disabled={busy} onClick={() => { setDetails(d => ({ ...d, ...TEST_PAYMENT_DETAILS[method] })); setTouched({}); setError(''); }}>Use test details</button></div>
        {method === 'UPI' ? field('upi', 'UPI ID', { placeholder: 'name@bank', maxLength: 325, spellCheck: false }) : <>{field('holder', 'Cardholder name', { placeholder: 'Name on card', maxLength: 100 })}{field('number', 'Card number', { placeholder: '4242 4242 4242 4242', inputMode: 'numeric', maxLength: 23 })}<div className="card-details-row">{field('expiry', 'Expiry date', { placeholder: 'MM/YY', maxLength: 5, inputMode: 'numeric' })}{field('cvv', 'Security code', { placeholder: 'CVV', type: 'password', inputMode: 'numeric', maxLength: 4 })}</div></>}
        {valid && <p className="payment-format-valid" role="status"><Check size={14} />Format looks correct. Bank authorization is simulated.</p>}
      </div>
      <p className="checkout-disclaimer">College demo: use test details only. No real charge, PIN, or OTP. Payment details are validated and discarded; only the method and receipt are saved.</p>
      {error && <p className="checkout-error" role="alert">{error}</p>}
      <button type="submit" className="btn primary full checkout-pay" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}Pay {money(amount)} & confirm <ArrowRight size={17} /></button>
      <div className="checkout-secondary"><button type="button" disabled={busy} onClick={onCancel}>Back to review</button><button type="button" disabled={busy} onClick={() => pay('FAILED')}>Test a failed payment</button></div>
    </form>
  </section>;
}
