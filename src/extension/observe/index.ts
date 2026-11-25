/**
 * Observation activation wiring (P2-4).
 *
 * Consumed by the extension gate: in Herdr it subscribes the three
 * `task:subagent:*` bus channels plus the `before_subagent_spawn` hook,
 * Zod-parses every frame at the boundary (P2-1), reduces it into the
 * direct-only roster (P2-2), and starts the per-session bridge publisher
 * (P2-3). Outside Herdr the gate never calls this.
 *
 * FR-12 / F-15: every handler is synchronous — parse + reduce only — and
 * never awaits I/O, so an OMP turn is never blocked. Malformed frames are
 * dropped at the parse boundary (NFR-02 fail-soft; the artifact-scan
 * fallback is P5 scope).
 *
 * P2-R9 late-attach: NOT implemented — workers already running before
 * activation missed `before_subagent_spawn`, never enter the direct-id
 * set, and are excluded from the roster. Documented limitation.
 */
import type { CallerContext } from "../../herdr/context";
import type { LensExtensionApi } from "../api";
import { type BridgeHandle, type BridgeOptions, startBridge } from "../bridge";
import { Roster } from "../roster";
import {
	parseSubagentEvent,
	parseSubagentLifecycle,
	parseSubagentProgress,
	parseSubagentSpawn,
} from "./schemas";

/** Live observation session returned by `startObservation`. */
export interface Observation {
	readonly roster: Roster;
	readonly bridge: BridgeHandle;
	/** Detach every subscription and close the bridge; idempotent. */
	stop(): Promise<void>;
}

/** Test seam: bridge factory + options the gate can override. */
export interface ObservationDeps {
	readonly startBridge?: (roster: Roster, opts: BridgeOptions) => Promise<BridgeHandle>;
	/** Session cwd forwarded to the bridge (default socket-dir naming). */
	readonly cwd?: string;
}

export type StartObservation = (
	pi: LensExtensionApi,
	ctx: CallerContext,
	deps?: ObservationDeps,
) => Promise<Observation>;

/**
 * Activate observation. The `ctx` parameter is reserved for P4/P5
 * (topology identity, history source); today's bridge needs only `cwd`.
 */
export const startObservation: StartObservation = async (pi, _ctx, deps = {}) => {
	const roster = new Roster();
	let stopped = false;

	// Handlers: parse at the boundary, reduce synchronously, return. The
	// `stopped` flag makes stop() deterministic even when the host exposes
	// no unsubscribe surface (bus off()/return-value are undocumented).
	const onSpawn = (payload: unknown): void => {
		if (stopped) return;
		const parsed = parseSubagentSpawn(payload);
		if (parsed.ok) roster.applySpawn(parsed.value);
	};
	const onLifecycle = (payload: unknown): void => {
		if (stopped) return;
		const parsed = parseSubagentLifecycle(payload);
		if (parsed.ok) roster.applyLifecycle(parsed.value);
	};
	const onProgress = (payload: unknown): void => {
		if (stopped) return;
		const parsed = parseSubagentProgress(payload);
		if (parsed.ok) roster.applyProgress(parsed.value);
	};
	const onEvent = (payload: unknown): void => {
		if (stopped) return;
		const parsed = parseSubagentEvent(payload);
		if (parsed.ok) roster.applyEvent(parsed.value);
	};

	const bus = pi.events;
	bus?.on("task:subagent:event", onEvent);
	bus?.on("task:subagent:progress", onProgress);
	bus?.on("task:subagent:lifecycle", onLifecycle);
	pi.on("before_subagent_spawn", onSpawn);

	const detach = (): void => {
		stopped = true;
		bus?.off?.("task:subagent:event", onEvent);
		bus?.off?.("task:subagent:progress", onProgress);
		bus?.off?.("task:subagent:lifecycle", onLifecycle);
		pi.off?.("before_subagent_spawn", onSpawn);
	};

	let bridge: BridgeHandle;
	try {
		bridge = await (deps.startBridge ?? startBridge)(roster, {
			history: () => [], // P5 stub seam — no restart history yet
			cwd: deps.cwd ?? process.cwd(),
		});
	} catch (err) {
		detach();
		throw err;
	}

	let stoppedOnce = false;
	return {
		roster,
		bridge,
		async stop() {
			if (stoppedOnce) return;
			stoppedOnce = true;
			detach();
			await bridge.close();
		},
	};
};
