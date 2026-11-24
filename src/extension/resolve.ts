import { resolve } from "node:path";

/**
 * Absolute path to the viewer entry point, resolved against the installed
 * package root (`import.meta.dirname`), never `process.cwd()` — so
 * clean-profile installs work from any working directory (F-16).
 *
 * `src/viewer/cli.ts` itself ships in P3; P1 only resolves the path.
 */
export function resolveViewerCommand(): string {
	return resolve(import.meta.dirname, "../viewer/cli.ts");
}
