import { describe, expect, test } from "bun:test";
import type { WorkerSnapshot } from "../../src/protocol/types";
import {
	formatCounters,
	inspector,
	notLiveLabel,
	renderScreen,
	rosterRow,
	selectableWorkerIds,
} from "../../src/viewer/render";
import { applyMessage, initialViewerState, type ViewerState } from "../../src/viewer/state";

function snap(id: string, over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
	return { id, agent: "task", status: "running", updatedAt: 1_000, ...over };
}

function stateWith(workers: WorkerSnapshot[], init: Partial<ViewerState> = {}): ViewerState {
	return initialViewerState({
		session: "sess-1",
		live: true,
		workers: new Map(workers.map((w) => [w.id, w])),
		...init,
	});
}

describe("notLiveLabel (P3-R9)", () => {
	test("historical workers get the badge; live workers do not", () => {
		expect(notLiveLabel(snap("a", { historical: true }))).toContain("not-live");
		expect(notLiveLabel(snap("a"))).toBe("");
		expect(notLiveLabel(snap("a", { historical: false }))).toBe("");
	});
});

describe("formatCounters", () => {
	test("renders all present counters; empty when none", () => {
		const text = formatCounters({
			tokens: 1414,
			cost: 0.0342,
			requests: 4,
			toolCount: 7,
			durationMs: 12_300,
		});
		expect(text).toContain("1,414");
		expect(text).toContain("0.03");
		expect(text).toContain("4");
		expect(text).toContain("7");
		expect(text).toContain("12.3s");
		expect(formatCounters({})).toBe("");
		expect(formatCounters(undefined)).toBe("");
	});

	test("renders only the fields that are present", () => {
		const text = formatCounters({ tokens: 5 });
		expect(text).toContain("5");
		expect(text).not.toContain("cost");
		expect(text).not.toContain("tools");
	});
});

describe("rosterRow", () => {
	test("renders name/id, agent, status, counters; selected marker", () => {
		const w = snap("w-1", {
			name: "scout",
			model: "m",
			counters: { tokens: 10 },
		});
		const selected = rosterRow(w, { selected: true });
		const plain = rosterRow(w, { selected: false });
		expect(selected).toContain(">");
		expect(plain).not.toContain(">");
		expect(selected).toContain("scout");
		expect(selected).toContain("w-1");
		expect(selected).toContain("task");
		expect(selected).toContain("running");
		expect(selected).toContain("10");
	});

	test("falls back to id when name is absent; shows not-live badge", () => {
		expect(rosterRow(snap("w-2"))).toContain("w-2");
		expect(rosterRow(snap("w-3", { historical: true }))).toContain("not-live");
	});
});

describe("inspector", () => {
	test("renders detail lines incl. model/role/thinking/session (FR-07)", () => {
		const w = snap("w-1", {
			name: "scout",
			model: "devin/swe-2",
			modelRole: "scout",
			thinkingLevel: "high",
			activity: "searching",
			assignment: "find seams",
			parentToolCallId: "tc-9",
			index: 2,
			sessionFile: "/tmp/w-1.jsonl",
			counters: { tokens: 5, toolCount: 2 },
		});
		const text = inspector(w).join("\n");
		expect(text).toContain("w-1");
		expect(text).toContain("devin/swe-2");
		expect(text).toContain("scout");
		expect(text).toContain("high");
		expect(text).toContain("searching");
		expect(text).toContain("tc-9");
		expect(text).toContain("/tmp/w-1.jsonl");
	});

	test("a bare snapshot renders id/status without optional lines", () => {
		const text = inspector(snap("w-9")).join("\n");
		expect(text).toContain("w-9");
		expect(text).toContain("running");
		expect(text).not.toContain("model:");
		expect(text).not.toContain("session:");
	});
});

describe("selectableWorkerIds", () => {
	test("finished workers selectable by default (v1.2); hidden while collapsed on demand", () => {
		const s = stateWith([
			snap("live-1"),
			snap("done-1", { status: "completed" }),
			snap("done-2", { status: "failed" }),
		]);
		expect(selectableWorkerIds(s)).toEqual(["live-1", "done-1", "done-2"]);
		expect(selectableWorkerIds({ ...s, finishedCollapsed: true })).toEqual(["live-1"]);
	});

	test("historical rows stay selectable (they render a file, not live tail)", () => {
		const s = stateWith([snap("live-1"), snap("old-1", { status: "completed", historical: true })]);
		expect(selectableWorkerIds(s)).toContain("old-1");
	});

	test("worker scope reduces the selection set to the scoped id (D3)", () => {
		const s = stateWith([snap("a"), snap("b")], { scope: { workerId: "b" } });
		expect(selectableWorkerIds(s)).toEqual(["b"]);
	});
});

describe("renderScreen — roster mode", () => {
	test("header carries session + status; roster lists live workers", () => {
		const out = renderScreen(stateWith([snap("a"), snap("b")]), { status: "connected" });
		expect(out).toContain("sess-1");
		expect(out).toContain("connected");
		expect(out).toContain("a");
		expect(out).toContain("b");
	});

	test("finished visible by default (v1.2 owner decision); collapse on demand hides rows", () => {
		const s = stateWith([
			snap("live-1"),
			snap("done-1", { status: "completed" }),
			snap("done-2", { status: "aborted" }),
		]);
		const expanded = renderScreen(s);
		expect(expanded).toContain("finished (2):");
		expect(expanded).toContain("done-1");
		expect(expanded).toContain("done-2");
		const collapsed = renderScreen({ ...s, finishedCollapsed: true });
		expect(collapsed).toContain("finished (2) — press e to expand");
		expect(collapsed).not.toContain("done-1");
	});

	test("history section renders with not-live label (P3-R9)", () => {
		const s = stateWith([snap("live-1"), snap("old-1", { status: "completed", historical: true })]);
		const out = renderScreen(s);
		expect(out).toContain("old-1");
		expect(out).toContain("not-live");
	});

	test("degraded and offline states are surfaced (FR-12, D1)", () => {
		const base = stateWith([snap("a")]);
		expect(renderScreen({ ...base, degraded: true })).toContain("degraded");
		expect(renderScreen({ ...base, live: false })).toContain("offline");
		const withNotice = {
			...base,
			notices: [{ level: "warn" as const, message: "resyncing" }],
		};
		expect(renderScreen(withNotice)).toContain("resyncing");
	});

	test("selected worker gets inspector + transcript block", () => {
		const s = stateWith([snap("a", { sessionFile: "/tmp/a.jsonl" })], { selectedId: "a" });
		const out = renderScreen(s, { transcript: { workerId: "a", text: "line one\nline two" } });
		expect(out).toContain("line one");
		expect(out).toContain("line two");
	});

	test("transcript render failure shows the error, not a crash", () => {
		const s = stateWith([snap("a")], { selectedId: "a" });
		const out = renderScreen(s, { transcriptError: "omp render exited 1: boom" });
		expect(out).toContain("boom");
	});
});

describe("renderScreen — worker-scoped mode (D3, P3-R13)", () => {
	test("renders only the scoped worker; no roster of other workers", () => {
		const s = stateWith([snap("a"), snap("b")], { scope: { workerId: "b" } });
		const out = renderScreen(s);
		expect(out).toContain("b");
		expect(out).not.toContain("rosterRow");
		// the non-scoped worker id must not appear as a roster row
		expect(out.split("\n").filter((l) => l.includes("(a)"))).toEqual([]);
	});

	test("unknown scoped id renders a not-found notice, not a crash", () => {
		const s = stateWith([snap("a")], { scope: { workerId: "ghost" } });
		const out = renderScreen(s);
		expect(out).toContain("ghost");
		expect(out).toContain("not found");
	});

	test("scoped worker renders inspector + transcript without a roster section", () => {
		const s = stateWith([snap("a", { sessionFile: "/tmp/a.jsonl" }), snap("b")], {
			scope: { workerId: "a" },
		});
		const out = renderScreen(s, { transcript: { workerId: "a", text: "scoped output" } });
		expect(out).toContain("scoped output");
		expect(out).not.toContain("(b)");
	});
});

describe("renderScreen — direct-only display (P3-R8)", () => {
	test("renders exactly the workers the stream reports — no fabricated rows", () => {
		const s = stateWith([]);
		const out = renderScreen(s);
		expect(out).toContain("0");
		expect(out).not.toMatch(/^\s*>/m);
	});

	test("selection on a removed worker is ignored", () => {
		const s = stateWith([snap("a")], { selectedId: "gone" });
		expect(() => renderScreen(s)).not.toThrow();
	});
});

describe("renderScreen — reducer-built state stays consistent", () => {
	test("applyMessage fixtures render identically to hand-built ones", () => {
		let s = initialViewerState();
		s = applyMessage(s, {
			v: 1,
			type: "hello",
			session: "sess-2",
			workers: [snap("live-1")],
			history: [snap("old-1", { status: "completed" })],
		});
		const out = renderScreen(s, { status: "connected" });
		expect(out).toContain("sess-2");
		expect(out).toContain("live-1");
		expect(out).toContain("not-live");
	});
});
