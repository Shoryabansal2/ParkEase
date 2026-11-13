'use client';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
function Focus({ facility, facilities }) {
  const map = useMap();
  const previous = useRef(null);
  const catalogKey = facilities.map(f => f.id).join(',');
  useEffect(() => { if (facilities.length) map.fitBounds(L.latLngBounds(facilities.map(f => [f.lat, f.lng])), { padding: [35, 35], maxZoom: 15 }); }, [catalogKey, map]);
  useEffect(() => { if (facility && previous.current && previous.current !== facility.id) map.flyTo([facility.lat, facility.lng], 15, { duration: 0.6 }); previous.current = facility?.id || null; }, [facility?.id, map]);
  return null;
}
export default function ParkingMap({ facilities, selected, onSelect }) {
  return <MapContainer center={[28.6314, 77.2177]} zoom={15} scrollWheelZoom={false} className="parking-map" aria-label="Parking facilities across Delhi NCR">
    <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
    <Focus facility={selected} facilities={facilities} />
    {facilities.map(f => <Marker key={f.id} position={[f.lat, f.lng]} eventHandlers={{ click: () => onSelect(f) }} icon={L.divIcon({ className: 'price-marker', html: `<span class="${selected?.id === f.id ? 'selected' : ''}">₹${Number(f.rate)}</span>`, iconSize: [64, 35], iconAnchor: [32, 35] })}><Popup><strong>{f.name}</strong><br />{f.available} spaces available</Popup></Marker>)}
  </MapContainer>;
}
