'use client';
import { Bike, CarFront, Zap } from 'lucide-react';
export default function CapacityFields({ value, onChange, disabled = false }) {
  const total = Object.values(value).reduce((n, v) => n + Number(v || 0), 0);
  return <fieldset className="capacity-fields" disabled={disabled}><legend>Parking capacity</legend><p>Set the number of spaces available for each vehicle type.</p><div className="capacity-inputs">{[{ type: 'CAR', name: 'Car spaces', icon: CarFront }, { type: 'BIKE', name: 'Bike spaces', icon: Bike }, { type: 'EV', name: 'EV spaces', icon: Zap }].map(({ type, name, icon: Icon }) => <label key={type}><span><Icon size={15} />{name}</span><input type="number" aria-label={name} min="0" max="500" step="1" required value={value[type]} onChange={e => onChange({ ...value, [type]: e.target.value === '' ? '' : Number(e.target.value) })} /></label>)}</div><div className={`capacity-total ${total < 1 || total > 500 ? 'capacity-invalid' : ''}`}><span>Total parking spaces</span><strong>{total}</strong></div><small>1–500 spaces in total. Capacity reductions preserve booking history and cannot remove reserved or checked-in bays.</small></fieldset>;
}
