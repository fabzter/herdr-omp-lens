import { resolve } from "node:path";

/**
 * Absolute path to the viewer entry point, resolved against the installed
 * package root (`import.meta.dirname`), never `process.cwd()` — so
 * clean-profile installs work from any working directory (F-16).
 *
 * Returns a RUNNABLE shell invocation, not a bare path: `cli.ts` ships
 * without a shebang or exec bit, and `pane.send_input` is shell text — the
 * command word must be the `bun` binary or the launch dies with EACCES.
 */
export function resolveViewerCommand(): string {
	return `bun ${resolve(import.meta.dirname, "../viewer/cli.ts")}`;
}
