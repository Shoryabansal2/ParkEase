export const extraFacilities = [
  { id: 'india-gate', name: 'India Gate Visitor Parking', address: 'C-Hexagon, India Gate, New Delhi', lat: 28.6129, lng: 77.2295, rate: 45, ev: 1, covered: 0, distance: '3.8', image: 'garden', tag: 'Near the landmark' },
  { id: 'khan-market', name: 'Khan Market District Parking', address: 'Khan Market, Rabindra Nagar, New Delhi', lat: 28.6002, lng: 77.227, rate: 50, ev: 1, covered: 1, distance: '5.1', image: 'city', tag: 'Shop & stroll' },
  { id: 'karol-bagh', name: 'Karol Bagh Metro Parking', address: 'Pusa Road, Karol Bagh, New Delhi', lat: 28.6508, lng: 77.1900, rate: 30, ev: 0, covered: 1, distance: '4.7', image: 'garage', tag: 'Metro connection' },
  { id: 'nehru-place', name: 'Nehru Place Business Parking', address: 'District Centre, Nehru Place, New Delhi', lat: 28.5494, lng: 77.2516, rate: 35, ev: 1, covered: 1, distance: '11.4', image: 'stadium', tag: 'Workday ready' },
  { id: 'aerocity', name: 'Aerocity Central Parking', address: 'Worldmark District, Aerocity, New Delhi', lat: 28.5505, lng: 77.121, rate: 60, ev: 1, covered: 1, distance: '16.2', image: 'city', tag: 'Airport district' },
  { id: 'cyber-hub', name: 'Cyber Hub Business Parking', address: 'DLF Cyber City, Sector 24, Gurugram', lat: 28.4950, lng: 77.088, rate: 60, ev: 1, covered: 1, distance: '23.8', image: 'garage', tag: 'Business & dining' },
  { id: 'noida-sector18', name: 'Sector 18 Market Parking', address: 'Sector 18, Noida, Uttar Pradesh', lat: 28.5700, lng: 77.321, rate: 40, ev: 1, covered: 1, distance: '16.5', image: 'stadium', tag: 'Across the NCR' },
  { id: 'rajouri-garden', name: 'Rajouri Garden Market Parking', address: 'Ring Road, Rajouri Garden, New Delhi', lat: 28.649, lng: 77.1216, rate: 35, ev: 0, covered: 0, distance: '10.9', image: 'garden', tag: 'Market favorite' }
].map((f, i) => ({ ...f, rating: [4.6, 4.7, 4.5, 4.6, 4.8, 4.7, 4.6, 4.5][i], status: 'APPROVED', operatorId: 'operator-demo' }));
export function makeSlots(facilities) {
  return facilities.flatMap(f => Array.from({ length: 36 }, (_, i) => ({ id: `${f.id}-${i + 1}`, facilityId: f.id, label: `${i < 12 ? 'A' : i < 24 ? 'B' : 'C'}-${String(i % 12 + 1).padStart(2, '0')}`, vehicleType: i < 24 ? 'CAR' : i < 32 ? 'BIKE' : 'EV', blocked: i === 4 || i === 17 ? 1 : 0 })));
}
