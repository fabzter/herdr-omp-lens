import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { HerdrApiError, socketTransport } from "../../src/herdr/transport";

/**
 * Wire-level test server: NDJSON over a unix socket, one request per line,
 * mirroring the observed Herdr protocol ({id,method,params} → {id,result|error}).
 */

interface CapturedRequest {
	id: string;
	method: string;
	params: unknown;
}

interface Server {
	socketPath: string;
	captured: CapturedRequest[];
	stop(): void;
}

function startServer(
	handler: (req: CapturedRequest) => Record<string, unknown> | null,
	options: { splitMultibyte?: boolean } = {},
): Server {
	const captured: CapturedRequest[] = [];
	const dir = mkdtempSync(join(tmpdir(), "herdr-lens-test-"));
	const socketPath = join(dir, "herdr.sock");
	const listener = Bun.listen<undefined>({
		unix: socketPath,
		socket: {
			data(socket: Socket, data: Buffer) {
				const lines = data
					.toString("utf8")
					.split("\n")
					.filter((l) => l.trim() !== "");
				for (const line of lines) {
					let req: CapturedRequest | null = null;
					try {
						req = JSON.parse(line) as CapturedRequest;
					} catch {
						socket.write(
							`${JSON.stringify({ id: "", error: { code: "invalid_request", message: "bad json" } })}\n`,
						);
						continue;
					}
					if (!req || typeof req.id !== "string") continue;
					captured.push(req);
					const response = handler(req);
					if (response === null) {
						// simulate a stalled server: never respond
						continue;
					}
					if (options.splitMultibyte) {
						// split inside the FIRST multi-byte UTF-8 sequence so the two
						// halves arrive in separate data events
						const bytes = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
						const firstMultibyte = bytes.findIndex((b) => b >= 0x80);
						if (firstMultibyte >= 0) {
							socket.write(bytes.subarray(0, firstMultibyte + 1));
							setTimeout(() => {
								try {
									socket.write(bytes.subarray(firstMultibyte + 1));
								} catch {
									// client already closed; test is done
								}
							}, 25);
							continue;
						}
					}
					socket.write(`${JSON.stringify(response)}\n`);
				}
			},
			close() {},
			error(_socket: Socket, _error: unknown) {},
		},
	});
	return {
		socketPath,
		captured,
		stop: () => {
			listener.stop(true);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

let server: Server | null = null;
afterEach(() => {
	server?.stop();
	server = null;
});

describe("socketTransport request/response", () => {
	test("sends {id,method,params} line and resolves with result", async () => {
		server = startServer((req) => ({
			id: req.id,
			result: { type: "pong", version: "0.9.5", protocol: 22 },
		}));
		const t = socketTransport(server.socketPath);
		const result = await t.request("ping", {});
		expect(result).toEqual({ type: "pong", version: "0.9.5", protocol: 22 });
		expect(server.captured).toHaveLength(1);
		const req = server.captured[0];
		expect(req?.method).toBe("ping");
		expect(req?.params).toEqual({});
		expect(typeof req?.id).toBe("string");
		expect(req?.id.length).toBeGreaterThan(0);
	});

	test("error response rejects with HerdrApiError carrying code", async () => {
		server = startServer((req) => ({
			id: req.id,
			error: { code: "pane_not_found", message: "pane not found" },
		}));
		const t = socketTransport(server.socketPath);
		try {
			await t.request("pane.get", { pane_id: "w1:p9" });
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(HerdrApiError);
			expect((error as HerdrApiError).code).toBe("pane_not_found");
			expect((error as HerdrApiError).message).toContain("pane not found");
		}
	});

	test("per-request lines get independent responses", async () => {
		server = startServer((req) => ({
			id: req.id,
			result: { type: "ok", echo: req.method },
		}));
		const t = socketTransport(server.socketPath);
		expect(await t.request("a", {})).toEqual({ type: "ok", echo: "a" });
		expect(await t.request("b", {})).toEqual({ type: "ok", echo: "b" });
		expect(server.captured).toHaveLength(2);
	});

	test("decodes a multi-byte UTF-8 char split across two socket chunks", async () => {
		const title = "señal órbita 🚀";
		server = startServer(
			(req) => ({ id: req.id, result: { type: "pane_info", pane: { title } } }),
			{ splitMultibyte: true },
		);
		const t = socketTransport(server.socketPath);
		const result = (await t.request("pane.get", { pane_id: "w1:p1" })) as Record<string, unknown>;
		const pane = result.pane as Record<string, unknown>;
		expect(pane.title).toBe(title);
		expect(pane.title).not.toContain("�");
	});

	test("request timeout rejects when server never responds", async () => {
		server = startServer(() => null); // stalled
		const t = socketTransport(server.socketPath, { requestMs: 50 });
		await expect(t.request("ping", {})).rejects.toThrow(/timeout/i);
	});

	test("connect failure rejects (missing socket file)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "herdr-lens-test-"));
		const t = socketTransport(join(dir, "nonexistent.sock"), { connectMs: 500 });
		await expect(t.request("ping", {})).rejects.toThrow();
		rmSync(dir, { recursive: true, force: true });
	});
});
