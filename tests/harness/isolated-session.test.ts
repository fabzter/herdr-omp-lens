import { describe, expect, test } from "bun:test";

import { createIsolatedSession } from "./isolated-session";

const NOT_IMPLEMENTED = "isolated-session helper implemented in P4 (RC-6)";

describe("createIsolatedSession (RC-6 P1 stub)", () => {
	test("exposes the requested session name", () => {
		const session = createIsolatedSession("lens-p1");
		expect(session.sessionName).toBe("lens-p1");
	});

	test("setup rejects with the P4 placeholder error", async () => {
		const session = createIsolatedSession("lens-p1");
		await expect(session.setup()).rejects.toThrow(NOT_IMPLEMENTED);
	});

	test("teardown rejects with the P4 placeholder error", async () => {
		const session = createIsolatedSession("lens-p1");
		await expect(session.teardown()).rejects.toThrow(NOT_IMPLEMENTED);
	});

	test("assertDailyWorkspaceUntouched rejects with the P4 placeholder error", async () => {
		const session = createIsolatedSession("lens-p1");
		await expect(session.assertDailyWorkspaceUntouched()).rejects.toThrow(NOT_IMPLEMENTED);
	});
});
