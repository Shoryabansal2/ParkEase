import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const localConfig = fileURLToPath(new URL('../data/mysql-test-runtime/connection.json', import.meta.url));
const config = process.env.PARKEASE_MYSQL_TEST_CONFIG || (!process.env.DB_HOST && !process.env.DB_USER && existsSync(localConfig) ? localConfig : '');
const files = (await readdir(new URL('./', import.meta.url))).filter(f => f.endsWith('.test.js')).map(f => fileURLToPath(new URL(f, import.meta.url)));
const child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...files], { stdio: 'inherit', env: { ...process.env, PARKEASE_TEST_MYSQL: 'true', ...(config ? { PARKEASE_MYSQL_TEST_CONFIG: config } : {}) } });
child.on('exit', code => process.exit(code ?? 1));
