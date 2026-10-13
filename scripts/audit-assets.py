from pathlib import Path
import json,hashlib
root=Path(__file__).resolve().parents[1];folder=root/'public'/'assets'
manifest=json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
for item in manifest['assets']:
    f=folder/item['path'];assert f.is_file(),f;assert hashlib.sha256(f.read_bytes()).hexdigest()==item['sha256'],f
    assert f.stat().st_size<25*1024*1024,f
print('Dependency files verified',len(manifest['assets']),'total bytes',sum((folder/a['path']).stat().st_size for a in manifest['assets']))
