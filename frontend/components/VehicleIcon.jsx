import { Bike, CarFront, Zap } from 'lucide-react';

export default function VehicleIcon({ type = 'CAR', size = 25 }) {
  const Icon = type === 'BIKE' ? Bike : type === 'EV' ? Zap : CarFront;
  return <Icon size={size} aria-hidden="true" data-vehicle-type={type} />;
}
