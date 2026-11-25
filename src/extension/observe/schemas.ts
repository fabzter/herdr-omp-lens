/**
 * Zod intake schemas for the native subagent bus (P2-1).
 *
 * Shapes match the OBSERVED payloads in `probes/out/frames.jsonl`
 * (docs/analysis/phase-0-probe-report.md). Validation happens at the boundary:
 * parse helpers wrap `safeParse`, return a typed result, and NEVER throw, so a
 * malformed frame degrades to `{ ok: false, error }` instead of breaking the
 * OMP turn loop (P2-R8, FR-12).
 *
 * Unknown/extra keys are stripped by default so additive upstream fields do not
 * trip shape-drift detection; missing required fields do.
 */
import { z } from "zod";

/** Typed result of a boundary parse; the failure branch carries the ZodError. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: z.ZodError };

function parseWith<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
	const result = schema.safeParse(input);
	if (result.success) {
		return { ok: true, value: result.data };
	}
	return { ok: false, error: result.error };
}

/**
 * `before_subagent_spawn` hook payload (F-03/RC-10): `spawnKey` is the worker
 * id and the parent hook fires only for direct spawns. It carries NO
 * `parentToolCallId`.
 */
export const subagentSpawnSchema = z.object({
	type: z.literal("before_subagent_spawn"),
	agent: z.string(),
	invocationKind: z.string().optional(),
	modelRole: z.string().optional(),
	patterns: z.array(z.string()).optional(),
	spawnKey: z.string(),
});
export type SubagentSpawn = z.infer<typeof subagentSpawnSchema>;

export function parseSubagentSpawn(input: unknown): ParseResult<SubagentSpawn> {
	return parseWith(subagentSpawnSchema, input);
}

/** `task:subagent:lifecycle` frame — identity + status + persisted JSONL path. */
export const subagentLifecycleSchema = z.object({
	id: z.string(),
	agent: z.string(),
	parentToolCallId: z.string().optional(),
	detached: z.boolean().optional(),
	agentSource: z.string().optional(),
	status: z.string(),
	sessionFile: z.string().optional(),
	index: z.number().optional(),
});
export type SubagentLifecycle = z.infer<typeof subagentLifecycleSchema>;

export function parseSubagentLifecycle(input: unknown): ParseResult<SubagentLifecycle> {
	return parseWith(subagentLifecycleSchema, input);
}

const recentToolSchema = z.object({
	tool: z.string(),
	isError: z.boolean().optional(),
	endMs: z.number().optional(),
});

/**
 * `task:subagent:progress` is an ENVELOPE (RC-9/F-02): roster counters live in
 * the nested `.progress` object, NOT at top level. `sessionFile` was observed
 * at the envelope level on the terminal frame and is preserved as optional.
 */
export const subagentProgressSchema = z.object({
	index: z.number().optional(),
	agent: z.string().optional(),
	agentSource: z.string().optional(),
	parentToolCallId: z.string().optional(),
	detached: z.boolean().optional(),
	assignment: z.string().optional(),
	sessionFile: z.string().optional(),
	progress: z.object({
		id: z.string(),
		status: z.string(),
		recentTools: z.array(recentToolSchema).optional(),
		recentOutput: z.array(z.string()).optional(),
		toolCount: z.number().optional(),
		requests: z.number().optional(),
		tokens: z.number().optional(),
		cost: z.number().optional(),
		durationMs: z.number().optional(),
		modelOverride: z.array(z.string()).optional(),
		modelRole: z.string().optional(),
		contextWindow: z.number().optional(),
		resolvedModelIdentity: z.string().optional(),
		resolvedThinkingLevel: z.string().optional(),
	}),
});
export type SubagentProgress = z.infer<typeof subagentProgressSchema>;

export function parseSubagentProgress(input: unknown): ParseResult<SubagentProgress> {
	return parseWith(subagentProgressSchema, input);
}

/**
 * `task:subagent:event` frame — `{id, event}` where `event` is the full session
 * event union (agent_start, message_update, tool_execution_end, …). Only
 * `event.type` is contracted; the union's extra keys pass through via
 * looseObject.
 */
export const subagentEventSchema = z.object({
	id: z.string(),
	event: z.looseObject({
		type: z.string(),
	}),
});
export type SubagentEvent = z.infer<typeof subagentEventSchema>;

export function parseSubagentEvent(input: unknown): ParseResult<SubagentEvent> {
	return parseWith(subagentEventSchema, input);
}
