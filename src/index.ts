/**
 * herdr-omp-lens — public barrel.
 *
 *   - src/protocol  (task 2: wire protocol types & codecs)
 *   - src/herdr     (tasks 3–5: caller context, guarded no-focus adapter,
 *                  lifecycle subscription)
 *   - src/extension (task 6: OMP extension entry, bound via
 *     package.json `omp.extensions` → ./src/extension/index.ts)
 */

export type {
	LensCommandDefinition,
	LensCommandHandler,
	LensEventBus,
	LensExtensionApi,
	LensHookHandler,
} from "./extension/api";
export { default as lensExtension } from "./extension/index";
export { resolveViewerCommand } from "./extension/resolve";
export {
	createOverviewTab,
	getPane,
	guardedRequest,
	reportMetadata,
	runInPane,
	snapshot,
	splitPane,
} from "./herdr/adapter";
export type { CallerContext } from "./herdr/context";
export { callerContext, isHerdrEnv } from "./herdr/context";
export { assertAllowedRequest, DENIED_METHODS, HerdrForbiddenError } from "./herdr/guards";
export type { SubscribeLifecycleOptions } from "./herdr/lifecycle";
export { subscribeLifecycle } from "./herdr/lifecycle";
export type {
	EventStream,
	EventStreamHandlers,
	EventStreamOpener,
	HerdrTransport,
	SocketTransportOptions,
} from "./herdr/transport";
export { HerdrApiError, socketEventStream, socketTransport } from "./herdr/transport";
export type {
	LifecycleHandlers,
	PaneInfo,
	PaneMetadata,
	SessionSnapshot,
	Subscription,
} from "./herdr/types";
export {
	decodeClientMessage,
	decodeMessage,
	encodeMessage,
} from "./protocol/codec";
export type {
	ClientDecodeResult,
	ClientMessage,
	DecodeResult,
	Message,
	WorkerSnapshot,
	WorkerStatus,
} from "./protocol/types";
export { PROTOCOL_VERSION } from "./protocol/types";
