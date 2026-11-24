import { describe, expect, test } from "bun:test";
import { assertAllowedRequest, DENIED_METHODS } from "../../src/herdr/guards";

describe("DENIED_METHODS", () => {
	// Tamper test: removing an entry from the denylist fails this test AND the
	// corresponding assertAllowedRequest throw test below.
	test("denylist contains exactly the forbidden methods", () => {
		expect([...DENIED_METHODS].sort()).toEqual([
			"agent.focus",
			"agent.start",
			"agent.view.set",
			"pane.focus",
			"pane.report_agent",
			"tab.focus",
			"workspace.focus",
		]);
	});
});

describe("assertAllowedRequest — denied", () => {
	test.each(DENIED_METHODS)("%s throws", (method) => {
		expect(() => assertAllowedRequest(method, {})).toThrow(/forbidden/i);
	});

	test("layout.apply WITH tab_id throws (kills live PTYs, V-HDR-5)", () => {
		expect(() => assertAllowedRequest("layout.apply", { tab_id: "w1:t1" })).toThrow(/forbidden/i);
	});

	test("tab.create with focus:true throws (focus theft)", () => {
		expect(() => assertAllowedRequest("tab.create", { workspace_id: "w1", focus: true })).toThrow(
			/focus/i,
		);
	});

	test("pane.split with focus:true throws (focus theft)", () => {
		expect(() =>
			assertAllowedRequest("pane.split", { target_pane_id: "w1:p1", focus: true }),
		).toThrow(/focus/i);
	});
});

describe("assertAllowedRequest — allowed", () => {
	test("layout.apply WITHOUT tab_id is ok (additive tab only)", () => {
		expect(() => assertAllowedRequest("layout.apply", {})).not.toThrow();
		expect(() =>
			assertAllowedRequest("layout.apply", { workspace_id: "w1", focus: false }),
		).not.toThrow();
	});

	test("tab.create / pane.split with focus:false are ok", () => {
		expect(() =>
			assertAllowedRequest("tab.create", { workspace_id: "w1", label: "x", focus: false }),
		).not.toThrow();
		expect(() =>
			assertAllowedRequest("pane.split", { target_pane_id: "w1:p1", focus: false }),
		).not.toThrow();
	});

	test("pane.send_input, pane.report_metadata, pane.get, session.snapshot are ok", () => {
		expect(() =>
			assertAllowedRequest("pane.send_input", { pane_id: "w1:p1", text: "ls" }),
		).not.toThrow();
		expect(() =>
			assertAllowedRequest("pane.report_metadata", { pane_id: "w1:p1", source: "s" }),
		).not.toThrow();
		expect(() => assertAllowedRequest("pane.get", { pane_id: "w1:p1" })).not.toThrow();
		expect(() => assertAllowedRequest("session.snapshot", {})).not.toThrow();
	});

	test("non-object params cannot smuggle tab_id", () => {
		expect(() => assertAllowedRequest("layout.apply", null)).not.toThrow();
		expect(() => assertAllowedRequest("layout.apply", "tab_id")).not.toThrow();
	});
});
