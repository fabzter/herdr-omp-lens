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
		expect(text).toContain(
			"j/k select · J/K scroll · e finished · t thinking off · r refresh · q quit",
		);
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

describe("renderTuiScreen — v1.3 consistency (detail matches roster style)", () => {
	test("usage facts use the roster's style (N req · Nk tok · duration), not tok= counters", () => {
		const s = stateWith(
			[
				snap("a", {
					name: "alpha",
					counters: { requests: 7, tokens: 30100, cost: 0.08, toolCount: 4, durationMs: 91000 },
				}),
			],
			{ selectedId: "a" },
		);
		const text = plain(renderTuiScreen(s, { width: 140 }));
		expect(text).toContain("7 req · 30.1k tok · $0.08 · 4 tools · 1m 31s");
		expect(text).not.toContain("tok=30,100");
	});

	test("updated renders as a readable clock time, never a raw epoch", () => {
		const s = stateWith([snap("a", { name: "alpha", updatedAt: 1_700_000_000_000 })], {
			selectedId: "a",
		});
		const text = plain(renderTuiScreen(s, { width: 140 }));
		expect(text).not.toContain("1700000000000");
		expect(/updated\s+\d{2}:\d{2}:\d{2}/.test(text)).toBe(true);
	});

	test("read-only fact lives once in the footer, not as per-row badge noise", () => {
		const s = stateWith([snap("a", { name: "alpha" }), snap("b", { name: "bravo" })], {
			selectedId: "a",
		});
		const text = plain(renderTuiScreen(s, { width: 140 }));
		const footer = text.split("\n").at(-1) ?? "";
		expect(footer).toContain("read-only");
		expect(text.split("\n").filter((l) => l.includes("[read-only]")).length).toBe(0);
	});
});

describe("renderTuiScreen — v1.5 fixed frame (footer locked, OMP text graphics)", () => {
	function framed(
		height: number,
		width = 120,
		over: Partial<import("../../src/viewer/state").ViewerState> = {},
	) {
		const s = stateWith(
			[
				snap("a", { name: "alpha", sessionFile: "/tmp/a.jsonl" }),
				snap("b", { name: "bravo", status: "completed" }),
				snap("c", { name: "ghost", historical: true }),
			],
			{ selectedId: "a", ...over },
		);
		return renderTuiScreen(s, { width, height });
	}

	test("frame is EXACTLY height rows; footer is always the last row", () => {
		for (const h of [8, 12, 16, 24, 40]) {
			const lines = framed(h).split("\n");
			expect(lines.length).toBe(h);
			expect(plain(lines.at(-1) ?? "")).toContain("q quit");
			expect(plain(lines[0] ?? "")).toContain("omp lens — session sess-1 [connected]");
		}
	});

	test("footer stays locked with long transcript content (tail-follow, no growth)", () => {
		const s = stateWith([snap("a", { name: "alpha", sessionFile: "/tmp/a.jsonl" })], {
			selectedId: "a",
		});
		const tx = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const lines = renderTuiScreen(s, {
			width: 120,
			height: 16,
			transcript: { workerId: "a", text: tx },
		}).split("\n");
		expect(lines.length).toBe(16);
		expect(plain(lines.at(-1) ?? "")).toContain("q quit");
		const body = plain(lines.join("\n"));
		expect(body).toContain("line 199"); // tail visible
		expect(body).toContain("earlier lines"); // overflow indicator
	});

	test("T-junction rules align with the body divider; section headers carry disclosure glyphs", () => {
		const lines = framed(16).split("\n").map(plain);
		expect(lines[1]).toContain("┬");
		expect(lines.at(-2)).toContain("┴");
		const teeCol = (lines[1] ?? "").indexOf("┬");
		const bodyDividerCol = (lines[2] ?? "").indexOf("│");
		expect(teeCol).toBe(bodyDividerCol);
		expect(lines.some((l) => l.startsWith("▾ workers (1):"))).toBe(true);
		expect(lines.some((l) => l.startsWith("▾ finished (1):"))).toBe(true);
		expect(lines.some((l) => l.startsWith("▾ history (1):"))).toBe(true);
	});

	test("machine tokens stay contiguous in the framed output (pane-grep safe)", () => {
		const raw = framed(16);
		expect(raw).toContain("workers (1):");
		expect(raw).toContain("finished (1):");
		expect(raw).toContain("history (1):");
		expect(raw).toContain("[connected]");
		expect(raw).toContain("omp lens");
	});

	test("selected row carries selectedBg tint; empty state keeps both columns + hint card", () => {
		const raw = framed(16);
		expect(raw).toContain("\x1b[48;2;"); // selectedBg present
		const empty = renderTuiScreen(stateWith([]), { width: 120, height: 14 });
		const el = empty.split("\n").map(plain);
		expect(el.length).toBe(14);
		expect(el.some((l) => l.includes("│") && l.includes("(no agents yet"))).toBe(true);
		expect(el.some((l) => l.includes("╭"))).toBe(true); // hint card box
		expect(plain(el.at(-1) ?? "")).toContain("q quit");
	});

	test("stacked narrow frame: no │ divider, full-width rules, footer locked", () => {
		const s = stateWith([snap("a", { name: "alpha" })], { selectedId: "a" });
		const lines = renderTuiScreen(s, { width: 60, height: 12 }).split("\n").map(plain);
		expect(lines.length).toBe(12);
		// body rows must not carry the two-column divider (scrollbar track excepted)
		expect(lines.some((l) => l.includes("┬"))).toBe(false);
		expect(plain(lines.at(-1) ?? "")).toContain("q quit");
	});

	test("roster overflow keeps the selected row visible with a scrollbar", () => {
		const workers = Array.from({ length: 30 }, (_, i) => snap(`w${i}`, { name: `agent-${i}` }));
		const s = stateWith(workers, { selectedId: "w29" });
		const lines = renderTuiScreen(s, { width: 120, height: 12 }).split("\n").map(plain);
		expect(lines.length).toBe(12);
		expect(lines.some((l) => l.includes("agent-29"))).toBe(true); // selection windowed into view
		expect(lines.some((l) => l.includes("█"))).toBe(true); // scrollbar thumb
	});
});

describe("renderTuiScreen — v1.6 transcript scroll (view-local, read-only)", () => {
	function longTx(n: number): string {
		return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
	}
	function withTx(scroll: number, height = 16) {
		const s = stateWith([snap("a", { name: "alpha", sessionFile: "/tmp/a.jsonl" })], {
			selectedId: "a",
			txScroll: scroll,
		});
		return renderTuiScreen(s, {
			width: 120,
			height,
			transcript: { workerId: "a", text: longTx(100) },
		});
	}

	test("txScroll=0 tail-follows; scrolling up reveals earlier lines with ↓ indicator", () => {
		const follow = plain(withTx(0));
		expect(follow).toContain("line 99");
		expect(follow).toContain("↑");
		expect(follow).not.toContain("↓");
		const up = plain(withTx(20));
		expect(up).toContain("↓ 20 more lines");
		expect(up).toContain("↑");
		expect(up).not.toContain("line 99"); // tail no longer visible
	});

	test("g (MAX_SAFE_INTEGER) clamps to the top: line 0 visible, no ↑ indicator", () => {
		const top = plain(withTx(Number.MAX_SAFE_INTEGER));
		expect(top).toContain("line 0");
		expect(top).not.toContain("earlier lines");
		expect(top).toContain("more lines"); // content below
	});

	test("stale oversized offset clamps to content, never blanks the pane", () => {
		const s = stateWith([snap("a", { name: "alpha", sessionFile: "/tmp/a.jsonl" })], {
			selectedId: "a",
			txScroll: 5000,
		});
		const out = plain(
			renderTuiScreen(s, {
				width: 120,
				height: 16,
				transcript: { workerId: "a", text: longTx(100) },
			}),
		);
		expect(out).toContain("line 0");
		expect(out.split("\n").length).toBe(16);
	});

	test("short transcript ignores scroll offset (nothing to scroll)", () => {
		const s = stateWith([snap("a", { name: "alpha", sessionFile: "/tmp/a.jsonl" })], {
			selectedId: "a",
			txScroll: 50,
		});
		const out = plain(
			renderTuiScreen(s, {
				width: 120,
				height: 24,
				transcript: { workerId: "a", text: "only one line" },
			}),
		);
		expect(out).toContain("only one line");
		expect(out).not.toContain("earlier lines");
		expect(out).not.toContain("more lines");
	});

	test("footer advertises J/K scroll; frame stays exactly height rows while scrolled", () => {
		const raw = withTx(10);
		expect(raw).toContain("J/K");
		expect(raw.split("\n").length).toBe(16);
		expect(plain(raw.split("\n").at(-1) ?? "")).toContain("q quit");
	});
});
