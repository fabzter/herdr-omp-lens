/**
 * Two-column OMP-look viewer screen (v1.1): the worker roster painted by
 * pi-tui's own `agent` painter on the left, the selected worker's inspector +
 * transcript on the right — the same rows OMP's Agent Hub produces, without a
 * second OMP instance. Below STACK_BELOW columns the layout stacks instead.
 *
 * The machine-readable contract stays identical to `render.ts` so the E2E
 * pane greps still apply: `omp lens — session <id> [status]`,
 * `workers (N):`, `finished (N) — press e to expand`, `history (N):`,
 * `scope: worker <id>`, `[not-live]` badges and the key footer are unchanged.
 */
import { UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, type StaticEnvironment, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { padTo, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "@oh-my-pi/pi-tui/term/painters/agent";
import type { TspAgentProps } from "@oh-my-pi/pi-wire/tsp";
import type { WorkerSnapshot, WorkerStatus } from "../protocol/types";
import { footer, inspector, partition, type RenderScreenOptions, transcriptBlock } from "./render";
import type { ViewerState } from "./state";

export interface TuiScreenOptions extends RenderScreenOptions {
	/** Terminal cell width; defaults to 80. */
	width?: number;
}

/** Widths below this stack the roster above the detail instead of two columns. */
export const STACK_BELOW = 100;

const SEP = "│";
const MARKER_WIDTH = 2;

let cachedEnv: StaticEnvironment | undefined;
function paintEnv(): StaticEnvironment {
	cachedEnv ??= staticEnvironment(loadThemeSync("dark"));
	return cachedEnv;
}

/** Roster row → `agent` painter props: the OMP Agent Hub row verbatim. */
function agentProps(w: WorkerSnapshot): TspAgentProps {
	const badges: { text: string; tone?: "neutral" | "muted" }[] = [];
	if (w.historical === true) badges.push({ text: "not-live", tone: "muted" });
	badges.push({ text: "read-only", tone: "muted" });
	const counters = w.counters;
	return {
		name: w.name ?? w.id,
		agent: w.agent === "" ? undefined : w.agent,
		task: w.assignment ?? (w.name === undefined ? undefined : w.id),
		status: statusMap(w.status),
		model: w.model,
		thinking: w.thinkingLevel,
		badges,
		collapsed: true, // read-only pane: never expand children rows
		stats:
			counters === undefined
				? undefined
				: {
						requests: counters.requests,
						tokens: counters.tokens,
						cost: counters.cost,
						tools: counters.toolCount,
						took: counters.durationMs,
					},
	};
}

function statusMap(status: WorkerStatus): TspAgentProps["status"] {
	switch (status) {
		case "queued":
			return "pending";
		case "completed":
			return "done";
		default:
			return status;
	}
}

/** One roster row through the real `agent` painter, with the selection marker. */
function agentRow(w: WorkerSnapshot, selected: boolean, width: number): string[] {
	// UiNode's prop bag is an open record; TspAgentProps is a closed interface —
	// widen through unknown (the painter reads the same fields back).
	const node = new UiNode("agent", agentProps(w) as unknown as Readonly<Record<string, unknown>>);
	const block = paintNode(paintEnv(), node, Math.max(1, width - MARKER_WIDTH));
	return block.rows.map((row, i) => `${selected && i === 0 ? ">" : " "} ${row}`);
}

/** Selected worker's detail (inspector + transcript), wrapped to the column.
 * v1.2: never empty — with no selection the column shows a hint, so both
 * panes stay open all the time (owner UX decision 2026-11-25). */
function detailLines(s: ViewerState, opts: TuiScreenOptions, width: number): string[] {
	const w = s.selectedId !== undefined ? s.workers.get(s.selectedId) : undefined;
	if (w === undefined) {
		return s.workers.size === 0
			? wrap("(no agents yet — delegate a task in OMP to see it here)", width)
			: wrap("(no agent selected — j/k to select)", width);
	}
	const lines: string[] = [];
	for (const line of inspector(w)) lines.push(...wrap(line, width));
	lines.push("");
	for (const line of transcriptBlock(s, w, opts)) lines.push(...wrap(line, width));
	return lines;
}

function scopedTui(s: ViewerState, opts: TuiScreenOptions, width: number): string[] {
	const scopedId = s.scope?.workerId ?? "";
	const lines: string[] = [`scope: worker ${scopedId}`];
	const w = s.workers.get(scopedId);
	if (w === undefined) {
		lines.push(`worker ${scopedId}: not found`);
		return lines;
	}
	for (const line of inspector(w)) lines.push(...wrap(line, width));
	lines.push("");
	for (const line of transcriptBlock(s, w, opts)) lines.push(...wrap(line, width));
	return lines;
}

function rosterLines(s: ViewerState, width: number): string[] {
	const p = partition(s);
	const lines: string[] = [`workers (${p.live.length}):`];
	for (const w of p.live) lines.push(...agentRow(w, w.id === s.selectedId, width));
	if (p.finished.length > 0) {
		if (s.finishedCollapsed) {
			lines.push(`finished (${p.finished.length}) — press e to expand`);
		} else {
			lines.push(`finished (${p.finished.length}):`);
			for (const w of p.finished) lines.push(...agentRow(w, w.id === s.selectedId, width));
		}
	}
	if (p.history.length > 0) {
		lines.push(`history (${p.history.length}):`);
		for (const w of p.history) lines.push(...agentRow(w, w.id === s.selectedId, width));
	}
	return lines;
}

/**
 * Full TUI screen: header, notices, then the two columns (or the stacked
 * layout under STACK_BELOW, or the single scoped column), then the footer.
 */
export function renderTuiScreen(s: ViewerState, opts: TuiScreenOptions = {}): string {
	const width = Math.max(20, opts.width ?? 80);
	const status = opts.status ?? (s.live ? "connected" : "offline");
	const header = `omp lens — session ${s.session ?? "?"} [${status}]${s.degraded ? " · degraded" : ""}`;
	const noticeLines = s.notices.slice(-3).map((n) => `! ${n.level}: ${n.message}`);

	if (s.scope?.workerId !== undefined) {
		return [header, ...noticeLines, ...scopedTui(s, opts, width), footer(s)].join("\n");
	}

	const left = rosterLines(s, width >= STACK_BELOW ? leftWidth(width) : width);
	const right = detailLines(s, opts, width >= STACK_BELOW ? rightWidth(width) : width);

	if (width < STACK_BELOW) {
		return [header, ...noticeLines, ...left, "", ...right, footer(s)].join("\n");
	}

	const leftW = leftWidth(width);
	const body: string[] = [];
	const rows = Math.max(left.length, right.length);
	for (let i = 0; i < rows; i += 1) {
		const l = padTo(left[i] ?? "", leftW);
		const r = truncate(right[i] ?? "", rightWidth(width), "");
		body.push(`${l}  ${SEP} ${r}`);
	}
	return [header, ...noticeLines, ...body, footer(s)].join("\n");
}

function leftWidth(width: number): number {
	return Math.floor((width - SEP.length - 2) / 2);
}
function rightWidth(width: number): number {
	return Math.max(10, width - leftWidth(width) - SEP.length - 2);
}
