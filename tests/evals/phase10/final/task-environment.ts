export const EXECUTION_ENVIRONMENT = `Execution environment (shared by all variants; not additional product requirements):
The sandbox runs Node.js 20 in an isolated container without network access or package installation. Use Node's built-in test runner for your own tests.
The shell has no Git executable. Git operations are available only through the MCP tools granted to your role; git_* tool names are not shell commands. A .git file does not imply a Git CLI is installed.
Use fs_read/fs_write for worktree-relative files. If your role can commit, call git_applyPatch with {"patch":""} to commit files already written; use the granted git_diff tool for diffs. Do not revert working files just to reconstruct a patch. Do not require shell git log/status/add/commit to finish the task.`;

export function withExecutionEnvironment(goal: string): string {
  return `${EXECUTION_ENVIRONMENT}\n\n${goal}`;
}
