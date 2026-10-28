/** Exact C-locale Git discovery diagnostics, without classifying other failures. */
export function isGitNotRepositoryDiagnostic(stderr: unknown): boolean {
  return typeof stderr === "string" && (
    /^fatal: not a git repository \(or any of the parent directories\): \.git\r?\n?$/.test(stderr) ||
    /^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\r?\n?$/.test(stderr)
  );
}
