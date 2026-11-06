// QA23 SYNTHETIC ONLY. Append-only multi-operation admission lab, NOT a QA Manager helper.
// Creates files with 'wx' only. Never modifies/removes/renames existing files or Git refs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const stop = (reason) => {throw new Error('QA23_STOP:' + reason);};
const pad = (n) => String(n).padStart(6,'0');
const expectedIds = ['front-A', 'front-B', 'front-C'];
const parentRaw = process.env.QA23_SYNTHETIC_PARENT;
function readFileStrict(p) {
  const s = fs.lstatSync(p);
  if (!s.isFile() || s.isSymbolicLink()) stop('UNSAFE_INPUT_FILE');
  return fs.readFileSync(p,'utf8');
}
function readJSON(p) {
  try {return JSON.parse(readFileStrict(p));} catch(e) {stop('INVALID_JSON_OR_FILE:' + path.basename(p));}
}
function createNew(p, value) {
  // Exclusive OS create is the sole admission claim. This does not block a rogue legacy writer.
  const fd = fs.openSync(p,'wx',0o600);
  try {fs.writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value)+'\n','utf8');fs.fsyncSync(fd);}
  finally {fs.closeSync(fd);}
}
function assertDir(p) {
  const s=fs.lstatSync(p);
  if(!s.isDirectory()||s.isSymbolicLink())stop('UNSAFE_DIRECTORY');
}
function parent() {
  if(!parentRaw || !path.isAbsolute(parentRaw))stop('PARENT_ENV_REQUIRED');
  const r=path.resolve(parentRaw);
  if(!fs.existsSync(r))stop('PARENT_NOT_FOUND');
  assertDir(r);
  if(process.platform==='win32'){
    const temp=path.resolve(process.env.RUNNER_TEMP||'C:\\nonexistent');
    if(!(r.toLowerCase().startsWith(temp.toLowerCase()+path.sep)))stop('NOT_IN_WINDOWS_RUNNER_TEMP');
  }else if(!r.startsWith('/mnt/data/qa23_multi_case_v2')){
    stop('NOT_IN_SYNTHETIC_PARENT');
  }
  return r;
}
function root(arg) {
  if(!arg||!path.isAbsolute(arg))stop('ABSOLUTE_ROOT_REQUIRED');
  const p=path.resolve(arg), par=parent();
  if(path.dirname(p)!==par || !/^case-[a-z0-9-]+$/i.test(path.basename(p)))stop('PATH_OUTSIDE_ALLOWED_ROOT');
  if(fs.existsSync(p))assertDir(p);
  return p;
}
function sub(p, child){return path.join(p,child);}
function file(p,dir,n,suffix){return sub(sub(p,dir),pad(n)+(suffix||'.json'));}
function git(cwd,args) {
  const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:20000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  if(r.error||r.status!==0)stop('SYNTHETIC_GIT_FAILED');
  return r.stdout.trim();
}
function canonicalGit(p) {
  return path.resolve(git(p,['rev-parse','--absolute-git-dir']).replace(/\//g,path.sep)).toLowerCase();
}
function whitelist(p,dir,names) {
  const current=fs.readdirSync(sub(p,dir));
  for(const name of current) if(!names.has(name))stop('UNEXPECTED_FILE_'+dir+'_'+name);
}
function isInt(i){return Number.isSafeInteger(i)&&i>=0;}
function bootstrap(p) {
  if(fs.existsSync(p))stop('BOOTSTRAP_ROOT_PREEXISTS');
  fs.mkdirSync(p,{mode:0o700});
  for(const dir of ['legacy','new','events','snapshots'])fs.mkdirSync(sub(p,dir),{mode:0o700});
  git(sub(p,'legacy'),['init','--quiet']);git(sub(p,'new'),['init','--quiet']);
  const genesis={schema:'QA23_SYNTHETIC_STATE_V2',epoch:0,fronts:Object.fromEntries(expectedIds.map(x=>[x,'active']))};
  const content=JSON.stringify(genesis)+'\n';
  createNew(file(p,'snapshots',0),content);
  const meta={schema:'QA23_SYNTHETIC_BOOTSTRAP_V2',initialSha256:sha(content),
    legacyGit:canonicalGit(sub(p,'legacy')),newGit:canonicalGit(sub(p,'new'))};
  if(meta.legacyGit===meta.newGit)stop('GIT_DOMAINS_SAME');
  createNew(sub(p,'bootstrap.json'),meta);
  console.log('BOOTSTRAP_PASS=TRUE GIT_INDEPENDENT=TRUE');
}
function inspect(p) {
  for(const dir of ['legacy','new','events','snapshots'])assertDir(sub(p,dir));
  whitelist(p,'events',new Set(Array.from({length:100},(_,i)=>[`${pad(i+1)}.prepare.json`,`${pad(i+1)}.commit.json`]).flat()));
  whitelist(p,'snapshots',new Set(Array.from({length:101},(_,i)=>`${pad(i)}.json`)));
  const meta=readJSON(sub(p,'bootstrap.json'));
  if(meta.schema!=='QA23_SYNTHETIC_BOOTSTRAP_V2')stop('META_SCHEMA');
  if(canonicalGit(sub(p,'legacy'))!==meta.legacyGit||canonicalGit(sub(p,'new'))!==meta.newGit||meta.legacyGit===meta.newGit)stop('GIT_DOMAIN_CHANGED');
  const initialText=readFileStrict(file(p,'snapshots',0));
  if(sha(initialText)!==meta.initialSha256)stop('GENESIS_MUTATED');
  const genesis=JSON.parse(initialText);
  if(genesis.schema!=='QA23_SYNTHETIC_STATE_V2'||genesis.epoch!==0||expectedIds.some(id=>genesis.fronts[id]!=='active'))stop('GENESIS_INVALID');
  const evs=fs.readdirSync(sub(p,'events'));
  const epochs=evs.map(v=>Number(v.slice(0,6))).filter(isInt);
  const max=epochs.length?Math.max(...epochs):0;
  if(max>100)stop('MAX_EPOCH');
  let state=genesis, beforeHash=sha(initialText), receiptHash=meta.initialSha256, status='READY';
  for(let epoch=1;epoch<=max;epoch++){
    const prepPath=file(p,'events',epoch,'.prepare.json'),commitPath=file(p,'events',epoch,'.commit.json'),snapPath=file(p,'snapshots',epoch);
    if(!fs.existsSync(prepPath)){status='UNCERTAIN_STOP';break;}
    const prep=readJSON(prepPath);
    if(prep.schema!=='QA23_PREPARE_V2'||prep.epoch!==epoch||prep.beforeHash!==beforeHash||prep.previousReceipt!==receiptHash||!expectedIds.includes(prep.frontId)||state.fronts[prep.frontId]!=='active')stop('INVALID_PREPARE_CHAIN');
    if(!fs.existsSync(commitPath)||!fs.existsSync(snapPath)){status='UNCERTAIN_STOP';break;}
    const nextText=readFileStrict(snapPath),next=JSON.parse(nextText),rc=readJSON(commitPath);
    const desired={...state.fronts,[prep.frontId]:'ready_for_integration'};
    if(next.schema!=='QA23_SYNTHETIC_STATE_V2'||next.epoch!==epoch||JSON.stringify(next.fronts)!==JSON.stringify(desired))stop('INVALID_NEXT_STATE');
    if(rc.schema!=='QA23_COMMIT_V2'||rc.epoch!==epoch||rc.beforeHash!==beforeHash||rc.afterHash!==sha(nextText)||rc.frontId!==prep.frontId||rc.previousReceipt!==receiptHash||rc.prepareHash!==sha(readFileStrict(prepPath)))stop('INVALID_COMMIT_RECEIPT');
    state=next;beforeHash=sha(nextText);receiptHash=sha(readFileStrict(commitPath));
  }
  if(status==='READY' && fs.readdirSync(sub(p,'snapshots')).length!==max+1)status='UNCERTAIN_STOP';
  // There is no repair routine: partial/tampered journals never advance.
  return {status,epoch:state.epoch,state,beforeHash,receiptHash,gitIndependent:true};
}
function advance(p,id,interrupt) {
  if(!expectedIds.includes(id))stop('FRONT_NOT_ALLOWED');
  const checked=inspect(p);
  if(checked.status!=='READY')stop('PREVIOUS_EPOCH_UNCERTAIN');
  if(checked.state.fronts[id]!=='active')stop('FRONT_ALREADY_MARKED');
  const epoch=checked.epoch+1;
  const prepare={schema:'QA23_PREPARE_V2',epoch,frontId:id,beforeHash:checked.beforeHash,previousReceipt:checked.receiptHash};
  // Crucial admission decision: exactly one competing process can create this name.
  try{createNew(file(p,'events',epoch,'.prepare.json'),prepare);}catch(e){if(e.code==='EEXIST')stop('ADMISSION_ALREADY_CLAIMED');throw e;}
  console.log('ADMISSION_CLAIMED_EPOCH='+epoch);
  if(interrupt==='prepare'){console.log('SIMULATED_INTERRUPT=AFTER_PREPARE');process.exitCode=46;return;}
  const next={schema:'QA23_SYNTHETIC_STATE_V2',epoch,fronts:{...checked.state.fronts,[id]:'ready_for_integration'}};
  createNew(file(p,'snapshots',epoch),next);
  if(interrupt==='snapshot'){console.log('SIMULATED_INTERRUPT=AFTER_SNAPSHOT');process.exitCode=47;return;}
  const afterHash=sha(readFileStrict(file(p,'snapshots',epoch)));
  const receipt={schema:'QA23_COMMIT_V2',epoch,frontId:id,beforeHash:checked.beforeHash,
    afterHash,previousReceipt:checked.receiptHash,prepareHash:sha(readFileStrict(file(p,'events',epoch,'.prepare.json')))};
  createNew(file(p,'events',epoch,'.commit.json'),receipt);
  console.log('COMMIT_PASS=TRUE EPOCH='+epoch+' FRONT='+id+' AFTER_SHA='+afterHash);
}
function main(){
  const [verb,rootArg,id,extra,...other]=process.argv.slice(2);
  if(other.length||!['bootstrap','inspect','advance'].includes(verb))stop('ARGS_INVALID');
  const p=root(rootArg);
  if(verb==='bootstrap'&&id===undefined&&extra===undefined)bootstrap(p);
  else if(verb==='inspect'&&id===undefined&&extra===undefined){
    const found=inspect(p);console.log('INSPECT='+found.status+' EPOCH='+found.epoch+' GIT_INDEPENDENT='+found.gitIndependent);
    if(found.status!=='READY')process.exitCode=31;
  }else if(verb==='advance' && id && (extra===undefined||['--interrupt=prepare','--interrupt=snapshot'].includes(extra)))advance(p,id,extra?.split('=')[1]);
  else stop('ARGS_INVALID');
}
try{main();}catch(e){console.error(e.message);process.exitCode=23;}
