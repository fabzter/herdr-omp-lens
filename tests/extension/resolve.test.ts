import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveViewerCommand } from "../../src/extension/resolve";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("resolveViewerCommand", () => {
	test("returns a runnable `bun <abs path to src/viewer/cli.ts>` invocation", () => {
		const command = resolveViewerCommand();

		// pane.send_input is shell text: the command word must be executable —
		// a bare non-executable .ts path cannot be launched by a shell.
		expect(command.startsWith("bun ")).toBe(true);
		const scriptPath = command.slice("bun ".length);
		expect(isAbsolute(scriptPath)).toBe(true);
		expect(scriptPath.endsWith(`src${sep}viewer${sep}cli.ts`)).toBe(true);
		expect(command).toBe(`bun ${resolve(PACKAGE_ROOT, "src/viewer/cli.ts")}`);
	});

	test("is independent of process.cwd()", () => {
		const before = resolveViewerCommand();
		const original = process.cwd();
		try {
			process.chdir(tmpdir());
			// macOS: tmpdir() is a /var symlink; cwd reports the resolved /private path.
			expect(process.cwd()).not.toBe(original);
			expect(resolveViewerCommand()).toBe(before);
		} finally {
			process.chdir(original);
		}
	});
});
