'use client';
import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { localDateValue } from './booking-window.mjs';

export default function BookingDatePicker({ value, min, max, onChange, label = 'Parking date', tier = 'Standard' }) {
  const [open, setOpen] = useState(false), [month, setMonth] = useState(value.slice(0, 7));
  const root = useRef(null), trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    const outside = e => { if (!root.current?.contains(e.target)) setOpen(false); };
    const escape = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  const first = new Date(`${month}-01T12:00`), year = first.getFullYear(), monthIndex = first.getMonth();
  const length = new Date(year, monthIndex + 1, 0).getDate(), offset = (first.getDay() + 6) % 7;
  const previous = localDateValue(new Date(year, monthIndex - 1, 1)).slice(0, 7), next = localDateValue(new Date(year, monthIndex + 1, 1)).slice(0, 7);
  return <div className={`booking-date-picker ${open ? 'calendar-open' : ''}`} ref={root}>
    <button type="button" ref={trigger} className="calendar-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setMonth(value.slice(0, 7)); setOpen(!open); }}><span>{new Date(`${value}T12:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span><CalendarDays size={15} /></button>
    {open && <section className="booking-calendar" role="dialog" aria-label={`${label} calendar`}><div className="calendar-month"><button type="button" aria-label="Previous month" disabled={previous < min.slice(0, 7)} onClick={() => setMonth(previous)}><ChevronLeft size={17} /></button><strong>{first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</strong><button type="button" aria-label="Next month" disabled={next > max.slice(0, 7)} onClick={() => setMonth(next)}><ChevronRight size={17} /></button></div><div className="calendar-week">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i}>{d}</span>)}</div><div className="calendar-days">{Array.from({ length: offset }, (_, i) => <span key={`blank-${i}`} />)}{Array.from({ length }, (_, i) => { const d = localDateValue(new Date(year, monthIndex, i + 1)); const locked = d < min || d > max; return <button type="button" key={d} disabled={locked} aria-label={new Date(`${d}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} aria-pressed={value === d} className={value === d ? 'chosen' : ''} onClick={() => { onChange(d); setOpen(false); trigger.current?.focus(); }}>{i + 1}</button>; })}</div><p>{tier === 'Premium VIP' ? 'VIP: book up to 7 days ahead.' : 'Standard: book up to 24 hours ahead.'}<br /><span>Grey dates are outside your booking window.</span></p></section>}
  </div>;
}
