/**
 * Herdr caller-context detection.
 *
 * When an OMP extension runs inside a Herdr pane, Herdr injects HERDR_ENV=1 plus
 * five vars identifying the caller. socketPath is Herdr's own socket — the
 * extension connects to it as a client; it is NOT a bridge socket we bind.
 */

export interface CallerContext {
	workspaceId: string;
	tabId: string;
	paneId: string;
	binPath: string;
	socketPath: string;
}

const REQUIRED_VARS = [
	"HERDR_WORKSPACE_ID",
	"HERDR_TAB_ID",
	"HERDR_PANE_ID",
	"HERDR_BIN_PATH",
	"HERDR_SOCKET_PATH",
] as const;

/** True only when HERDR_ENV==="1" and all five context vars are present. */
export function isHerdrEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.HERDR_ENV !== "1") return false;
	return REQUIRED_VARS.every((key) => typeof env[key] === "string" && env[key] !== "");
}

/** Caller context when running under Herdr; null otherwise. */
export function callerContext(env: NodeJS.ProcessEnv = process.env): CallerContext | null {
	if (!isHerdrEnv(env)) return null;
	return {
		// biome-ignore lint/style/noNonNullAssertion: presence guaranteed by isHerdrEnv
		workspaceId: env.HERDR_WORKSPACE_ID!,
		// biome-ignore lint/style/noNonNullAssertion: presence guaranteed by isHerdrEnv
		tabId: env.HERDR_TAB_ID!,
		// biome-ignore lint/style/noNonNullAssertion: presence guaranteed by isHerdrEnv
		paneId: env.HERDR_PANE_ID!,
		// biome-ignore lint/style/noNonNullAssertion: presence guaranteed by isHerdrEnv
		binPath: env.HERDR_BIN_PATH!,
		// biome-ignore lint/style/noNonNullAssertion: presence guaranteed by isHerdrEnv
		socketPath: env.HERDR_SOCKET_PATH!,
	};
}
