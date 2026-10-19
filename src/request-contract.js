// A shared request contract, independent of UI and provider implementation.
export function requestContract(skillId) {
  if (skillId === "conversation" || skillId?.startsWith("custom-"))
    return "chat";
  if (skillId === "code-change") return "code-qa";
  if (skillId === "code-verify") return "handoff";
  return "analysis";
}
