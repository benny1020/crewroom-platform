// Real inspector pause/resume from an owned worker, with an independent parent watchdog.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import assert from "node:assert/strict";
const scripts=path.dirname(fileURLToPath(import.meta.url)),directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"qualification-stack-smoke-")));
const results=[];let child,stage="setup",clue={};
try{
  for(const mode of ["js_spin","promise_spin","async_wait"]){
    stage=mode;const root=path.join(directory,mode),output=path.join(root,"capture.json"),nonce=randomBytes(16).toString("hex"),fixture=path.join(root,"server/src/services/native-runtime/native-session-executor.ts");
    fs.mkdirSync(path.dirname(fixture),{recursive:true});
    const spin=mode==="js_spin"?'function SYNTHETIC_PRIVATE_STACK(){for(;;){}};SYNTHETIC_PRIVATE_STACK();':mode==="promise_spin"?'function SYNTHETIC_PRIVATE_STACK(){void Promise.resolve().then(SYNTHETIC_PRIVATE_STACK)};void SYNTHETIC_PRIVATE_STACK();':'void new Promise(()=>{});';
    fs.writeFileSync(fixture,`import {Worker} from 'node:worker_threads';const privateValue='SYNTHETIC_PRIVATE_STACK';const worker=new Worker(${JSON.stringify(path.join(scripts,"crewroom-runtime-stack-worker.mjs"))},{execArgv:[],env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8},workerData:${JSON.stringify({output,nonce,sourceRoot:root,title:"preserves remote warm continuity across completed turns: warm",invocation:1})}});worker.once('online',()=>{${spin}});`);
    const log=fs.openSync(path.join(root,"private.log"),"wx",0o600);
    child=spawn(process.execPath,["--max-old-space-size=256",fixture],{cwd:root,detached:true,env:{PATH:process.env.PATH,HOME:root,TMPDIR:root},stdio:["ignore",log,log]});
    let timedOut=false,capture;const exit=new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
    const poll=setInterval(()=>{try{capture=JSON.parse(fs.readFileSync(output,"utf8"));if(capture.nonce===nonce){clearInterval(poll);if(child.exitCode===null&&child.signalCode===null)process.kill(-child.pid,"SIGTERM");}}catch{}},20);
    const watchdog=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,"SIGKILL");}catch{}},15000);
    try{await exit;}finally{clearTimeout(watchdog);clearInterval(poll);fs.closeSync(log);}if(!capture)try{capture=JSON.parse(fs.readFileSync(output,"utf8"));}catch{}
    clue={watchdogExpired:timedOut,capturePresent:Boolean(capture),status:capture?.status,reason:capture?.reason,resumeConfirmed:capture?.resumeConfirmed,disconnectConfirmed:capture?.disconnectConfirmed,allowedFrames:capture?.frames?.length};assert.equal(timedOut,false);assert.ok(capture);assert.equal(capture.nonce,nonce);assert.equal(capture.disconnectConfirmed,true);
    if(capture.paused)assert.equal(capture.resumeConfirmed,true);
    if(mode!=="async_wait"){assert.equal(capture.status,"captured");assert.equal(capture.resumeConfirmed,true);assert.ok(capture.frames.length>0);}else assert.notEqual(capture.status,"captured");
    const text=fs.readFileSync(output,"utf8");assert.ok(!text.includes("SYNTHETIC_PRIVATE_STACK"));assert.ok(!text.includes(root));assert.equal(fs.statSync(output).mode&511,384);assert.equal(capture.coordinateSpace,"runtime_transformed");
    results.push({mode,status:capture.status,paused:capture.paused,resumeConfirmed:capture.resumeConfirmed,disconnectConfirmed:capture.disconnectConfirmed,allowedFrames:capture.frames.length,watchdogExpired:false,ownChildSettled:true,sentinelAbsent:true});child=undefined;
  }
  console.log(JSON.stringify({inspectorSmoke:"passed",results}));
}catch(error){console.log(JSON.stringify({inspectorSmoke:"failed",stage,...clue,errorClass:["AssertionError","Error","TypeError"].includes(error?.name)?error.name:"unknown"}));process.exitCode=1;}
finally{if(child&&child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,"SIGKILL");}catch{}await new Promise(resolve=>child.once("close",resolve));}fs.rmSync(directory,{recursive:true,force:true});}
