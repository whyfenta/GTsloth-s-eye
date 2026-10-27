import { asset } from './model';
import { productIndex, type Product } from './slip-model';

/**
 * 健保碼 → 六碼 and 對接品名, built from the private sku-nhi-map.csv by `npm run slip-assets -- --map …`. A third element is the
 * 改用六碼 of a replaced 六碼.
 */
interface ProductFile { dataDate: string; products: Record<string, ([string, string] | [string, string, string])[]> }
export interface Catalog { dataDate: string; index: Map<string, Product[]> }
let file: Promise<ProductFile> | undefined;
/** ~0.3 MB (gzip ~0.1 MB), fetched once for both pages; a failed load is retried on the next call. */
function loadFile(): Promise<ProductFile> {
  if (!file) {
    file = fetch(asset('nhi/products.json')).then(async response => {
      if (!response.ok) throw new Error(`nhi/products.json: HTTP ${response.status}`);
      return await response.json() as ProductFile;
    });
    file.catch(() => { file = undefined; });
  }
  return file;
}
let pending: Promise<Catalog> | undefined;
/** Loaded on the first scan only; a failed load is retried on the next scan. */
export function loadProducts(): Promise<Catalog> {
  if (!pending) {
    pending = loadFile().catch(() => { throw new Error('商品對照載入失敗，尚差藥品先以健保碼顯示；下次掃碼會再試。'); }).then(file => {
      const entries = Object.entries(file.products).flatMap(([code, list]) => list.map(([sku, key, replacedBy]) => ({ sku, code, key, replacedBy })));
      return { dataDate: file.dataDate, index: productIndex(entries) };
    });
    pending.catch(() => { pending = undefined; });
  }
  return pending;
}
/** 六碼 → 健保碼, for the safety list's A factor (樹懶的管理). Each 六碼 has one row in the map, so one code. */
export const loadNhiCodes = (): Promise<Map<string, string>> =>
  loadFile().then(file => new Map(Object.entries(file.products).flatMap(([code, list]) => list.map(([sku]) => [sku, code] as const))));
