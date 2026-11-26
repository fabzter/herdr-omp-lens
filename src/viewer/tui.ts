/**
 * Two-column OMP-look viewer screen (v1.1–v1.3): the worker roster painted by
 * pi-tui's own `agent` painter on the left, the selected worker's inspector +
 * transcript on the right — the same rows OMP's Agent Hub produces, without a
 * second OMP instance. Below STACK_BELOW columns the layout stacks instead.
 *
 * v1.3 polish: OMP-theme chrome throughout — styled header with a colored
 * connection chip, dim section headers, accent selection marker, kv-painter
 * detail grid, dim separators/footer. Every machine-readable token stays ONE
 * contiguous styled run so pane-grep E2E checks pass unmodified:
 * `omp lens — session <id> [status]`, `workers (N):`,
 * `finished (N) — press e to expand`, `history (N):`, `scope: worker <id>`,
 * `[not-live]` badges and the key footer.
 */
import { UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, type StaticEnvironment, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { padTo, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "@oh-my-pi/pi-tui/term/painters/agent";
import "@oh-my-pi/pi-tui/term/painters/kv";
import type { TspAgentProps, TspKvProps } from "@oh-my-pi/pi-wire/tsp";
import type { WorkerSnapshot, WorkerStatus } from "../protocol/types";
import { formatCounters, partition, type RenderScreenOptions } from "./render";
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
let cachedTheme: Theme | undefined;
function paintEnv(): StaticEnvironment {
	cachedEnv ??= staticEnvironment(theme());
	return cachedEnv;
}
function theme(): Theme {
	cachedTheme ??= loadThemeSync("dark");
	return cachedTheme;
}

/** Roster row → `agent` painter props: the OMP Agent Hub row verbatim. */
function agentProps(w: WorkerSnapshot): TspAgentProps {
	const badges: { text: string; tone?: "neutral" | "muted" }[] = [];
	if (w.historical === true) badges.push({ text: "not-live", tone: "muted" });
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
	const mark = selected ? theme().fg("accent", "❯") : " ";
	return block.rows.map((row, i) => `${i === 0 ? mark : " "} ${row}`);
}

/** Inspector facts as kv-painter items (same field set as render.ts inspector). */
function inspectorItems(w: WorkerSnapshot): TspKvProps["items"] {
	const items: { k: string; v: string }[] = [
		{ k: "worker", v: `${w.name ?? w.id} (${w.id})` },
		{
			k: "status",
			v: `${w.status}${w.historical === true ? " [not-live]" : ""}`,
		},
	];
	if (w.agent !== "") items.push({ k: "agent", v: w.agent });
	if (w.model !== undefined) items.push({ k: "model", v: w.model });
	if (w.modelRole !== undefined) items.push({ k: "role", v: w.modelRole });
	if (w.thinkingLevel !== undefined) items.push({ k: "thinking", v: w.thinkingLevel });
	if (w.assignment !== undefined) items.push({ k: "assignment", v: w.assignment });
	if (w.activity !== undefined) items.push({ k: "activity", v: w.activity });
	if (w.parentToolCallId !== undefined) items.push({ k: "parent call", v: w.parentToolCallId });
	if (w.index !== undefined) items.push({ k: "index", v: String(w.index) });
	items.push({ k: "updated", v: String(w.updatedAt) });
	const counters = formatCounters(w.counters);
	if (counters !== "") items.push({ k: "counters", v: counters });
	if (w.sessionFile !== undefined) items.push({ k: "session", v: w.sessionFile });
	return items;
}

/** kv grid through OMP's own painter. */
function kvRows(items: TspKvProps["items"], width: number): string[] {
	const props: TspKvProps = { items, layout: "grid" };
	const node = new UiNode("kv", props as unknown as Readonly<Record<string, unknown>>);
	return [...paintNode(paintEnv(), node, width).rows];
}

/** Transcript block: dim rule header, styled error/loading hints, body as-is. */
function styledTranscript(
	s: ViewerState,
	w: WorkerSnapshot,
	opts: TuiScreenOptions,
	width: number,
): string[] {
	const t = theme();
	const lines: string[] = [t.style("dim", "── transcript ──")];
	if (opts.transcriptError !== undefined) {
		lines.push(...wrap(t.fg("error", `render error: ${opts.transcriptError}`), width));
	} else if (opts.transcript !== undefined && opts.transcript.workerId === w.id) {
		for (const line of opts.transcript.text.split("\n")) lines.push(...wrap(line, width));
	} else if (w.sessionFile === undefined && !s.transcriptRefs.has(w.id)) {
		lines.push(...wrap(t.style("dim", "(no transcript yet)"), width));
	} else {
		lines.push(...wrap(t.style("dim", "(transcript loading…)"), width));
	}
	return lines;
}

/** Selected worker's detail (kv inspector + transcript), wrapped to the column.
 * v1.2: never empty — with no selection the column shows a hint, so both
 * panes stay open all the time (owner UX decision 2026-11-25). */
function detailLines(s: ViewerState, opts: TuiScreenOptions, width: number): string[] {
	const w = s.selectedId !== undefined ? s.workers.get(s.selectedId) : undefined;
	if (w === undefined) {
		const hint =
			s.workers.size === 0
				? "(no agents yet — delegate a task in OMP to see it here)"
				: "(no agent selected — j/k to select)";
		return wrap(theme().style("dim", hint), width);
	}
	return [...kvRows(inspectorItems(w), width), "", ...styledTranscript(s, w, opts, width)];
}

function scopedTui(s: ViewerState, opts: TuiScreenOptions, width: number): string[] {
	const scopedId = s.scope?.workerId ?? "";
	const t = theme();
	const lines: string[] = [t.style("strong", `scope: worker ${scopedId}`)];
	const w = s.workers.get(scopedId);
	if (w === undefined) {
		lines.push(t.fg("warning", `worker ${scopedId}: not found`));
		return lines;
	}
	lines.push(...kvRows(inspectorItems(w), width), "", ...styledTranscript(s, w, opts, width));
	return lines;
}

function rosterLines(s: ViewerState, width: number): string[] {
	const p = partition(s);
	const t = theme();
	const lines: string[] = [t.style("dim", `workers (${p.live.length}):`)];
	for (const w of p.live) lines.push(...agentRow(w, w.id === s.selectedId, width));
	if (p.finished.length > 0) {
		if (s.finishedCollapsed) {
			lines.push(t.style("dim", `finished (${p.finished.length}) — press e to expand`));
		} else {
			lines.push(t.style("dim", `finished (${p.finished.length}):`));
			for (const w of p.finished) lines.push(...agentRow(w, w.id === s.selectedId, width));
		}
	}
	if (p.history.length > 0) {
		lines.push(t.style("dim", `history (${p.history.length}):`));
		for (const w of p.history) lines.push(...agentRow(w, w.id === s.selectedId, width));
	}
	return lines;
}

/** Header: strong product name, dim session, colored connection chip. */
function headerLine(s: ViewerState, status: string): string {
	const t = theme();
	const chipTone = status === "connected" ? "success" : status === "offline" ? "error" : "warning";
	const degraded = s.degraded ? t.fg("warning", " · degraded") : "";
	return (
		t.style("strong", "omp lens") +
		t.style("dim", ` — session ${s.session ?? "?"} `) +
		t.fg(chipTone, `[${status}]`) +
		degraded
	);
}

/** Footer: accent keys, dim labels — one contiguous run per token. */
function footerLine(s: ViewerState): string {
	const t = theme();
	const thinking = s.thinkingVisible ? "on" : "off";
	const key = (k: string) => t.fg("accent", k);
	const dim = (x: string) => t.style("dim", x);
	return [
		`${key("j/k")}${dim(" select")}`,
		`${key("e")}${dim(" finished")}`,
		`${key("t")}${dim(` thinking ${thinking}`)}`,
		`${key("r")}${dim(" refresh")}`,
		`${key("q")}${dim(" quit")}`,
	].join(dim(" · "));
}

/**
 * Full TUI screen: header, notices, then the two columns (or the stacked
 * layout under STACK_BELOW, or the single scoped column), then the footer.
 */
export function renderTuiScreen(s: ViewerState, opts: TuiScreenOptions = {}): string {
	const width = Math.max(20, opts.width ?? 80);
	const status = opts.status ?? (s.live ? "connected" : "offline");
	const t = theme();
	const header = headerLine(s, status);
	const noticeLines = s.notices.slice(-3).map((n) => {
		const tone = n.level === "error" ? "error" : n.level === "warn" ? "warning" : "muted";
		return t.fg(tone, `! ${n.level}: ${n.message}`);
	});
	const foot = footerLine(s);

	if (s.scope?.workerId !== undefined) {
		return [header, ...noticeLines, ...scopedTui(s, opts, width), foot].join("\n");
	}

	const left = rosterLines(s, width >= STACK_BELOW ? leftWidth(width) : width);
	const right = detailLines(s, opts, width >= STACK_BELOW ? rightWidth(width) : width);

	if (width < STACK_BELOW) {
		return [header, ...noticeLines, ...left, "", ...right, foot].join("\n");
	}

	const leftW = leftWidth(width);
	const sep = t.style("dim", SEP);
	const body: string[] = [];
	const rows = Math.max(left.length, right.length);
	for (let i = 0; i < rows; i += 1) {
		const l = padTo(left[i] ?? "", leftW);
		const r = truncate(right[i] ?? "", rightWidth(width), "");
		body.push(`${l}  ${sep} ${r}`);
	}
	return [header, ...noticeLines, ...body, foot].join("\n");
}

function leftWidth(width: number): number {
	return Math.floor((width - SEP.length - 2) / 2);
}
function rightWidth(width: number): number {
	return Math.max(10, width - leftWidth(width) - SEP.length - 2);
}
