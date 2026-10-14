from pathlib import Path
import sys,json,hashlib
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'tmp'/'python'))
import pymupdf as fitz
from PIL import Image
import zxingcpp
mm=lambda n:n*72/25.4
out=root/'output'/'validation';renders=root/'output'/'previews';renders.mkdir(parents=True,exist_ok=True)
reports=[]
files=[Path(str(expected)[:-len('.expected.json')]+'.pdf') for expected in (root/'output'/'pdf').glob('*.expected.json')]
if not files: raise RuntimeError('Generate PDFs with scripts/qa-0015.ts before verification.')
for filename in files:
    doc=fitz.open(filename);decoded=[];page_reports=[]
    diagnostic=filename.name=='barcode-font-check.pdf'
    expected_path=filename.with_suffix('.expected.json')
    expected=json.loads(expected_path.read_text(encoding='utf-8'))['codes'] if expected_path.exists() else None
    for p in doc:
        pix=p.get_pixmap(matrix=fitz.Matrix(200/72,200/72))
        im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
        im.save(renders/f'{filename.stem}-{p.number+1:02}.png')
        results=zxingcpp.read_barcodes(im,formats=zxingcpp.BarcodeFormat.Code128)
        results=sorted(results,key=lambda r:r.position.top_left.y)
        codes=[r.text for r in results];decoded.extend(codes)
        drawings=p.get_drawings()
        bars=[d['rect'] for d in drawings if d['fill']==(0,0,0) and abs(d['rect'].height-mm(10))<.02]
        bar_tops=sorted(set(round(r.y0,2) for r in bars))
        # Count column (157-200 mm) must stay blank: no boxes or text inside the table body.
        count_x0,count_x1=mm(157),mm(200);body_top,body_bottom=mm(297-264),mm(297-15)
        boxes=[d['rect'] for d in drawings if d['rect'].x0>count_x0+.5 and d['rect'].x1<count_x1-.5 and d['rect'].height>.5]
        spans=[s for b in p.get_text('dict')['blocks'] for line in b.get('lines',[]) for s in line['spans'] if s['text'].strip()]
        count_text=[s['text'] for s in spans if s['bbox'][0]>count_x0+.5 and body_top<s['bbox'][1]<body_bottom]
        name_sizes={round(s['size'],1) for s in spans if mm(51)<s['bbox'][0]<mm(53) and s['bbox'][1]>body_top}
        qty_sizes={round(s['size'],1) for s in spans if mm(132)<s['bbox'][0] and s['bbox'][2]<=mm(157) and s['bbox'][1]>body_top}
        sku_spans=[s for s in spans if mm(10)<s['bbox'][0] and s['bbox'][2]<mm(50) and body_top<s['bbox'][1]<body_bottom and s['text'].strip().isdigit() and len(s['text'].strip())==6]
        qty_spans=[s for s in spans if mm(132)<s['bbox'][0] and s['bbox'][2]<=mm(157) and body_top<s['bbox'][1]<body_bottom and s['text'].strip()]
        header_fills=[d['rect'] for d in drawings if d['fill'] and all(abs(a-b)<.015 for a,b in zip(d['fill'],(.84,.90,.86))) and abs(d['rect'].x0-mm(10))<.05 and abs(d['rect'].x1-mm(200))<.05]
        row_fills=[d['rect'] for d in drawings if d['fill'] and all(abs(a-b)<.015 for a,b in zip(d['fill'],(.92,.95,.93))) and abs(d['rect'].x0-mm(50))<.05 and abs(d['rect'].x1-mm(200))<.05 and d['rect'].y0>=body_top+mm(8)-.05]
        body_fills=[d for d in drawings if d['fill'] and d['rect'].y0>=body_top+mm(8)-.05 and d['rect'].y1<=body_bottom+.05 and d['rect'].x0<mm(50)-.05 and d['fill']!=(0,0,0)]
        if not diagnostic:
            assert abs(p.rect.width-mm(210))<.02 and abs(p.rect.height-mm(297))<.02
            assert len(codes)==len(bar_tops)>0,(filename,p.number,codes,bar_tops)
            assert not boxes and not count_text,(filename,p.number,boxes,count_text)
            assert name_sizes=={16.0},(filename,p.number,name_sizes)
            # 20 pt, or smaller only when a long quantity would not fit its column.
            assert qty_sizes and all(12.0<=size<=20.0 for size in qty_sizes),(filename,p.number,qty_sizes)
            assert sku_spans and all(abs(s['size']-16)<.05 and s['font']=='Courier' for s in sku_spans),(filename,p.number,sku_spans)
            assert qty_spans and all(s['font']=='Courier-Bold' for s in qty_spans),(filename,p.number,qty_spans)
            assert len(header_fills)==1,(filename,p.number,header_fills)
            assert len(row_fills)==len(codes)//2,(filename,p.number,row_fills,codes)
            assert not body_fills,(filename,p.number,body_fills)
            # Nine handwritten digits (~4 mm each) still fit the blank column.
            assert count_x1-count_x0>=mm(9*4+4)
            assert all(abs(r.width/mm(.4)-round(r.width/mm(.4)))<.002 for r in bars)
            assert all(t2-t1>=mm(22.6)-.05 for t1,t2 in zip(bar_tops,bar_tops[1:]))
            assert min(r.x0 for r in bars)>=mm(10+4)-.05
            assert max(r.x1 for r in bars)<=mm(50-4)+.05
            # All glyph rectangles stay inside the page; page footer is allowed below table.
            for b in p.get_text('dict')['blocks']:
                for line in b.get('lines',[]):
                    for s in line['spans']:
                        x0,y0,x1,y1=s['bbox'];assert x0>=mm(9.9) and x1<=mm(200.1) and y0>=0 and y1<=mm(297)
            assert '名稱' in p.get_text() and '實量' in p.get_text()
        page_reports.append({'page':p.number+1,'codes':codes,'a4':not diagnostic,'countColumnBlank':not boxes and not count_text,'nameSizes':sorted(name_sizes),'quantitySizes':sorted(qty_sizes),'skuFonts':sorted(set(s['font'] for s in sku_spans)),'quantityFonts':sorted(set(s['font'] for s in qty_spans)),'headerFill':len(header_fills)==1,'alternatingRows':len(row_fills),'barcodeColumnBodyFillFree':not body_fills,'minBarGapMM':min(((b-a)/mm(1)-10 for a,b in zip(bar_tops,bar_tops[1:])),default=None)})
    if expected is not None:
        assert decoded==expected,(filename,decoded[:10],expected[:10])
    else:
        assert decoded==['000001','000002','012345','100001','100002','999999'],(filename,decoded)
    reports.append({'file':filename.name,'pages':len(doc),'decoded':len(decoded),'allCodesMatch':True,'sha256':hashlib.sha256(filename.read_bytes()).hexdigest(),'pageDetails':page_reports})
(out/'barcode-and-layout.json').write_text(json.dumps({'decoder':'ZXing C++ 3.1.1 independent of JsBarcode/font encoder','dpi':200,'files':reports},ensure_ascii=False,indent=2),encoding='utf-8')
print('Verified',len(reports),'PDFs;',sum(r['decoded'] for r in reports),'barcodes;',sum(r['pages'] for r in reports),'rendered pages')
