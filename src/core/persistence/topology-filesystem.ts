import { spawn } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import { durableSsrfFlags, GIT_ENV, GIT_SSRF_SUBCOMMAND_FLAGS, parseRemoteUrl } from '../git-remote.ts';
import { persistenceHome } from './identity.ts';

export function flushTopologyDirectory(path:string):void{
  let fd:number|undefined;
  try{fd=openSync(path,'r');fsyncSync(fd);}
  catch(error){if(!(process.platform==='win32'&&['EISDIR','EPERM','EINVAL','ENOTSUP'].includes((error as NodeJS.ErrnoException).code??'')))throw error;}
  finally{if(fd!==undefined)closeSync(fd);}
}
/** Complete tree accounting includes .git, sparse files, and metadata headroom. */
export async function topologyDirectoryBytes(root:string,limit=Number.MAX_SAFE_INTEGER):Promise<number>{
  let bytes=0;
  const pending=[root];
  while(pending.length){
    const path=pending.pop()!;
    let info;
    try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    bytes+=4096+info.size;
    if(!Number.isSafeInteger(bytes)||bytes>limit)throw new OperationError('request_too_large','The staged checkout exceeds its reserved recovery capacity.');
    if(info.isDirectory())for(const entry of await readdir(path))pending.push(join(path,entry));
  }
  return bytes;
}
export function flushTopologyTree(root:string):void{
  const visit=(path:string)=>{
    const info=lstatSync(path);
    if(info.isSymbolicLink())throw new OperationError('writer_manifest_unsafe','Canonical checkout recovery refuses symbolic links.');
    if(info.isDirectory()){
      for(const entry of readdirSync(path))visit(join(path,entry));
      flushTopologyDirectory(path);
    }else if(info.isFile()){
      const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    }
  };
  visit(root);
}

/** Reserved staging, no DB checkout; kill only this owned Git child on overflow. */
export async function cloneTopologyCheckout(url:string,destination:string,maxBytes:number,timeoutMs=600_000):Promise<void>{
  parseRemoteUrl(url);
  if(existsSync(destination))throw new OperationError('source_changed','The reserved clone staging path already exists.');
  const base=join(persistenceHome(),'empty-hooks');mkdirSync(base,{recursive:true,mode:0o700});
  const hooks=mkdtempSync(join(base,'clone-'));
  const child=spawn('git',[...durableSsrfFlags(),'-c',`core.hooksPath=${hooks}`, 'clone',...GIT_SSRF_SUBCOMMAND_FLAGS,'--depth=1','--',url,destination],
    {stdio:['ignore','ignore','ignore'],env:{...process.env,...GIT_ENV}});
  let failure:unknown,check:Promise<void>|undefined;
  const stop=(error:unknown)=>{failure??=error;child.kill('SIGKILL');};
  const monitor=setInterval(()=>{
    if(!check)check=topologyDirectoryBytes(destination,maxBytes).then(()=>{}).catch(stop).finally(()=>{check=undefined;});
  },50);
  const timer=setTimeout(()=>stop(new OperationError('storage_error','The staged clone exceeded its execution deadline.')),timeoutMs);
  try{
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    await check;
    if(failure)throw failure;
    if(code!==0)throw new OperationError('storage_error','The reserved source clone failed.','Inspect the configured remote and owner Git credentials.');
    await topologyDirectoryBytes(destination,maxBytes);
  }finally{clearInterval(monitor);clearTimeout(timer);await check;rmSync(hooks,{recursive:true,force:true});}
}
