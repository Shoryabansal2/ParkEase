import sharp from 'sharp';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const PHOTO_BODY_LIMIT = '3mb';
export const defaultPhotoDirectory = new URL('../data/uploads/facilities/', import.meta.url);
const invalid = message => Object.assign(new Error(message), { status: 400 });

export async function saveFacilityPhoto(value, directory) {
  const match = typeof value === 'string' && /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw invalid('Upload a JPG, PNG, or WebP image.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) throw invalid('Parking photos must be 2 MB or smaller.');
  let output;
  try {
    const image = sharp(bytes, { limitInputPixels: 20000000, animated: false });
    const meta = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format) || meta.format !== match[1] || (meta.pages || 1) > 1 || meta.width < 320 || meta.height < 200) throw new Error('Invalid dimensions or format');
    output = await image.rotate().resize({ width: 1200, height: 900, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch { throw invalid('Choose a valid, still JPG, PNG, or WebP image of at least 320 × 200 pixels and at most 20 megapixels.'); }
  const filename = `${randomUUID()}.webp`, path = join(directory, filename);
  await mkdir(directory, { recursive: true });
  await writeFile(path, output, { flag: 'wx' });
  return { photoUrl: `/api/uploads/facilities/${filename}`, discard: () => unlink(path).catch(() => {}) };
}
