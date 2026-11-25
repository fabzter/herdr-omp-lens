/**
 * Pure screen renderers for the viewer CLI (P3-R6/R8/R9/R13, FR-08/FR-10,
 * D3/D4). No I/O: cli.ts feeds a `ViewerState` plus optional transcript text
 * in and gets deterministic lines out. Renders exactly the workers the
 * stream reports — nothing fabricated, nothing merged from elsewhere.
 */
import type { WorkerSnapshot } from "../protocol/types";
import { isFinishedStatus, type ViewerState } from "./state";

const NOT_LIVE = "[not-live]";

/** Badge for persisted entries: live snapshots render unlabeled (RC-3). */
export function notLiveLabel(w: WorkerSnapshot): string {
	return w.historical === true ? NOT_LIVE : "";
}

/** `tok=… cost=$… req=… tools=… Ds` — only fields the snapshot carries. */
export function formatCounters(c: WorkerSnapshot["counters"] | undefined): string {
	if (c === undefined) return "";
	const parts: string[] = [];
	if (c.tokens !== undefined) parts.push(`tok=${c.tokens.toLocaleString("en-US")}`);
	if (c.cost !== undefined) parts.push(`cost=$${c.cost.toFixed(2)}`);
	if (c.requests !== undefined) parts.push(`req=${c.requests}`);
	if (c.toolCount !== undefined) parts.push(`tools=${c.toolCount}`);
	if (c.durationMs !== undefined) parts.push(`${(c.durationMs / 1000).toFixed(1)}s`);
	return parts.join(" ");
}

/** One roster line: `> name (id) agent/status [not-live] tok=…`. */
export function rosterRow(w: WorkerSnapshot, opts: { selected?: boolean } = {}): string {
	const mark = opts.selected === true ? ">" : " ";
	const badge = notLiveLabel(w);
	const counters = formatCounters(w.counters);
	return [
		`${mark} ${w.name ?? w.id} (${w.id}) ${w.agent}/${w.status}`,
		badge === "" ? "" : badge,
		counters,
	]
		.filter((p) => p !== "")
		.join(" ");
}

/** Multi-line worker detail (FR-07 lineage/model/activity fields). */
export function inspector(w: WorkerSnapshot): string[] {
	const badge = notLiveLabel(w);
	const lines = [
		`worker: ${w.name ?? w.id} (${w.id})`,
		`status: ${w.status}${badge === "" ? "" : ` ${badge}`}`,
	];
	if (w.agent !== "") lines.push(`agent: ${w.agent}`);
	if (w.model !== undefined) lines.push(`model: ${w.model}`);
	if (w.modelRole !== undefined) lines.push(`role: ${w.modelRole}`);
	if (w.thinkingLevel !== undefined) lines.push(`thinking level: ${w.thinkingLevel}`);
	if (w.assignment !== undefined) lines.push(`assignment: ${w.assignment}`);
	if (w.activity !== undefined) lines.push(`activity: ${w.activity}`);
	if (w.parentToolCallId !== undefined) lines.push(`parent tool call: ${w.parentToolCallId}`);
	if (w.index !== undefined) lines.push(`index: ${w.index}`);
	const counters = formatCounters(w.counters);
	if (counters !== "") lines.push(`counters: ${counters}`);
	if (w.sessionFile !== undefined) lines.push(`session: ${w.sessionFile}`);
	return lines;
}

interface RosterPartition {
	live: WorkerSnapshot[];
	finished: WorkerSnapshot[];
	history: WorkerSnapshot[];
}

function partition(s: ViewerState): RosterPartition {
	const p: RosterPartition = { live: [], finished: [], history: [] };
	for (const w of s.workers.values()) {
		if (w.historical === true) {
			p.history.push(w);
		} else if (isFinishedStatus(w.status)) {
			p.finished.push(w);
		} else {
			p.live.push(w);
		}
	}
	return p;
}

/**
 * Ids the selection cursor may rest on: live rows, expanded finished rows
 * (FR-08), and history rows (a file render is still inspectable; it is the
 * live-tail path they are excluded from, RC-3). Worker-scoped mode reduces
 * the set to the scoped id (D3).
 */
export function selectableWorkerIds(s: ViewerState): string[] {
	const scopedId = s.scope?.workerId;
	if (scopedId !== undefined) {
		return s.workers.has(scopedId) ? [scopedId] : [];
	}
	const p = partition(s);
	const ids = p.live.map((w) => w.id);
	if (!s.finishedCollapsed) ids.push(...p.finished.map((w) => w.id));
	ids.push(...p.history.map((w) => w.id));
	return ids;
}

export interface RenderScreenOptions {
	/** Connection label; defaults to deriving from state.live. */
	status?: string;
	/** Transcript text for the shown worker; workerId pins it to the right row. */
	transcript?: { workerId: string; text: string };
	/** Render failure text shown in place of the transcript (FR-12). */
	transcriptError?: string;
}

function transcriptBlock(
	s: ViewerState,
	worker: WorkerSnapshot,
	opts: RenderScreenOptions,
): string[] {
	const lines = ["── transcript ──"];
	if (opts.transcriptError !== undefined) {
		lines.push(`render error: ${opts.transcriptError}`);
	} else if (opts.transcript !== undefined && opts.transcript.workerId === worker.id) {
		lines.push(...opts.transcript.text.split("\n"));
	} else if (worker.sessionFile === undefined && !s.transcriptRefs.has(worker.id)) {
		lines.push("(no transcript yet)");
	} else {
		lines.push("(transcript loading…)");
	}
	return lines;
}

function scopedScreen(s: ViewerState, opts: RenderScreenOptions): string[] {
	const scopedId = s.scope?.workerId ?? "";
	const lines: string[] = [`scope: worker ${scopedId}`];
	const w = s.workers.get(scopedId);
	if (w === undefined) {
		lines.push(`worker ${scopedId}: not found`);
	} else {
		lines.push(...inspector(w), ...transcriptBlock(s, w, opts));
	}
	return lines;
}

function footer(s: ViewerState): string {
	const thinking = s.thinkingVisible ? "on" : "off";
	return `j/k select · e finished · t thinking ${thinking} · r refresh · q quit`;
}

/** Full text screen: header, notices, roster sections, inspector, transcript. */
export function renderScreen(s: ViewerState, opts: RenderScreenOptions = {}): string {
	const status = opts.status ?? (s.live ? "connected" : "offline");
	const lines: string[] = [
		`omp lens — session ${s.session ?? "?"} [${status}]${s.degraded ? " · degraded" : ""}`,
	];
	for (const n of s.notices.slice(-3)) {
		lines.push(`! ${n.level}: ${n.message}`);
	}
	if (s.scope?.workerId !== undefined) {
		lines.push(...scopedScreen(s, opts), footer(s));
		return lines.join("\n");
	}

	const p = partition(s);
	lines.push(`workers (${p.live.length}):`);
	for (const w of p.live) {
		lines.push(rosterRow(w, { selected: w.id === s.selectedId }));
	}
	if (p.finished.length > 0) {
		if (s.finishedCollapsed) {
			lines.push(`finished (${p.finished.length}) — press e to expand`);
		} else {
			lines.push(`finished (${p.finished.length}):`);
			for (const w of p.finished) {
				lines.push(rosterRow(w, { selected: w.id === s.selectedId }));
			}
		}
	}
	if (p.history.length > 0) {
		lines.push(`history (${p.history.length}):`);
		for (const w of p.history) {
			lines.push(rosterRow(w, { selected: w.id === s.selectedId }));
		}
	}

	const selected = s.selectedId !== undefined ? s.workers.get(s.selectedId) : undefined;
	if (selected !== undefined) {
		lines.push("", ...inspector(selected), ...transcriptBlock(s, selected, opts));
	}
	lines.push(footer(s));
	return lines.join("\n");
}
