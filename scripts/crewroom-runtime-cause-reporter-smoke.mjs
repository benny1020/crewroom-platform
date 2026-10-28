// Tiny actual Vitest API/serialization proof, entirely outside product sources.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { EXPECTED_CASES, RECOVERY_FILE } from "./crewroom-runtime-cause-reporter.mjs";
const infrastructure=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const dependencyRoot=path.resolve(process.env.CREWROOM_QUALIFICATION_DEPENDENCY_ROOT ?? infrastructure);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"qualification-cause-smoke-"));
const source=path.join(directory,"product"), output=path.join(directory,"causes.json");
const reporter=path.join(infrastructure,"scripts/crewroom-runtime-cause-reporter.mjs");
async function run(label, extra, interruptPartial=false) {
  const log=fs.openSync(path.join(directory,`${label}.log`),"wx",0o600);
  const report=path.join(directory,`${label}.json`);
  const child=spawn(process.execPath,[path.join(dependencyRoot,"node_modules/vitest/vitest.mjs"),"run","--config",path.join(directory,"vitest.config.mjs"),"--root",source,"--maxWorkers=1","--includeTaskLocation","--reporter=json",`--outputFile=${report}`,...extra],{cwd:source,detached:true,env:{PATH:process.env.PATH,HOME:directory,TMPDIR:directory,CI:"true",PAPERCLIP_TELEMETRY_DISABLED:"1",CREWROOM_QUALIFICATION_SOURCE_ROOT:source,CREWROOM_QUALIFICATION_CAUSE_OUTPUT:output},stdio:["ignore",log,log]});
  let timedOut=false, escalation, observedPartial=null;
  const watcher=interruptPartial?setInterval(()=>{
    try{const value=JSON.parse(fs.readFileSync(output,"utf8"));
      if(value.complete===false&&value.cases.some(item=>item.title===EXPECTED_CASES[0]&&item.status==="failed")&&value.cases.some(item=>item.title===EXPECTED_CASES[1]&&item.status==="running")){
        observedPartial=value;clearInterval(watcher);process.kill(-child.pid,"SIGKILL");
      }
    }catch{}
  },20):undefined;
  const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,"SIGTERM");}catch{}escalation=setTimeout(()=>{try{process.kill(-child.pid,"SIGKILL");}catch{}},2000);},30000);
  try {
    const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
    assert.equal(timedOut,false);
    if(interruptPartial){assert.ok(observedPartial);assert.equal(observedPartial.complete,false);return observedPartial;}
    assert.equal(code,1);return JSON.parse(fs.readFileSync(report,"utf8"));
  } finally {clearTimeout(timer);clearTimeout(escalation);clearInterval(watcher);fs.closeSync(log);}
}
let failureStage="setup";
try {
  fs.mkdirSync(path.dirname(path.join(source,RECOVERY_FILE)),{recursive:true});
  fs.symlinkSync(path.join(dependencyRoot,"node_modules"),path.join(source,"node_modules"),"dir");
  fs.writeFileSync(path.join(directory,"vitest.config.mjs"),`export default {cacheDir:${JSON.stringify(path.join(directory,"cache"))},test:{include:[${JSON.stringify(RECOVERY_FILE)}],pool:'forks',maxWorkers:1,testTimeout:5000}};`);
  const fixture=`import {it,expect} from 'vitest';\n${[0,1].map((index)=>`it(${JSON.stringify(EXPECTED_CASES[index])},()=>{try{expect(${index?"false":"0"}).toBe(${index?"true":"1"});}catch(cause){throw new Error('SYNTHETIC_PRIVATE_CAUSE_SENTINEL',{cause:new Error('SYNTHETIC_PRIVATE_CAUSE_SENTINEL',{cause})});}});`).join("\n")}\n`;
  fs.writeFileSync(path.join(source,RECOVERY_FILE),fixture);
  failureStage="stock_run";const baseline=await run("stock",[]);
  failureStage="combined_run";const combined=await run("combined",[`--reporter=${reporter}`]);
  failureStage="validation";
  assert.equal(baseline.numTotalTests,2);assert.equal(baseline.numFailedTests,2);
  assert.equal(combined.numTotalTests,baseline.numTotalTests);assert.equal(combined.numFailedTests,baseline.numFailedTests);assert.equal(combined.success,false);
  const text=fs.readFileSync(output,"utf8"), value=JSON.parse(text);
  assert.equal(value.status,"available");assert.equal(value.cases.length,2);assert.ok(!text.includes("SYNTHETIC_PRIVATE_CAUSE_SENTINEL"));
  assert.equal(fs.statSync(output).mode&0o777,0o600);
  for(const item of value.cases){const entries=item.chains[0].entries;assert.equal(entries.length,3);assert.equal(entries[2].errorClass,"assertion");assert.ok(entries[2].locations.some(frame=>frame.file===RECOVERY_FILE));}
  assert.ok(value.cases.some(item=>item.chains[0].entries[2].comparison?.actual===0));
  assert.ok(value.cases.some(item=>item.chains[0].entries[2].comparison?.actual===false));
  failureStage="partial_run";
  fs.writeFileSync(path.join(source,RECOVERY_FILE),`import {it} from 'vitest';\nit(${JSON.stringify(EXPECTED_CASES[0])},()=>{throw new Error('SYNTHETIC_PRIVATE_CAUSE_SENTINEL');});\nit(${JSON.stringify(EXPECTED_CASES[1])},async()=>{await new Promise(()=>{});},10000);\nit(${JSON.stringify(EXPECTED_CASES[2])},()=>{});\n`);
  const partial=await run("partial",[`--reporter=${reporter}`],true);
  assert.ok(partial.cases.some(item=>item.title===EXPECTED_CASES[0]&&item.status==="failed"));
  assert.ok(partial.cases.some(item=>item.title===EXPECTED_CASES[1]&&item.status==="running"));
  assert.ok(!partial.cases.some(item=>item.title===EXPECTED_CASES[2]));
  assert.ok(!JSON.stringify(partial).includes("SYNTHETIC_PRIVATE_CAUSE_SENTINEL"));
  console.log(JSON.stringify({partialSavedBeforeRunEnd:true,partialFailedAndRunning:true,notStartedRecognizable:true,actualVitestHook:true,stockTests:2,stockFailed:2,countsUnchanged:true,twoLevelCauses:true,boolAndInt:true,sentinelAbsent:true,ownerOnlyFile:true}));
} catch (error) {
  console.log(JSON.stringify({smoke:"failed",stage:failureStage,errorClass:["AssertionError","Error","TypeError"].includes(error?.name)?error.name:"unknown"}));process.exitCode=1;
} finally {fs.rmSync(directory,{recursive:true});}
