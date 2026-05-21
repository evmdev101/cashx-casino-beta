import { spawnSync } from 'node:child_process';
import path from 'node:path';

const rootDir = process.cwd();
const serverDir = path.join(rootDir, 'server');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('node', ['--check', path.join(serverDir, 'mines-server.js')]);
run('node', ['--check', path.join(serverDir, 'pvp-server.js')]);

