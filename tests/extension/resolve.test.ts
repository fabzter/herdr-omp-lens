import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveViewerCommand } from "../../src/extension/resolve";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("resolveViewerCommand", () => {
	test("returns an absolute path to src/viewer/cli.ts under the package root", () => {
		const command = resolveViewerCommand();

		expect(isAbsolute(command)).toBe(true);
		expect(command.endsWith(`src${sep}viewer${sep}cli.ts`)).toBe(true);
		expect(command).toBe(resolve(PACKAGE_ROOT, "src/viewer/cli.ts"));
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
