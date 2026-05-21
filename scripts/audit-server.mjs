import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const serverDir = path.join(rootDir, 'server');
const cacheDir = path.join(serverDir, '.npm-cache');
const logsDir = path.join(cacheDir, '_logs');

mkdirSync(logsDir, { recursive: true });

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['audit', '--omit=dev'],
  {
    cwd: serverDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
      npm_config_logs_dir: logsDir,
    },
  }
);

process.exit(result.status ?? 1);

