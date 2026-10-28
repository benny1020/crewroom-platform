// Diagnostic worker only: no inspector port, source reads, evaluation or values.
import {isMainThread,workerData,parentPort} from "node:worker_threads";
import {Session} from "node:inspector";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
export const STACK_FILES=[
  "server/src/services/native-runtime/native-session-executor.ts",
  "server/src/realtime/runner-prp-outbound.ts",
  "server/src/realtime/runner-prp-ws.ts",
  "server/src/redaction.ts",
  "packages/paperclip-runner/src/live/runnerd-codex-transport.ts",
  "packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts",
  "packages/paperclip-runner/src/drivers/codex/codex-harness-session.ts",
  "packages/paperclip-runner/src/native-session-runtime.ts"
];
export function safeStackLocation(url,lineNumber,columnNumber,root){
  if(typeof url!=="string"||!Number.isInteger(lineNumber)||!Number.isInteger(columnNumber)||lineNumber<0||lineNumber>=1000000||columnNumber<0||columnNumber>=100000)return null;
  try{const absolute=url.startsWith("file:")?fileURLToPath(url):path.resolve(root,url),relative=path.relative(root,absolute).split(path.sep).join("/");return STACK_FILES.includes(relative)?{file:relative,line:lineNumber+1,column:columnNumber+1}:null;}catch{return null;}
}
if(!isMainThread){
  const {output,nonce,sourceRoot,title,invocation}=workerData;
  let session,finished=false,started=false,cancelled=false,paused=false,resumeConfirmed=false,disconnectConfirmed=false;
  const scripts=new Map();let frames=[];
  const result={version:1,nonce,title,phase:"close_idle",invocation,diagnosticOnly:true,coordinateSpace:"runtime_transformed",status:"unavailable",reason:"not_captured"};
  const send=(method)=>new Promise((resolve,reject)=>session.post(method,(error,value)=>error?reject(error):resolve(value)));
  const bounded=async(operation,ms)=>{let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("capture_timeout")),Math.max(1,ms));})]);}finally{clearTimeout(timer);}};
  const save=()=>{try{const temporary=`${output}.partial`;fs.writeFileSync(temporary,JSON.stringify({...result,paused,resumeConfirmed,disconnectConfirmed,frames}),{mode:0o600,flag:"wx"});fs.renameSync(temporary,output);}catch{}};
  const cancel=()=>{cancelled=true;if(started)return;finished=true;clearTimeout(trigger);parentPort.close();};
  parentPort.on("message",message=>{if(message==="cancel")cancel();});
  const trigger=setTimeout(async()=>{
    if(finished)return;started=true;const deadline=performance.now()+500;
    try{
      session=new Session();session.connectToMainThread();
      session.on("Debugger.scriptParsed",({params})=>{const location=safeStackLocation(params.url,0,0,sourceRoot);if(location)scripts.set(params.scriptId,location.file);});
      const observed=new Promise(resolve=>session.once("Debugger.paused",({params})=>{
        paused=true;
        for(const frame of (params.callFrames??[]).slice(0,64)){
          const location=frame.location,file=scripts.get(location?.scriptId);
          const safe=file?safeStackLocation(path.join(sourceRoot,file),location.lineNumber,location.columnNumber,sourceRoot):null;
          if(safe&&!frames.some(old=>old.file===safe.file&&old.line===safe.line&&old.column===safe.column))frames.push(safe);
          if(frames.length===8)break;
        }
        resolve();
      }));
      session.on("Debugger.resumed",()=>{resumeConfirmed=true;});
      await bounded(send("Debugger.enable"),deadline-performance.now());
      await bounded(send("Debugger.pause"),deadline-performance.now());
      await bounded(observed,deadline-performance.now());
      await bounded(send("Debugger.resume"),deadline-performance.now());resumeConfirmed=true;
      await bounded(send("Debugger.disable"),deadline-performance.now());
      result.reason=frames.length?"frames_captured":"no_allowed_frames";
    }catch{result.reason="capture_unconfirmed";}
    finally{
      // An attempted pause is never treated as proof of resumption.
      if(session){
        if(!resumeConfirmed){try{await bounded(send("Debugger.resume"),Math.max(1,deadline-performance.now()));resumeConfirmed=true;}catch{}}
        try{session.disconnect();disconnectConfirmed=true;}catch{}
      }
      if(!cancelled&&paused&&resumeConfirmed&&disconnectConfirmed&&frames.length&&result.reason==="frames_captured")result.status="captured";
      if(cancelled){result.status="unavailable";result.reason="capture_unconfirmed";}
      save();finished=true;parentPort.close();
    }
  },workerData.syntheticProof===true?100:5000);
}
