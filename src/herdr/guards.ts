/**
 * Runtime transport guard (P1-R5 / P6-R3 layer B). The single boundary every
 * adapter call routes through, so dynamically constructed calls cannot evade
 * the static source scan. Tamper-tested: deleting an entry from DENIED_METHODS
 * fails tests/herdr/guards.test.ts.
 */

/**
 * Methods the lens must never send, for any params:
 * - agent.start / pane.report_agent: semantic lifecycle takeover — the viewer is
 *   an ordinary pane, reported via pane.report_metadata only (V-HDR-6/7).
 * - agent.view.set: atomically replaces the user's Agents view, no restore API
 *   (V-HDR-7).
 * - *.focus methods: focus theft — the adapter is no-focus only.
 */
export const DENIED_METHODS: readonly string[] = Object.freeze([
	"agent.focus",
	"agent.start",
	"agent.view.set",
	"pane.focus",
	"pane.report_agent",
	"tab.focus",
	"workspace.focus",
]);

/** Thrown by assertAllowedRequest for a forbidden method or params. */
export class HerdrForbiddenError extends Error {
	readonly method: string;

	constructor(method: string, message: string) {
		super(message);
		this.name = "HerdrForbiddenError";
		this.method = method;
	}
}

/**
 * Throws HerdrForbiddenError when the request is forbidden:
 * - method in DENIED_METHODS (any params);
 * - layout.apply carrying tab_id (replaces then closes the live tab, killing
 *   PTYs/scrollback and minting indistinguishable tab.closed — V-HDR-5);
 * - any request with params.focus === true (no-focus adapter, always).
 */
export function assertAllowedRequest(method: string, params: unknown): void {
	if (DENIED_METHODS.includes(method)) {
		throw new HerdrForbiddenError(method, `forbidden herdr request: ${method}`);
	}
	const fields =
		params !== null && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
	if (method === "layout.apply" && fields !== undefined && "tab_id" in fields) {
		throw new HerdrForbiddenError(
			method,
			"forbidden herdr request: layout.apply with tab_id destroys the live tab (V-HDR-5)",
		);
	}
	if (fields !== undefined && fields.focus === true) {
		throw new HerdrForbiddenError(
			method,
			`forbidden herdr request: ${method} with focus:true (adapter is no-focus)`,
		);
	}
}
