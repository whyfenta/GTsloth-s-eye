import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

// Exercise the real page handlers with controlled SHA-256 completion, using synthetic data only.
const bundled = await build({ entryPoints: ['src/collect.ts'], bundle: true, write: false, format: 'iife',
  loader: { '.css': 'empty' }, define: { __APP_VERSION__: '"test"' } });
const qr = (date: string) => ['0000000000', '1', '12', 'TESTNAME', 'A123456789', '0500101', '345', date,
  '0099', '7', 'Z9', 'TESTDX', '0000000000', '過敏史:無', 'TESTCODE', '1', 'BID', 'PO', '14'].join(';') + ';';
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
class Element {
  value = ''; textContent = ''; placeholder = ''; hidden = false; disabled = false;
  dataset = {}; className = ''; href = ''; download = ''; children: Element[] = [];
  classList = { toggle() {} };
  listeners = new Map<string, (event: any) => void>();
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, listener); }
  replaceChildren(...items: Element[]) { this.children = items; }
  append(...items: Element[]) { this.children.push(...items); }
  scrollIntoView() {}
  focus() {}
  click() { this.listeners.get('click')?.({}); }
}
function page(stored: Record<string, string> = {}) {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const saved = new Map<string, string>(Object.entries(stored));
  const copied: string[] = [], downloads: Blob[] = [];
  const digests: { resolve: (value: ArrayBuffer) => void; reject: (error: Error) => void }[] = [];
  let serial = 0;
  runInNewContext(bundled.outputFiles[0].text, {
    document: { getElementById: get, createElement: () => new Element() },
    window: { addEventListener() {} },
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) },
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    crypto: { subtle: { digest: () => new Promise<ArrayBuffer>((resolve, reject) => digests.push({ resolve, reject })) } },
    performance: { now: () => 10000 }, confirm: () => true,
    TextEncoder, TextDecoder, Blob, Date,
    URL: { createObjectURL: (blob: Blob) => { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout: () => 1, clearTimeout() {},
  });
  return { get, saved, copied, downloads, digests,
    paste(text: string) { get('scan').listeners.get('paste')!({ preventDefault() {}, clipboardData: { getData: () => text } }); },
    async resolve() { assert.ok(digests.length); digests.shift()!.resolve(Uint8Array.of(++serial).buffer); await flush(); },
  };
}

// Copy and download include every preceding scan, even when digests finish later.
const exports = page();
exports.paste(qr('1150101')); await flush(); await exports.resolve();
exports.paste(qr('1150102')); exports.paste(qr('1150103')); await flush();
exports.get('copy').click(); exports.get('download').click(); await flush();
assert.equal(exports.copied.length, 0); assert.equal(exports.downloads.length, 0);
await exports.resolve();
assert.equal(exports.copied.length, 0); assert.equal(exports.downloads.length, 0);
await exports.resolve();
assert.equal(exports.copied.length, 1); assert.equal(exports.downloads.length, 1);
assert.equal(exports.copied[0].trimEnd().split('\n').length, 3);
assert.ok(exports.copied[0].includes('1150103'));
assert.equal(await exports.downloads[0].text(), exports.copied[0]);

// A click also finishes a buffered scan before exporting it (no blur event required).
exports.get('scan').value = qr('1150104');
exports.get('scan').listeners.get('input')!({ isComposing: false });
exports.get('copy').click(); await flush();
assert.equal(exports.copied.length, 1);
await exports.resolve();
assert.equal(exports.copied[1].trimEnd().split('\n').length, 4);

// Clear invalidates both an in-flight digest and scans/exports still waiting behind it.
const cleared = page();
cleared.paste(qr('1150101')); await flush(); await cleared.resolve();
cleared.paste(qr('1150102')); cleared.paste(qr('1150103')); await flush();
cleared.get('download').click();
cleared.get('scan').value = qr('1150104');
cleared.get('scan').listeners.get('input')!({ isComposing: false });
cleared.get('clear').click();
assert.equal(cleared.saved.size, 0);
await cleared.resolve();
assert.equal(cleared.digests.length, 0);
assert.equal(cleared.saved.size, 0);
assert.equal(cleared.get('collected').textContent, '0');
assert.equal(cleared.get('scan-status').textContent, '已清除。');
assert.equal(cleared.downloads.length, 0);
cleared.get('copy').click(); await flush();
assert.equal(cleared.copied[0], ''); // No buffered scan survived the clear.
cleared.paste(qr('1150105')); await flush(); await cleared.resolve();
assert.equal(cleared.get('collected').textContent, '1');
assert.ok([...cleared.saved.values()][0].includes('1150105'));
assert.ok(![...cleared.saved.values()][0].includes('1150102'));

// A rejected digest after clear cannot overwrite the clear status or block future scans.
cleared.paste(qr('1150106')); await flush(); cleared.get('clear').click();
cleared.digests.shift()!.reject(new Error('synthetic digest failure')); await flush();
assert.equal(cleared.get('scan-status').textContent, '已清除。');
cleared.paste(qr('1150107')); await flush(); await cleared.resolve();
assert.equal(cleared.get('collected').textContent, '1');

// A drugs-only second QR joins the line before it; the saved lines keep each line's QR count for the institution summary.
const STORAGE = 'gtsloth-qr-samples';
const multi = page();
multi.paste(qr('1150101')); await flush(); await multi.resolve();
multi.paste('TESTCODE02;1;QD;PO;14;'); await flush(); await multi.resolve();
assert.match(multi.get('scan-status').textContent, /^這是只有藥品的第 2 個 QR，已把 1 個藥接在第 1 行/);
assert.equal(multi.get('collected').textContent, '1');
assert.equal(multi.get('multi').hidden, false);
assert.equal(multi.get('multi-total').textContent, '1');
assert.deepEqual(multi.get('multi-list').children.map(item => item.textContent), ['醫事機構代碼 0000000000：1 張有第 2 個 QR（此院所共收 1 張）']);
const stored = JSON.parse(multi.saved.get(STORAGE)!);
assert.deepEqual([stored.version, stored.qrs, stored.lines[0].endsWith(';TESTCODE;1;BID;PO;14;TESTCODE02;1;QD;PO;14;')], [2, [2], true]);
multi.get('copy-multi').click(); await flush();
assert.equal(multi.copied[0], '有第 2 個 QR 的處方 1 張（共收 1 張）\n醫事機構代碼 0000000000：1 張有第 2 個 QR（此院所共收 1 張）\n');
const reopened = page({ [STORAGE]: multi.saved.get(STORAGE)! });
assert.deepEqual([reopened.get('collected').textContent, reopened.get('multi-total').textContent], ['1', '1']);
// Lines saved before QR counts existed come back as one QR each.
const older = page({ [STORAGE]: JSON.stringify({ version: 1, lines: stored.lines }) });
assert.deepEqual([older.get('collected').textContent, older.get('multi').hidden], ['1', true]);
console.log('collection queue and export regression checks passed');
