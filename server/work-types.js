import { WORK_TYPES as shared } from "../src/workflow-domain.js";
export const WORK_TYPES = {
  ...shared,
  "code-qa": {
    name: "코드 수정 · 실제 QA",
    done: "고정 커밋의 수정 diff와 실제 검사 통과 결과를 별도 QA 실행에서 확인하고 사람이 수용",
    steps: [
      { name: "코드 수정 · 검사", agentId: "dev", skill: "code-change" },
      { name: "독립 QA 실행", agentId: "qa", skill: "code-verify" },
    ],
  },
};
