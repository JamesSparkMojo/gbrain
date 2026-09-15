/** Existing trusted core source entry points retain their ordinary result shapes. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { isInsideGitRepo, hasTrackedContent } from '../git-remote.ts';
import { msysToNativePath } from '../path-confine.ts';
import { defaultCloneDir, SourceOpError, type AddSourceOpts, type SourceRow } from '../sources-ops.ts';
import { DEFAULT_CALENDAR_ID } from '../google/types.ts';
import { runManagedSourceLifecycle } from './source-lifecycle.ts';
import { WRITE_ERROR_CODES, type WriteErrorCode } from './types.ts';

export function assertTopologyCommitted(result:Record<string,unknown>):void{
  if(result.state==='committed')return;
  const code=result.state==='failed'?String(result.write_error??'storage_error'):'write_pending';
  const error=new OperationError(code,'Source lifecycle has not committed.','Inspect the same request_id before submitting another lifecycle intent.');
  error.writeError=(WRITE_ERROR_CODES as readonly string[]).includes(code)?code as WriteErrorCode:'storage_error';
  error.writeRequest={request_id:String(result.request_id),state:result.state==='failed'?'failed':'recovering',retry_after_ms:result.state==='failed'?null:1000};
  throw error;
}
export async function addManagedSource(engine:BrainEngine,opts:AddSourceOpts):Promise<SourceRow>{
  let path=opts.localPath?resolve(msysToNativePath(opts.localPath)):undefined;
  let config:Record<string,unknown>=opts.federated==null?{}:{federated:opts.federated};
  if(opts.remoteUrl){path=resolve(opts.cloneDir??defaultCloneDir(opts.id));config={...config,remote_url:opts.remoteUrl,managed_clone:true};}
  if(opts.github){
    const gh=opts.github;path=resolve(msysToNativePath(gh.dir));
    config={kind:'github',gh_token_env:gh.tokenEnv,gh_handle:gh.handle,gh_scope:gh.scope,gh_repos:gh.repos.join(','),gh_involvement:gh.involvement,
      gh_managed:path===defaultCloneDir(`${opts.id}-github`),federated:opts.federated??true,
      ...(gh.appId!==undefined&&gh.appPemPath!==undefined?{gh_app_id:gh.appId,gh_app_pem_path:gh.appPemPath}:{}),
      ...(gh.appInstallId!==undefined?{gh_app_install_id:gh.appInstallId}:{})};
  }
  if(opts.google){
    const google=opts.google;path=resolve(msysToNativePath(google.dir));
    config={kind:'google',g_account:google.account,g_services:google.services.join(','),g_history_days:google.historyDays,
      ...(google.calendarId&&google.calendarId!==DEFAULT_CALENDAR_ID?{g_calendar_id:google.calendarId}:{}),
      ...(google.access&&google.access!=='vault'?{g_access:google.access}:{}),...(google.tokenCommand?{g_token_command:google.tokenCommand}:{}),
      ...(google.tokenEnv?{g_token_env:google.tokenEnv}:{}),g_managed:path===defaultCloneDir(`${opts.id}-google`),federated:opts.federated??true};
  }
  if(path&&!opts.remoteUrl&&!opts.github&&!opts.google&&!opts.force&&existsSync(path)&&(!isInsideGitRepo(path)||!hasTrackedContent(path)))
    throw new SourceOpError('not_a_git_repo','The source path must contain committed Git content. Use --force to register an ordinary directory.');
  const result=await runManagedSourceLifecycle(engine,{operation:'add',sourceId:opts.id,path,name:opts.name,config,remoteUrl:opts.remoteUrl,
    createDirectory:!!(opts.github||opts.google),requestId:opts.requestId,expectedIncarnation:opts.expectedIncarnation});
  assertTopologyCommitted(result);
  const [row]=await engine.executeRaw<SourceRow>('SELECT * FROM sources WHERE id=$1 AND incarnation=$2::uuid',[opts.id,result.source_incarnation]);
  if(!row)throw new OperationError('source_changed','The created source was subsequently removed.');
  return row;
}
