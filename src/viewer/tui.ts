/**
 * Two-column OMP-look viewer screen (v1.1–v1.5): the worker roster painted by
 * pi-tui's own `agent` painter on the left, the selected worker's kv inspector +
 * transcript on the right — the same components OMP's Agent Hub uses, without a
 * second OMP instance.
 *
 * v1.5 (owner: "more visual appeal, text graphics like OMP, footer locked at the
 * bottom"; design consult agy-neon 2026-11-26): with `height` set the screen is
 * a FIXED full-viewport frame — statusLineBg header/footer bars, borderMuted
 * T-junction rules, section headers with disclosure glyphs + rule fill,
 * selectedBg row tint, scroll-windowed roster with a native scrollbar,
 * tail-following transcript. Without `height` the natural-height layout is kept
 * (headless callers / legacy tests).
 *
 * Machine tokens stay ONE contiguous styled run for pane-grep E2E:
 * `omp lens — session <id> [status]`, `workers (N):`, `finished (N):`,
 * `finished (N) — press e to expand`, `history (N):`, `scope: worker <id>`,
 * `[not-live]`, footer keys.
 */
import { UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, type StaticEnvironment, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { boxRows } from "@oh-my-pi/pi-tui/term/painters/card";
import { formatDuration } from "@oh-my-pi/pi-tui/term/painters/elapsed";
import { scrollbar, scrollWindow } from "@oh-my-pi/pi-tui/term/painters/picker";
import { padTo, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "@oh-my-pi/pi-tui/term/painters/agent";
import "@oh-my-pi/pi-tui/term/painters/kv";
import type { TspAgentProps, TspKvProps } from "@oh-my-pi/pi-wire/tsp";
import type { WorkerSnapshot, WorkerStatus } from "../protocol/types";
import { partition, type RenderScreenOptions, type RosterPartition } from "./render";
import type { ViewerState } from "./state";

export interface TuiScreenOptions extends RenderScreenOptions {
	/** Terminal cell width; defaults to 80. */
	width?: number;
	/** Terminal rows; when set, the frame is exactly this tall (footer = last row). */
	height?: number;
}

/** Widths below this stack the roster above the detail instead of two columns. */
export const STACK_BELOW = 100;

const SEP = "│";
const MARKER_WIDTH = 2;
/** Separator cells between columns: ` │ ` (1 space each side). */
const SEP_CELLS = 3;

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

/** Theme color for a worker status (kv value tint links detail to roster). */
function statusColor(w: WorkerSnapshot): string {
	if (w.historical === true) return "muted";
	switch (w.status) {
		case "running":
			return "accent";
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "aborted":
			return "warning";
		default:
			return "muted";
	}
}

/** One roster row through the real `agent` painter, marker + selectedBg tint. */
function agentRow(w: WorkerSnapshot, selected: boolean, width: number): string[] {
	// UiNode's prop bag is an open record; TspAgentProps is a closed interface —
	// widen through unknown (the painter reads the same fields back).
	const node = new UiNode("agent", agentProps(w) as unknown as Readonly<Record<string, unknown>>);
	const block = paintNode(paintEnv(), node, Math.max(1, width - MARKER_WIDTH));
	const t = theme();
	const mark = selected ? t.fg("accent", t.symbols.symbol("nav.cursor")) : " ";
	return block.rows.map((row, i) => {
		const line = padTo(`${i === 0 ? mark : " "} ${row}`, width);
		return selected ? t.bg("selectedBg", line) : line;
	});
}

/** Inspector facts as kv-painter items (same field set as render.ts inspector). */
function inspectorItems(w: WorkerSnapshot): TspKvProps["items"] {
	const statusSpans: { t: string; s: string }[] = [{ t: w.status, s: statusColor(w) }];
	if (w.historical === true) statusSpans.push({ t: " [not-live]", s: "muted" });
	const items: TspKvProps["items"][number][] = [
		{ k: "worker", v: `${w.name ?? w.id} (${w.id})` },
		{ k: "status", v: statusSpans },
	];
	if (w.agent !== "") items.push({ k: "agent", v: w.agent });
	if (w.model !== undefined) items.push({ k: "model", v: w.model });
	if (w.modelRole !== undefined) items.push({ k: "role", v: w.modelRole });
	if (w.thinkingLevel !== undefined) items.push({ k: "thinking", v: w.thinkingLevel });
	if (w.assignment !== undefined) items.push({ k: "assignment", v: w.assignment });
	if (w.activity !== undefined) items.push({ k: "activity", v: w.activity });
	if (w.parentToolCallId !== undefined) items.push({ k: "parent call", v: w.parentToolCallId });
	if (w.index !== undefined) items.push({ k: "index", v: String(w.index) });
	items.push({
		k: "updated",
		v: new Date(w.updatedAt).toLocaleTimeString("en-GB", { hour12: false }),
	});
	const usage = usageFacts(w);
	if (usage !== "") items.push({ k: "usage", v: usage });
	if (w.sessionFile !== undefined) items.push({ k: "session", v: w.sessionFile });
	return items;
}

/** Usage facts in the SAME style as the roster's agent-painter facts line. */
function usageFacts(w: WorkerSnapshot): string {
	const c = w.counters;
	if (c === undefined) return "";
	const out: string[] = [];
	if (c.requests !== undefined) out.push(`${c.requests} req`);
	if (c.tokens !== undefined)
		out.push(`${c.tokens >= 1000 ? `${(c.tokens / 1000).toFixed(1)}k` : c.tokens} tok`);
	if (c.cost !== undefined) out.push(`$${c.cost.toFixed(2)}`);
	if (c.toolCount !== undefined) out.push(`${c.toolCount} tools`);
	if (c.durationMs !== undefined) out.push(formatDuration(c.durationMs));
	return out.join(" · ");
}

/** kv grid through OMP's own painter. */
function kvRows(items: TspKvProps["items"], width: number): string[] {
	const props: TspKvProps = { items, layout: "grid" };
	const node = new UiNode("kv", props as unknown as Readonly<Record<string, unknown>>);
	return [...paintNode(paintEnv(), node, width).rows];
}

/** Section header: disclosure glyph + contiguous token + borderMuted rule fill. */
function sectionHeader(label: string, collapsed: boolean, width: number, dim = false): string {
	const t = theme();
	const tone = dim ? "dim" : "muted";
	const glyph = t.fg(tone, `${t.symbols.symbol(collapsed ? "nav.expand" : "nav.collapse")} `);
	const text = t.fg(tone, label);
	const fill = Math.max(0, width - visibleWidth(glyph) - visibleWidth(text) - 1);
	return `${glyph}${text}${fill > 0 ? t.fg("borderMuted", ` ${t.symbols.box.horizontal.repeat(fill)}`) : ""}`;
}

/** Transcript block: rule header (contiguous token), styled hints, body as-is. */
function styledTranscript(
	s: ViewerState,
	w: WorkerSnapshot,
	opts: TuiScreenOptions,
	width: number,
	rule = true,
): string[] {
	const t = theme();
	const lines: string[] = [];
	if (rule) {
		const head = t.style("muted", "── transcript ──");
		const fill = Math.max(0, width - visibleWidth(head));
		lines.push(head + (fill > 0 ? t.fg("borderMuted", t.symbols.box.horizontal.repeat(fill)) : ""));
	}
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

interface DetailParts {
	kv: string[];
	transcript: string[]; // includes the rule row first
}

/** Selected worker's detail split into kv + transcript parts for clipping. */
function detailParts(
	s: ViewerState,
	opts: TuiScreenOptions,
	width: number,
): DetailParts | undefined {
	const w = s.selectedId !== undefined ? s.workers.get(s.selectedId) : undefined;
	if (w === undefined) return undefined;
	return {
		kv: kvRows(inspectorItems(w), width),
		transcript: styledTranscript(s, w, opts, width),
	};
}

/** Empty/no-selection hint card (both columns stay visible — v1.2 invariant). */
function hintRows(s: ViewerState, width: number): string[] {
	const t = theme();
	const hint =
		s.workers.size === 0
			? "(no agents yet — delegate a task in OMP to see it here)"
			: "(no agent selected — j/k to select)";
	const inner = Math.max(10, Math.min(width - 4, 56));
	const body = [
		"",
		...wrap(t.style("muted", hint), inner - 4),
		t.style("dim", `session ${s.session ?? "?"} · r refresh · q quit`),
		"",
	];
	return boxRows(
		t,
		body,
		Math.min(width, inner + 4),
		`${t.fg("accent", t.symbols.symbol("icon.omp"))} ${t.style("muted", "omp lens")}`,
		"borderMuted",
	);
}

/** Natural-height detail (legacy/headless path). */
function detailLines(s: ViewerState, opts: TuiScreenOptions, width: number): string[] {
	const parts = detailParts(s, opts, width);
	if (parts === undefined)
		return wrap(
			theme().style(
				"dim",
				s.workers.size === 0
					? "(no agents yet — delegate a task in OMP to see it here)"
					: "(no agent selected — j/k to select)",
			),
			width,
		);
	return [...parts.kv, "", ...parts.transcript];
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

interface RosterSection {
	header: string;
	rows: string[];
}

/** Roster as sections (headers carry disclosure glyphs + rule fill at width). */
function rosterSections(s: ViewerState, width: number): RosterSection[] {
	const p = partition(s);
	const sections: RosterSection[] = [
		{
			header: sectionHeader(`workers (${p.live.length}):`, false, width),
			rows: p.live.flatMap((w) => agentRow(w, w.id === s.selectedId, width)),
		},
	];
	if (p.finished.length > 0) {
		sections.push(
			s.finishedCollapsed
				? {
						header: sectionHeader(
							`finished (${p.finished.length}) — press e to expand`,
							true,
							width,
						),
						rows: [],
					}
				: {
						header: sectionHeader(`finished (${p.finished.length}):`, false, width),
						rows: p.finished.flatMap((w) => agentRow(w, w.id === s.selectedId, width)),
					},
		);
	}
	if (p.history.length > 0) {
		sections.push({
			header: sectionHeader(`history (${p.history.length}):`, false, width, true),
			rows: p.history.flatMap((w) => agentRow(w, w.id === s.selectedId, width)),
		});
	}
	return sections;
}

/** Natural-height roster (legacy/headless path): plain contiguous headers. */
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

/** bgFill: re-open a background after any full reset inside the row. */
function bgFill(t: Theme, color: string, row: string): string {
	const sgr = `\x1b[48;2;${hexRgb(t.hex(color))}m`;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: re-open bg after SGR resets on purpose
	return `${sgr}${row.replace(/\x1b\[(?:0|49)m/g, (m) => `${m}${sgr}`)}\x1b[49m`;
}
function hexRgb(hex: string): string {
	const h = hex.replace("#", "");
	return `${Number.parseInt(h.slice(0, 2), 16)};${Number.parseInt(h.slice(2, 4), 16)};${Number.parseInt(h.slice(4, 6), 16)}`;
}

/** Header bar: π mark + contiguous session token + chip; right summary when wide. */
function headerBar(s: ViewerState, status: string, width: number, p: RosterPartition): string {
	const t = theme();
	const chipTone = status === "connected" ? "success" : status === "offline" ? "error" : "warning";
	const left =
		` ${t.fg("accent", t.symbols.symbol("icon.omp"))} ` +
		t.style("strong", "omp lens") +
		t.style("dim", ` — session ${s.session ?? "?"} `) +
		t.fg(chipTone, `[${status}]`) +
		(s.degraded ? t.fg("warning", " · degraded") : "");
	let right = "";
	if (width >= 76) {
		right = t.style(
			"dim",
			`${t.symbols.symbol("status.enabled")} ${p.live.length} live · ${t.symbols.symbol("status.done")} ${p.finished.length} done · ${p.history.length} hist `,
		);
	}
	const fill = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
	return bgFill(t, "statusLineBg", left + " ".repeat(fill) + right);
}

/** Footer bar: read-only + key hints left, position/size right. Always last row. */
function footerBar(
	s: ViewerState,
	width: number,
	height: number,
	selIdx: number,
	total: number,
): string {
	const t = theme();
	const thinking = s.thinkingVisible ? "on" : "off";
	const key = (k: string) => t.fg("accent", k);
	const dim = (x: string) => t.style("dim", x);
	const hints = [
		`${key("j/k")}${dim(" select")}`,
		`${key("e")}${dim(" finished")}`,
		`${key("t")}${dim(` thinking ${thinking}`)}`,
		`${key("r")}${dim(" refresh")}`,
		`${key("q")}${dim(" quit")}`,
	].join(dim(" · "));
	const left = ` ${dim("read-only")}${t.fg("borderMuted", " │ ")}${hints}`;
	let right = "";
	if (width >= 76)
		right = t.style(
			"dim",
			`${total === 0 ? "0/0" : `${selIdx + 1}/${total}`} · ${width}×${height} `,
		);
	const fill = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
	return bgFill(t, "statusLineBg", left + " ".repeat(fill) + right);
}

/** T-junction rule aligned with the body divider column. */
function teeRule(width: number, leftW: number, junction: "teeDown" | "teeUp"): string {
	const t = theme();
	const box = t.symbols.box;
	return t.fg(
		"borderMuted",
		box.horizontal.repeat(leftW + 1) +
			box[junction] +
			box.horizontal.repeat(Math.max(0, width - leftW - 2)),
	);
}

/** Clip the roster to bodyH keeping the selection visible; scrollbar when overflow. */
function clipRoster(sections: RosterSection[], bodyH: number, width: number): string[] {
	const t = theme();
	// breathable: blank row between non-empty sections when everything fits
	const withBreathers: string[] = [];
	const plain: string[] = [];
	for (let i = 0; i < sections.length; i += 1) {
		const sec = sections[i] as RosterSection;
		if (i > 0 && (sec.rows.length > 0 || sec.header !== "")) {
			withBreathers.push("");
		}
		withBreathers.push(sec.header, ...sec.rows);
		plain.push(sec.header, ...sec.rows);
	}
	// find selected row index in the plain list (marker ❯ at start after ANSI)
	const isSelected = (r: string) => {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strip SGR to test the marker column
		const stripped = r.replace(/\x1b\[[0-9;]*m/g, "");
		return stripped.startsWith(t.symbols.symbol("nav.cursor"));
	};
	const fit = withBreathers.length <= bodyH ? withBreathers : plain;
	if (fit.length <= bodyH) return fit;
	const idx = fit.findIndex(isSelected);
	const { start, end } = scrollWindow(fit.length, Math.max(0, idx), bodyH);
	const bar = scrollbar(t, fit.length, start, bodyH);
	const out: string[] = [];
	for (let i = start; i < end; i += 1) {
		const row = padTo(truncate(fit[i] ?? "", width - 1, ""), width - 1);
		out.push(`${row}${bar[i - start] ?? ""}`);
	}
	return out;
}

/** Clip detail to bodyH: kv pinned (≤45%), transcript tail-follows. */
function clipDetail(
	parts: DetailParts | undefined,
	s: ViewerState,
	bodyH: number,
	width: number,
): string[] {
	const t = theme();
	if (parts === undefined) {
		const card = hintRows(s, width);
		const top = Math.max(0, Math.floor((bodyH - card.length) / 2));
		const out = Array.from({ length: bodyH }, () => "");
		for (let i = 0; i < card.length && top + i < bodyH; i += 1) out[top + i] = card[i] as string;
		return out;
	}
	const maxKv = Math.min(parts.kv.length, Math.max(3, Math.floor(bodyH * 0.45)));
	const kv = parts.kv.slice(0, maxKv);
	const kvHidden = parts.kv.length - kv.length;
	if (kvHidden > 0) kv.push(t.style("dim", `… ${kvHidden} more`));
	const spacer = bodyH >= kv.length + 6 ? 1 : 0;
	const txH = Math.max(1, bodyH - kv.length - spacer - 1);
	const txBody = parts.transcript.slice(1); // rule row handled separately
	const rule = parts.transcript[0] ?? "";
	let tx: string[];
	if (txBody.length <= txH) {
		tx = txBody;
	} else {
		const hidden = txBody.length - (txH - 1);
		tx = [t.style("dim", `↑ ${hidden} earlier lines`), ...txBody.slice(txBody.length - (txH - 1))];
	}
	const out = [...kv, ...(spacer ? [""] : []), rule, ...tx];
	while (out.length < bodyH) out.push("");
	return out.slice(0, bodyH);
}

/** Fixed-height full-viewport frame (v1.5): footer is ALWAYS the last row. */
function framedScreen(
	s: ViewerState,
	opts: TuiScreenOptions,
	width: number,
	height: number,
): string {
	const t = theme();
	const p = partition(s);
	const status = opts.status ?? (s.live ? "connected" : "offline");
	const twoCol = width >= STACK_BELOW && s.scope?.workerId === undefined;
	const leftW = columnLeft(width);
	const rightW = Math.max(10, width - leftW - SEP_CELLS);
	const maxNotices = height >= 12 ? 3 : height >= 8 ? 1 : 0;
	const notices = s.notices.slice(-maxNotices).map((n) => {
		const tone = n.level === "error" ? "error" : n.level === "warn" ? "warning" : "muted";
		return truncate(t.fg(tone, `! ${n.level}: ${n.message}`), width, "");
	});
	const rules = height >= 7;
	const bodyH = Math.max(1, height - 2 - notices.length - (rules ? 2 : 0));
	const selIds = selectableIds(s);
	const selIdx = s.selectedId === undefined ? -1 : selIds.indexOf(s.selectedId);

	const header = headerBar(s, status, width, p);
	const footer = footerBar(s, width, height, selIdx, selIds.length);
	const topRule = rules
		? twoCol
			? teeRule(width, leftW, "teeDown")
			: t.fg("borderMuted", t.symbols.box.horizontal.repeat(width))
		: undefined;
	const bottomRule = rules
		? twoCol
			? teeRule(width, leftW, "teeUp")
			: t.fg("borderMuted", t.symbols.box.horizontal.repeat(width))
		: undefined;

	let body: string[];
	if (s.scope?.workerId !== undefined) {
		body = clipScoped(s, opts, width, bodyH);
	} else if (twoCol) {
		const left = clipRoster(rosterSections(s, leftW), bodyH, leftW);
		const right = clipDetail(detailParts(s, opts, rightW), s, bodyH, rightW);
		const sep = t.fg("borderMuted", SEP);
		body = [];
		for (let i = 0; i < bodyH; i += 1) {
			const l = padTo(left[i] ?? "", leftW);
			const r = truncate(right[i] ?? "", rightW, "");
			body.push(`${l} ${sep} ${r}`);
		}
	} else {
		// stacked: roster ~35%, full-width rule, detail the rest
		const rosterH = Math.min(bodyH - 2, Math.max(4, Math.floor(bodyH * 0.35)));
		const left = clipRoster(rosterSections(s, width), rosterH, width);
		const rule = t.fg("borderMuted", t.symbols.box.horizontal.repeat(width));
		const detailH = Math.max(1, bodyH - left.length - 1);
		const right = clipDetail(detailParts(s, opts, width), s, detailH, width);
		body = [...left, rule, ...right];
		while (body.length < bodyH) body.push("");
		body = body.slice(0, bodyH);
	}

	return [
		header,
		...(topRule !== undefined ? [topRule] : []),
		...notices,
		...body,
		...(bottomRule !== undefined ? [bottomRule] : []),
		footer,
	].join("\n");
}

/** Scoped mode inside the fixed frame. */
function clipScoped(
	s: ViewerState,
	opts: TuiScreenOptions,
	width: number,
	bodyH: number,
): string[] {
	const scopedId = s.scope?.workerId ?? "";
	const t = theme();
	const head = t.style("strong", `scope: worker ${scopedId}`);
	const w = s.workers.get(scopedId);
	if (w === undefined) {
		const out = [head, t.fg("warning", `worker ${scopedId}: not found`)];
		while (out.length < bodyH) out.push("");
		return out.slice(0, bodyH);
	}
	const parts: DetailParts = {
		kv: kvRows(inspectorItems(w), width),
		transcript: styledTranscript(s, w, opts, width),
	};
	const clipped = clipDetail(parts, s, Math.max(1, bodyH - 1), width);
	return [head, ...clipped].slice(0, bodyH);
}

/** Ids the selection cursor may rest on (mirrors render.selectableWorkerIds). */
function selectableIds(s: ViewerState): string[] {
	const scopedId = s.scope?.workerId;
	if (scopedId !== undefined) return s.workers.has(scopedId) ? [scopedId] : [];
	const p = partition(s);
	const ids = p.live.map((w) => w.id);
	if (!s.finishedCollapsed) ids.push(...p.finished.map((w) => w.id));
	ids.push(...p.history.map((w) => w.id));
	return ids;
}

/**
 * Full TUI screen. With `height`: fixed frame, footer locked to the last row.
 * Without: natural-height layout (legacy/headless).
 */
export function renderTuiScreen(s: ViewerState, opts: TuiScreenOptions = {}): string {
	const width = Math.max(20, opts.width ?? 80);
	if (opts.height !== undefined && opts.height >= 5) {
		return framedScreen(s, opts, width, opts.height);
	}
	const status = opts.status ?? (s.live ? "connected" : "offline");
	const t = theme();
	const header =
		t.style("strong", "omp lens") +
		t.style("dim", ` — session ${s.session ?? "?"} `) +
		t.fg(
			status === "connected" ? "success" : status === "offline" ? "error" : "warning",
			`[${status}]`,
		) +
		(s.degraded ? t.fg("warning", " · degraded") : "");
	const noticeLines = s.notices.slice(-3).map((n) => {
		const tone = n.level === "error" ? "error" : n.level === "warn" ? "warning" : "muted";
		return t.fg(tone, `! ${n.level}: ${n.message}`);
	});
	const thinking = s.thinkingVisible ? "on" : "off";
	const key = (k: string) => t.fg("accent", k);
	const dim = (x: string) => t.style("dim", x);
	const foot = [
		dim("read-only"),
		`${key("j/k")}${dim(" select")}`,
		`${key("e")}${dim(" finished")}`,
		`${key("t")}${dim(` thinking ${thinking}`)}`,
		`${key("r")}${dim(" refresh")}`,
		`${key("q")}${dim(" quit")}`,
	].join(dim(" · "));

	if (s.scope?.workerId !== undefined) {
		return [header, ...noticeLines, ...scopedTui(s, opts, width), foot].join("\n");
	}

	const left = rosterLines(s, width >= STACK_BELOW ? columnLeft(width) : width);
	const right = detailLines(
		s,
		opts,
		width >= STACK_BELOW ? Math.max(10, width - columnLeft(width) - SEP_CELLS) : width,
	);

	if (width < STACK_BELOW) {
		return [header, ...noticeLines, ...left, "", ...right, foot].join("\n");
	}

	const leftW = columnLeft(width);
	const sep = t.fg("borderMuted", SEP);
	const body: string[] = [];
	const rows = Math.max(left.length, right.length);
	for (let i = 0; i < rows; i += 1) {
		const l = padTo(left[i] ?? "", leftW);
		const r = truncate(right[i] ?? "", Math.max(10, width - leftW - SEP_CELLS), "");
		body.push(`${l} ${sep} ${r}`);
	}
	return [header, ...noticeLines, ...body, foot].join("\n");
}

/** Asymmetric 44/56 split (consult §7): roster capped at 58 on ultra-wide panes. */
function columnLeft(width: number): number {
	return Math.max(20, Math.min(58, Math.floor((width - SEP_CELLS) * 0.44)));
}
