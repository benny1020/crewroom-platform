// Passive CI diagnostics. Never persist arguments, messages, paths or process IDs.
import fs from "node:fs";
import { setInterval, clearInterval } from "node:timers";
import {Worker} from "node:worker_threads";
export const REMOTE_TITLES = ["warm", "hard", "legacy", "changed", "same-server"].map(value => `preserves remote warm continuity across completed turns: ${value}`);
export const PHASES = ["tls", "asset", "execution_input", "prepare_run", "finalize_run", "execute_session", "close_idle", "tunnel_close", "docker_execute", "sync_tar", "sync_ps"];
export function createPhaseObserver({ output, context, intervalMs = 1000 }) {
  const started = performance.now(), counts = new Map(), active = new Map();
  let sequence=0, pulseCount=0, lastPulseMs=0, timer, unavailable=false,stackAttempted=false,stackWorker,stackClosed;
  const events=[];
  const elapsed=()=>Math.min(9999999,Math.max(0,Math.round(performance.now()-started)));
  const title=()=>{try{const value=context();return REMOTE_TITLES.includes(value)?value:null;}catch{return null;}};
  function save() {
    if(!output)return;
    try {
      const temporary=`${output}.partial`;
      const root=process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT;
      const workerCwdRelation=process.cwd()===root?"product_root":process.cwd()===`${root}/server`?"server_root":"other";
      fs.writeFileSync(temporary,JSON.stringify({version:1,status:unavailable?"unavailable":"available",diagnosticOnly:true,workerCwdRelation,pulseCount,lastPulseMs,events,active:[...active.values()]}),{mode:0o600,flag:"wx"});
      fs.renameSync(temporary,output);
    }catch{unavailable=true;}
  }
  function event(phase, edge, invocation, caseTitle, result) {
    try {
      const item={sequence:++sequence,elapsedMs:elapsed(),title:caseTitle,phase,edge,invocation};
      if(phase==="docker_execute"&&edge==="leave") {
        if(Number.isInteger(result?.exitCode)&&Math.abs(result.exitCode)<=9999)item.exitCode=result.exitCode;
        if(typeof result?.timedOut==="boolean")item.timedOut=result.timedOut;
      }
      events.push(item);if(events.length>256)events.shift();save();
    }catch{unavailable=true;}
  }
  function wrap(fn,phase) {
    if(!PHASES.includes(phase))throw new Error("invalid_phase");
    return function(...args) {
      const caseTitle=title();if(!caseTitle)return Reflect.apply(fn,this,args);
      if(!timer){timer=setInterval(()=>{pulseCount=Math.min(9999999,pulseCount+1);lastPulseMs=elapsed();save();},intervalMs);timer.unref();}
      const key=`${caseTitle}:${phase}`,invocation=Math.min(9999999,(counts.get(key)??0)+1);counts.set(key,invocation);
      const activity={title:caseTitle,phase,invocation},activityKey=`${key}:${invocation}`;
      active.set(activityKey,activity);event(phase,"enter",invocation,caseTitle);
      if(phase==="close_idle"&&!stackAttempted&&process.env.CREWROOM_QUALIFICATION_STACK_OUTPUT&&/^[a-f0-9]{32}$/.test(process.env.CREWROOM_QUALIFICATION_CAPTURE_NONCE??"")){
        stackAttempted=true;
        try{
          stackWorker=new Worker(new URL("./crewroom-runtime-stack-worker.mjs",import.meta.url),{execArgv:[],env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8},workerData:{output:process.env.CREWROOM_QUALIFICATION_STACK_OUTPUT,nonce:process.env.CREWROOM_QUALIFICATION_CAPTURE_NONCE,sourceRoot:process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT,title:caseTitle,invocation}});
          stackClosed=new Promise(resolve=>{stackWorker.once("exit",resolve);stackWorker.on("error",()=>{});});stackWorker.unref();
        }catch{unavailable=true;}
      }
      const finish=(edge,result)=>{active.delete(activityKey);event(phase,edge,invocation,caseTitle,result);if(phase==="close_idle")try{stackWorker?.postMessage("cancel");}catch{}};
      let result;
      try{result=Reflect.apply(fn,this,args);}catch(error){finish("throw");throw error;}
      // Return the original thenable; observation does not add an await boundary.
      try{if(result&&typeof result.then==="function")result.then(value=>finish("leave",value),()=>finish("reject"));else finish("leave",result);}catch{unavailable=true;}
      return result;
    };
  }
  return {wrap,enabled:()=>title()!==null,exports:(actual,replacements)=>new Proxy(actual,{get:(target,key,receiver)=>Object.hasOwn(replacements,key)?replacements[key]:Reflect.get(target,key,receiver)}),stop(){if(timer)clearInterval(timer);timer=undefined;save();if(stackWorker){try{stackWorker.postMessage("cancel");}catch{}return stackClosed;}}};
}
