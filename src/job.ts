import type { OCREngine } from './ocr';
import type { DocumentSource } from './source';
import type { InventoryRow, JobState, PageReport } from './model';
export type JobEvents = { state: (state: JobState) => void; page: (report: PageReport, rows: InventoryRow[]) => void; error: (message: string) => void };
export class InventoryJob {
  engine: OCREngine; source: DocumentSource; events: JobEvents; state: JobState = 'idle'; completed=0;
  pauseRequested=false; cancelled=false; resumeGate?: ()=>void; running=false;
  // Resolves on cancel so a worker that never answers cannot keep run() alive.
  cancelRelease!: ()=>void; cancelGate=new Promise<null>(resolve=>{this.cancelRelease=()=>resolve(null);});
  constructor(engine: OCREngine, source: DocumentSource, events: JobEvents) { this.engine=engine;this.source=source;this.events=events; }
  setState(state:JobState){this.state=state;this.events.state(state);}
  async run():Promise<void>{
    if(this.running)return;this.running=true;this.setState('loading');
    try {
      await Promise.race([this.engine.initialize(),this.cancelGate]); if(this.cancelled)return;this.setState('running');
      for(let page=1;page<=this.source.pages;page++){
        if(this.cancelled)break;
        if(this.pauseRequested){await new Promise<void>(resolve=>{this.resumeGate=resolve;this.setState('paused');});this.resumeGate=undefined;if(this.cancelled)break;this.setState('running');}
        const result=await Promise.race([this.engine.extract(this.source,page),this.cancelGate]); if(this.cancelled||!result)break;
        this.completed=page;this.events.page(result.report,result.rows);
        if(result.report.status==='rejected'&&!this.engine.layout&&!this.engine.textLayout){this.setState('error');this.events.error(result.report.reason);return;}
      }
      if(!this.cancelled)this.setState('complete');
    } catch(error){if(!this.cancelled){this.setState('error');this.events.error(error instanceof Error?error.message:'辨識失敗，請重試。');}}
    finally{this.running=false;await this.engine.terminate();this.events.state(this.state);}
  }
  pause(){if(this.state==='running')this.pauseRequested=true;}
  resume(){this.pauseRequested=false;this.resumeGate?.();}
  async cancel(){this.cancelled=true;this.cancelRelease();this.pauseRequested=false;this.resumeGate?.();this.setState('cancelled');await this.engine.terminate();}
}
