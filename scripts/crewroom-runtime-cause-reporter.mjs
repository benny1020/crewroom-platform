// Infrastructure reporter: public Vitest API, no product imports or raw error persistence.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RECOVERY_FILE = "server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts";
export const EXPECTED_CASES = [
  "keeps checkpoint SQL independent of streamed output volume with a real Postgres writer",
  "adopts the same runner from Postgres after losing the controller filesystem (prepared task: false)",
  "adopts the same runner from Postgres after losing the controller filesystem (prepared task: true)",
  "adopts one active runner across hot and hard controller restarts without duplicating steering",
  "hard-restarts a dead runner with a current prompt on the same run and provider session",
  "hot-restarts a dead runner with a historical prompt on the same run and provider session",
  "hot-restarts a dead runner with a unregistered prompt on the same run and provider session",
  "quarantines a pre-auth runner root and bootstraps the same run",
  "preserves remote warm continuity across completed turns: warm",
  "preserves remote warm continuity across completed turns: hard",
  "preserves remote warm continuity across completed turns: legacy",
  "preserves remote warm continuity across completed turns: changed",
  "preserves remote warm continuity across completed turns: same-server"
];
export const ALLOWED_SOURCE_FILES = [
  "server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts",
  "server/src/services/native-runtime/native-session-executor.ts",
  "packages/paperclip-runner/src/live/runnerd-codex-transport.ts"
];
export const ERROR_CODES = [
  "runner_remote_directory_staging_failed",
  "runner_remote_staging_failed",
  "runner_remote_artifact_verification_failed",
  "runner_remote_artifact_metadata_invalid",
  "runner_remote_artifact_contract_incompatible",
  "runner_remote_codex_artifact_verification_failed",
  "runner_remote_codex_artifact_unavailable",
  "runner_remote_codex_install_failed",
  "runner_remote_provider_artifact_incompatible",
  "runner_remote_session_capability_missing",
  "runner_remote_preinstalled_link_failed",
  "runner_remote_codex_source_conflict",
  "runner_harness_state_mismatch",
  "runner_state_identity_mismatch",
  "runner_state_directory_unsafe",
  "runner_local_connect_failed",
  "provider_transport_failed",
  "native_provider_terminal_failed",
  "native_event_replay_conflict"
];

const classes = Object.freeze({ AssertionError: "assertion", TypeError: "type_error", RangeError: "range_error", ReferenceError: "reference_error", SyntaxError: "syntax_error", TimeoutError: "timeout", Error: "error" });
const operators = Object.freeze({ be: "equal", equal: "equal", "deeply equal": "equal", "be greater than": "greater_than", "be less than": "less_than", "be greater than or equal to": "greater_or_equal", "be less than or equal to": "less_or_equal" });

export function safeLocation(file, line, column, root) {
  if (typeof file !== "string" || !Number.isInteger(line) || !Number.isInteger(column) || line < 1 || line > 1e6 || column < 1 || column > 1e5) return null;
  try {
    const candidate = file.startsWith("file://") ? fileURLToPath(file) : path.resolve(root, file);
    const canonical = filename => { try { return fs.realpathSync.native(filename); } catch { return path.resolve(filename); } };
    const relative=path.relative(canonical(root), canonical(candidate)).split(path.sep).join("/");
    if (!ALLOWED_SOURCE_FILES.includes(relative)) return null;
    return { file: relative, line, column };
  } catch { return null; }
}

export function sanitizeError(error, root) {
  const kind = typeof error?.name === "string" ? error.name : "";
  const result = { errorClass: Object.hasOwn(classes, kind) ? classes[kind] : "unknown" };
  const message = typeof error?.message === "string" ? error.message.slice(0, 200000).replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)[0] : "";
  const first = message.startsWith(`${kind}: `) ? message : `${kind}: ${message}`;
  const prefix=first.replace(/^(?:Error|AssertionError|TypeError|RangeError|ReferenceError|SyntaxError|TimeoutError):\s*/, "");
  const code=typeof error?.code === "string" && ERROR_CODES.includes(error.code) ? error.code : ERROR_CODES.find(candidate=>prefix===candidate||prefix.startsWith(`${candidate}:`)||prefix.startsWith(`${candidate} `));
  if(code)result.errorCode=code;
  if (/^Error: (?:(?:Test|Hook) timed out|Timed out)(?: in| after| waiting|\.)/.test(first)) result.errorClass = "timeout";
  const primitive = "(true|false|[+-]?(?:0|[1-9]\\d{0,6}))";
  const comparison = first.match(new RegExp(`^AssertionError: expected ${primitive} to (be|equal|deeply equal|be greater than|be less than|be greater than or equal to|be less than or equal to) ${primitive}(?: // Object\\.is equality)?$`));
  const value = raw => raw === "true" ? true : raw === "false" ? false : Number(raw);
  if (comparison) result.comparison = { operator: operators[comparison[2]], expected: value(comparison[3]), actual: value(comparison[1]) };
  const length = first.match(/^AssertionError: expected .+ to have a length of ([0-9]{1,7}) but got ([0-9]{1,7})$/);
  if (length) result.comparison = { operator: "length_equal", expected: Number(length[1]), actual: Number(length[2]) };
  const locations = [];
  const add = location => { if (location && !locations.some(old => old.line === location.line && old.column === location.column)) locations.push(location); };
  if (Array.isArray(error?.stacks)) for (const frame of error.stacks.slice(0, 200)) add(safeLocation(frame?.file, frame?.line, frame?.column, root));
  if (typeof error?.stack === "string") for (const line of error.stack.slice(0, 200000).split(/\r?\n/).slice(1)) {
    const frame = line.match(/^\s+at (?:[^()\r\n]+ \()?([^()\r\n]+):(\d{1,7}):(\d{1,6})\)?\s*$/);
    if (frame) add(safeLocation(frame[1], Number(frame[2]), Number(frame[3]), root));
  }
  if (locations.length) result.locations = locations.slice(0, 3);
  return result;
}

export function sanitizeChain(error, root) {
  const seen = new Set(), entries = [];
  let current = error, chainState = "absent";
  while (current && typeof current === "object") {
    if (seen.has(current)) { chainState = "cycle"; break; }
    if (entries.length === 8) { chainState = "truncated"; break; }
    seen.add(current);
    entries.push({ depth: entries.length, relation: entries.length ? "cause" : "root", ...sanitizeError(current, root) });
    current = current.cause;
    if (current && typeof current === "object") chainState = "complete";
  }
  return { chainState, entries };
}

export default class QualificationCauseReporter {
  cases = [];
  unavailable = false;
  onTestCaseResult(test) {
    try {
      const root = path.resolve(process.env.CREWROOM_QUALIFICATION_SOURCE_ROOT ?? process.cwd());
      if (!EXPECTED_CASES.includes(test.name) || safeLocation(test.module.moduleId, 1, 1, root)?.file !== RECOVERY_FILE) return;
      const errors = test.result().errors;
      this.cases.push({ title: test.name, chains: Array.isArray(errors) ? errors.slice(0, 3).map(error => sanitizeChain(error, root)) : [] });
    } catch { this.unavailable = true; }
  }
  onTestRunEnd() {
    try {
      const output = process.env.CREWROOM_QUALIFICATION_CAUSE_OUTPUT;
      if (!output) return;
      const temporary = `${output}.partial`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, status: this.unavailable ? "unavailable" : "available", cases: this.cases }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, output);
    } catch { /* Missing output is explicitly diagnostics_unavailable, never a test pass. */ }
  }
}
