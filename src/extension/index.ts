import { isHerdrEnv } from "../herdr/context";
import type { LensExtensionApi } from "./api";

/**
 * OMP extension entry (bound via package.json `omp.extensions`).
 *
 * Herdr activation gate (FR-01): outside a Herdr pane this is a complete
 * no-op — no commands registered, no hooks or bus channels subscribed.
 * Inside Herdr it registers the read-only `/lens` placeholder; full command
 * behavior is P4. Handlers are fire-and-forget and never await I/O on the
 * hot path, so an OMP turn is never blocked (FR-12 / F-15).
 */
export default function lensExtension(pi: LensExtensionApi): void {
	if (!isHerdrEnv()) return;

	pi.registerCommand("lens", {
		description: "herdr-omp-lens overview (placeholder — implemented in P4)",
		handler: () => {
			// Read-only placeholder: intentionally does nothing until P4.
		},
	});
}
