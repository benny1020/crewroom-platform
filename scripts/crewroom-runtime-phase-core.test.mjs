import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createPhaseObserver,REMOTE_TITLES} from "./crewroom-runtime-phase-core.mjs";
test("passive wrappers preserve promise, arguments, this, return value and thrown identity",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"qualification-phase-unit-"));
  const output=path.join(dir,"phase.json"), expected={private:"SYNTHETIC_PRIVATE_PHASE"};
  let title=REMOTE_TITLES[0],calls=0;
  const observer=createPhaseObserver({output,context:()=>title,intervalMs:5});
  try{
    const promise=Promise.resolve(expected),receiver={};
    const wrapped=observer.wrap(function(arg){assert.equal(this,receiver);assert.equal(arg,expected);calls++;return promise;},"execute_session");
    assert.equal(wrapped.call(receiver,expected),promise);await promise;assert.equal(calls,1);
    assert.equal(observer.wrap(()=>expected,"execution_input")(),expected);
    assert.throws(observer.wrap(()=>{throw expected;},"asset"),error=>error===expected);
    const rejected=Promise.reject(expected);assert.equal(observer.wrap(()=>rejected,"prepare_run")(),rejected);await assert.rejects(rejected,error=>error===expected);
    await new Promise(resolve=>setTimeout(resolve,15));observer.stop();
    const text=fs.readFileSync(output,"utf8"),value=JSON.parse(text);
    assert.ok(value.pulseCount>0);assert.equal(value.active.length,0);assert.ok(!text.includes("SYNTHETIC_PRIVATE_PHASE"));assert.equal(fs.statSync(output).mode&511,384);
    const before=text;title="unrelated SYNTHETIC_PRIVATE_PHASE";
    assert.equal(wrapped.call(receiver,expected),promise);await promise;assert.equal(calls,2);assert.equal(fs.readFileSync(output,"utf8"),before);
  }finally{observer.stop();fs.rmSync(dir,{recursive:true});}
});
test("observation I/O failure cannot replace original success or failure",()=>{
  const observer=createPhaseObserver({output:"/nonexistent-qualification-fixture/output",context:()=>REMOTE_TITLES[0]});
  const error=new Error("SYNTHETIC_PRIVATE_PHASE");
  try{assert.equal(observer.wrap(()=>7,"execution_input")(),7);assert.throws(observer.wrap(()=>{throw error;},"asset"),value=>value===error);}finally{observer.stop();}
});
test("unwrapped module exports remain live and identical",()=>{
  const observer=createPhaseObserver({context:()=>null});let value=1;
  const original=()=>1,replacement=()=>2,actual={get live(){return value;},original,untouched:original};
  const exports=observer.exports(actual,{original:replacement});
  assert.equal(exports.live,1);value=2;assert.equal(exports.live,2);assert.equal(exports.original,replacement);assert.equal(exports.untouched,original);
});
