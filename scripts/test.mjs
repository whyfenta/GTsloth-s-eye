import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const file of readdirSync('tests').filter(name => name.endsWith('.test.ts'))) {
  const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', `tests/${file}`], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
