/**
 * Signal-cleanup fixture: starts a real bridge in a child process, prints the
 * socket path, then sends itself the signal named by argv[2]. If the bridge's
 * handler cleans up and re-raises the default, the process dies and the
 * parent test asserts the socket file is gone. If the handler misbehaves the
 * child keeps running and the parent's test timeout makes the failure loud.
 */
import { startBridge } from "../../../src/extension/bridge";
import { Roster } from "../../../src/extension/roster";

const signal = process.argv[2] === "SIGINT" ? "SIGINT" : "SIGTERM";

const bridge = await startBridge(new Roster(), {});
console.log(bridge.socketPath);

setTimeout(() => {
	process.kill(process.pid, signal);
}, 50);
