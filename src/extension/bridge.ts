/**
 * Per-session unix-socket NDJSON bridge publisher (P2-3 / P2-R6).
 *
 * - Local unix socket ONLY (NFR-01): a per-session `bridge.sock` inside a
 *   `0700` directory unique per OMP process (`$TMPDIR/herdr-omp-lens-…`), the
 *   socket file itself `0600`, unlinked on `close()`/SIGINT/SIGTERM/process
 *   exit (RC-14). `opts.socketPath` overrides the location; its parent
 *   directory is still enforced to `0700`.
 * - Handshake boundary (RC-12 / FR-11): the first complete line from a client
 *   must validate via `decodeClientMessage` (`{v:1, role:"viewer", session}`);
 *   `control.*` fields, wrong role/version/session, and malformed JSON all
 *   fail → the client is closed without a `hello`.
 * - On accept: `hello{v:1, session (echoed), workers: roster.snapshot(),
 *   history: opts.history?.() ?? []}` then deltas.
 * - Deltas: roster `onChange` → `worker.upsert` coalesced within
 *   `coalesceMs` (default 150 ms, NFR-03) latest-wins per worker;
 *   `worker.finished` → terminal `worker.upsert` (flushing the pending one),
 *   then `transcript.ref{id, sessionFile, artifactDir}` the first time a
 *   `sessionFile` is seen for a worker, then `worker.removed{id}`.
 * - Fire-and-forget + bounded (FR-12): broadcasts never await; per-client
 *   unflushed bytes are capped (`maxClientBufferedBytes`) and a consumer that
 *   exceeds the cap is dropped with a `notice` — never allowed to stall a
 *   roster callback.
 */
import { chmodSync, existsSync, mkdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Socket } from "bun";
import { decodeClientMessage, encodeMessage } from "../protocol/codec";
import type { ClientMessage, Message, WorkerSnapshot } from "../protocol/types";
import type { Roster } from "./roster";

export interface BridgeHandle {
	/** The BRIDGE socket — the value P4 exports as LENS_SOCKET_PATH (RC-4/F-01). */
	readonly socketPath: string;
	/** Fire-and-forget: encodes and queues the message to every authed client. */
	broadcast(m: Message): void;
	/**
	 * Live authed-client count (P4-3): the topology manager's post-launch
	 * health probe (SDD §8.3) waits for a NEW viewer on the bridge rather than
	 * trusting `pane.get` alone. Counts completed handshakes only.
	 */
	viewerCount(): number;
	/** Stop listening, drop clients, unlink the socket, remove signal handlers. */
	close(): Promise<void>;
}

export interface BridgeOptions {
	/** Explicit socket location; the parent directory is enforced to 0700. */
	socketPath?: string;
	/** P5 seam (RC-3): invoked per viewer connect to fill `hello.history`. */
	history?: () => WorkerSnapshot[];
	/** Session cwd; only used to make the default socket dir name readable. */
	cwd?: string;
	/** Progress coalescing window in ms (NFR-03). Default 150. */
	coalesceMs?: number;
	/** Per-client unflushed-byte ceiling before the client is dropped. Default 1 MiB. */
	maxClientBufferedBytes?: number;
}

const DEFAULT_COALESCE_MS = 150;
const DEFAULT_MAX_BUFFERED = 1024 * 1024;
const HANDSHAKE_BUFFER_LIMIT = 64 * 1024;

interface ClientState {
	decoder: StringDecoder;
	buffer: string;
	authed: boolean;
	/** Bytes accepted by socket.write but not yet confirmed flushed (drain). */
	pendingBytes: number;
	dead: boolean;
}

/** Accepted peer; `socket.data` carries the per-connection ClientState. */
type BridgeSocket = Socket<ClientState>;

let instanceCounter = 0;

function defaultSocketDir(cwd: string | undefined): string {
	const slug = (cwd ?? "")
		.split("/")
		.filter((s) => s !== "")
		.pop()
		?.replace(/[^a-zA-Z0-9._-]/g, "")
		.slice(0, 16);
	const tag = `${process.pid}-${instanceCounter++}-${Math.random().toString(36).slice(2, 8)}`;
	return join(
		tmpdir(),
		`herdr-omp-lens-${slug !== undefined && slug !== "" ? `${slug}-` : ""}${tag}`,
	);
}

export async function startBridge(roster: Roster, opts: BridgeOptions = {}): Promise<BridgeHandle> {
	const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
	const maxBuffered = opts.maxClientBufferedBytes ?? DEFAULT_MAX_BUFFERED;

	// --- socket location: unique dir, 0700, socket 0600 ----------------------
	const socketPath = opts.socketPath ?? join(defaultSocketDir(opts.cwd), "bridge.sock");
	const dir = dirname(socketPath);
	const dirPreExisted = existsSync(dir);
	mkdirSync(dir, { recursive: true });
	if (dirPreExisted) {
		// Caller-owned dir: never chmod it; require it already be owner-only.
		if ((statSync(dir).mode & 0o777) !== 0o700) {
			throw new Error(
				`bridge socket dir must be mode 0700 (found 0${(statSync(dir).mode & 0o777).toString(8)}): ${dir}`,
			);
		}
	} else {
		chmodSync(dir, 0o700);
	}

	const clients = new Set<BridgeSocket>();
	const pendingUpserts = new Map<string, WorkerSnapshot>();
	const transcriptRefsSent = new Set<string>();
	let coalesceTimer: NodeJS.Timeout | null = null;
	let closed = false;
	let signalRaised = false;

	function cleanupFs(): void {
		try {
			unlinkSync(socketPath);
		} catch {
			// already gone
		}
		if (opts.socketPath === undefined || !dirPreExisted) {
			try {
				rmdirSync(dir);
			} catch {
				// non-empty or already gone — best effort
			}
		}
	}

	/** Registered per bridge; must re-raise so the default exit still happens. */
	function onSignal(sig: "SIGINT" | "SIGTERM"): () => void {
		return () => {
			if (signalRaised) return;
			signalRaised = true;
			cleanupFs();
			process.removeListener("SIGINT", signalHandlers.SIGINT);
			process.removeListener("SIGTERM", signalHandlers.SIGTERM);
			process.removeListener("exit", onExit);
			// Re-raise only when no other listener remains: with a host or
			// second-bridge handler present, termination is theirs to decide —
			// 'exit' above already ran our cleanup.
			if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
		};
	}
	function onExit(): void {
		cleanupFs();
	}
	const signalHandlers: Record<"SIGINT" | "SIGTERM", () => void> = {
		SIGINT: onSignal("SIGINT"),
		SIGTERM: onSignal("SIGTERM"),
	};

	// --- outbound ------------------------------------------------------------

	function dropClient(socket: BridgeSocket, state: ClientState): void {
		if (state.dead) return;
		state.dead = true;
		clients.delete(socket);
		try {
			socket.write(
				encodeMessage({
					v: 1,
					type: "notice",
					level: "warn",
					message: "slow consumer: dropping bridge client",
				}),
			);
		} catch {
			// socket already unhealthy
		}
		// terminate(), not end(): end() waits to flush already-backpressured
		// bytes and can hang on a stalled peer.
		try {
			socket.terminate();
		} catch {
			// already gone
		}
	}

	// Bun's socket.write accepts into its internal buffer once the peer's
	// kernel socket buffer is full and then returns a SHORT count; every
	// unflushed byte stays pending until the drain event confirms the flush.
	function writeLine(socket: BridgeSocket, state: ClientState, m: Message): void {
		if (state.dead || closed) return;
		const line = encodeMessage(m);
		let written: number;
		try {
			written = socket.write(line);
		} catch {
			dropClient(socket, state);
			return;
		}
		state.pendingBytes += Buffer.byteLength(line) - Math.max(0, written);
		if (state.pendingBytes > maxBuffered) dropClient(socket, state);
	}

	function sendHello(
		socket: BridgeSocket,
		state: ClientState,
		session: ClientMessage["session"],
	): void {
		let history: WorkerSnapshot[] = [];
		try {
			history = opts.history?.() ?? [];
		} catch {
			// fail-soft: a throwing history source degrades to an empty history
		}
		writeLine(socket, state, {
			v: 1,
			type: "hello",
			session,
			workers: roster.snapshot(),
			history,
		});
	}

	function broadcast(m: Message): void {
		if (closed) return;
		for (const socket of clients) {
			const state = socket.data;
			if (!state.authed) continue;
			writeLine(socket, state, m);
		}
	}

	function broadcastUpsert(w: WorkerSnapshot): void {
		broadcast({ v: 1, type: "worker.upsert", worker: w });
	}

	function flushUpserts(): void {
		if (coalesceTimer !== null) {
			clearTimeout(coalesceTimer);
			coalesceTimer = null;
		}
		const batch = [...pendingUpserts.values()];
		pendingUpserts.clear();
		for (const w of batch) broadcastUpsert(w);
	}

	/** Broadcast any pending upsert for this worker immediately (ordering). */
	function flushWorker(id: string): void {
		const pending = pendingUpserts.get(id);
		if (pending === undefined) return;
		pendingUpserts.delete(id);
		if (pendingUpserts.size === 0 && coalesceTimer !== null) {
			clearTimeout(coalesceTimer);
			coalesceTimer = null;
		}
		broadcastUpsert(pending);
	}

	/** Emit transcript.ref the first time a sessionFile is seen (RC-5/P2-R6). */
	function maybeTranscriptRef(w: WorkerSnapshot): void {
		const sessionFile = w.sessionFile;
		if (sessionFile === undefined || sessionFile === "") return;
		if (transcriptRefsSent.has(w.id)) return;
		transcriptRefsSent.add(w.id);
		flushWorker(w.id); // viewer sees the worker's latest state before the ref
		broadcast({
			v: 1,
			type: "transcript.ref",
			id: w.id,
			sessionFile,
			artifactDir: dirname(sessionFile),
		});
	}

	// --- roster wiring ---------------------------------------------------------
	roster.onChange((w) => {
		if (closed) return;
		pendingUpserts.set(w.id, w);
		if (coalesceTimer === null) {
			coalesceTimer = setTimeout(flushUpserts, coalesceMs);
		}
		maybeTranscriptRef(w);
	});
	roster.onSignal((s) => {
		if (closed) return;
		if (s.type === "worker.finished") {
			flushWorker(s.id); // final state goes out before the removal, if pending
			maybeTranscriptRef(s.worker);
			broadcast({ v: 1, type: "worker.removed", id: s.id });
		}
		// "worker.spawned": the paired onChange already queued the upsert.
		// "roster.empty": no wire message; viewers see the individual removals.
	});

	// --- listener ---------------------------------------------------------------

	const listener = Bun.listen<ClientState>({
		unix: socketPath,
		socket: {
			open(socket: BridgeSocket) {
				const state: ClientState = {
					decoder: new StringDecoder("utf8"),
					buffer: "",
					authed: false,
					pendingBytes: 0,
					dead: false,
				};
				socket.data = state;
				clients.add(socket);
			},
			data(socket: BridgeSocket, data: Buffer) {
				const state = socket.data;
				// v1 is observation-only: post-handshake input is discarded, not
				// buffered (a chatty viewer must never grow host memory).
				if (state.authed || state.dead || closed) return;
				state.buffer += state.decoder.write(data);
				let nl = state.buffer.indexOf("\n");
				while (nl >= 0 && !state.authed && !state.dead) {
					const line = state.buffer.slice(0, nl);
					state.buffer = state.buffer.slice(nl + 1);
					const decoded = decodeClientMessage(line);
					if (!decoded.ok) {
						state.dead = true;
						try {
							socket.close();
						} catch {
							// already closing
						}
						return;
					}
					state.authed = true;
					sendHello(socket, state, decoded.message.session);
					nl = state.buffer.indexOf("\n");
				}
				if (state.buffer.length > HANDSHAKE_BUFFER_LIMIT) {
					dropClient(socket, state);
				}
			},
			close(socket: BridgeSocket, _error: unknown) {
				socket.data.dead = true;
				clients.delete(socket);
			},
			drain(socket: BridgeSocket) {
				socket.data.pendingBytes = 0;
			},
			error(socket: BridgeSocket, _error: unknown) {
				socket.data.dead = true;
				clients.delete(socket);
				try {
					socket.close();
				} catch {
					// already gone
				}
			},
			connectError(_socket: BridgeSocket, _error: unknown) {
				// server-side: a failed accept; nothing to clean up
			},
		},
	});
	chmodSync(socketPath, 0o600);

	const onSigint = signalHandlers.SIGINT;
	const onSigterm = signalHandlers.SIGTERM;
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);
	process.on("exit", onExit);

	const handle: BridgeHandle = {
		socketPath,
		viewerCount: () => {
			let count = 0;
			for (const socket of clients) {
				const state = socket.data;
				if (state.authed && !state.dead) count++;
			}
			return count;
		},
		broadcast,
		close: async () => {
			if (closed) return;
			closed = true;
			if (coalesceTimer !== null) {
				clearTimeout(coalesceTimer);
				coalesceTimer = null;
			}
			pendingUpserts.clear();
			process.removeListener("SIGINT", onSigint);
			process.removeListener("SIGTERM", onSigterm);
			process.removeListener("exit", onExit);
			listener.stop(true);
			for (const socket of clients) {
				try {
					socket.close();
				} catch {
					// already gone
				}
			}
			clients.clear();
			cleanupFs();
			await Promise.resolve();
		},
	};
	return Promise.resolve(handle);
}
