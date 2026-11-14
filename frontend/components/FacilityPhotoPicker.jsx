'use client';
import { useId, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';

export default function FacilityPhotoPicker({ value, existingUrl, onChange, onBusyChange = () => {}, disabled = false }) {
  const id = useId(), [error, setError] = useState(''), [reading, setReading] = useState(false), [filename, setFilename] = useState('');
  const preview = value === undefined ? existingUrl : value;
  async function choose(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setError('Choose a JPG, PNG, or WebP image.'); return; }
    if (file.size > 2 * 1024 * 1024) { setError('Choose an image no larger than 2 MB.'); return; }
    setReading(true); onBusyChange(true);
    try {
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('The photo could not be read. Try another file.')); reader.readAsDataURL(file); });
      await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => image.width >= 320 && image.height >= 200 && image.width * image.height <= 20000000 ? resolve() : reject(new Error('Use an image at least 320 × 200 pixels and no more than 20 megapixels.')); image.onerror = () => reject(new Error('This file is not a valid image.')); image.src = data; });
      onChange(data); setFilename(file.name);
    } catch (e) { setError(e.message); }
    finally { setReading(false); onBusyChange(false); }
  }
  return <div className="facility-photo-picker"><label htmlFor={id}><ImagePlus size={17} />Parking photo <span>Optional</span></label><p id={`${id}-help`}>Show drivers your parking entrance or bays. JPG, PNG, or WebP · up to 2 MB · at least 320 × 200 px. Uploaded photos will be visible on your listing.</p>{preview && <div className="facility-upload-preview"><img src={preview} alt="Parking listing photo preview" /><span className="facility-upload-filename">{filename || 'Current listing photo'}</span><button type="button" className="btn small" disabled={disabled || reading} onClick={() => { onChange(null); setFilename(''); setError(''); }}><X size={13} />Remove photo</button></div>}<input id={id} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload parking photo" aria-describedby={`${id}-help`} disabled={disabled || reading} onChange={choose} />{reading && <p role="status">Preparing your photo…</p>}{error && <p className="photo-picker-error" role="alert">{error}</p>}</div>;
}
