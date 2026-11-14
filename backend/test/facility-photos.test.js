import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

test('facility photo uploads validate, persist, and respect listing ownership', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'parkease-photos-'));
  const store = await createStore();
  const server = createApp(store, { secret: 'isolated-photo-tests', photoDirectory: directory }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); for (const file of await readdir(directory)) await unlink(join(directory, file)); await rmdir(directory); });
  const req = async (path, token, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const operator = (await req('/auth/demo', null, 'POST', { role: 'OPERATOR' })).data.token;
  const driver = (await req('/auth/demo', null, 'POST', { role: 'DRIVER' })).data.token;
  const admin = (await req('/auth/login', null, 'POST', { email: 'admin@parkease.com', password: 'ParkEase@123' })).data.token;
  const foreign = (await req('/auth/register', null, 'POST', { name: 'Photo Operator', email: 'photo.operator@example.com', password: 'PhotoTest@123', role: 'OPERATOR' })).data.token;
  const bytes = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#526c48' } }).jpeg().toBuffer();
  const photo = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  const fields = { name: 'Uploaded Photo Parking', address: 'Test Avenue, New Delhi, 110001', lat: 28.6, lng: 77.2, rate: 40, covered: true, ev: false };
  const startAt = new Date(Date.now() + 3600000).toISOString(), endAt = new Date(Date.now() + 7200000).toISOString();
  const discovery = '/facilities?' + new URLSearchParams({ startAt, endAt, vehicleType: 'CAR' });
  let facility;
  await t.test('create stores an optimized local photo and retains pending approval', async () => {
    const response = await req('/manage/facilities', operator, 'POST', { ...fields, photo });
    assert.equal(response.status, 201); facility = response.data;
    assert.equal(facility.status, 'PENDING'); assert.match(facility.photoUrl, /^\/api\/uploads\/facilities\/[a-f0-9-]+\.webp$/); assert.equal(facility.photo, undefined);
    const image = await fetch(base.replace(/\/api$/, '') + facility.photoUrl); assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type'), /image\/webp/); assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    const meta = await sharp(Buffer.from(await image.arrayBuffer())).metadata(); assert.equal(meta.format, 'webp'); assert.equal(meta.width, 1200); assert.equal(meta.exif, undefined);
    assert.ok(!(await req(discovery)).data.some(f => f.id === facility.id));
    assert.equal((await req(`/manage/facilities/${facility.id}`, admin, 'PATCH', { status: 'APPROVED' })).status, 200);
    assert.equal((await req(discovery)).data.find(f => f.id === facility.id).photoUrl, facility.photoUrl);
  });
  await t.test('authentication and ownership protect uploads and replacements', async () => {
    const before = (await readdir(directory)).length;
    assert.equal((await req('/manage/facilities', null, 'POST', { ...fields, photo })).status, 401);
    assert.equal((await req('/manage/facilities', driver, 'POST', { ...fields, photo })).status, 403);
    assert.equal((await req(`/manage/facilities/${facility.id}`, foreign, 'PATCH', { photo })).status, 403);
    assert.equal((await readdir(directory)).length, before);
  });
  await t.test('corrupt, spoofed, unsupported, oversized and undersized images create no files or listings', async () => {
    const before = (await readdir(directory)).length, count = (await store.all('facilities')).length;
    const tiny = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } }).png().toBuffer();
    const invalid = ['data:image/svg+xml;base64,PHN2Zy8+', 'data:image/jpeg;base64,bm90LWltYWdl', photo.replace('image/jpeg', 'image/png'), `data:image/png;base64,${tiny.toString('base64')}`, `data:image/jpeg;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}`];
    for (const bad of invalid) assert.equal((await req('/manage/facilities', operator, 'POST', { ...fields, photo: bad })).status, 400);
    assert.equal((await readdir(directory)).length, before); assert.equal((await store.all('facilities')).length, count);
  });
  await t.test('owners can replace and remove a photo without changing bookings or listing status', async () => {
    const updated = await req(`/manage/facilities/${facility.id}`, operator, 'PATCH', { photo });
    assert.equal(updated.status, 200); assert.notEqual(updated.data.photoUrl, facility.photoUrl); assert.equal(updated.data.status, 'APPROVED');
    const cleared = await req(`/manage/facilities/${facility.id}`, operator, 'PATCH', { photo: null });
    assert.equal(cleared.status, 200); assert.equal(cleared.data.photoUrl, null);
    assert.equal((await req('/uploads/facilities/not-a-file.webp')).status, 404);
  });
});
