import type { DocumentSource, PageSource } from './source';
import type { TextPage } from './textlayer';
/**
 * Several files read as one document. Pages are numbered across the files in
 * import order, so a page number identifies one page of one file everywhere.
 * The files stay owned (and disposed) by the caller.
 */
export class SourceSet implements PageSource {
  files: DocumentSource[]; starts: number[]; pages: number;
  constructor(files: DocumentSource[]) {
    this.files = files; let next = 1;
    this.starts = files.map(file => { const start = next; next += file.pages; return start; }); this.pages = next - 1;
  }
  fileIndex(pageNumber: number): number { let index = this.starts.length - 1; while (index > 0 && this.starts[index] > pageNumber) index--; return index; }
  /** Page number inside its own file. */
  localPage(pageNumber: number): number { return pageNumber - this.starts[this.fileIndex(pageNumber)] + 1; }
  render(pageNumber: number, dpi?: number): Promise<HTMLCanvasElement> { return this.files[this.fileIndex(pageNumber)].render(this.localPage(pageNumber), dpi); }
  textPage(pageNumber: number, dpi?: number): Promise<TextPage | undefined> { return this.files[this.fileIndex(pageNumber)].textPage(this.localPage(pageNumber), dpi); }
}
