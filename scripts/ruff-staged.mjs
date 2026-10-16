/**
 * Pre-commit hook for Python files (see lefthook.yml): fixes and formats the
 * staged .py files with Ruff. Ruff is a Python tool (pip install ruff); if
 * it isn't installed, the commit goes ahead and this prints a note.
 *
 * A Node script rather than shell in lefthook.yml, so it behaves the same
 * on macOS, Linux and Windows with no shell quoting to get wrong.
 */
import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);
if (files.length === 0) process.exit(0);

const run = (args) => spawnSync("ruff", args, { stdio: "inherit", shell: process.platform === "win32" });

const probe = run(["--version"]);
if (probe.error || probe.status !== 0) {
  console.log("Ruff is not installed (pip install ruff), so Python files were not checked.");
  process.exit(0);
}

const check = run(["check", "--fix", ...files]);
if (check.status !== 0) process.exit(check.status ?? 1);
const format = run(["format", ...files]);
process.exit(format.status ?? 1);
