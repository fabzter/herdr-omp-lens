/**
 * Herdr JSON socket transport (V-HDR-1..4): newline-delimited JSON over Herdr's
 * own unix socket ($HERDR_SOCKET_PATH — NOT the lens bridge socket, F-01).
 * Wire shape: {"id","method","params"}\n → {"id","result":{...}} or
 * {"id","error":{"code","message"}}. One request per connection; the server
 * closes after responding (events.subscribe is the sole streaming exception —
 * Task 5 handles that on its own connection).
 *
 * Per-call timeouts (F-15): 2s connect / 5s request. No network beyond the
 * local socket.
 */

import { StringDecoder } from "node:string_decoder";
import type { Socket } from "bun";

export interface HerdrTransport {
	request(method: string, params: unknown): Promise<unknown>;
}

export interface SocketTransportOptions {
	/** Max time to establish the connection, ms (default 2000). */
	connectMs?: number;
	/** Max time to wait for the response line, ms (default 5000). */
	requestMs?: number;
}

/** Error body returned by the Herdr server: {"error":{"code","message"}}. */
export class HerdrApiError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "HerdrApiError";
		this.code = code;
	}
}

let nextRequestId = 0;

/**
 * JSON-over-unix-socket transport. `request` opens a fresh connection, sends
 * one request line, resolves with the response `result`, and rejects with
 * HerdrApiError on a server error or Error on transport failure/timeout.
 */
export function socketTransport(
	socketPath: string,
	options: SocketTransportOptions = {},
): HerdrTransport {
	const connectMs = options.connectMs ?? 2000;
	const requestMs = options.requestMs ?? 5000;
	return {
		request: (method: string, params: unknown) =>
			socketRequest(socketPath, method, params, connectMs, requestMs),
	};
}

function socketRequest(
	socketPath: string,
	method: string,
	params: unknown,
	connectMs: number,
	requestMs: number,
): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const id = `lens-${Date.now().toString(36)}-${nextRequestId++}`;
	const decoder = new StringDecoder("utf8");
	let socket: Socket | undefined;
	let buffer = "";
	let settled = false;
	let connectTimer: NodeJS.Timeout | undefined;
	let requestTimer: NodeJS.Timeout | undefined;

	function finish(error: Error | null, result?: unknown): void {
		if (settled) return;
		settled = true;
		clearTimeout(connectTimer);
		clearTimeout(requestTimer);
		const s = socket;
		socket = undefined;
		if (s !== undefined) {
			try {
				s.close();
			} catch {
				// best-effort cleanup; the promise is already settled
			}
		}
		if (error === null) {
			resolve(result);
		} else {
			reject(error);
		}
	}

	function handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return; // not JSON — not our response
		}
		if (message === null || typeof message !== "object") return;
		const record = message as Record<string, unknown>;
		if (record.id !== id) return; // echo/foreign frame — ignore
		const error = record.error;
		if (error !== null && typeof error === "object") {
			const body = error as Record<string, unknown>;
			finish(
				new HerdrApiError(
					typeof body.code === "string" ? body.code : "unknown_error",
					typeof body.message === "string" ? body.message : "herdr request failed",
				),
			);
			return;
		}
		if ("result" in record) {
			finish(null, record.result);
		}
	}

	function handleChunk(chunk: string): void {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0 && !settled) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			handleLine(line.trim());
			newline = buffer.indexOf("\n");
		}
	}

	const pending = Bun.connect({
		unix: socketPath,
		socket: {
			data(_socket: Socket, data: Buffer) {
				// StringDecoder keeps an incomplete multi-byte char buffered across
				// chunks; Buffer.toString would corrupt it into U+FFFD.
				handleChunk(decoder.write(data));
			},
			close(_socket: Socket, _error: unknown) {
				if (settled) return;
				// flush any trailing partial bytes, then a final-chance response
				// line missing its trailing newline
				handleChunk(decoder.end());
				if (buffer.trim() !== "") handleLine(buffer);
				if (!settled) {
					finish(new Error(`herdr socket closed before response (${method})`));
				}
			},
			connectError(_socket: Socket, error: unknown) {
				finish(new Error(`herdr socket connect failed (${socketPath}): ${String(error)}`));
			},
			drain() {},
			error(_socket: Socket, error: unknown) {
				finish(new Error(`herdr socket error (${method}): ${String(error)}`));
			},
			timeout(_socket: Socket) {
				finish(new Error(`herdr socket idle timeout (${method})`));
			},
		},
	});

	connectTimer = setTimeout(() => {
		finish(new Error(`herdr socket connect timeout after ${connectMs}ms (${socketPath})`));
		void pending.then((s) => s.close()).catch(() => {});
	}, connectMs);

	pending.then(
		(s) => {
			if (settled) {
				s.close();
				return;
			}
			socket = s;
			clearTimeout(connectTimer);
			requestTimer = setTimeout(() => {
				finish(new Error(`herdr request timeout after ${requestMs}ms (${method})`));
			}, requestMs);
			s.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
		},
		(error: unknown) => {
			finish(new Error(`herdr socket connect failed (${socketPath}): ${String(error)}`));
		},
	);

	return promise;
}

/**
 * Held-open event stream (events.subscribe — the one streaming exception to
 * one-request-per-connection). Every parsed NDJSON line reaches onFrame as a
 * decoded JSON value; onClosed fires exactly once when the connection ends,
 * whichever side closed it. `close()` also emits onClosed — local teardown is
 * still "the stream ended" — but never twice. There is deliberately no
 * request/idle timeout: the stream is long-lived by design; the only bound is
 * connectMs. Callers bound any waits they impose on pushed frames
 * (e.g. lifecycle's subscription_started wait after events_lost).
 */
export interface EventStreamHandlers {
	onFrame(frame: unknown): void;
	onClosed(): void;
}

export interface EventStream {
	readonly socketPath: string;
	close(): void;
}

export type EventStreamOpener = (
	socketPath: string,
	method: string,
	params: unknown,
	handlers: EventStreamHandlers,
) => Promise<EventStream>;

/** Real-socket EventStreamOpener bound to Herdr's socket (default seam). */
export function socketEventStream(
	socketPath: string,
	options: SocketTransportOptions = {},
): EventStreamOpener {
	const connectMs = options.connectMs ?? 2000;
	return (_path, method, params, handlers) =>
		openEventStream(socketPath, method, params, handlers, connectMs);
}

function openEventStream(
	socketPath: string,
	method: string,
	params: unknown,
	handlers: EventStreamHandlers,
	connectMs: number,
): Promise<EventStream> {
	const { promise, resolve, reject } = Promise.withResolvers<EventStream>();
	const id = `lens-${Date.now().toString(36)}-${nextRequestId++}`;
	const decoder = new StringDecoder("utf8");
	let socket: Socket | undefined;
	let buffer = "";
	let settled = false; // openEventStream promise resolved or rejected
	let closed = false; // stream ended; handlers.onClosed delivered exactly once

	function notifyClosed(): void {
		closed = true;
		handlers.onClosed();
	}

	function finishOpen(error: Error | null, stream?: EventStream): void {
		if (settled) return;
		settled = true;
		clearTimeout(connectTimer);
		if (error === null && stream !== undefined) {
			resolve(stream);
		} else {
			reject(error ?? new Error(`herdr event stream failed (${method})`));
		}
	}

	function handleLine(line: string): void {
		if (closed) return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return; // not JSON — not a protocol frame
		}
		if (message === null || typeof message !== "object") return;
		handlers.onFrame(message);
	}

	function handleChunk(chunk: string): void {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0 && !closed) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const trimmed = line.trim();
			if (trimmed !== "") handleLine(trimmed);
			newline = buffer.indexOf("\n");
		}
	}

	const stream: EventStream = {
		socketPath,
		close() {
			if (closed) return;
			const s = socket;
			socket = undefined;
			if (s !== undefined) {
				try {
					s.close();
				} catch {
					// best-effort; the stream is dead either way
				}
			}
			notifyClosed();
		},
	};

	const pending = Bun.connect({
		unix: socketPath,
		socket: {
			data(_socket: Socket, data: Buffer) {
				// StringDecoder keeps an incomplete multi-byte char buffered across
				// chunks; Buffer.toString would corrupt it into U+FFFD.
				handleChunk(decoder.write(data));
			},
			close(_socket: Socket, _error: unknown) {
				if (closed) return;
				// flush partial bytes and a last line missing its trailing newline
				handleChunk(decoder.end());
				if (buffer.trim() !== "") handleLine(buffer);
				socket = undefined;
				if (!settled) {
					finishOpen(new Error(`herdr event stream closed before open (${method})`));
				}
				notifyClosed();
			},
			connectError(_socket: Socket, error: unknown) {
				if (closed) return;
				finishOpen(new Error(`herdr socket connect failed (${socketPath}): ${String(error)}`));
				notifyClosed();
			},
			drain() {},
			error(_socket: Socket, error: unknown) {
				if (closed) return;
				if (!settled) {
					finishOpen(new Error(`herdr event stream error (${method}): ${String(error)}`));
				}
				notifyClosed();
			},
			timeout() {
				// an idle long-lived stream is normal; if the runtime tears the
				// socket down afterwards the close handler reports it
			},
		},
	});

	const connectTimer = setTimeout(() => {
		finishOpen(new Error(`herdr socket connect timeout after ${connectMs}ms (${socketPath})`));
		void pending.then((s) => s.close()).catch(() => {});
	}, connectMs);

	pending.then(
		(s) => {
			if (closed || settled) {
				s.close();
				return;
			}
			socket = s;
			clearTimeout(connectTimer);
			s.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
			finishOpen(null, stream);
		},
		(error: unknown) => {
			finishOpen(new Error(`herdr socket connect failed (${socketPath}): ${String(error)}`));
		},
	);

	return promise;
}
