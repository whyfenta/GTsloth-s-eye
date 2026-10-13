import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {generatePDF,scanTestRows,barcodeFontText,ROW_HEIGHTS} from '../src/pdf';import {cleanProductName,emptyBox,type InventoryRow} from '../src/model';
import {PDFDocument} from 'pdf-lib';import fontkit from '@pdf-lib/fontkit';
const root=process.cwd();const out=path.join(root,'output');await fs.mkdir(path.join(out,'pdf'),{recursive:true});await fs.mkdir(path.join(out,'validation'),{recursive:true});
const input=process.env.INVENTORY_SAMPLE_PDF;if(!input)throw new Error('Set INVENTORY_SAMPLE_PDF to the private sample PDF path.');const before=createHash('sha256').update(await fs.readFile(input)).digest('hex');
const records=JSON.parse(await fs.readFile(path.join(root,'tests/fixtures/sample-gold.json'),'utf8'));
const rows:InventoryRow[]=records.map((r:any,i:number)=>({id:`gold-${i}`,page:r.page,sku:r.sku,rawName:r.rawName,name:r.cleanName,location:r.location,bookQty:r.bookQty,
  boxes:{sku:emptyBox,rawName:emptyBox,location:emptyBox,bookQty:emptyBox},confidence:{sku:100,rawName:100,location:100,bookQty:100},issues:[],reviewed:true}));
const font=new Uint8Array(await fs.readFile(path.join(root,'public/assets/fonts/NotoSansTC-PDF.ttf')));const results=[];
for(const mode of ['sku','location'] as const){const name=`範本盤點表_${mode==='sku'?'代號':'儲位'}.pdf`;const result=await generatePDF(rows,{storeName:process.env.INVENTORY_SAMPLE_STORE??'範本門市（校對示例）',sortMode:mode,rowHeight:22.6},font);
  await fs.writeFile(path.join(out,'pdf',name),result.bytes);results.push({name,pageCount:result.pageCount,barcodes:result.barcodeCount,bytes:result.bytes.length,sha256:createHash('sha256').update(result.bytes).digest('hex')});console.log(name,result.pageCount+' pages',result.barcodeCount+' barcodes');}
for(const height of ROW_HEIGHTS){const name=`條碼掃讀測試_${height}mm.pdf`;const result=await generatePDF(scanTestRows(),{storeName:'掃描器實機驗收',sortMode:'sku',rowHeight:height,title:'相鄰條碼掃讀測試',note:'原尺寸 100% 列印。逐列確認六位數與前導零，避免掃到相鄰列。'},font);
  await fs.writeFile(path.join(out,'pdf',name),result.bytes);results.push({name,pageCount:result.pageCount,barcodes:result.barcodeCount,bytes:result.bytes.length,sha256:createHash('sha256').update(result.bytes).digest('hex')});}
const barcodeFontDocument=await PDFDocument.create();barcodeFontDocument.registerFontkit(fontkit);const embedded=await barcodeFontDocument.embedFont(await fs.readFile(path.join(root,'public/assets/fonts/LibreBarcode128-Regular.ttf')),{subset:true});
const page=barcodeFontDocument.addPage([300,300]);for(const [i,r] of scanTestRows().entries())page.drawText(barcodeFontText(r.sku),{x:50,y:265-i*40,size:36,font:embedded});
await fs.writeFile(path.join(out,'validation','barcode-font-check.pdf'),await barcodeFontDocument.save());
const after=createHash('sha256').update(await fs.readFile(input)).digest('hex');if(before!==after)throw new Error('Source changed');
const report={createdAt:new Date().toISOString(),sourceSHA256:before,sourceUnchanged:before===after,goldRows:rows.length,prefixMatches:records.filter((r:any)=>cleanProductName(r.rawName).name===r.cleanName).length,
  outputs:results,privacy:'Real inventory source/gold fixture/output PDFs remain local and are ignored by Git; only static code/models/fonts are deployed.',physicalScanner:'Pending actual printer and scanner; three spacing test PDFs provided.'};
await fs.writeFile(path.join(out,'validation','pdf-generation.json'),JSON.stringify(report,null,2));console.log('Source unchanged',before,'rows',rows.length);
