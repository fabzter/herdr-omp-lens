/**
 * Herdr-facing shared types (ratified P1 interface block, phase-01 spec).
 * Task 4 owns this file; Task 5 imports LifecycleHandlers/Subscription, never recreates.
 * Wire payloads are snake_case; the adapter maps them to these camelCase types.
 */

export interface PaneInfo {
	paneId: string;
	tabId: string;
	workspaceId: string;
	title?: string;
	agent?: string;
}

/**
 * A tab in the session snapshot. `label` is the tab's display label — the
 * only reliable identity for the overview on Herdr 0.9.5, where snapshot
 * pane `title` is always null (the one-tab regression: matching survivors
 * by pane.title never matched, so every reopen spawned a duplicate tab).
 */
export interface TabInfo {
	tabId: string;
	workspaceId: string;
	label?: string;
}

export interface SessionSnapshot {
	workspaces: unknown[];
	tabs: TabInfo[];
	panes: PaneInfo[];
}

/**
 * pane.report_metadata body. `source` is required (V-HDR-7: reports are
 * source-scoped); tokens are optional per-source patches.
 */
export interface PaneMetadata {
	source: string;
	title?: string;
	displayAgent?: string;
	stateLabels?: Record<string, string>;
	tokens?: Record<string, string>;
	seq?: number;
	ttlMs?: number;
}

/**
 * Session-wide lifecycle subscriptions (V-HDR-2): tab.closed, pane.closed,
 * pane.exited, pane.moved, workspace.closed, layout.updated. F-12: P1 owns
 * transparent events_lost resubscribe; onEventsLost lets P4 reconcile ids.
 */
export interface LifecycleHandlers {
	onTabClosed?(e: { workspaceId: string; tabId: string }): void;
	onPaneClosed?(e: { workspaceId: string; paneId: string }): void;
	onPaneExited?(e: { workspaceId: string; paneId: string }): void;
	onPaneMoved?(e: {
		previousPaneId: string;
		previousWorkspaceId: string;
		previousTabId: string;
		pane: PaneInfo;
	}): void;
	onWorkspaceClosed?(e: { workspaceId: string }): void;
	onLayoutUpdated?(e: { tabId: string }): void;
	onEventsLost?(): void;
}

export interface Subscription {
	close(): Promise<void>;
}
