"""Run after assets.mjs with fonttools==4.60.1 to derive the static PDF font."""
from pathlib import Path
import sys,json,hashlib
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'tmp'/'python'))
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
import fontTools
assets=root/'public'/'assets';source=assets/'fonts'/'NotoSansTC-Regular.ttf';target=assets/'fonts'/'NotoSansTC-PDF.ttf'
f=TTFont(source);instantiateVariableFont(f,{'wght':400},inplace=True);f.save(target)
manifest=json.loads((assets/'manifest.json').read_text(encoding='utf-8'));manifest['assets']=[a for a in manifest['assets'] if a['path']!='fonts/NotoSansTC-PDF.ttf'];manifest['assets'].append({'path':'fonts/NotoSansTC-PDF.ttf','bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'source':'Derived from fonts/NotoSansTC-Regular.ttf','sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'conversion':f'fontTools {fontTools.__version__} instantiateVariableFont wght=400','license':'SIL Open Font License 1.1'})
manifest['notice']='Self-hosted dependencies only. Browser font is the upstream variable font; PDF font is a static wght=400 instance, embedded in full to avoid subset glyph loss.'
(assets/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
notice=assets/'SOURCE-NOTICES.txt';notice.write_text(notice.read_text(encoding='utf-8')+'\nPDF font NotoSansTC-PDF.ttf is a static wght=400 instance derived with fontTools 4.60.1. It is embedded in full (no subset). Source and output hashes are in manifest.json.\n',encoding='utf-8')
print('PDF font',target.stat().st_size,'bytes')
