import { describe, expect, test } from "bun:test";
import type { WorkerSnapshot } from "../../src/protocol/types";
import type { ViewerState } from "../../src/viewer/state";
import { initialViewerState } from "../../src/viewer/state";
import { renderTuiScreen, STACK_BELOW } from "../../src/viewer/tui";

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

/** ANSI-free copy for substring assertions. */
function plain(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip SGR/OSC sequences on purpose
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

describe("renderTuiScreen — E2E token contract (unchanged from render.ts)", () => {
	test("header, roster sections, scope line and footer tokens all survive the pi-tui layout", () => {
		const s = stateWith(
			[
				snap("a", { name: "alpha" }),
				snap("b", { status: "completed" }),
				snap("c", { name: "ghost", historical: true }),
			],
			{ finishedCollapsed: true },
		);
		const text = plain(renderTuiScreen(s, { width: 140 }));
		expect(text).toContain("omp lens — session sess-1 [connected]");
		expect(text).toContain("workers (1):");
		expect(text).toContain("finished (1) — press e to expand");
		expect(text).toContain("history (1):");
		expect(text).toContain("[not-live]");
		expect(text).toContain("j/k select · e finished · t thinking off · r refresh · q quit");
	});

	test("scoped mode keeps `scope: worker <id>` and the not-found line", () => {
		const s = stateWith([snap("a")], { scope: { workerId: "a" } });
		const text = plain(renderTuiScreen(s, { width: 140 }));
		expect(text).toContain("scope: worker a");
		const missing = stateWith([snap("a")], { scope: { workerId: "zzz" } });
		expect(plain(renderTuiScreen(missing, { width: 140 }))).toContain("worker zzz: not found");
	});
});

describe("renderTuiScreen — two-column layout", () => {
	test("selected worker's detail sits right of the │ separator on the same rows", () => {
		const s = stateWith([snap("a", { name: "alpha" }), snap("b", { name: "bravo" })], {
			selectedId: "b",
		});
		const lines = renderTuiScreen(s, { width: 140 }).split("\n");
		const sep = lines.filter((l) => l.includes("│"));
		expect(sep.length).toBeGreaterThan(0);
		const detailRow = sep.find((l) => /worker\s+bravo/.test(plain(l)));
		expect(detailRow).toBeDefined();
	});

	test("selection marker lands on the left column of the selected row", () => {
		const s = stateWith([snap("a", { name: "alpha" }), snap("b", { name: "bravo" })], {
			selectedId: "b",
		});
		const lines = renderTuiScreen(s, { width: 140 }).split("\n");
		const row = lines.find((l) => plain(l).includes("bravo") && plain(l).startsWith("❯"));
		expect(row).toBeDefined();
	});

	test("below STACK_BELOW the roster stacks above the detail — no separator", () => {
		const s = stateWith([snap("a", { name: "alpha" })], { selectedId: "a" });
		const lines = renderTuiScreen(s, { width: STACK_BELOW - 10 }).split("\n");
		expect(lines.every((l) => !l.includes("│"))).toBe(true);
		const text = plain(lines.join("\n"));
		expect(text).toContain("workers (1):");
		expect(/worker\s+alpha/.test(text)).toBe(true);
	});
});

describe("renderTuiScreen — transcript + status mapping", () => {
	test("transcript text appears in the detail column; errors surface verbatim", () => {
		const s = stateWith([snap("a", { name: "alpha", sessionFile: "/tmp/a.jsonl" })], {
			selectedId: "a",
		});
		const ok = plain(
			renderTuiScreen(s, { width: 140, transcript: { workerId: "a", text: "line one\nline two" } }),
		);
		expect(ok).toContain("── transcript ──");
		expect(ok).toContain("line one");
		const bad = plain(renderTuiScreen(s, { width: 140, transcriptError: "boom" }));
		expect(bad).toContain("render error: boom");
	});

	test("worker statuses map onto agent-painter statuses (queued→pending, completed→done)", () => {
		const s = stateWith([snap("a"), snap("b", { status: "completed" })], {
			finishedCollapsed: false,
			selectedId: "a",
		});
		const lines = renderTuiScreen(s, { width: 140 }).split("\n").map(plain);
		expect(lines.some((l) => l.includes("finished (1):"))).toBe(true);
		// completed maps to `done`: the painter draws the success glyph on b's row
		const finishedRow = lines.find((l) => l.includes(" b ⟦task⟧"));
		expect(finishedRow).toBeDefined();
		expect(finishedRow).toContain("✔");
	});
});

describe("renderTuiScreen — v1.2 persistent panes (owner UX decision 2026-11-25)", () => {
	test("finished workers stay visible by default, OMP-hub style", () => {
		const s = stateWith([snap("done-1", { name: "alpha", status: "completed" })]);
		const text = plain(renderTuiScreen(s, { width: 140 }));
		expect(text).toContain("workers (0):");
		expect(text).toContain("finished (1):");
		expect(text).toContain("alpha");
		expect(text).not.toContain("press e to expand");
	});

	test("zero workers still renders BOTH columns with the empty-state hint", () => {
		const s = stateWith([]);
		const lines = renderTuiScreen(s, { width: 140 }).split("\n");
		const sep = lines.filter((l) => l.includes("│"));
		expect(sep.length).toBeGreaterThan(0);
		const hintRow = sep.find((l) => plain(l).includes("(no agents yet"));
		expect(hintRow).toBeDefined();
		expect(plain(lines.join("\n"))).toContain("workers (0):");
	});

	test("workers present but none selected: right column shows the select hint, never disappears", () => {
		const s = stateWith([snap("a", { name: "alpha" })]); // no selectedId
		const lines = renderTuiScreen(s, { width: 140 }).split("\n");
		const sep = lines.filter((l) => l.includes("│"));
		expect(sep.length).toBeGreaterThan(0);
		expect(sep.some((l) => plain(l).includes("(no agent selected"))).toBe(true);
	});

	test("retained finished row keeps the two-column detail after reaping (selection survives)", () => {
		const s = stateWith([snap("a", { name: "alpha", status: "completed" })], { selectedId: "a" });
		const lines = renderTuiScreen(s, { width: 140 }).split("\n");
		const detailRow = lines.find((l) => l.includes("│") && /worker\s+alpha/.test(plain(l)));
		expect(detailRow).toBeDefined();
	});
});

describe("renderTuiScreen — v1.3 polish (OMP-theme chrome, tokens stay grep-safe)", () => {
	test("output carries OMP theme styling (SGR escapes) on header, sections, footer", () => {
		const s = stateWith([snap("a", { name: "alpha" })], { selectedId: "a" });
		const raw = renderTuiScreen(s, { width: 140 });
		// biome-ignore lint/suspicious/noControlCharactersInRegex: detect SGR styling on purpose
		expect(/\x1b\[/.test(raw)).toBe(true);
		// header product name is bold; connection chip is colored
		expect(raw).toContain("\x1b[1momp lens\x1b[22m");
	});

	test("machine tokens remain contiguous single runs after styling (pane-grep safe)", () => {
		const s = stateWith([snap("a", { name: "alpha" }), snap("b", { status: "completed" })], {
			selectedId: "a",
		});
		const raw = renderTuiScreen(s, { width: 140 });
		// each token must appear verbatim in the RAW (styled) output, not split by escapes
		expect(raw).toContain("workers (1):");
		expect(raw).toContain("finished (1):");
		expect(raw).toContain("[connected]");
		expect(raw).toContain("j/k");
		expect(raw.includes("scope: worker")).toBe(false); // not scoped here
	});

	test("scoped header token stays one contiguous styled run", () => {
		const s = stateWith([snap("a")], { scope: { workerId: "a" } });
		const raw = renderTuiScreen(s, { width: 140 });
		expect(raw).toContain("scope: worker a");
	});

	test("selection marker is the accent ❯ glyph, not the old ascii >", () => {
		const s = stateWith([snap("a", { name: "alpha" })], { selectedId: "a" });
		const lines = renderTuiScreen(s, { width: 140 }).split("\n").map(plain);
		expect(lines.some((l) => l.startsWith("❯") && l.includes("alpha"))).toBe(true);
	});
});
