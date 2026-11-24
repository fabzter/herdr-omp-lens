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
