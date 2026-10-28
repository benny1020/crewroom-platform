// This template is copied privately; only __PRODUCT_ROOT__ is substituted.
import { afterAll, vi, TestRunner } from "vitest";
const observer=await vi.hoisted(async()=>{
  const {createPhaseObserver}=await import("./crewroom-runtime-phase-core.mjs");
  return createPhaseObserver({output:process.env.CREWROOM_QUALIFICATION_PHASE_OUTPUT,context:()=>{const test=TestRunner.getCurrentTest();return test?.file?.filepath===`${process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT}/server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts`?test.name:null;}});
});
vi.mock("__PRODUCT_ROOT__/server/src/__tests__/helpers/docker-command-runner.ts",async original=>{
  const actual=await original();
  return observer.exports(actual,{createRunnerTestTlsTunnel:observer.wrap(function(...args){
    const result=Reflect.apply(actual.createRunnerTestTlsTunnel,this,args);
    // Preserve the original Promise, then attach observation to its result.
    if(observer.enabled())result.then(tunnel=>{try{tunnel.close=observer.wrap(tunnel.close,"tunnel_close");}catch{}},()=>{});
    return result;
  },"tls"),dockerCommandRunner(...args){const runner=Reflect.apply(actual.dockerCommandRunner,this,args);if(observer.enabled())runner.execute=observer.wrap(runner.execute,"docker_execute");return runner;}});
});
vi.mock("__PRODUCT_ROOT__/server/src/services/native-runtime/runtime-context.ts",async original=>{const actual=await original();return observer.exports(actual,{materializeAsset:observer.wrap(actual.materializeAsset,"asset")});});
vi.mock("__PRODUCT_ROOT__/server/src/services/native-runtime/native-execution-input.ts",async original=>{const actual=await original();return observer.exports(actual,{buildNativeExecutionInput:observer.wrap(actual.buildNativeExecutionInput,"execution_input")});});
vi.mock("__PRODUCT_ROOT__/server/src/services/native-runtime/prepare-native-run.ts",async original=>{const actual=await original();return observer.exports(actual,{prepareNativeHeartbeatRun:observer.wrap(actual.prepareNativeHeartbeatRun,"prepare_run")});});
vi.mock("__PRODUCT_ROOT__/server/src/services/native-runtime/native-run-finalizer.ts",async original=>{const actual=await original();return observer.exports(actual,{finalizeNativeRun:observer.wrap(actual.finalizeNativeRun,"finalize_run")});});
vi.mock("__PRODUCT_ROOT__/server/src/services/native-runtime/native-session-executor.ts",async original=>{const actual=await original();return observer.exports(actual,{executePaperclipNativeSession:observer.wrap(actual.executePaperclipNativeSession,"execute_session"),closeIdleWarmNativeSessionsForRestart:observer.wrap(actual.closeIdleWarmNativeSessionsForRestart,"close_idle")});});
vi.mock("node:child_process",async original=>{const actual=await original();return observer.exports(actual,{execFileSync:function(...args){const phase=args[0]==="tar"?"sync_tar":args[0]==="ps"?"sync_ps":null;return phase?Reflect.apply(observer.wrap(actual.execFileSync,phase),this,args):Reflect.apply(actual.execFileSync,this,args);}});});
afterAll(()=>observer.stop());
