import { describe, expect, it } from "vitest";
import { isGitNotRepositoryDiagnostic } from "./git-not-repository-diagnostic.js";

const classic = "fatal: not a git repository (or any of the parent directories): .git";
const boundary = "fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).";
describe("Git non-repository discovery diagnostics", () => {
  it.each([classic, classic + "\n", classic + "\r\n", boundary, boundary + "\n", boundary.replace(/\n/g, "\r\n") + "\r\n",
    boundary.replace("mount point /", "mount point /mnt/work space (test)")])("recognizes only an exact supported diagnostic: %s", stderr => {
    expect(isGitNotRepositoryDiagnostic(stderr)).toBe(true);
  });
  it.each([null, undefined, "fatal: detected dubious ownership in repository", "fatal: not a git repository", classic + "\nPermission denied\n",
    boundary.split("\n")[0], boundary + "\nfatal: additional failure", boundary.replace("not set", "set"),
    boundary.replace("mount point /)", "mount point /\nother)")])("preserves unrelated or incomplete errors: %s", stderr => {
    expect(isGitNotRepositoryDiagnostic(stderr)).toBe(false);
  });
});
