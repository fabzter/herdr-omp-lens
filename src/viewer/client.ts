/**
 * Bridge viewer client (P3-R1 / P3-R7 / P3-R10).
 *
 * `connectBridge` opens the bridge unix socket, sends the single outbound
 * frame the protocol allows — `ClientMessage{v:1, role:"viewer", session}` —
 * then applies `hello` + deltas through the pure `applyMessage` reducer.
 * The returned promise resolves once the first `hello` is applied (or fails
 * soft on close/connectError): an awaited client always holds the
 * authoritative snapshot, so no delta can ever be applied before it.
 * NDJSON lines are decoded through `decodeMessage`, so malformed/wrong-`v`
 * frames degrade to a warn notice and never throw (NFR-02).
 *
 * On disconnect the client retries a bounded number of times; every successful
 * connect re-handshakes and the fresh `hello` authoritatively resyncs state
 * (P3-R10). The client is strictly read-only: nothing but the handshake is
 * ever written — no `control.*`, no post-handshake input (P3-R7).
 */
import { StringDecoder } from "node:string_decoder";
import type { Socket } from "bun";
import { decodeMessage } from "../protocol/codec";
import { PROTOCOL_VERSION } from "../protocol/types";
import { applyInternal, applyMessage, initialViewerState, type ViewerState } from "./state";

export type BridgeStatus = "connected" | "reconnecting" | "closed";

export interface ConnectBridgeOptions {
	/** Bridge socket path (LENS_SOCKET_PATH / BridgeHandle.socketPath). */
	socketPath: string;
	/** OMP session id sent in the handshake (LENS_SESSION). */
	session: string;
	/** Max consecutive reconnect attempts after a disconnect. Default 5. */
	maxReconnectAttempts?: number;
	/** Delay between reconnect attempts in ms. Default 250. */
	reconnectDelayMs?: number;
	/** Seed state (e.g. worker scope); defaults to initialViewerState(). */
	state?: ViewerState;
}

export interface BridgeClient {
	/** Latest reduced state; replaced, never mutated. */
	readonly state: ViewerState;
	status(): BridgeStatus;
	/** cb runs after every state change; exceptions are swallowed (FR-12). */
	subscribe(cb: (s: ViewerState) => void): void;
	onStatus(cb: (s: BridgeStatus) => void): void;
	/** Idempotent: closes the socket and suppresses reconnects. */
	close(): Promise<void>;
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 250;
/** A single NDJSON frame past this size is abusive; drop the pending bytes. */
const MAX_LINE_BUFFER_BYTES = 4 * 1024 * 1024;

function handshakeLine(session: string): string {
	return `${JSON.stringify({ v: PROTOCOL_VERSION, role: "viewer", session })}\n`;
}

export function connectBridge(opts: ConnectBridgeOptions): Promise<BridgeClient> {
	const maxAttempts = opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
	const delayMs = opts.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

	let state: ViewerState = opts.state ?? initialViewerState();
	let status: BridgeStatus = "reconnecting";
	let userClosed = false;
	let attempts = 0;
	let retryTimer: Timer | null = null;
	let socket: Socket | null = null;

	const subscribers = new Set<(s: ViewerState) => void>();
	const statusSubscribers = new Set<(s: BridgeStatus) => void>();

	function setState(next: ViewerState): void {
		if (next === state) return;
		state = next;
		for (const cb of subscribers) {
			try {
				cb(state);
			} catch {
				// a bad consumer must never break the stream (FR-12)
			}
		}
	}

	function setStatus(next: BridgeStatus): void {
		if (next === status) return;
		status = next;
		for (const cb of statusSubscribers) {
			try {
				cb(status);
			} catch {
				// swallowed (FR-12)
			}
		}
	}

	function notice(level: "info" | "warn" | "error", message: string): void {
		setState(applyMessage(state, { v: 1, type: "notice", level, message }));
	}

	const ready = Promise.withResolvers<void>();
	let readySettled = false;
	function settleReady(): void {
		if (!readySettled) {
			readySettled = true;
			ready.resolve();
		}
	}

	function scheduleReconnect(): void {
		if (userClosed || retryTimer !== null) return;
		if (attempts >= maxAttempts) {
			notice("error", `bridge unreachable after ${attempts} reconnect attempt(s)`);
			setStatus("closed");
			return;
		}
		attempts += 1;
		setStatus("reconnecting");
		retryTimer = setTimeout(() => {
			retryTimer = null;
			void open();
		}, delayMs);
	}

	async function open(): Promise<void> {
		if (userClosed) return;
		// Per-connection line decoding: StringDecoder.end() on close() makes a
		// shared decoder unusable for the next connect (P3-R10 resync).
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		try {
			socket = await Bun.connect({
				unix: opts.socketPath,
				socket: {
					open(s: Socket) {
						if (userClosed) {
							s.close();
							return;
						}
						attempts = 0;
						setStatus("connected");
						// The only outbound frame the viewer ever sends (P3-R7).
						s.write(handshakeLine(opts.session));
					},
					data(_s: Socket, data: Buffer) {
						buffer += decoder.write(data);
						if (buffer.length > MAX_LINE_BUFFER_BYTES) {
							buffer = "";
							notice("warn", "oversized bridge frame; dropped buffered bytes");
							return;
						}
						let nl = buffer.indexOf("\n");
						while (nl >= 0) {
							const line = buffer.slice(0, nl);
							buffer = buffer.slice(nl + 1);
							nl = buffer.indexOf("\n");
							if (line.trim() === "") continue;
							const decoded = decodeMessage(line);
							if (decoded.ok) {
								setState(applyMessage(state, decoded.message));
								if (decoded.message.type === "hello") settleReady();
							} else {
								notice("warn", `dropped malformed bridge frame: ${decoded.error}`);
							}
						}
					},
					close(_s: Socket) {
						if (userClosed) return;
						decoder.end();
						setState(applyInternal(state, { type: "disconnected" }));
						notice("warn", "disconnected from bridge; resyncing");
						settleReady(); // fail-soft: never wedge the caller awaiting hello
						scheduleReconnect();
					},
					error(_s: Socket, _e: unknown) {
						// close() follows and drives the reconnect path
					},
					connectError(_s: Socket, _e: unknown) {
						settleReady();
						scheduleReconnect();
					},
				},
			});
		} catch {
			// Bun.connect rejection (e.g. missing socket file): same bounded path.
			settleReady();
			scheduleReconnect();
		}
	}

	void open();

	const client: BridgeClient = {
		get state() {
			return state;
		},
		status() {
			return status;
		},
		subscribe(cb) {
			subscribers.add(cb);
		},
		onStatus(cb) {
			statusSubscribers.add(cb);
		},
		close: async () => {
			if (userClosed) return;
			userClosed = true;
			if (retryTimer !== null) {
				clearTimeout(retryTimer);
				retryTimer = null;
			}
			try {
				socket?.close();
			} catch {
				// already gone
			}
			socket = null;
			setState(applyInternal(state, { type: "disconnected" }));
			setStatus("closed");
			settleReady();
			await Promise.resolve();
		},
	};

	// Resolves on the first applied hello, or fail-soft on close/connectError.
	return ready.promise.then(() => client);
}
