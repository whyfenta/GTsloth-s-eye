import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {generatePDF,type RowHeight} from '../src/pdf';import {emptyBox,type InventoryRow} from '../src/model';
const font=new Uint8Array(readFileSync('public/assets/fonts/NotoSansTC-PDF.ttf'));
// One-line names keep every row at the selected minimum height.
const rows=(n:number)=>Array.from({length:n},(_,i):InventoryRow=>({id:`r${i}`,page:1,sku:String(i+1).padStart(6,'0'),rawName:'品項',name:'品項',location:'A01',bookQty:'1',
  boxes:{sku:emptyBox,rawName:emptyBox,location:emptyBox,bookQty:emptyBox},confidence:{sku:100,rawName:100,location:100,bookQty:100},issues:[],reviewed:true,attention:false}));
const pages=async(n:number,rowHeight:RowHeight)=>(await generatePDF(rows(n),{storeName:'測試門市',sortMode:'sku',rowHeight},font)).pageCount;
test('a page holds 11 rows at 22.6 mm, 9 at 25.8 mm and 8 at 29 mm',async()=>{
  for(const [rowHeight,perPage] of [[22.6,11],[25.8,9],[29,8]] as const){
    assert.equal(await pages(perPage,rowHeight),1,`${perPage} rows of ${rowHeight} mm fit one page`);
    assert.equal(await pages(perPage+1,rowHeight),2,`${perPage+1} rows of ${rowHeight} mm need a second page`);
  }
});
