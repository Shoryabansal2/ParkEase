import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionSecret } from '../src/session-secret.js';

test('local session keys persist across restarts and configured JWT_SECRET takes precedence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'parkease-session-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'session.key');
  const first = await sessionSecret(file, '');
  assert.match(first, /^[a-f0-9]{96}$/);
  assert.equal(await sessionSecret(file, ''), first);
  assert.equal(await sessionSecret(file, 'configured-key'), 'configured-key');
});
