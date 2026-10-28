import {test} from "node:test";
import assert from "node:assert/strict";
import {STACK_FILES,safeStackLocation} from "./crewroom-runtime-stack-worker.mjs";
test("inspector locations allow only exact source files and bounded runtime coordinates",()=>{
  const root="/synthetic/product",file=STACK_FILES[0];
  assert.deepEqual(safeStackLocation(`file://${root}/${file}`,4,2,root),{file,line:5,column:3});
  for(const [url,line,column]of[[`${root}/../private/key.ts`,1,1],[`${root}/${file}/../secret`,1,1],[`${root}/${file}`,-1,0],[`${root}/${file}`,1,100000],[`${root}/${file}`,true,1],[`https://private.invalid/${file}`,1,1]])assert.equal(safeStackLocation(url,line,column,root),null);
});
