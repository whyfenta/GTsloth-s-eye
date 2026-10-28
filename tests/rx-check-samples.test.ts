import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rxFacts, splitFields } from '../src/prescription-qr';
import { checkPrescription, dxLabel, RULE_FILES } from '../src/rx-check';
import { readRxData } from '../src/rx-data';

// The prototype check_rules.py is the specification. It runs here on a copy given this repository's rule tables and NHI file,
// so only the logic is compared. Prints line numbers and counts, never a sample's content.
const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('check_rules', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
drugs = m.load_nhi(m.NHI)
out = []
for name in sys.argv[2:]:
    for line in open(name, encoding='utf-8-sig'):
        if line.startswith('失敗') or not line.strip():
            continue
        rx = m.parse(line.rstrip('\\n'))
        out.append({'rows': m.check(rx, drugs), 'labels': [m.dx_label(d) for d in rx['dx']]})
sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))
`;
type Row = [string, string, string, string, string];

// De-identified samples stay on the pharmacist's computer: set RX_SAMPLES to the collector's .txt files (joined by ; on Windows,
// : elsewhere) and RX_PROTOTYPE to check_rules.py.
test('every drug of the local samples gets the prototype check_rules.py verdict, reason and cautions', t => {
  const samples = process.env.RX_SAMPLES?.split(path.delimiter).filter(Boolean) ?? [];
  const prototype = process.env.RX_PROTOTYPE;
  if (!samples.length || !prototype || ![prototype, ...samples].every(file => existsSync(file))) return t.skip('Set RX_SAMPLES to the de-identified sample files and RX_PROTOTYPE to check_rules.py.');
  const data = readRxData(...(['rules', 'drugs', 'icd10cm'].map(name => JSON.parse(readFileSync(`public/assets/rx/${name}.json`, 'utf8'))) as Parameters<typeof readRxData>));
  assert.ok(data.rules.repeated === '黃' && data.rules.byDepartment, 'settings.csv 不是原型的做法（同成分重複＝黃、科別常用＝保留），比對前請暫時改回。');

  const dir = mkdtempSync(path.join(tmpdir(), 'rx-check-'));
  let python;
  try {
    const source = readFileSync(prototype, 'utf8');
    const nhi = path.resolve('docs/reference/nhi-drug-codes.csv');
    assert.match(source, /^NHI = Path\(.*\)$/m, 'check_rules.py 找不到 NHI = Path(…) 這一行，比對程式要跟著改。');
    writeFileSync(path.join(dir, 'check_rules.py'), source.replace(/^NHI = Path\(.*\)$/m, `NHI = Path(${JSON.stringify(nhi)})`));
    for (const file of RULE_FILES.filter(file => file !== 'settings')) copyFileSync(`docs/reference/rx-rules/${file}.csv`, path.join(dir, `${file}.csv`));
    python = spawnSync('python', ['-I', '-c', DRIVER, path.join(dir, 'check_rules.py'), ...samples], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(python.status, 0, `check_rules.py 執行失敗：${python.stderr?.split('\n').slice(-3).join(' ')}`);
  const expected = JSON.parse(python.stdout) as { rows: string[][]; labels: string[] }[];

  const lines = samples.flatMap(file => readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r\n|\r|\n/)).filter(line => !line.startsWith('失敗') && line.trim());
  assert.equal(lines.length, expected.length, '處方張數');
  // Repeated-ingredient notes come last in both; Python lists them in hash order, so they are compared sorted.
  const repeatsLast = (rows: Row[]) => [...rows.filter(row => !row[4].startsWith('同成分重複')), ...rows.filter(row => row[4].startsWith('同成分重複')).sort()];
  let drugs = 0, flagged = 0;
  const differ: string[] = [];
  lines.forEach((line, i) => {
    const fields = splitFields(line);
    const rx = rxFacts(fields, fields[5].trim().toUpperCase());
    const result = checkPrescription(rx, data.drugs, data.rules);
    const ours: Row[] = [
      ...result.notes.filter(note => !note.text.startsWith('同成分重複')).map((note): Row => ['', '', '', note.level, note.text]),
      ...result.drugs.flatMap(drug => [[drug.code, drug.info?.atc ?? '?', `${drug.frequency} ${drug.route}`, drug.verdict, drug.reason] as Row,
        ...drug.notes.map((note): Row => [drug.code, '', '', note.level, note.text])]),
      ...result.notes.filter(note => note.text.startsWith('同成分重複')).map((note): Row => ['', '', '', note.level, note.text]),
    ];
    const theirs = expected[i].rows.map(([code, , atc, use, level, note]): Row => [code, atc, use, level, note]);
    drugs += result.drugs.length;
    flagged += Number(ours.some(row => row[3] === '黃' || row[3] === '紅'));
    const labels = rx.dx.map(code => dxLabel(code, data.icd));
    if (JSON.stringify(repeatsLast(ours)) !== JSON.stringify(repeatsLast(theirs)) || JSON.stringify(labels) !== JSON.stringify(expected[i].labels)) differ.push(`#${i + 1}`);
  });
  console.log(`處方 ${lines.length} 張，藥品 ${drugs} 個，出現黃或紅的處方 ${flagged} 張；與原型不同 ${differ.length} 張`);
  assert.deepEqual(differ, [], `與 check_rules.py 不同的處方（樣本行號，略過失敗行）：${differ.slice(0, 20).join(' ')}`);
});
