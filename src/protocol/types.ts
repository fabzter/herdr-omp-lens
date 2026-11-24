/**
 * Versioned NDJSON bridge protocol — canonical types.
 * Verbatim from docs/plans/specs/phase-01-foundation-spec.md ("Interfaces produced").
 * Field names align with observed Phase 0 `task:subagent:*` payloads.
 */

export const PROTOCOL_VERSION = 1;

export type WorkerStatus =
	| "queued"
	| "running"
	| "idle"
	| "parked"
	| "completed"
	| "failed"
	| "aborted";

export interface WorkerSnapshot {
	id: string;
	name?: string;
	agent: string;
	status: WorkerStatus;
	model?: string;
	activity?: string;
	sessionFile?: string;
	counters?: {
		tokens?: number;
		cost?: number;
		requests?: number;
		toolCount?: number;
		durationMs?: number;
	};
	/** F-06: lineage + model-role inspector fields (FR-07 / P3-R3), mapped by P2 from the bus. */
	parentToolCallId?: string;
	index?: number;
	modelRole?: string;
	thinkingLevel?: string;
	assignment?: string;
	/** P5: true for persisted / not-live entries (additive; PROTOCOL_VERSION stays 1). */
	historical?: boolean;
	/** Epoch milliseconds when this snapshot was produced. */
	updatedAt: number;
}

/** Server -> client messages. */
export type Message =
	| {
			v: 1;
			type: "hello";
			session: string;
			workers: WorkerSnapshot[];
			history?: WorkerSnapshot[];
	  }
	| { v: 1; type: "worker.upsert"; worker: WorkerSnapshot }
	| { v: 1; type: "worker.removed"; id: string }
	| {
			v: 1;
			type: "transcript.ref";
			id: string;
			sessionFile: string;
			artifactDir?: string;
	  }
	| {
			v: 1;
			type: "topology";
			tabId?: string;
			paneIds: string[];
			state: "open" | "closed";
	  }
	| {
			v: 1;
			type: "notice";
			level: "info" | "warn" | "error";
			message: string;
	  };

export type DecodeResult = { ok: true; message: Message } | { ok: false; error: string };

/** F-07: client -> server handshake; the same boundary also rejects control.* (P1-R4 / FR-11). */
export type ClientMessage = { v: 1; role: "viewer"; session: string };

export type ClientDecodeResult =
	| { ok: true; message: ClientMessage }
	| { ok: false; error: string };
