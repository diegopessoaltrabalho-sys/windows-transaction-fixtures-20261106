// QA23 self-contained synthetic tests. Create new fixtures only; never cleanup, delete, overwrite.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
const script=path.resolve(process.argv[2]||'');
if(!fs.existsSync(script)||path.basename(script)!=='QA23_BOOTSTRAP_MULTI_V2.mjs')throw new Error('STOP_SCRIPT_NOT_OUR_SYNTHETIC_LAB');
const parent=path.resolve(process.argv[3]||'');
if(!path.isAbsolute(process.argv[3]||''))throw new Error('STOP_PARENT_NOT_ABSOLUTE');
if(process.platform==='win32'){
  const runner=path.resolve(process.env.RUNNER_TEMP||'C:\\not-a-runner');
  if(!parent.toLowerCase().startsWith(runner.toLowerCase()+path.sep))throw new Error('STOP_WINDOWS_PARENT_OUTSIDE_RUNNER_TEMP');
}else if(!parent.startsWith('/mnt/data/qa23_multi_case_v2'))throw new Error('STOP_LINUX_PARENT_NOT_SYNTHETIC');
if(fs.existsSync(parent))throw new Error('STOP_LAB_PARENT_ALREADY_EXISTS');
fs.mkdirSync(parent,{mode:0o700});
const env={...process.env,QA23_SYNTHETIC_PARENT:parent,GIT_CONFIG_NOSYSTEM:'1'};
let checks=0;
function check(ok,code){if(!ok)throw new Error('CHECK_FAILED:'+code);checks++;console.log('PASS='+code)}
function root(id){return path.join(parent,'case-'+id)}
function run(cmd,id,...args){return spawnSync(process.execPath,[script,cmd,root(id),...args],{env,encoding:'utf8',timeout:30000});}
function works(r,marker){return r.status===0&&r.stdout.includes(marker)}
function rejected(r,marker){return r.status===23&&r.stderr.includes(marker)}
async function runAsync(cmd,id,...args){
  return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[script,cmd,root(id),...args],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');
    p.stdout.on('data',s=>stdout+=s);p.stderr.on('data',s=>stderr+=s);
    p.on('error',reject);p.on('close',(code,signal)=>resolve({status:code,signal,stdout,stderr}));
  });
}
for(const name of ['normal','race','crash-prepare','crash-snapshot','unknown','validation']){
  check(works(run('bootstrap',name),'BOOTSTRAP_PASS=TRUE GIT_INDEPENDENT=TRUE'),'BOOTSTRAP_'+name.toUpperCase().replaceAll('-','_'));
}
check(works(run('inspect','normal'),'INSPECT=READY EPOCH=0'),'GENESIS_READ_ONLY');
for(const [i,id] of ['front-A','front-B','front-C'].entries()){
  check(works(run('advance','normal',id),`COMMIT_PASS=TRUE EPOCH=${i+1} FRONT=${id}`),'SEQUENTIAL_COMMIT_'+(i+1));
  check(works(run('inspect','normal'),`INSPECT=READY EPOCH=${i+1}`),'SEQUENTIAL_CHAIN_VERIFIED_'+(i+1));
}
check(rejected(run('advance','normal','front-A'),'FRONT_ALREADY_MARKED'),'DUPLICATE_FRONT_BLOCKED');
check(rejected(run('advance','normal','unexpected-front'),'FRONT_NOT_ALLOWED'),'UNKNOWN_FRONT_BLOCKED');
check(rejected(run('advance','normal','front-A','--unknown-flag'),'ARGS_INVALID'),'UNRECOGNIZED_ARGUMENT_BLOCKED');
check(works(run('inspect','race'),'INSPECT=READY EPOCH=0'),'CONCURRENCY_BEGIN_CLEAN');
const racing=await Promise.all(Array.from({length:6},()=>runAsync('advance','race','front-A')));
check(racing.filter(r=>r.status===0&&r.stdout.includes('COMMIT_PASS=TRUE')).length===1,'CONCURRENT_EXACTLY_ONE_WINNER');
check(racing.filter(r=>r.status===23).length===5,'CONCURRENT_ALL_LOSERS_FAIL_CLOSED');
check(works(run('inspect','race'),'INSPECT=READY EPOCH=1'),'CONCURRENT_RECEIPT_CHAIN_VALID');
check(works(run('advance','race','front-B'),'COMMIT_PASS=TRUE EPOCH=2'),'NEXT_EPOCH_AFTER_RACE_ALLOWED');
check(works(run('inspect','race'),'INSPECT=READY EPOCH=2'),'NEXT_EPOCH_AFTER_RACE_VERIFIED');
const partialPrepare=run('advance','crash-prepare','front-A','--interrupt=prepare');
check(partialPrepare.status===46&&partialPrepare.stdout.includes('SIMULATED_INTERRUPT=AFTER_PREPARE'),'CRASH_AFTER_PREPARE_SIMULATED');
check(run('inspect','crash-prepare').status===31,'CRASH_AFTER_PREPARE_UNCERTAIN');
check(rejected(run('advance','crash-prepare','front-B'),'PREVIOUS_EPOCH_UNCERTAIN'),'CRASH_AFTER_PREPARE_NO_NEXT_EPOCH');
const partialSnapshot=run('advance','crash-snapshot','front-A','--interrupt=snapshot');
check(partialSnapshot.status===47&&partialSnapshot.stdout.includes('SIMULATED_INTERRUPT=AFTER_SNAPSHOT'),'CRASH_AFTER_SNAPSHOT_SIMULATED');
check(run('inspect','crash-snapshot').status===31,'CRASH_AFTER_SNAPSHOT_UNCERTAIN');
check(rejected(run('advance','crash-snapshot','front-B'),'PREVIOUS_EPOCH_UNCERTAIN'),'CRASH_AFTER_SNAPSHOT_NO_NEXT_EPOCH');
check(rejected(run('advance','validation','front-Z'),'FRONT_NOT_ALLOWED'),'INVALID_IDENTIFIER_BLOCKED');
const outside=path.resolve(parent,'..','case-outside');
const failOutside=spawnSync(process.execPath,[script,'bootstrap',outside],{env,encoding:'utf8',timeout:30000});
check(rejected(failOutside,'PATH_OUTSIDE_ALLOWED_ROOT'),'OUTSIDE_ROOT_REJECTED');
check(!fs.existsSync(outside),'OUTSIDE_ROOT_NOT_CREATED');
// Synthetic contamination is a new file only: fail closed without changing old journal.
fs.writeFileSync(path.join(root('unknown'),'events','unexpected.marker'),'invalid event\n',{flag:'wx'});
check(rejected(run('advance','unknown','front-A'),'UNEXPECTED_FILE_events'),'UNKNOWN_ADDITIONAL_EVENT_FAIL_CLOSED');
check(fs.existsSync(path.join(root('unknown'),'events','unexpected.marker')),'UNEXPECTED_MARKER_PRESERVED_NO_CLEANUP');
check(!fs.existsSync(path.join(root('crash-prepare'),'snapshots','000001.json')),'CRASH_PREPARE_NO_STATE_MATERIALIZATION');
check(fs.existsSync(path.join(root('crash-snapshot'),'snapshots','000001.json')),'CRASH_SNAPSHOT_STATE_PRESERVED_AS_UNCERTAIN');
check(!fs.existsSync(path.join(root('crash-snapshot'),'events','000001.commit.json')),'CRASH_SNAPSHOT_NO_FALSE_RECEIPT');
console.log('QA23_SYNTHETIC_MULTI_PASS_COUNT='+checks);
console.log('IMPORTANT_LIMIT=NO_LEGACY_WRITER_ENFORCEMENT_NO_REAL_QA_APPROVAL');
