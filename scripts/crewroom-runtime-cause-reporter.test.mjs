import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Reporter, { EXPECTED_CASES, RECOVERY_FILE, sanitizeChain, sanitizeError } from "./crewroom-runtime-cause-reporter.mjs";

const root = "/synthetic/product";
test("nested causes preserve only fixed classes, bounded comparisons and exact fixture frames", () => {
  const inner = { name: "AssertionError", message: "expected false to be true", stacks: [{ file: `${root}/${RECOVERY_FILE}`, line: 333, column: 9 }, { file: "/private/SYNTHETIC_SECRET.key", line: 1, column: 1 }] };
  const wrapped = { name: "Error", message: "SYNTHETIC_SECRET", cause: { name: "TypeError", message: "SYNTHETIC_SECRET", cause: inner } };
  const value = sanitizeChain(wrapped, root);
  assert.equal(value.chainState, "complete");
  assert.deepEqual(value.entries.map(entry => [entry.depth, entry.relation, entry.errorClass]), [[0,"root","error"],[1,"cause","type_error"],[2,"cause","assertion"]]);
  assert.deepEqual(value.entries[2].comparison, { operator: "equal", expected: true, actual: false });
  assert.deepEqual(value.entries[2].locations, [{ file: RECOVERY_FILE, line: 333, column: 9 }]);
  assert.ok(!JSON.stringify(value).includes("SYNTHETIC_SECRET"));
  assert.ok(!JSON.stringify(value).includes(root));
});
test("cycles and depth are bounded and absent cause is explicit", () => {
  const cycle = { name: "Error", message: "private" }; cycle.cause = cycle;
  assert.equal(sanitizeChain(cycle, root).chainState, "cycle");
  let deep = { name: "Error" }; for (let index=0; index<12; index++) deep = { name: "Error", cause: deep };
  const limited = sanitizeChain(deep, root);
  assert.equal(limited.entries.length, 8); assert.equal(limited.chainState, "truncated");
  assert.equal(sanitizeChain({ name:"Error" }, root).chainState, "absent");
});
test("prototype names, string/object values and private paths cannot escape", () => {
  for (const name of ["constructor", "__proto__", "SYNTHETIC_SECRET"]) assert.equal(sanitizeError({name}, root).errorClass, "unknown");
  for (const message of ["expected 'SYNTHETIC_SECRET' to be 'OTHER'", "expected 12345678901234 to be 0", "expected { token: 'SYNTHETIC_SECRET' } to equal {}"])
    assert.deepEqual(sanitizeError({name:"AssertionError",message,actual:"SYNTHETIC_SECRET",expected:"OTHER"},root),{errorClass:"assertion"});
});
test("official hook only accepts expected title and fixture, and writes sanitized owner-only output", () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cause-reporter-offline-"));
  const oldRoot=process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT, oldOutput=process.env.CREWROOM_QUALIFICATION_CAUSE_OUTPUT;
  try {
    process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT=root;
    process.env.CREWROOM_QUALIFICATION_CAUSE_OUTPUT=path.join(directory,"causes.json");
    const reporter=new Reporter();
    reporter.onTestCaseResult({name:"SYNTHETIC_SECRET",module:{moduleId:`${root}/${RECOVERY_FILE}`},result(){throw Error("private");}});
    reporter.onTestCaseResult({name:EXPECTED_CASES[0],module:{moduleId:`${root}/${RECOVERY_FILE}`},result(){return {errors:[{name:"Error",message:"SYNTHETIC_SECRET",cause:{name:"AssertionError",message:"expected 0 to be 1"}}]};}});
    reporter.onTestRunEnd();
    const output=process.env.CREWROOM_QUALIFICATION_CAUSE_OUTPUT;
    assert.equal(fs.statSync(output).mode&0o777,0o600);
    const text=fs.readFileSync(output,"utf8"); assert.ok(!text.includes("SYNTHETIC_SECRET"));
    const value=JSON.parse(text); assert.equal(value.status,"available");assert.equal(value.cases.length,1);
    assert.equal(value.cases[0].chains[0].entries[1].comparison.actual,0);
  } finally {
    if(oldRoot===undefined)delete process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT;else process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT=oldRoot;
    if(oldOutput===undefined)delete process.env.CREWROOM_QUALIFICATION_CAUSE_OUTPUT;else process.env.CREWROOM_QUALIFICATION_CAUSE_OUTPUT=oldOutput;
    fs.rmSync(directory,{recursive:true});
  }
});
test("reporter hook errors mark diagnostics unavailable without throwing or leaking", () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cause-reporter-unavailable-"));
  const oldRoot=process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT,oldOutput=process.env.CREWROOM_QUALIFICATION_CAUSE_OUTPUT;
  try{
    process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT=root;process.env.CREWROOM_QUALIFICATION_CAUSE_OUTPUT=path.join(directory,"causes.json");
    const reporter=new Reporter();
    assert.doesNotThrow(()=>reporter.onTestCaseResult({name:EXPECTED_CASES[0],module:{moduleId:`${root}/${RECOVERY_FILE}`},result(){throw new Error("SYNTHETIC_SECRET");}}));
    reporter.onTestRunEnd();
    const text=fs.readFileSync(process.env.CREWROOM_QUALIFICATION_CAUSE_OUTPUT,"utf8");assert.equal(JSON.parse(text).status,"unavailable");assert.ok(!text.includes("SYNTHETIC_SECRET"));
  }finally{
    if(oldRoot===undefined)delete process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT;else process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT=oldRoot;
    if(oldOutput===undefined)delete process.env.CREWROOM_QUALIFICATION_CAUSE_OUTPUT;else process.env.CREWROOM_QUALIFICATION_CAUSE_OUTPUT=oldOutput;
    fs.rmSync(directory,{recursive:true});
  }
});
test("known owner codes and two fixed owner source files are retained without suffixes", () => {
  const file="server/src/services/native-runtime/native-session-executor.ts";
  const result=sanitizeError({name:"Error",message:"runner_remote_directory_staging_failed: SYNTHETIC_SECRET",stacks:[{file:`${root}/${file}`,line:10857,column:11},{file:`${root}/server/src/private/SYNTHETIC_SECRET.ts`,line:1,column:1}]},root);
  assert.equal(result.errorCode,"runner_remote_directory_staging_failed");
  assert.deepEqual(result.locations,[{file,line:10857,column:11}]);assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET"));
  assert.equal(sanitizeError({name:"Error",message:"runner_remote_directory_staging_failed_SECRET"},root).errorCode,undefined);
});
test("fixed typed terminal codes survive without arbitrary provider code data",()=>{
 const result=sanitizeError({name:"NativeProviderTerminalFailure",code:"native_provider_terminal_failed",providerCode:"SYNTHETIC_SECRET",message:"SYNTHETIC_SECRET"},root);
 assert.equal(result.errorCode,"native_provider_terminal_failed");assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET"));
});
