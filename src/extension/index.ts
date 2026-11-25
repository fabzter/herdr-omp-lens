import { callerContext } from "../herdr/context";
import type { LensExtensionApi } from "./api";
import {
	type Observation,
	type ObservationDeps,
	type StartObservation,
	startObservation,
} from "./observe";

/**
 * OMP extension entry (bound via package.json `omp.extensions`).
 *
 * Herdr activation gate (FR-01): outside a Herdr pane this is a complete
 * no-op — no commands registered, no hooks or bus channels subscribed.
 * Inside Herdr it registers the read-only `/lens` placeholder (full command
 * behavior is P4) and activates observation (P2-4): bus subscriptions,
 * roster reducer, bridge publisher. Activation runs fire-and-forget off
 * the gate's synchronous signature — bus/frame handlers never await I/O
 * on the hot path, so an OMP turn is never blocked (FR-12 / F-15).
 */
export interface LensExtensionDeps extends ObservationDeps {
	/** Test seam: observation starter (default: the P2-4 wiring). */
	readonly startObservation?: StartObservation;
	/** Sink for activation failures; defaults to a bounded stderr report. */
	readonly onObservationError?: (err: unknown) => void;
}

const defaultObservationErrorSink = (err: unknown): void => {
	try {
		console.error(`herdr-omp-lens: observation failed to start: ${String(err)}`);
	} catch {
		// A broken console must never break OMP activation.
	}
};

/** The active observation session, or null until activation resolves (P4 seam). */
let active: Observation | null = null;

export function activeObservation(): Observation | null {
	return active;
}

export default function lensExtension(pi: LensExtensionApi, deps?: LensExtensionDeps): void {
	const ctx = callerContext();
	if (ctx === null) return;

	pi.registerCommand("lens", {
		description: "herdr-omp-lens overview (placeholder — implemented in P4)",
		handler: () => {
			// Read-only placeholder: intentionally does nothing until P4.
		},
	});
}
