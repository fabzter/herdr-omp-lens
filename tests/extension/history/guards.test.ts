import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readdir as readdirAsync, stat as statAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lensExtension, { type LensExtensionDeps, lensReady, stopLens } from "../../../src/extension";
import type {
	LensCommandDefinition,
	LensExtensionApi,
	LensHookHandler,
} from "../../../src/extension/api";
import { startBridge as realStartBridge } from "../../../src/extension/bridge";
import {
	boundedReadFile,
	boundedTailReadFile,
	createHistorySource,
	type HistorySource,
} from "../../../src/extension/history";
import type { TopologyManager } from "../../../src/extension/topology";
import { makeFixtureTree, PROJECT_CWD } from "./fixtures";

/**
 * P5-R5 / P5-R10 tamper guards for the history path.
 *
 * (a) no `omp session` attach/transfer/lease argv; (b) no `omp read history://`
 * for historical rendering; (c) the scanner writes nothing to OMP session dirs;
 * (d) any lens-created cache path is 0700 dir / 0600 file; (e) no socket or
 * bind attempt; (f) gate off (HERDR_ENV unset) -> no history scan at all.
 *
 * Static guards scan src/extension/history/*.ts with comments stripped, so the
 * documentation that forbids these verbs does not trip them. Each guard also
 * carries in-suite sabotage fixtures proving the checker is not vacuous.
 */

const HISTORY_SRC = join(import.meta.dir, "../../../src/extension/history");

// --- static rules -----------------------------------------------------------

export interface Rule {
	id: string;
	pattern: RegExp;
}

/** Strip block and line comments (naive; history sources contain no `//` in strings). */
export function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
}

export const SOURCE_RULES: Rule[] = [
	// (a) lease / attach / transfer verbs anywhere in history code.
	{ id: "a-lease-verb", pattern: /\b(lease|attach|transfer)\b/i },
	// (b) historical URI construction.
	{ id: "b-history-uri", pattern: /history:\/\// },
	// (c) process spawn is never needed by the scanner (no omp invocation at all).
	{ id: "spawn", pattern: /\bBun\.spawn(Sync)?\b|\bchild_process\b|\bexec(File)?(Sync)?\b/ },
	// (c) write verbs from node:fs / Bun.
	{
		id: "c-write-verb",
		pattern:
			/\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|symlink|symlinkSync|chmod|chmodSync|truncate|truncateSync|createWriteStream|Bun\.write)\b/,
	},
	// (c) open-for-write flags as string literals.
	{ id: "c-write-flag", pattern: /["'](w|a|r\+|w\+|a\+|wx|ax|wa)["']/ },
	// (e) any socket / bind / listen / server primitive.
	{
		id: "e-socket",
		pattern:
			/\bBun\.(listen|connect|serve|udpSocket)\b|\bcreateServer\b|\bcreateConnection\b|\bnode:net\b|from ["'](net|dgram)["']|\bdgram\b/,
	},
];

export function violations(code: string, rules: Rule[] = SOURCE_RULES): string[] {
	const out: string[] = [];
	stripComments(code)
		.split("\n")
		.forEach((line, i) => {
			for (const rule of rules) {
				if (rule.pattern.test(line)) out.push(`${rule.id} L${i + 1}: ${line.trim()}`);
			}
		});
	return out;
}

/** Runtime argv check (guard a/b): any recorded argv that names history:// or a session lease verb. */
export function argvViolations(argvs: string[][]): string[] {
	const out: string[] = [];
	for (const argv of argvs) {
		const line = argv.join(" ");
		if (/history:\/\//.test(line)) out.push(`history:// argv: ${line}`);
		if (/\bsession\b/.test(line) && /\b(attach|transfer|lease)\b/.test(line)) {
			out.push(`session lease argv: ${line}`);
		}
		if (/\blease\b/.test(line)) out.push(`lease argv: ${line}`);
	}
	return out;
}

function historySources(): { name: string; code: string }[] {
	return readdirSync(HISTORY_SRC)
		.filter((f) => f.endsWith(".ts"))
		.sort()
		.map((name) => ({ name, code: readFileSync(join(HISTORY_SRC, name), "utf8") }));
}

// --- filesystem helpers -----------------------------------------------------

interface Entry {
	path: string;
	isDir: boolean;
	mode: number;
	size: number;
	mtimeMs: number;
}

function snapshot(root: string): Entry[] {
	const out: Entry[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const p = join(dir, name);
			const st = statSync(p);
			out.push({
				path: p,
				isDir: st.isDirectory(),
				mode: st.mode & 0o777,
				size: st.size,
				mtimeMs: st.mtimeMs,
			});
			if (st.isDirectory()) walk(p);
		}
	};
	walk(root);
	return out;
}

/** Lens-created cache paths must be owner-only: 0700 dirs, 0600 files. */
function assertOwnerOnly(path: string): void {
	const st = statSync(path);
	const mode = st.mode & 0o777;
	const want = st.isDirectory() ? 0o700 : 0o600;
	if (mode !== want) {
		throw new Error(`${path}: mode 0${mode.toString(8)} != 0${want.toString(8)}`);
	}
}

type Callable = (...args: unknown[]) => unknown;

/** Replace Bun.<name> with recorders that throw; restore in finally. */
async function recordBun(
	names: string[],
	run: () => Promise<void>,
): Promise<Record<string, unknown[][]>> {
	const bun = Bun as unknown as Record<string, Callable>;
	const originals: Record<string, Callable> = {};
	const calls: Record<string, unknown[][]> = {};
	for (const name of names) {
		originals[name] = bun[name] as Callable;
		calls[name] = [];
		bun[name] = (...args: unknown[]) => {
			calls[name]?.push(args);
			throw new Error(`Bun.${name} must not be called from the history path`);
		};
	}
	try {
		await run();
	} finally {
		for (const name of names) bun[name] = originals[name] as Callable;
	}
	return calls;
}

// --- env + activation helpers (gate/control) --------------------------------

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

const tmpDirs: string[] = [];
afterEach(async () => {
	await stopLens();
	for (const [key, original] of saved) {
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	saved.clear();
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

function tmpdirPath(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "lens-guard-"));
	tmpDirs.push(dir);
	return join(dir, name);
}

function fakePi(): LensExtensionApi {
	return {
		registerCommand(_name: string, _definition: LensCommandDefinition) {},
		on(_event: string, _handler: LensHookHandler) {},
		off(_event: string, _handler: LensHookHandler) {},
	};
}

function spyHistory(): { source: HistorySource; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		source: {
			scan: async (cwd: string) => {
				calls.push(cwd);
				return { workers: [], warnings: [], scannedAt: 0 };
			},
		},
	};
}

const noopTopology: TopologyManager = {
	onWorkerSpawned: () => Promise.resolve(),
	onHistoryPresent: () => Promise.resolve(),
	onWorkerFinished: () => {},
	onRosterEmpty: () => {},
	openOverview: () => Promise.resolve(),
	openWorkerSplit: () => Promise.resolve({ paneId: "p-x" }),
	state: () => "closed",
	stop: () => Promise.resolve(),
};

// --- static guards over src/extension/history/ ------------------------------

describe("static guards over src/extension/history/ (comments stripped)", () => {
	test("scans the real history sources (non-vacuous: scan.ts is present)", () => {
		const names = historySources().map((s) => s.name);
		expect(names).toContain("scan.ts");
		expect(names).toContain("merge.ts");
	});

	for (const { name, code } of historySources()) {
		test(`${name}: no lease/attach/transfer, no history:// construction, no spawn, no write verbs, no socket`, () => {
			expect(violations(code)).toEqual([]);
		});
	}

	test("sabotage: a history:// read snippet is caught (red)", () => {
		const snippet = 'const argv = ["omp", "read", "history://" + id];';
		expect(violations(snippet).map((v) => v.split(" ")[0])).toEqual(["b-history-uri"]);
	});

	test("sabotage: an omp session attach / lease snippet is caught (red)", () => {
		expect(violations('spawn(["omp", "session", "attach", id]);').length).toBeGreaterThan(0);
		expect(violations("const lease = acquire(sessionFile);").length).toBeGreaterThan(0);
	});

	test("sabotage: write verbs and write-open flags are caught (red); read-open is not", () => {
		expect(violations("await writeFile(p, data);").length).toBeGreaterThan(0);
		expect(violations("await mkdir(dir, { recursive: true });").length).toBeGreaterThan(0);
		expect(violations('const fh = await open(p, "w");').length).toBeGreaterThan(0);
		expect(violations('const fh = await open(p, "a");').length).toBeGreaterThan(0);
		expect(violations('const fh = await open(p, "r");')).toEqual([]);
	});

	test("sabotage: socket / bind attempts are caught (red)", () => {
		expect(violations('Bun.listen({ unix: "/tmp/x.sock", socket: {} });').length).toBeGreaterThan(
			0,
		);
		expect(violations('await Bun.connect({ unix: "/tmp/x.sock" });').length).toBeGreaterThan(0);
		expect(violations('import net from "node:net";').length).toBeGreaterThan(0);
	});

	test("comments documenting the forbidden verbs do not trip the guard", () => {
		expect(
			violations("// no lease, no `omp read history://` here\n/* writeFile */ const x = 1;"),
		).toEqual([]);
	});
});

// --- (a)/(b) argv recorder ---------------------------------------------------

describe("(a)/(b) argv recorder: the history scan constructs no omp argv", () => {
	test("scan under Bun.spawn/listen/connect/serve recorders: no spawn, no socket, no forbidden argv", async () => {
		const tree = makeFixtureTree();
		tmpDirs.push(tree.sessionsRoot);
		const source = createHistorySource({ sessionsRoot: tree.sessionsRoot });

		let result: Awaited<ReturnType<HistorySource["scan"]>> | undefined;
		const calls = await recordBun(["spawn", "listen", "connect", "serve"], async () => {
			result = await source.scan(PROJECT_CWD);
		});

		// Non-vacuous: the scan really ran over the fixture (w1, w2, w3 surface).
		expect(result?.workers.map((w) => w.id).sort()).toEqual(["w1", "w2", "w3"]);
		expect(calls.spawn).toEqual([]);
		expect(calls.listen).toEqual([]);
		expect(calls.connect).toEqual([]);
		expect(calls.serve).toEqual([]);
	});

	test("sabotage: recorded omp read history:// and session attach argv are caught (red)", () => {
		expect(argvViolations([["omp", "read", "history://abc"]])).toHaveLength(1);
		expect(argvViolations([["omp", "session", "attach", "w1"]])).toHaveLength(1);
		expect(argvViolations([["omp", "render", "/tmp/w1.jsonl", "--plain"]])).toEqual([]);
	});
});

// --- (c) read-only seams + tree snapshot ------------------------------------

describe("(c) scanner writes nothing to OMP session dirs", () => {
	test("every seam op is a read on the fixture root, and the tree is byte-identical", async () => {
		const tree = makeFixtureTree();
		tmpDirs.push(tree.sessionsRoot);
		const before = snapshot(tree.sessionsRoot);
		const ops: string[] = [];
		const underRoot = (p: string): void => {
			if (!p.startsWith(tree.sessionsRoot)) throw new Error(`read outside fixture root: ${p}`);
		};

		const source = createHistorySource({
			sessionsRoot: tree.sessionsRoot,
			readDir: async (p) => {
				ops.push("readdir");
				underRoot(p);
				return readdirAsync(p);
			},
			stat: async (p) => {
				ops.push("stat");
				underRoot(p);
				return statAsync(p);
			},
			readFile: async (p, enc, max) => {
				ops.push("readFile");
				underRoot(p);
				return boundedReadFile(p, enc, max ?? 256 * 1024);
			},
			readFileTail: async (p, enc, max) => {
				ops.push("readFileTail");
				underRoot(p);
				return boundedTailReadFile(p, enc, max ?? 256 * 1024);
			},
		});

		const scan = await source.scan(PROJECT_CWD);
		expect(scan.workers).toHaveLength(3);

		expect(ops.length).toBeGreaterThan(0);
		expect(snapshot(tree.sessionsRoot)).toEqual(before);
	});

	test("sabotage: a write into the session dir changes the snapshot (red)", () => {
		const tree = makeFixtureTree();
		tmpDirs.push(tree.sessionsRoot);
		const before = snapshot(tree.sessionsRoot);
		writeFileSync(join(tree.sessionDirs[0] ?? "", "injected.jsonl"), "{}\n");
		expect(snapshot(tree.sessionsRoot)).not.toEqual(before);
	});
});

// --- (d) owner-only cache paths ---------------------------------------------

describe("(d) lens-created cache paths are 0700 dir / 0600 file", () => {
	test("scan creates no files or dirs, so no cache path exists to violate the mode rule", async () => {
		const tree = makeFixtureTree();
		tmpDirs.push(tree.sessionsRoot);
		const beforePaths = new Set(snapshot(tree.sessionsRoot).map((e) => e.path));
		const source = createHistorySource({ sessionsRoot: tree.sessionsRoot });
		await source.scan(PROJECT_CWD);
		await source.scan(PROJECT_CWD); // second scan exercises the mtime cache path too
		const created = snapshot(tree.sessionsRoot).filter((e) => !beforePaths.has(e.path));
		expect(created).toEqual([]);
	});

	test("mode helper is not vacuous: a 0644 file and a 0755 dir are rejected", () => {
		const dir = tmpdirPath("loose");
		mkdirFixture(dir);
		const file = join(dir, "f.json");
		writeFileSync(file, "{}");
		chmodSync(file, 0o644);
		chmodSync(dir, 0o755);
		expect(() => assertOwnerOnly(file)).toThrow(/0644 != 0600/);
		expect(() => assertOwnerOnly(dir)).toThrow(/0755 != 0700/);
		chmodSync(file, 0o600);
		chmodSync(dir, 0o700);
		expect(() => assertOwnerOnly(file)).not.toThrow();
		expect(() => assertOwnerOnly(dir)).not.toThrow();
	});
});

function mkdirFixture(dir: string): void {
	// Bare dir creation for the mode-helper fixture only (test scaffolding, not the scanner).
	Bun.spawnSync(["mkdir", "-p", dir]);
}

// --- (f) gate off -> no history scan ----------------------------------------

describe("(f) gate off (HERDR_ENV unset) performs no history scan", () => {
	test("activation with HERDR_ENV unset never invokes the history source", async () => {
		setEnv(Object.fromEntries(HERDR_VARS.map((k) => [k, undefined])));
		const spy = spyHistory();
		const deps: LensExtensionDeps = { cwd: PROJECT_CWD, history: spy.source };

		lensExtension(fakePi(), deps);
		await lensReady();

		expect(spy.calls).toEqual([]);
	});

	test("control: with the gate open the same spy IS scanned once (proves the spy is wired)", async () => {
		setEnv(FULL_ENV);
		const socketPath = tmpdirPath("bridge.sock");
		const spy = spyHistory();
		const deps: LensExtensionDeps = {
			cwd: PROJECT_CWD,
			history: spy.source,
			startBridge: (roster, o) => realStartBridge(roster, { ...o, socketPath, coalesceMs: 10 }),
			createTopologyManager: () => noopTopology,
		};

		lensExtension(fakePi(), deps);
		await lensReady();

		expect(spy.calls).toEqual([PROJECT_CWD]);
	});
});
