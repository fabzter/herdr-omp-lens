/**
 * Herdr adapter (P1-R5): additive, no-focus socket calls over an injectable
 * transport. Every call routes through assertAllowedRequest (guards.ts) before
 * touching the transport; focus:false is hardcoded on create/split.
 * Results are validated at the boundary (Zod) and mapped snake_case → camelCase.
 *
 * Each function takes an optional trailing `t?: HerdrTransport` (default
 * socketTransport(c.socketPath)) so unit tests inject a mock (ledger ruling).
 */

import { z } from "zod";
import type { CallerContext } from "./context";
import { assertAllowedRequest } from "./guards";
import { HerdrApiError, type HerdrTransport, socketTransport } from "./transport";
import type { PaneInfo, PaneMetadata, SessionSnapshot, TabInfo } from "./types";

/**
 * The single boundary every adapter call routes through: guard first, then
 * transport. Exported so tests can prove the guard runs before the transport.
 */
export async function guardedRequest(
	t: HerdrTransport,
	method: string,
	params: unknown,
): Promise<unknown> {
	assertAllowedRequest(method, params);
	return t.request(method, params);
}
const wirePaneInfo = z
	.object({
		pane_id: z.string(),
		tab_id: z.string(),
		workspace_id: z.string(),
		title: z
			.string()
			.nullish()
			.transform((v) => v ?? undefined),
		agent: z
			.string()
			.nullish()
			.transform((v) => v ?? undefined),
	})
	.transform((w): PaneInfo => {
		const pane: PaneInfo = { paneId: w.pane_id, tabId: w.tab_id, workspaceId: w.workspace_id };
		if (w.title !== undefined) pane.title = w.title;
		if (w.agent !== undefined) pane.agent = w.agent;
		return pane;
	});

/**
 * Tabs carry `label` even when pane `title` is null (Herdr 0.9.5), so the
 * overview survivor is matched on this — never on pane.title. Extra wire
 * keys (agent_status, focused, number, pane_count, …) are stripped.
 */
const wireTabInfo = z
	.object({
		tab_id: z.string(),
		workspace_id: z.string(),
		label: z
			.string()
			.nullish()
			.transform((v) => v ?? undefined),
	})
	.transform((w): TabInfo => {
		const tab: TabInfo = { tabId: w.tab_id, workspaceId: w.workspace_id };
		if (w.label !== undefined) tab.label = w.label;
		return tab;
	});

const tabCreatedResult = z.object({
	type: z.literal("tab_created"),
	tab: z.object({ tab_id: z.string() }),
	root_pane: z.object({ pane_id: z.string() }),
});
const paneInfoResult = z.object({
	type: z.literal("pane_info"),
	pane: wirePaneInfo,
});

const sessionSnapshotResult = z.object({
	type: z.literal("session_snapshot"),
	snapshot: z.object({
		workspaces: z.array(z.unknown()),
		tabs: z.array(wireTabInfo),
		panes: z.array(wirePaneInfo),
	}),
});

function parseResult<S extends z.ZodType>(schema: S, method: string, result: unknown): z.output<S> {
	const parsed = schema.safeParse(result);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("; ");
		throw new Error(`herdr ${method}: unexpected response shape: ${detail}`);
	}
	return parsed.data;
}

/** Create a labelled tab in the caller's workspace. Never takes focus. */
export async function createOverviewTab(
	c: CallerContext,
	label: string,
	env?: Record<string, string>,
	t: HerdrTransport = socketTransport(c.socketPath),
): Promise<{ tabId: string; rootPaneId: string }> {
	const params: Record<string, unknown> = { workspace_id: c.workspaceId, label, focus: false };
	if (env !== undefined) params.env = env;
	const result = parseResult(
		tabCreatedResult,
		"tab.create",
		await guardedRequest(t, "tab.create", params),
	);
	return { tabId: result.tab.tab_id, rootPaneId: result.root_pane.pane_id };
}

/** Split targetPaneId into a new no-focus pane. env applies to the new process. */
export async function splitPane(
	c: CallerContext,
	targetPaneId: string,
	dir: "right" | "down",
	env?: Record<string, string>,
	t: HerdrTransport = socketTransport(c.socketPath),
): Promise<{ paneId: string }> {
	const params: Record<string, unknown> = {
		target_pane_id: targetPaneId,
		direction: dir,
		focus: false,
	};
	if (env !== undefined) params.env = env;
	const result = parseResult(
		paneInfoResult,
		"pane.split",
		await guardedRequest(t, "pane.split", params),
	);
	return { paneId: result.pane.paneId };
}

/**
 * Queue a shell command into a pane (pane.send_input {pane_id,text,keys:["enter"]},
 * the raw form of `herdr pane run`). The ack means input-queue admission only
 * (V-HDR-6); it is not proof the command executed.
 */
export async function runInPane(
	c: CallerContext,
	paneId: string,
	command: string,
	t: HerdrTransport = socketTransport(c.socketPath),
): Promise<void> {
	await guardedRequest(t, "pane.send_input", {
		pane_id: paneId,
		text: command,
		keys: ["enter"],
	});
}

/** Authoritative pane read; null when the pane is gone (V-HDR-4). */
export async function getPane(
	c: CallerContext,
	paneId: string,
	t: HerdrTransport = socketTransport(c.socketPath),
): Promise<PaneInfo | null> {
	let result: unknown;
	try {
		result = await guardedRequest(t, "pane.get", { pane_id: paneId });
	} catch (error) {
		if (
			error instanceof HerdrApiError &&
			(error.code === "pane_not_found" || error.code === "not_found")
		) {
			return null;
		}
		throw error;
	}
	return parseResult(paneInfoResult, "pane.get", result).pane;
}

/** Authoritative session bootstrap/reconcile read (V-HDR-4). */
export async function snapshot(
	c: CallerContext,
	t: HerdrTransport = socketTransport(c.socketPath),
): Promise<SessionSnapshot> {
	const result = parseResult(
		sessionSnapshotResult,
		"session.snapshot",
		await guardedRequest(t, "session.snapshot", {}),
	);
	return {
		workspaces: result.snapshot.workspaces,
		tabs: result.snapshot.tabs,
		panes: result.snapshot.panes,
	};
}

/** pane.report_metadata — display-only, requires source (V-HDR-7). */
export async function reportMetadata(
	c: CallerContext,
	paneId: string,
	meta: PaneMetadata,
	t: HerdrTransport = socketTransport(c.socketPath),
): Promise<void> {
	const params: Record<string, unknown> = { pane_id: paneId, source: meta.source };
	if (meta.title !== undefined) params.title = meta.title;
	if (meta.displayAgent !== undefined) params.display_agent = meta.displayAgent;
	if (meta.stateLabels !== undefined) params.state_labels = meta.stateLabels;
	if (meta.tokens !== undefined) params.tokens = meta.tokens;
	if (meta.seq !== undefined) params.seq = meta.seq;
	if (meta.ttlMs !== undefined) params.ttl_ms = meta.ttlMs;
	await guardedRequest(t, "pane.report_metadata", params);
}
