import { describe, expect, test } from "bun:test";
import {
	createOverviewTab,
	getPane,
	guardedRequest,
	reportMetadata,
	runInPane,
	snapshot,
	splitPane,
} from "../../src/herdr/adapter";
import type { CallerContext } from "../../src/herdr/context";
import { HerdrApiError, type HerdrTransport } from "../../src/herdr/transport";

const C: CallerContext = {
	workspaceId: "w1",
	tabId: "w1:t1",
	paneId: "w1:p1",
	binPath: "/bin/herdr",
	socketPath: "/sock",
};

interface RecordedCall {
	method: string;
	params: unknown;
}

/** Mock transport: records every (method, params); serves canned results. */
function mockTransport(results: Record<string, unknown> = {}) {
	const calls: RecordedCall[] = [];
	const transport: HerdrTransport = {
		request: (method: string, params: unknown) => {
			calls.push({ method, params });
			const result = results[method];
			if (result instanceof Error) return Promise.reject(result);
			return Promise.resolve(result);
		},
	};
	return { calls, transport };
}

function wirePane(paneId: string, tabId = "w1:t1", extra: Record<string, unknown> = {}) {
	return { pane_id: paneId, tab_id: tabId, workspace_id: "w1", ...extra };
}

describe("guardedRequest (adapter guard routing)", () => {
	test("forbidden method throws and transport.request is never called", async () => {
		const { calls, transport } = mockTransport();
		await expect(guardedRequest(transport, "agent.start", {})).rejects.toThrow(/forbidden/i);
		expect(calls).toHaveLength(0);
	});

	test("layout.apply with tab_id throws and transport.request is never called", async () => {
		const { calls, transport } = mockTransport();
		await expect(guardedRequest(transport, "layout.apply", { tab_id: "w1:t1" })).rejects.toThrow(
			/forbidden/i,
		);
		expect(calls).toHaveLength(0);
	});

	test("allowed method reaches transport.request", async () => {
		const { calls, transport } = mockTransport({ "pane.get": { type: "ok" } });
		const result = await guardedRequest(transport, "pane.get", { pane_id: "w1:p1" });
		expect(calls).toEqual([{ method: "pane.get", params: { pane_id: "w1:p1" } }]);
		expect(result).toEqual({ type: "ok" });
	});
});

describe("createOverviewTab", () => {
	test("sends tab.create with workspace_id, label, focus:false and env passthrough", async () => {
		const { calls, transport } = mockTransport({
			"tab.create": {
				type: "tab_created",
				tab: { tab_id: "w1:t2", workspace_id: "w1" },
				root_pane: wirePane("w1:p9", "w1:t2"),
			},
		});
		const env = { LENS_SOCKET_PATH: "/bridge.sock", LENS_SESSION: "sess-1" };
		const result = await createOverviewTab(C, "OMP subagents", env, transport);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("tab.create");
		expect(calls[0]?.params).toEqual({
			workspace_id: "w1",
			label: "OMP subagents",
			focus: false,
			env,
		});
		expect(result).toEqual({ tabId: "w1:t2", rootPaneId: "w1:p9" });
	});

	test("omits env when not provided", async () => {
		const { calls, transport } = mockTransport({
			"tab.create": {
				type: "tab_created",
				tab: { tab_id: "w1:t3" },
				root_pane: wirePane("w1:p10", "w1:t3"),
			},
		});
		await createOverviewTab(C, "x", undefined, transport);
		const params = calls[0]?.params as Record<string, unknown>;
		expect("env" in params).toBe(false);
	});

	test("rejects on malformed result", async () => {
		const { transport } = mockTransport({ "tab.create": { type: "tab_created", tab: {} } });
		await expect(createOverviewTab(C, "x", undefined, transport)).rejects.toThrow();
	});
});

describe("splitPane", () => {
	test("sends pane.split with target_pane_id, direction, focus:false, env passthrough", async () => {
		const { calls, transport } = mockTransport({
			"pane.split": { type: "pane_info", pane: wirePane("w1:p2") },
		});
		const env = { LENS_WORKER_ID: "w-7" };
		const result = await splitPane(C, "w1:p1", "right", env, transport);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("pane.split");
		expect(calls[0]?.params).toEqual({
			target_pane_id: "w1:p1",
			direction: "right",
			focus: false,
			env,
		});
		expect(result).toEqual({ paneId: "w1:p2" });
	});

	test("down direction passes through", async () => {
		const { calls, transport } = mockTransport({
			"pane.split": { type: "pane_info", pane: wirePane("w1:p3") },
		});
		await splitPane(C, "w1:p1", "down", undefined, transport);
		expect(calls[0]?.params).toMatchObject({ direction: "down", focus: false });
	});
});

describe("runInPane", () => {
	test("sends pane.send_input with text and Enter key (CLI pane run equivalent)", async () => {
		const { calls, transport } = mockTransport({ "pane.send_input": { type: "ok" } });
		await runInPane(C, "w1:p2", "omp render <id>", transport);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("pane.send_input");
		expect(calls[0]?.params).toEqual({
			pane_id: "w1:p2",
			text: "omp render <id>",
			keys: ["enter"],
		});
	});
});

describe("getPane", () => {
	test("maps pane_info result to PaneInfo (snake→camel)", async () => {
		const { calls, transport } = mockTransport({
			"pane.get": {
				type: "pane_info",
				pane: wirePane("w1:p2", "w1:t2", { title: "viewer", agent: "pi" }),
			},
		});
		const pane = await getPane(C, "w1:p2", transport);

		expect(calls[0]?.method).toBe("pane.get");
		expect(calls[0]?.params).toEqual({ pane_id: "w1:p2" });
		expect(pane).toEqual({
			paneId: "w1:p2",
			tabId: "w1:t2",
			workspaceId: "w1",
			title: "viewer",
			agent: "pi",
		});
	});

	test("returns null on pane_not_found HerdrApiError", async () => {
		const { transport } = mockTransport({
			"pane.get": new HerdrApiError("pane_not_found", "pane not found"),
		});
		await expect(getPane(C, "w1:gone", transport)).resolves.toBeNull();
	});

	test("propagates non-not-found errors", async () => {
		const { transport } = mockTransport({
			"pane.get": new HerdrApiError("server_unavailable", "boom"),
		});
		await expect(getPane(C, "w1:p1", transport)).rejects.toThrow("boom");
	});
});

describe("snapshot", () => {
	test("maps session.snapshot result; panes+tabs validated, workspaces passthrough", async () => {
		const workspaces = [{ workspace_id: "w1", label: "daily" }];
		// Wire shape per the 0.9.5 probe: snake_case, extra keys (focused,
		// pane_count, …) are stripped; label survives even though pane.title
		// is null on this version.
		const tabs = [
			{
				tab_id: "w1:t1",
				workspace_id: "w1",
				label: "OMP subagents",
				focused: false,
				pane_count: 1,
				number: 2,
				agent_status: "idle",
			},
			{ tab_id: "w1:t2", workspace_id: "w1" },
		];
		const { calls, transport } = mockTransport({
			"session.snapshot": {
				type: "session_snapshot",
				snapshot: {
					version: "0.9.5",
					protocol: 22,
					workspaces,
					tabs,
					panes: [wirePane("w1:p1"), wirePane("w1:p2", "w1:t2", { title: "v" })],
					layouts: [],
					agents: [],
				},
			},
		});
		const snap = await snapshot(C, transport);

		expect(calls[0]?.method).toBe("session.snapshot");
		expect(snap.workspaces).toEqual(workspaces);
		expect(snap.tabs).toEqual([
			{ tabId: "w1:t1", workspaceId: "w1", label: "OMP subagents" },
			{ tabId: "w1:t2", workspaceId: "w1" },
		]);
		expect(snap.panes).toEqual([
			{ paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
			{ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", title: "v" },
		]);
	});
});

describe("reportMetadata", () => {
	test("sends pane.report_metadata with required source and snake_case fields", async () => {
		const { calls, transport } = mockTransport({ "pane.report_metadata": { type: "ok" } });
		await reportMetadata(
			C,
			"w1:p2",
			{
				source: "lens:v1",
				title: "OMP subagents",
				displayAgent: "lens",
				stateLabels: { working: "rendering" },
				tokens: { summary: "4 workers" },
				seq: 2,
				ttlMs: 60_000,
			},
			transport,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("pane.report_metadata");
		expect(calls[0]?.params).toEqual({
			pane_id: "w1:p2",
			source: "lens:v1",
			title: "OMP subagents",
			display_agent: "lens",
			state_labels: { working: "rendering" },
			tokens: { summary: "4 workers" },
			seq: 2,
			ttl_ms: 60_000,
		});
	});

	test("omits absent optional fields", async () => {
		const { calls, transport } = mockTransport({ "pane.report_metadata": { type: "ok" } });
		await reportMetadata(C, "w1:p2", { source: "lens:v1" }, transport);
		expect(calls[0]?.params).toEqual({ pane_id: "w1:p2", source: "lens:v1" });
	});
});
