import { afterEach, describe, expect, test } from "bun:test";
import { callerContext, isHerdrEnv } from "../../src/herdr/context";

const FULL_ENV: NodeJS.ProcessEnv = {
	HERDR_ENV: "1",
	HERDR_WORKSPACE_ID: "w1",
	HERDR_TAB_ID: "w1:t1",
	HERDR_PANE_ID: "w1:p1",
	HERDR_BIN_PATH: "/bin/herdr",
	HERDR_SOCKET_PATH: "/sock",
};

const REQUIRED_VARS = [
	"HERDR_WORKSPACE_ID",
	"HERDR_TAB_ID",
	"HERDR_PANE_ID",
	"HERDR_BIN_PATH",
	"HERDR_SOCKET_PATH",
] as const;

describe("isHerdrEnv", () => {
	test("true when HERDR_ENV=1 and all required vars present", () => {
		expect(isHerdrEnv(FULL_ENV)).toBe(true);
	});

	test("false when HERDR_ENV is unset", () => {
		const { HERDR_ENV: _drop, ...rest } = FULL_ENV;
		expect(isHerdrEnv(rest)).toBe(false);
		expect(isHerdrEnv({})).toBe(false);
	});

	test("false when HERDR_ENV is not exactly '1'", () => {
		expect(isHerdrEnv({ ...FULL_ENV, HERDR_ENV: "0" })).toBe(false);
		expect(isHerdrEnv({ ...FULL_ENV, HERDR_ENV: "true" })).toBe(false);
	});

	test("false when HERDR_ENV=1 but a required var is missing", () => {
		const { HERDR_PANE_ID: _drop, ...rest } = FULL_ENV;
		expect(isHerdrEnv(rest)).toBe(false);
	});
});

describe("callerContext", () => {
	test("maps all five env vars to CallerContext fields exactly", () => {
		expect(callerContext(FULL_ENV)).toEqual({
			workspaceId: "w1",
			tabId: "w1:t1",
			paneId: "w1:p1",
			binPath: "/bin/herdr",
			socketPath: "/sock",
		});
	});

	test("socketPath comes from HERDR_SOCKET_PATH (herdr's socket, not a bridge socket)", () => {
		const ctx = callerContext({ ...FULL_ENV, HERDR_SOCKET_PATH: "/tmp/herdr.sock" });
		expect(ctx?.socketPath).toBe("/tmp/herdr.sock");
	});

	test("null when HERDR_ENV is unset", () => {
		expect(callerContext({})).toBeNull();
	});

	test("null when HERDR_ENV=0", () => {
		expect(callerContext({ ...FULL_ENV, HERDR_ENV: "0" })).toBeNull();
	});

	test.each(REQUIRED_VARS)("null when %s is missing", (missing) => {
		const env: NodeJS.ProcessEnv = { ...FULL_ENV };
		delete env[missing];
		expect(callerContext(env)).toBeNull();
	});

	test("null when a required var is empty", () => {
		expect(callerContext({ ...FULL_ENV, HERDR_BIN_PATH: "" })).toBeNull();
	});
});

describe("default env = process.env", () => {
	const touched = ["HERDR_ENV", ...REQUIRED_VARS] as const;
	const saved = new Map<string, string | undefined>();

	for (const key of touched) saved.set(key, process.env[key]);

	afterEach(() => {
		for (const key of touched) {
			const original = saved.get(key);
			if (original === undefined) delete process.env[key];
			else process.env[key] = original;
		}
	});

	test("callerContext() and isHerdrEnv() read process.env when env arg omitted", () => {
		for (const key of touched) delete process.env[key];
		expect(isHerdrEnv()).toBe(false);
		expect(callerContext()).toBeNull();

		for (const [key, value] of Object.entries(FULL_ENV)) {
			if (value !== undefined) process.env[key] = value;
		}
		expect(isHerdrEnv()).toBe(true);
		expect(callerContext()).toEqual({
			workspaceId: "w1",
			tabId: "w1:t1",
			paneId: "w1:p1",
			binPath: "/bin/herdr",
			socketPath: "/sock",
		});
	});
});
