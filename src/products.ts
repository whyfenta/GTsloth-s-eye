import { asset } from './model';
import { productIndex, type Product } from './slip-model';

/** 健保碼 → 六碼 and 對接品名, built from the private sku-nhi-map.csv by `npm run slip-assets -- --map …`. */
interface ProductFile { dataDate: string; products: Record<string, [string, string][]> }
export interface Catalog { dataDate: string; index: Map<string, Product[]> }
let pending: Promise<Catalog> | undefined;
/** Loaded on the first scan only (~0.3 MB, gzip ~0.1 MB); a failed load is retried on the next scan. */
export function loadProducts(): Promise<Catalog> {
  if (!pending) {
    pending = fetch(asset('nhi/products.json')).then(async response => {
      if (!response.ok) throw new Error('商品對照載入失敗，尚差藥品先以健保碼顯示；下次掃碼會再試。');
      const file = await response.json() as ProductFile;
      const entries = Object.entries(file.products).flatMap(([code, list]) => list.map(([sku, key]) => ({ sku, code, key })));
      return { dataDate: file.dataDate, index: productIndex(entries) };
    });
    pending.catch(() => { pending = undefined; });
  }
  return pending;
}
