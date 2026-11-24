/**
 * RC-6 isolated-named-session helper — P1 stub.
 *
 * The P1 spec assigns this branch the interface and a placeholder factory only;
 * the real Herdr session logic is implemented and owned in P4 (RC-6) and reused
 * by P6. Every method rejects until then.
 */

export interface IsolatedHerdrSession {
	sessionName: string;
	setup(): Promise<void>;
	teardown(): Promise<void>;
	assertDailyWorkspaceUntouched(): Promise<void>;
}

const NOT_IMPLEMENTED = "isolated-session helper implemented in P4 (RC-6)";

export function createIsolatedSession(sessionName: string): IsolatedHerdrSession {
	return {
		sessionName,
		async setup(): Promise<void> {
			throw new Error(NOT_IMPLEMENTED);
		},
		async teardown(): Promise<void> {
			throw new Error(NOT_IMPLEMENTED);
		},
		async assertDailyWorkspaceUntouched(): Promise<void> {
			throw new Error(NOT_IMPLEMENTED);
		},
	};
}
