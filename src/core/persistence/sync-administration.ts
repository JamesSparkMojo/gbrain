import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { resolveSourceId } from '../source-resolver.ts';
import { currentVerifiedLocalWriter } from './identity.ts';
import { submissionAuthority } from './authority.ts';
import type { OperationContext } from '../ops/contract.ts';
import { validateSyncWireParams } from './sync-wire.ts';

/** Private CLI transport: wire fields can never manufacture a trust lane. */
export async function runAuthenticatedSyncSlice(engine: BrainEngine, params: Record<string,unknown>): Promise<Record<string,unknown>> {
  const verified=currentVerifiedLocalWriter();
  if(!verified||verified.remote||verified.principal.kind!=='local_cli')throw new OperationError('permission_denied','Sync requires a current trusted CLI registration.');
  const wire=validateSyncWireParams(params);
  const sourceId=await resolveSourceId(engine,wire.options.sourceId??null,wire.cwd,{skipLocalSignals:true});
  const [source]=await engine.executeRaw<{incarnation:string;archived:boolean}>('SELECT incarnation,archived FROM sources WHERE id=$1',[sourceId]);
  if(!source||source.archived)throw new OperationError('source_changed','The selected sync source is unavailable.');
  await submissionAuthority({engine,remote:false,sourceId} as OperationContext,'submit_job',sourceId,source.incarnation,'__managed_sync_checkpoint__');
  const controller=new AbortController();
  const timer=wire.timeoutSeconds>0?setTimeout(()=>controller.abort(),wire.timeoutSeconds*1000):undefined;
  timer?.unref?.();
  let work:Promise<Record<string,unknown>>|undefined;
  const unregister=engine.registerBeforeDisconnect(async()=>{controller.abort();await work?.catch(()=>{});});
  try {
    work=(async()=>{
      const [brain]=await engine.executeRaw<{enabled:boolean}>('SELECT enabled FROM persistence_brain WHERE singleton=1');
      if(!brain?.enabled) {
        const {performSync}=await import('../../commands/sync.ts');
        return {...await performSync(engine,{...wire.options,sourceId,signal:controller.signal})};
      }
      const {performManagedSync}=await import('./sync-run.ts');
      return {...await performManagedSync(engine,{...wire.options,sourceId,signal:controller.signal},{maxPages:25,maxMs:1000})};
    })();
    return await work;
  } finally {if(timer)clearTimeout(timer);unregister();}
}
