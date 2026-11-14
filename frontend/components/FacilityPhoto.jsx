'use client';
import { useState } from 'react';

export const samplePhoto = facility => !facility.covered || facility.image === 'garden'
  ? { src: '/images/parking/outdoor.jpg', credit: 'Kindel Media', source: 'https://www.pexels.com/photo/photograph-of-cars-in-a-parking-lot-9799759/' }
  : facility.image === 'garage'
    ? { src: '/images/parking/garage.jpg', credit: 'Mak_ jp', source: 'https://www.pexels.com/photo/cars-on-parking-lot-18133067/' }
    : { src: '/images/parking/deck.jpg', credit: 'Jan van der Wolf', source: 'https://www.pexels.com/photo/empty-parking-deck-8961732/' };

export default function FacilityPhoto({ facility }) {
  const [failed, setFailed] = useState(null), sample = samplePhoto(facility);
  const uploaded = facility.photoUrl && failed !== facility.photoUrl;
  const src = uploaded ? facility.photoUrl : sample.src;
  return <><img className="facility-photo" src={src} alt={uploaded ? `${facility.name} parking photo uploaded by its operator` : `Sample ${sample.src.includes('outdoor') ? 'outdoor' : 'indoor'} parking photograph; not the actual ${facility.name} facility`} loading="lazy" decoding="async" onError={() => setFailed(src)} />{!uploaded && <a className="facility-photo-credit" href={sample.source} target="_blank" rel="noreferrer" title={`Sample photo by ${sample.credit} on Pexels`}>Sample photo · Pexels</a>}</>;
}
