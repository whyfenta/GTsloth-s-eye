// Shared by the management PDF tests: the text of every page of a generated PDF.
/** Text of every page, lines joined top to bottom. */
export async function pdfText(bytes:Uint8Array){
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc=await pdfjs.getDocument({data:bytes.slice(),isEvalSupported:false,verbosity:0,cMapUrl:'node_modules/pdfjs-dist/cmaps/',cMapPacked:true}).promise;const pages:{text:string;width:number;height:number}[]=[];
  for(let n=1;n<=doc.numPages;n++){const page=await doc.getPage(n);const view=page.getViewport({scale:1});const content=await page.getTextContent();
    const items=content.items.flatMap((i:any)=>'str' in i&&i.str.trim()?[{s:i.str,x:i.transform[4],y:i.transform[5]}]:[]).sort((a,b)=>b.y-a.y||a.x-b.x);
    pages.push({text:items.map(i=>i.s).join('\n'),width:view.width,height:view.height});}
  return pages;
}
