from pathlib import Path
import fitz
root=Path(__file__).resolve().parents[1]
out=root/'tmp'/'fixtures';out.mkdir(parents=True,exist_ok=True)
src=fitz.open(root.parent/'20261009_212541.pdf')
big=fitz.open()
for i in range(100):big.insert_pdf(src)
big.save(out/'inventory-200-pages.pdf',garbage=4,deflate=True)
upright=[]
for p in src:
    pix=p.get_pixmap(matrix=fitz.Matrix(3,3))
    from PIL import Image
    im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples).rotate(-90,expand=True)
    upright.append(im)
upright[0].save(out/'inventory.png')
# White out only the continuation heading band, retaining report metadata and rows.
from PIL import ImageDraw
im=upright[1].copy();ImageDraw.Draw(im).rectangle((0,int(im.height*.075),im.width,int(im.height*.126)),fill='white')
im.save(out/'continuation-no-header.png')
cont=fitz.open();cont.insert_pdf(src,from_page=0,to_page=0)
# Use the source page orientation so the inherited rotation remains applicable.
im=im.rotate(90,expand=True);im.save(out/'continuation-rotated.png')
page=cont.new_page(width=src[0].rect.width,height=src[0].rect.height);page.insert_image(page.rect,filename=str(out/'continuation-rotated.png'))
cont.save(out/'headerless-continuation.pdf',deflate=True)
receipt=fitz.open();page=receipt.new_page();page.insert_text((50,70),'RECEIPT\nItem          Price\n000111        254\nTOTAL         254',fontsize=16);receipt.save(out/'receipt.pdf')
mixed=fitz.open();mixed.insert_pdf(src,from_page=0,to_page=0);mixed.insert_pdf(receipt);mixed.save(out/'mixed-inventory-receipt.pdf')
extra=fitz.open()
for i in range(201):extra.new_page()
extra.save(out/'over-limit-201.pdf')
print('Fixtures',out,'200 pages bytes',(out/'inventory-200-pages.pdf').stat().st_size)
