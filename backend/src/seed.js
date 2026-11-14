import bcrypt from 'bcryptjs';
import { extraFacilities, makeSlots } from './catalog.js';
import { varyDemoCapacity } from './capacity.js';

export async function seedData() {
  const passwordHash = await bcrypt.hash('ParkEase@123', 10);
  const users = [
    { id: 'driver-demo', name: 'Shorya', email: 'driver@parkease.com', role: 'DRIVER', passwordHash, vehicle: 'DL 01 AB 1234' },
    { id: 'operator-demo', name: 'Rajesh Sharma', email: 'operator@parkease.com', role: 'OPERATOR', passwordHash, vehicle: '' },
    { id: 'admin-demo', name: 'Vikram Mehra', email: 'admin@parkease.com', role: 'ADMIN', passwordHash, vehicle: '' }
  ];
  const facilities = [
    { id: 'cp-central', name: 'CP Central Parking', address: 'Block A, Connaught Place, New Delhi', lat: 28.6328, lng: 77.2197, rate: 40, rating: 4.8, covered: 1, ev: 1, status: 'APPROVED', operatorId: 'operator-demo', tag: 'Most popular', distance: '0.4', image: 'city' },
    { id: 'palika', name: 'Palika Underground', address: 'Palika Bazaar, Connaught Place, New Delhi', lat: 28.6311, lng: 77.2182, rate: 30, rating: 4.6, covered: 1, ev: 0, status: 'APPROVED', operatorId: 'operator-demo', tag: 'Great value', distance: '0.7', image: 'garage' },
    { id: 'janpath', name: 'Janpath Avenue Parking', address: 'Janpath Road, New Delhi', lat: 28.6268, lng: 77.2191, rate: 35, rating: 4.7, covered: 0, ev: 1, status: 'APPROVED', operatorId: 'operator-demo', tag: 'EV friendly', distance: '1.2', image: 'garden' },
    { id: 'shivaji', name: 'Shivaji Stadium Parking', address: 'Baba Kharak Singh Marg, New Delhi', lat: 28.6316, lng: 77.2115, rate: 25, rating: 4.5, covered: 1, ev: 0, status: 'APPROVED', operatorId: 'operator-demo', tag: 'Easy access', distance: '1.5', image: 'stadium' },
    { id: 'saket', name: 'Saket District Parking', address: 'District Centre, Saket, New Delhi', lat: 28.5285, lng: 77.219, rate: 50, rating: 0, covered: 1, ev: 1, status: 'PENDING', operatorId: 'operator-demo', tag: 'New facility', distance: '14', image: 'city' }
  ];
  facilities.push(...extraFacilities);
  const slots = makeSlots(facilities);
  const data = { users, facilities, slots, bookings: [] };
  varyDemoCapacity(data);
  return data;
}
