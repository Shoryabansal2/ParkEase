import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep local demo sessions valid across watch-mode restarts. The key stays in
// ignored local data, never in source code or a public API response.
export async function sessionSecret(file, configured = process.env.JWT_SECRET) {
  if (configured) return configured;
  const path = file instanceof URL ? fileURLToPath(file) : file;
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const key = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{96}$/.test(key)) throw new Error('The local session signing key is invalid. Configure JWT_SECRET.');
  return key;
}
