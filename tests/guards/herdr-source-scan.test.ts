import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectSrcFiles, scanSources } from "../../scripts/scan-herdr-calls";

/**
 * P6-R3 layer (a): static source scan over src/. Asserts the lens never emits
 * the Herdr hazards the runtime denylist (guards.ts) also blocks:
 *   - layout.apply with tab_id (V-HDR-5)
 *   - agent.start / pane.report_agent / agent.view.set / *.focus literals (V-HDR-6/7, U-HDR-4)
 *   - tab.create / pane.split without focus:false, send_input with any focus (U-HDR-4)
 *   - herdr CLI tab/pane/agent verbs without --no-focus
 *   - pane.report_* other than pane.report_metadata, which must carry source (V-HDR-7)
 *   - a raw wire seam (transport .request / openStream / socketRequest /
 *     openEventStream / s.write of a request frame) that bypasses the
 *     guardedRequest boundary, or a non-literal method at the guarded seam
 *
 * Every rule is exercised by an in-memory fixture below; adding a fixture file
 * with any of these to the scan set makes the guard fail. The real tree scans
 * clean. See task-2-report.md for the quoted fixture-injection sabotage run.
 */

const SRC_ROOT = join(import.meta.dir, "../../src");

describe("src tree scans clean", () => {
	test("no findings over real src/**/*.ts", () => {
		const files = collectSrcFiles(SRC_ROOT);
		expect(files.length).toBeGreaterThan(0);
		expect(scanSources(files, { requireDenylist: true })).toEqual([]);
	});
});

// --- fixture-driven proof the guard is not vacuous -------------------------

const FORBIDDEN_FIXTURES: { name: string; rule: string; code: string }[] = [
	{
		name: "layout.apply with tab_id inline (V-HDR-5)",
		rule: "layout-apply-tab-id",
		code: `await guardedRequest(t, "layout.apply", { tab_id: "w1:t1" });`,
	},
	{
		name: "layout.apply with tab_id added by mutation",
		rule: "layout-apply-tab-id",
		code: `const p = { workspace_id: "w1" };\np.tab_id = "w1:t1";\nawait guardedRequest(t, "layout.apply", p);`,
	},
	{
		name: "layout.apply with params the scan cannot resolve",
		rule: "unresolvable-params",
		code: `await guardedRequest(t, "layout.apply", buildParams());`,
	},
	{
		name: "agent.start via guardedRequest (V-HDR-6)",
		rule: "denied-method-literal",
		code: `await guardedRequest(t, "agent.start", {});`,
	},
	{
		name: "agent.start via raw transport (bypasses the guard seam)",
		rule: "denied-method",
		code: `await t.request("agent.start", {});`,
	},
	{
		name: "agent.view.set (V-HDR-7)",
		rule: "denied-method-literal",
		code: `await guardedRequest(t, "agent.view.set", {});`,
	},
	{
		name: "pane.report_agent (V-HDR-6)",
		rule: "denied-method-literal",
		code: `await guardedRequest(t, "pane.report_agent", { pane_id: "w1:p1" });`,
	},
	{
		name: "metadata verb other than pane.report_metadata",
		rule: "report-not-metadata",
		code: `await guardedRequest(t, "pane.report_title", { pane_id: "w1:p1", source: "s" });`,
	},
	{
		name: "tab.create missing focus:false (U-HDR-4)",
		rule: "missing-focus-false",
		code: `await guardedRequest(t, "tab.create", { workspace_id: "w1" });`,
	},
	{
		name: "tab.create with focus:true",
		rule: "missing-focus-false",
		code: `await guardedRequest(t, "tab.create", { workspace_id: "w1", focus: true });`,
	},
	{
		name: "pane.split missing focus:false",
		rule: "missing-focus-false",
		code: `await guardedRequest(t, "pane.split", { target_pane_id: "w1:p1" });`,
	},
	{
		name: "pane.send_input carrying any focus param",
		rule: "send-input-focus",
		code: `await guardedRequest(t, "pane.send_input", { pane_id: "w1:p1", text: "x", focus: false });`,
	},
	{
		name: "pane.report_metadata missing source (V-HDR-7)",
		rule: "metadata-missing-source",
		code: `await guardedRequest(t, "pane.report_metadata", { pane_id: "w1:p1" });`,
	},
	{
		name: "non-literal method at the guarded seam",
		rule: "non-literal-method",
		code: `await guardedRequest(t, method, {});`,
	},
	{
		name: "herdr CLI pane split without --no-focus",
		rule: "cli-missing-no-focus",
		code: `const cmd = "herdr pane split --dir right";`,
	},
	{
		name: "tab_id param added by assignment",
		rule: "tab-id-mutation",
		code: `params.tab_id = "w1:t1";`,
	},
	{
		name: "a *.focus method literal not on the denylist",
		rule: "focus-method-literal",
		code: `await guardedRequest(t, "session.focus", {});`,
	},
	{
		name: "focus param that is not statically false",
		rule: "focus-prop",
		code: `await guardedRequest(t, "tab.create", { workspace_id: "w1", focus: opts.focus });`,
	},
	{
		name: "params object the scan cannot resolve on a guarded call",
		rule: "unresolvable-params",
		code: `await guardedRequest(t, "pane.get", buildParams("w1:p1"));`,
	},
	{
		name: "request frame written to a raw socket",
		rule: "raw-frame-write",
		code: `s.write(JSON.stringify({ id: "1", method: "pane.get", params: {} }) + "\\n");`,
	},
];

describe("fixture sabotage: every forbidden construction is caught", () => {
	test.each(FORBIDDEN_FIXTURES)("$name → $rule", ({ rule, code }) => {
		const findings = scanSources([{ path: "src/__fixture__.ts", content: code }]);
		expect(findings.map((f) => f.rule)).toContain(rule);
	});

	test("every fixture produces at least one finding (no silent pass)", () => {
		for (const f of FORBIDDEN_FIXTURES) {
			expect(
				scanSources([{ path: "src/__fixture__.ts", content: f.code }]).length,
				f.name,
			).toBeGreaterThan(0);
		}
	});
});

describe("allowed constructions produce no findings", () => {
	const CLEAN = [
		`await guardedRequest(t, "tab.create", { workspace_id: "w1", focus: false });`,
		`const p = { target_pane_id: "w1:p1", direction: "right", focus: false };\nawait guardedRequest(t, "pane.split", p);`,
		`await guardedRequest(t, "pane.send_input", { pane_id: "w1:p1", text: "ls", keys: ["enter"] });`,
		`await guardedRequest(t, "pane.report_metadata", { pane_id: "w1:p1", source: "lens" });`,
		`await guardedRequest(t, "layout.apply", { workspace_id: "w1" });`,
		`await guardedRequest(t, "session.snapshot", {});`,
		`const cmd = "herdr pane split --no-focus";`,
	];

	test.each(CLEAN)("clean: %s", (code) => {
		expect(scanSources([{ path: "src/__fixture__.ts", content: code }])).toEqual([]);
	});

	test("comments and docs naming forbidden verbs do not trip the scan", () => {
		const code = [
			`// guardedRequest(t, "agent.start", {}) is forbidden — never emit it`,
			`/* layout.apply with tab_id destroys the live tab (V-HDR-5) */`,
			`/** pane.report_agent and agent.view.set stay on the denylist. */`,
			`const note = "see V-HDR-7";`,
			`await guardedRequest(t, "pane.get", { pane_id: "w1:p1" });`,
		].join("\n");
		expect(scanSources([{ path: "src/__fixture__.ts", content: code }])).toEqual([]);
	});
});

describe("denylist presence in src/herdr/guards.ts", () => {
	test("a guards.ts missing denylist entries is flagged (requireDenylist)", () => {
		const brokenGuards = [
			`export const DENIED_METHODS: readonly string[] = Object.freeze([`,
			`\t"agent.focus",`,
			`\t"pane.focus",`,
			`]);`,
		].join("\n");
		const findings = scanSources([{ path: "src/herdr/guards.ts", content: brokenGuards }], {
			requireDenylist: true,
		});
		const missing = findings.filter((f) => f.rule === "denylist-missing");
		expect(missing.length).toBeGreaterThan(0);
		expect(missing.map((f) => f.detail).join(" ")).toMatch(/agent\.start/);
	});

	test("the real guards.ts satisfies the denylist requirement", () => {
		const files = collectSrcFiles(SRC_ROOT);
		expect(
			scanSources(files, { requireDenylist: true }).filter((f) => f.rule === "denylist-missing"),
		).toEqual([]);
	});
});
