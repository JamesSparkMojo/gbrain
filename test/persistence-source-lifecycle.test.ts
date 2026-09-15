import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { registerLocalWriter, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runManagedSourceClone } from '../src/core/persistence/topology-clone.ts';
import { topologyPrincipal } from '../src/core/persistence/topology-locks.ts';

import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
const databaseUrl=process.env.DATABASE_URL;
for(const flavor of ['pglite',...(databaseUrl?['postgres']:[])] as const)describe(`managed source lifecycle (${flavor})`,()=>{
let engine:BrainEngine;
let closePostgres:(()=>Promise<void>)|undefined;
beforeAll(async()=>{
  if(flavor==='postgres'){
    const fixture=await isolatedPersistencePostgres(databaseUrl!);engine=fixture.engine;closePostgres=fixture.close;
  }else{
    engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();
  }
},120_000);
afterAll(async()=>{if(!engine)return;await disposePersistenceConsumer(engine);if(closePostgres)await closePostgres();else await engine.disconnect();});
async function fixture(run:(home:string,source:string,root:string)=>Promise<void>){
  const home=mkdtempSync(join(tmpdir(),'gbrain-topology-'));
  try{await withEnv({GBRAIN_HOME:home,DATABASE_URL:undefined,GBRAIN_DATABASE_URL:undefined},async()=>{
    await resetPgliteState(engine as PGLiteEngine);await registerLocalWriter(engine,'cli');
    const source='lifecycle-source',root=join(home,'canonical');mkdirSync(root);
    writeFileSync(join(root,'example.md'),'---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)',[source,root]);
    await claimWorktree(engine,source,root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await run(home,source,root);
  });}finally{rmSync(home,{recursive:true,force:true});}
}
async function queued(source:string){
  const binding=(await getWorktreeBinding(engine,source))!;
  const authority=await submissionAuthority({engine,config:{engine:'pglite'},remote:false,sourceId:source,dryRun:false,logger:{info(){},warn(){},error(){}}},'put_page',source,binding.source_incarnation,'queued');
  return admitWrite(engine,{principal:authority.principal,operation:'put_page',sourceId:source,sourceIncarnation:binding.source_incarnation,
    slug:'queued',requestId:randomUUID(),callerIntent:{content:'queued'},intent:{content:'queued'},authority,
    worktreeId:binding.worktree_id,topologyGeneration:binding.topology_generation});
}

test('archive/restore advance topology and permanently invalidate accepted old bindings',()=>fixture(async(_home,source)=>{
  const old=(await getWorktreeBinding(engine,source))!;const accepted=await queued(source);
  const requestId=randomUUID();
  const result=await runManagedSourceLifecycle(engine,{operation:'archive',sourceId:source,requestId});
  expect(result).toMatchObject({state:'committed',invalidated_requests:1});
  expect((await engine.executeRaw<{state:string;error_code:string}>('SELECT state,error_code FROM persistence_requests WHERE id=$1::uuid',[accepted.id]))[0]).toEqual({state:'conflict',error_code:'source_changed'});
  const next=(await getWorktreeBinding(engine,source))!;expect(Number(next.topology_generation)).toBe(Number(old.topology_generation)+1);
  expect(await runManagedSourceLifecycle(engine,{operation:'archive',sourceId:source,requestId})).toEqual(result);
  await expect(runManagedSourceLifecycle(engine,{operation:'restore',sourceId:source,requestId})).rejects.toMatchObject({code:'idempotency_conflict'});
  await runManagedSourceLifecycle(engine,{operation:'restore',sourceId:source});
  expect((await engine.executeRaw<{archived:boolean}>('SELECT archived FROM sources WHERE id=$1',[source]))[0].archived).toBe(false);
}),60_000);

test('remove/recreate retains old request IDs and creates a new source incarnation',()=>fixture(async(_home,source,root)=>{
  const original=(await getWorktreeBinding(engine,source))!;const accepted=await queued(source);const requestId=randomUUID();
  const result=await runManagedSourceLifecycle(engine,{operation:'remove',sourceId:source,confirmDestructive:true,requestId});
  await runManagedSourceLifecycle(engine,{operation:'add',sourceId:source,path:root});
  const replacement=(await getWorktreeBinding(engine,source))!;
  expect(replacement.source_incarnation).not.toBe(original.source_incarnation);
  expect(await runManagedSourceLifecycle(engine,{operation:'remove',sourceId:source,confirmDestructive:true,requestId})).toEqual(result);
  expect((await engine.executeRaw('SELECT id FROM sources WHERE id=$1',[source]))).toHaveLength(1);
  expect((await engine.executeRaw<{state:string}>('SELECT state FROM persistence_requests WHERE id=$1::uuid',[accepted.id]))[0].state).toBe('conflict');
  expect((await engine.executeRaw<{outstanding_count:string}>("SELECT outstanding_count::text FROM persistence_counters WHERE key='brain'"))[0].outstanding_count).toBe('0');
}),60_000);

test('running publication refuses lifecycle before metadata or generation changes',()=>fixture(async(_home,source)=>{
  const binding=(await getWorktreeBinding(engine,source))!;await queued(source);
  const row=await claimNextWrite(engine,binding.owner_host_id!);expect(row).not.toBeNull();
  await expect(runManagedSourceLifecycle(engine,{operation:'archive',sourceId:source})).rejects.toMatchObject({code:'write_pending'});
  expect((await getWorktreeBinding(engine,source))!.topology_generation).toBe(binding.topology_generation);
  expect((await engine.executeRaw<{archived:boolean}>('SELECT archived FROM sources WHERE id=$1',[source]))[0].archived).toBe(false);
}),60_000);

test('rebind requires exact manifest including deletion and old path remains fenced',()=>fixture(async(home,source,root)=>{
  const candidate=join(home,'candidate');cpSync(root,candidate,{recursive:true});
  writeFileSync(join(candidate,'extra.md'),'Unexpected');
  await expect(runManagedSourceLifecycle(engine,{operation:'rebind',sourceId:source,path:candidate})).rejects.toMatchObject({code:'writer_manifest_mismatch'});
  rmSync(join(candidate,'extra.md'));
  await runManagedSourceLifecycle(engine,{operation:'rebind',sourceId:source,path:candidate});
  expect((await getWorktreeBinding(engine,source))!.local_path).toBe(candidate);
  const {assertManagedFilesystemWrite}=await import('../src/core/persistence/filesystem-guard.ts');
  expect(()=>assertManagedFilesystemWrite(join(root,'example.md'))).toThrow('managed canonical worktree');
}),60_000);

test('clone publication rolls forward after the directory rename and retains exact reservations until cleanup',()=>fixture(async(home,source,root)=>{
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/brain.git'})]);
  const principal=await topologyPrincipal(engine),requestId=randomUUID();
  const input={operation:'reclone' as const,sourceId:source,requestId};
  let providerCalls=0,renamed=0;
  const result=await runManagedSourceClone(engine,input,principal,requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage)=>{providerCalls++;cpSync(root,stage,{recursive:true});},
    boundary:async(name)=>{if(name==='new_moved'&&renamed++===0)throw new Error('injected lost transaction');},
  });
  expect(result).toMatchObject({state:'committed',cloned:true});expect(providerCalls).toBe(1);
  expect(await runManagedSourceLifecycle(engine,input)).toEqual(result);
  expect(readFileSync(join(root,'example.md'),'utf8')).toContain('Canonical');
  expect(readdirSync(home).some(name=>name.includes('gbrain-old')||name.startsWith('.gbrain-clone'))).toBe(false);
  expect((await engine.executeRaw<{recovery_bytes:string}>("SELECT recovery_bytes::text FROM persistence_counters WHERE key='brain'"))[0].recovery_bytes).toBe('0');
}),60_000);

test('stale cloned bytes fail before touching the active worktree and preserve a permanent failure receipt',()=>fixture(async(_home,source,root)=>{
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/brain.git'})]);
  const input={operation:'reclone' as const,sourceId:source,requestId:randomUUID()};
  const result=await runManagedSourceClone(engine,input,await topologyPrincipal(engine),input.requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage)=>{cpSync(root,stage,{recursive:true});writeFileSync(join(stage,'stale.md'),'Remote-only stale bytes');},
  });
  expect(result).toMatchObject({state:'failed',write_error:'writer_manifest_mismatch'});
  expect(readFileSync(join(root,'example.md'),'utf8')).toContain('Canonical');
  expect((await getWorktreeBinding(engine,source))!.state).toBe('active');
  expect(await runManagedSourceLifecycle(engine,input)).toEqual(result);
}),60_000);

test('revocation while cloning prevents publication and releases the root without replacing credentials',()=>fixture(async(_home,source,root)=>{
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/brain.git'})]);
  const principal=await topologyPrincipal(engine),input={operation:'reclone' as const,sourceId:source,requestId:randomUUID()};
  const result=await runManagedSourceClone(engine,input,principal,input.requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage)=>{cpSync(root,stage,{recursive:true});await revokeLocalWriter(engine,principal);},
  });
  expect(result).toMatchObject({state:'failed',write_error:'permission_denied'});
  expect((await getWorktreeBinding(engine,source))!.state).toBe('active');
  await expect(topologyPrincipal(engine)).rejects.toMatchObject({code:'permission_denied'});
}),60_000);

});
