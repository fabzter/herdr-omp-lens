/**
 * Structural subset of the OMP extension API (`ExtensionAPI` from
 * `@oh-my-pi/pi-coding-agent`). Declared locally — per the P1 ruling the
 * package stays dependency-light and OMP's real `pi` object satisfies this
 * type structurally at runtime.
 *
 * All handlers MUST enqueue work synchronously and return immediately
 * (fire-and-forget): never awaiting I/O inside a handler is what guarantees
 * an OMP turn is never blocked (FR-12 / F-15).
 */

/** Handler for a `/`-command invocation; receives the raw argument tail. */
export type LensCommandHandler = (args: string) => void;

/** Slash-command registration passed to `pi.registerCommand`. */
export interface LensCommandDefinition {
	description: string;
	handler: LensCommandHandler;
}

/** OMP lifecycle hook handler (`pi.on`). Fire-and-forget. */
export type LensHookHandler = (event: unknown) => void;

/**
 * Undocumented event-bus surface (`pi.events`): carries the
 * `task:subagent:{lifecycle,progress,event}` channels observed in Phase 0.
 * Subscriptions are fire-and-forget.
 */
export interface LensEventBus {
	on(channel: string, handler: (payload: unknown) => void): void;
	/**
	 * Detach a channel handler when the host bus exposes removal. Optional:
	 * the bus surface is undocumented (Phase 0), so consumers also guard
	 * handlers with a stopped flag for a deterministic `stop()`.
	 */
	off?(channel: string, handler: (payload: unknown) => void): void;
}

/** The subset of `ExtensionAPI` the lens extension touches. */
export interface LensExtensionApi {
	/** Register a `/name` slash command. */
	registerCommand(name: string, definition: LensCommandDefinition): void;
	/** Subscribe to an OMP lifecycle hook (e.g. `before_subagent_spawn`). */
	on(event: string, handler: LensHookHandler): void;
	/** Detach a hook handler when the host exposes removal (best-effort). */
	off?(event: string, handler: LensHookHandler): void;
	/**
	 * Event bus for `task:subagent:*` channels. Optional: the surface is
	 * undocumented (Phase 0), so consumers feature-detect and degrade to a
	 * `notice` when absent (P2-R8) instead of throwing.
	 */
	events?: LensEventBus;
}
