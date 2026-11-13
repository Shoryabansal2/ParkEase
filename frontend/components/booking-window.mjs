export function localDateValue(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function localTimeValue(date) { const d = new Date(date); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
export function bookingBounds(advanceHours = 24, now = Date.now()) {
  const earliest = Math.ceil(Number(now) / 60000) * 60000;
  const latest = Math.floor((Number(now) + advanceHours * 3600000) / 60000) * 60000;
  return { earliest, latest, minDate: localDateValue(earliest), maxDate: localDateValue(latest), earliestTime: localTimeValue(earliest), latestTime: localTimeValue(latest) };
}
export function clampWindow(date, time, advanceHours = 24, now = Date.now()) {
  const b = bookingBounds(advanceHours, now);
  const parsed = new Date(`${date}T${time}`).getTime();
  const safe = Math.min(b.latest, Math.max(b.earliest, Number.isFinite(parsed) ? parsed : b.earliest));
  return { date: localDateValue(safe), time: localTimeValue(safe) };
}
