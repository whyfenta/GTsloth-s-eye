// Keep the stock-report instructions consistent across both import screens.
const imageUrl = `${import.meta.env.BASE_URL}examples/im1c1-inventory-range.png`;
const figure = `<figure class="inventory-guide-figure"><div class="inventory-guide-image" tabindex="0" role="region" aria-label="庫存簡表主檔設定原圖，窄螢幕可橫向捲動"><img src="${imageUrl}" width="432" height="286" alt="樺穎 IM1C1 庫存簡表主檔設定：商品類別起始值為 09，結束值為 099999。" loading="lazy"></div><figcaption>主檔範圍：商品類別 09～099999<br><a href="${imageUrl}" target="_blank" rel="noopener" aria-label="開啟庫存簡表主檔設定原圖（另開分頁）">開啟原圖檢視 ↗</a></figcaption></figure>`;

export const inventoryImportGuide = `<div class="import-note inventory-import-guide"><span>如何取得庫存簡表？</span><div class="inventory-guide-content"><p>在樺穎的 IM1C1 製作後，將印表機設定為「列印至 PDF」按真實列印，即可生成 PDF 檔。主檔設定如圖，「商品類別」訂為09~099999即可。其餘非09類藥物如針頭、試紙等需盤點項目，建議訂在同一儲位後，以「儲位」為範圍條件生成補件附檔。如使用快照轉成 PDF，解析度低於 300 dpi 會提高辨識錯誤的風險。</p>${figure}</div></div>`;
