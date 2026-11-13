'use client';
import { useEffect, useId, useRef, useState } from 'react';

export function durationLabel(minutes) {
  const m = Math.round(minutes), h = Math.floor(m / 60), rest = m % 60;
  return h ? `${h}h${rest ? ` ${rest}m` : ''}` : `${m} min`;
}
export function parseDuration(text) {
  const value = text.toLowerCase().trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value));
  const match = value.match(/^(?:(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h))?\s*(?:(\d+)\s*(?:minutes?|mins?|m))?$/);
  if (!match || (!match[1] && !match[2])) return null;
  return Math.round(Number(match[1] || 0) * 60 + Number(match[2] || 0));
}
export default function DurationControl({ minutes, onChange, max = 1440, label = 'Parking duration', compact = false, disabled = false }) {
  const id = useId();
  const editing = useRef(false);
  const [text, setText] = useState(durationLabel(minutes)), [invalid, setInvalid] = useState(false);
  useEffect(() => { if (!editing.current) { setText(durationLabel(minutes)); setInvalid(false); } }, [minutes]);
  function commit() {
    const next = parseDuration(text);
    if (next === null || next < 15 || next > max) { setInvalid(true); setText(durationLabel(minutes)); return; }
    setInvalid(false); onChange(next); setText(durationLabel(next));
  }
  return <div className={`duration-control ${compact ? 'compact-duration' : ''}`}>
    <div className="duration-entry"><input id={id} aria-label={label} value={text} disabled={disabled} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined} onFocus={() => { editing.current = true; }} onChange={e => { const raw = e.target.value; setText(raw); const parsed = parseDuration(raw); if (parsed !== null && parsed >= 15 && parsed <= max) { setInvalid(false); onChange(parsed); } }} onBlur={() => { editing.current = false; commit(); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); editing.current = false; commit(); } }} placeholder="30 min or 1h 30m" /><span>type or slide</span></div>
    <input type="range" min="15" max={max} step="1" value={minutes} disabled={disabled} aria-label={`${label} slider`} aria-valuetext={durationLabel(minutes)} onChange={e => onChange(Number(e.target.value))} />
    {!compact && <div className="duration-presets">{[30, 60, 120, 240].filter(n => n <= max).map(n => <button disabled={disabled} type="button" className={n === minutes ? 'chosen' : ''} key={n} onClick={() => onChange(n)}>{durationLabel(n)}</button>)}<small>15 min–{durationLabel(max)}</small></div>}
    {invalid && <small className="duration-error" id={`${id}-error`} role="alert">Enter 15–{max} minutes, e.g. “30 min”.</small>}
  </div>;
}
