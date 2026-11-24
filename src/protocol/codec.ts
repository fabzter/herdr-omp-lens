/**
 * Versioned NDJSON bridge codec.
 * encodeMessage: JSON.stringify(m) + "\n".
 * decodeMessage / decodeClientMessage: parse + Zod safeParse, map failures to
 * { ok: false, error }; they NEVER throw (NFR-02). The client schema is strict:
 * any extra key (e.g. a "type": "control.*" field) fails validation (FR-11).
 */

import { z } from "zod";
import {
	type ClientDecodeResult,
	type ClientMessage,
	type DecodeResult,
	type Message,
	PROTOCOL_VERSION,
	type WorkerSnapshot,
	type WorkerStatus,
} from "./types";

const v = z.literal(PROTOCOL_VERSION);

const workerStatusSchema: z.ZodType<WorkerStatus> = z.enum([
	"queued",
	"running",
	"idle",
	"parked",
	"completed",
	"failed",
	"aborted",
]);

const workerSnapshotSchema: z.ZodType<WorkerSnapshot> = z.object({
	id: z.string(),
	name: z.string().optional(),
	agent: z.string(),
	status: workerStatusSchema,
	model: z.string().optional(),
	activity: z.string().optional(),
	sessionFile: z.string().optional(),
	counters: z
		.object({
			tokens: z.number().optional(),
			cost: z.number().optional(),
			requests: z.number().optional(),
			toolCount: z.number().optional(),
			durationMs: z.number().optional(),
		})
		.optional(),
	parentToolCallId: z.string().optional(),
	index: z.number().optional(),
	modelRole: z.string().optional(),
	thinkingLevel: z.string().optional(),
	assignment: z.string().optional(),
	historical: z.boolean().optional(),
	updatedAt: z.number(),
});

const messageSchema: z.ZodType<Message> = z.discriminatedUnion("type", [
	z.object({
		v,
		type: z.literal("hello"),
		session: z.string(),
		workers: z.array(workerSnapshotSchema),
		history: z.array(workerSnapshotSchema).optional(),
	}),
	z.object({
		v,
		type: z.literal("worker.upsert"),
		worker: workerSnapshotSchema,
	}),
	z.object({
		v,
		type: z.literal("worker.removed"),
		id: z.string(),
	}),
	z.object({
		v,
		type: z.literal("transcript.ref"),
		id: z.string(),
		sessionFile: z.string(),
		artifactDir: z.string().optional(),
	}),
	z.object({
		v,
		type: z.literal("topology"),
		tabId: z.string().optional(),
		paneIds: z.array(z.string()),
		state: z.enum(["open", "closed"]),
	}),
	z.object({
		v,
		type: z.literal("notice"),
		level: z.enum(["info", "warn", "error"]),
		message: z.string(),
	}),
]);

/** Strict: extra keys (control.* fields, type, anything) are rejected. */
const clientMessageSchema: z.ZodType<ClientMessage> = z.strictObject({
	v,
	role: z.literal("viewer"),
	session: z.string(),
});

function parseJson(line: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(line) };
	} catch (e) {
		return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
	}
}

function zodErrorString(error: z.ZodError): string {
	return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

export function encodeMessage(m: Message): string {
	return `${JSON.stringify(m)}\n`;
}

export function decodeMessage(line: string): DecodeResult {
	const parsed = parseJson(line);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const result = messageSchema.safeParse(parsed.value);
	if (!result.success) return { ok: false, error: zodErrorString(result.error) };
	return { ok: true, message: result.data };
}

export function decodeClientMessage(line: string): ClientDecodeResult {
	const parsed = parseJson(line);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const result = clientMessageSchema.safeParse(parsed.value);
	if (!result.success) return { ok: false, error: zodErrorString(result.error) };
	return { ok: true, message: result.data };
}
