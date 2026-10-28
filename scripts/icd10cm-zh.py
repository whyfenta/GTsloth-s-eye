"""健保署「2023年版_中文版ICD-10-CM/PCS」xlsx → docs/reference/icd10cm-zh.csv（只取診斷碼）。

用法：python scripts/icd10cm-zh.py <2023年中文版ICD-10-CM_PCS.xlsx>
來源與欄位見 docs/reference/icd10cm-zh.md。只用 Python 內建模組讀 xlsx。
"""
import csv
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

M = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
TARGET = Path(__file__).resolve().parents[1] / 'docs' / 'reference' / 'icd10cm-zh.csv'
# 工作表 → 版本欄的值。2014 版已刪除的舊碼也收，舊系統開的處方仍查得到名稱。
SHEETS = {'ICD-10-CM': '2023', '2014_cm代碼刪除': '2014已刪除'}


def sheets(path):
    z = zipfile.ZipFile(path)
    strings = [''.join(t.text or '' for t in si.iter(M + 't'))
               for si in ET.fromstring(z.read('xl/sharedStrings.xml'))]
    rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    for s in ET.fromstring(z.read('xl/workbook.xml')).find(M + 'sheets'):
        yield s.get('name'), z, rels[s.get(R + 'id')], strings


def rows(z, target, strings):
    for row in ET.fromstring(z.read('xl/' + target)).iter(M + 'row'):
        out = {}
        for c in row.findall(M + 'c'):
            v = c.find(M + 'v')
            text = '' if v is None else v.text or ''
            out[re.match(r'[A-Z]+', c.get('r'))[0]] = strings[int(text)] if c.get('t') == 's' and text else text
        yield out


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    found = {}
    for name, z, path, strings in sheets(sys.argv[1]):
        if name not in SHEETS:
            continue
        for r in list(rows(z, path, strings))[1:]:
            code = r.get('A', '').strip()
            if code and code not in found:
                # 儲存格內的斷行是排版殘留（Z53）：中文直接接回，英文換成空格。
                zh = re.sub(r'\s*\n\s*', '', r.get('D', '').strip())
                en = re.sub(r'\s*\n\s*', ' ', r.get('C', '').strip())
                found[code] = [code, r.get('B', '').strip(), zh, en, SHEETS[name]]
    missing = [n for n in SHEETS if n not in {s for s, *_ in sheets(sys.argv[1])}]
    if missing:
        sys.exit(f'xlsx 缺少工作表：{"、".join(missing)}')
    with open(TARGET, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(['代碼', '可申報', '中文名稱', '英文名稱', '版本'])
        w.writerows(found.values())
    old = sum(v[4] != '2023' for v in found.values())
    print(f'{TARGET.name}: {len(found)} 碼（2023 {len(found) - old}，2014已刪除 {old}）')


if __name__ == '__main__':
    main()
