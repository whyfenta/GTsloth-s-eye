from pathlib import Path
import json,sys,hashlib,collections,time
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'tmp'/'python'))
import pymupdf as fitz
from PIL import Image
import zxingcpp
t=time.perf_counter();f=root/'output'/'validation'/'200pages-performance-only.pdf';d=fitz.open(f);mm=lambda n:n*72/25.4
codes=[]
for p in d:
    assert abs(p.rect.width-mm(210))<.02 and abs(p.rect.height-mm(297))<.02
    pix=p.get_pixmap(matrix=fitz.Matrix(180/72,180/72),clip=fitz.Rect(mm(10),mm(31),mm(50),mm(279)))
    im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
    results=zxingcpp.read_barcodes(im,formats=zxingcpp.BarcodeFormat.Code128)
    assert len(results)==10,(p.number,len(results))
    codes.extend(r.text for r in results)
    # Stream pages without retaining rendered images.
gold=json.loads((root/'tests'/'fixtures'/'sample-gold.json').read_text(encoding='utf-8'))
expected=collections.Counter({r['sku']:100 for r in gold});assert collections.Counter(codes)==expected
report={'pages':len(d),'decoded':len(codes),'allCodesMatch':True,'seconds':time.perf_counter()-t,'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'manualReview':False}
(root/'output'/'validation'/'large-pdf.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))
