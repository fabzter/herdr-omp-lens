import { afterEach, describe, expect, test } from "bun:test";
import lensExtension from "../../src/extension";
import type { LensExtensionApi } from "../../src/extension/api";
import type { Observation, StartObservation } from "../../src/extension/observe";
import { Roster } from "../../src/extension/roster";

const HERDR_VARS = [
	"HERDR_ENV",
	"HERDR_WORKSPACE_ID",
	"HERDR_TAB_ID",
	"HERDR_PANE_ID",
	"HERDR_BIN_PATH",
	"HERDR_SOCKET_PATH",
] as const;

const FULL_ENV: Record<(typeof HERDR_VARS)[number], string> = {
	HERDR_ENV: "1",
	HERDR_WORKSPACE_ID: "w1",
	HERDR_TAB_ID: "w1:t1",
	HERDR_PANE_ID: "w1:p1",
	HERDR_BIN_PATH: "/bin/herdr",
	HERDR_SOCKET_PATH: "/sock",
};

const saved = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(vars)) {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	for (const [key, original] of saved) {
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	saved.clear();
});

interface FakePiCalls {
	commands: { name: string; description: string; handlerInvocable: boolean }[];
	hooks: string[];
	busSubs: string[];
}

/** Structural stub of the OMP extension surface — no pi-coding-agent dependency. */
function fakePi(): { pi: LensExtensionApi; calls: FakePiCalls } {
	const calls: FakePiCalls = { commands: [], hooks: [], busSubs: [] };
	const pi: LensExtensionApi = {
		registerCommand(name, definition) {
			definition.handler("");
			calls.commands.push({
				name,
				description: definition.description,
				handlerInvocable: true,
			});
		},
		on(event) {
			calls.hooks.push(event);
		},
		events: {
			on(channel) {
				calls.busSubs.push(channel);
			},
		},
	};
	return { pi, calls };
}

describe("lensExtension gate", () => {
	test("registers nothing when HERDR_ENV is unset", () => {
		setEnv(Object.fromEntries(HERDR_VARS.map((k) => [k, undefined])));
		const { pi, calls } = fakePi();

		lensExtension(pi);

		expect(calls.commands).toHaveLength(0);
		expect(calls.hooks).toHaveLength(0);
		expect(calls.busSubs).toHaveLength(0);
	});

	test("registers nothing when HERDR_ENV=1 but a context var is missing", () => {
		setEnv({ ...FULL_ENV, HERDR_SOCKET_PATH: undefined });
		const { pi, calls } = fakePi();

		lensExtension(pi);

		expect(calls.commands).toHaveLength(0);
		expect(calls.hooks).toHaveLength(0);
		expect(calls.busSubs).toHaveLength(0);
	});

	test("registers /lens and activates observation when the full Herdr env is present", () => {
		setEnv(FULL_ENV);
		const { pi, calls } = fakePi();
		let activated = 0;
		const startObservation = (async (): Promise<Observation> => {
			activated++;
			return {
				roster: new Roster(),
				bridge: {
					socketPath: "/stub/bridge.sock",
					broadcast() {},
					viewerCount() {
						return 0;
					},
					async close() {},
				},
				async stop() {},
			};
		}) satisfies StartObservation;

		lensExtension(pi, { startObservation });

		expect(calls.commands).toHaveLength(1);
		expect(calls.commands[0]?.name).toBe("lens");
		expect(calls.commands[0]?.handlerInvocable).toBe(true);
		// P2-4/P4-3: activation is delegated to startObservation (stubbed) — the
		// gate registers /lens + /lens split, the session_start capture hook and
		// the session_shutdown teardown hook (P6-R5); bus/spawn-hook
		// subscriptions live in observe/.
		expect(activated).toBe(1);
		expect(calls.hooks).toEqual(["session_start", "session_shutdown"]);
	});
});
