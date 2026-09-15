import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { digest } from './digest.ts';
import { lockCounters } from './journal.ts';
import { readJournalLimits } from './limits.ts';
import { principalKey } from './model.ts';

export interface TopologyChange {
  id:string; principal_id:string; request_id:string; digest:string; operation:string; source_id:string;
  source_incarnation:string|null; worktree_ids:string[]; state:'recovering'|'committed'|'failed';
  recovery:Record<string,unknown>|null; recovery_bytes:number; terminal_bytes:number; outcome:Record<string,unknown>|null;
}
export async function priorTopologyChange(engine:BrainEngine,principal:string,requestId:string,intent:unknown):Promise<TopologyChange|null> {
  const page=await engine.executeRaw("SELECT id FROM persistence_requests WHERE principal_kind='local_cli' AND principal_id=$1 AND request_id=$2::uuid",[principal,requestId]);
  if(page.length) throw new OperationError('idempotency_conflict','This request_id belongs to a page mutation.');
  const [prior]=await engine.executeRaw<TopologyChange>('SELECT * FROM persistence_topology_changes WHERE principal_id=$1::uuid AND request_id=$2::uuid',[principal,requestId]);
  if(prior && prior.digest!==digest(intent)) throw new OperationError('idempotency_conflict','This lifecycle request_id was accepted with different arguments.');
  return prior??null;
}
export async function recordTopologyChange(tx:BrainEngine, input:{principal:string;requestId:string;intent:unknown;operation:string;sourceId:string;incarnation:string|null;worktrees:string[]},
  outcome:Record<string,unknown>, recovery:Record<string,unknown>|null=null,recoveryBytes=0):Promise<TopologyChange> {
  const terminalBytes=16_384;
  if(Buffer.byteLength(JSON.stringify(outcome))+1024>terminalBytes) throw new OperationError('request_too_large','Lifecycle outcome exceeds its retained receipt capacity.');
  const limits=await readJournalLimits(tx);
  const key=principalKey({kind:'local_cli',id:input.principal});
  const counters=await lockCounters(tx,['brain',key,...input.worktrees.map(id=>`worktree:${id}`)]);
  await priorTopologyChange(tx,input.principal,input.requestId,input.intent);
  for(const counter of counters){
    const brain=counter.key==='brain';
    if(!counter.key.startsWith('worktree:')){
      if(Number(counter.lifetime_ids)+1>(brain?limits.brainLifetimeIds:limits.principalLifetimeIds)
        ||Number(counter.terminal_bytes)+terminalBytes>(brain?limits.brainTerminalBytes:limits.principalTerminalBytes))
        throw new OperationError('queue_capacity','Permanent lifecycle receipts reached the configured capacity. Increase the quota; existing IDs are retained.');
    }
    if(recoveryBytes && counter.key!==key && Number(counter.recovery_bytes)+recoveryBytes>(brain?limits.brainRecoveryBytes:limits.worktreeRecoveryBytes))
      throw new OperationError('queue_capacity','The lifecycle recovery exceeds available brain/worktree capacity.');
  }
  const [row]=await tx.executeRaw<TopologyChange>(`INSERT INTO persistence_topology_changes
    (principal_id,request_id,digest,operation,source_id,source_incarnation,worktree_ids,state,recovery,recovery_bytes,terminal_bytes,outcome)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid[],$8,$9::text::jsonb,$10,$11,$12::text::jsonb) RETURNING *`,
  [input.principal,input.requestId,digest(input.intent),input.operation,input.sourceId,input.incarnation,input.worktrees,recovery?'recovering':'committed',
    recovery?JSON.stringify(recovery):null,recoveryBytes,terminalBytes,JSON.stringify(outcome)]);
  for(const counter of counters){
    if(!counter.key.startsWith('worktree:')) await tx.executeRaw('UPDATE persistence_counters SET lifetime_ids=lifetime_ids+1,terminal_bytes=terminal_bytes+$2 WHERE key=$1',[counter.key,terminalBytes]);
    if(recoveryBytes && counter.key!==key) await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$2 WHERE key=$1',[counter.key,recoveryBytes]);
  }
  return row;
}
export function topologyReceipt(row:TopologyChange):Record<string,unknown>{
  return {...row.outcome,request_id:row.request_id,state:row.state,retry_after_ms:row.state==='recovering'?1000:null};
}
