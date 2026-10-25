import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[''].version, pkg.version);
assert.equal(lock.name, pkg.name);
const deny = /(?:^|\/)(?:fixtures|handoff|node_modules|output|tmp|qa-results|\.git)(?:\/|$)|\.pdf$|(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx|tar|zip|tgz)$|\.tar\.gz$|(?:^|\/)sku-nhi-map[^/]*\.csv$/i;
const secrets = [ /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{50,}/, /sk-(?:proj-)?[A-Za-z0-9_-]{40,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ ];
function inspect(file) {
  assert.ok(!deny.test(file), `Forbidden release path: ${file}`);
  assert.ok(statSync(file).isFile(), `Unexpected release entry: ${file}`);
  if (/\.(?:ts|mjs|js|json|html|css|md|txt|yml|yaml)$/.test(file)) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!secrets.some(pattern => pattern.test(text)), `Credential pattern detected in ${file}`);
  }
}
function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = `${dir}/${entry.name}`;
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}
const mode = process.argv[2] ?? 'source';
assert.ok(['source', 'dist'].includes(mode), 'Use source or dist');
// Locally deleted tracked files are absent from the next release, even before staging.
const files = mode === 'source'
  ? execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(file => file && existsSync(file))
  : filesIn('dist');
assert.ok(files.length > 0);
for (const file of files) inspect(file);
const manifest = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8'));
for (const asset of manifest.assets) {
  assert.ok(!path.isAbsolute(asset.path) && !asset.path.split('/').includes('..'));
  const file = `${mode === 'dist' ? 'dist' : 'public'}/assets/${asset.path}`;
  const bytes = readFileSync(file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, `Asset hash mismatch: ${file}`);
}
if (mode === 'dist') {
  assert.ok(!files.some(file => /(?:^|\/)(?:qa\.html|src|tests|scripts)(?:\/|$)/.test(file)));
  const entry = files.filter(file => /^dist\/assets\/index-.*\.js$/.test(file)).map(file => readFileSync(file, 'utf8')).join('\n');
  assert.ok(entry.includes(`v${pkg.version}`), 'Built UI version missing');
}
console.log(JSON.stringify({ mode, version: `v${pkg.version}`, files: files.length, verifiedAssets: manifest.assets.length, forbiddenPaths: 0, credentialPatterns: 0 }));
