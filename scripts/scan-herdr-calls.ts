/**
 * P6-R3 layer (a): static source scan for Herdr hazard calls (F-18/D5).
 *
 * Scans comment-stripped TypeScript source and reports every construction that
 * could emit a forbidden Herdr request — the same hazards the runtime denylist
 * in src/herdr/guards.ts enforces at the transport boundary (layer (b)). The
 * two layers are complementary: this scan fails closed on anything it cannot
 * statically prove safe; dynamically-composed calls it cannot see are caught by
 * assertAllowedRequest at runtime (tamper-tested in tests/herdr/guards.test.ts).
 *
 * Seam model (verified against src/):
 *  - guardedRequest(t, "<method>", <params>)  — the single guarded API seam;
 *    its method argument must be a string literal so the scan can check it
 *  - <t>.request(method, params)              — raw transport; only the
 *    `method` forward inside guardedRequest itself is allowed
 *  - openStream(path, "<method>", params, handlers) — lifecycle seam, literal
 *  - openEventStream / socketRequest          — transport internals; a bare
 *    `method` forward is allowed because the caller is guarded upstream
 *  - s.write(`${JSON.stringify({ id, method, params })}\n`) — frame emission
 *    inside transport.ts only
 *
 * Params resolve two ways: inline object literals, or `const p = {…}`
 * declarations with `p.key = v` / `p["k"] = v` mutations collected up to the
 * call site. Params that cannot be resolved, or contain a spread, fail closed
 * ("unresolvable-params" / "opaque-params") — the scan proves safety, it never
 * assumes it.
 *
 * Run directly (`bun scripts/scan-herdr-calls.ts [srcRoot]`) to print findings.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SourceFile {
	/** Repo-relative path with forward slashes, e.g. "src/herdr/adapter.ts". */
	path: string;
	content: string;
}

export interface ScanFinding {
	rule: string;
	path: string;
	line: number;
	detail: string;
}

export interface ScanOptions {
	/**
	 * When true, the scan set must contain src/herdr/guards.ts and that file
	 * must list every FORBIDDEN_METHOD literal — so removing a denylist entry
	 * fails this layer too, not only the runtime tamper test.
	 */
	requireDenylist?: boolean;
}

/**
 * The P6-R3 / V-HDR-5-7 / U-HDR-4 denylist — mirrored from the spec, NOT
 * imported from guards.ts, so weakening guards.ts cannot weaken this layer.
 */
const FORBIDDEN_METHODS = [
	"agent.focus",
	"agent.start",
	"agent.view.set",
	"pane.focus",
	"pane.report_agent",
	"tab.focus",
	"workspace.focus",
] as const;

const GUARDS_PATH_SUFFIX = "src/herdr/guards.ts";
/** transport.ts is the sole file allowed to serialize a request frame. */
const FRAME_WRITE_FILE = "src/herdr/transport.ts";
/**
 * Bun.connect is the Herdr wire only via transport.ts; the viewer and bridge
 * clients open their own unix sockets (not Herdr request paths). A connect
 * anywhere else is a new wire this guard must review.
 */
const ALLOWED_CONNECT_FILES: Record<string, true> = {
	"src/herdr/transport.ts": true,
	"src/viewer/client.ts": true,
	"src/extension/bridge.ts": true,
};

/** Strip block and line comments (naive; src/ contains no `//` inside strings
 * that would survive this — same pattern as tests/extension/history/guards). */
export function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
}

function skipString(code: string, start: number): number {
	const quote = code[start];
	let i = start + 1;
	while (i < code.length) {
		if (code[i] === "\\") {
			i += 2;
			continue;
		}
		if (code[i] === quote) return i + 1;
		i++;
	}
	return i;
}

/** Extract the balanced (...) argument list starting at openParen (index of
 * `(`). String-literal aware; null on unbalanced input. */
function argList(code: string, openParen: number): { argsText: string; end: number } | null {
	const stack: string[] = ["("];
	let i = openParen + 1;
	while (i < code.length && stack.length > 0) {
		const ch = code[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			i = skipString(code, i);
			continue;
		}
		if (ch === "(" || ch === "{" || ch === "[") {
			stack.push(ch);
		} else if (ch === ")" || ch === "}" || ch === "]") {
			const top = stack[stack.length - 1];
			if ((top === "(" && ch === ")") || (top === "{" && ch === "}") || (top === "[" && ch === "]")) {
				stack.pop();
			} else {
				return null; // mismatched closer — not extractable
			}
		}
		i++;
	}
	if (stack.length > 0) return null;
	return { argsText: code.slice(openParen + 1, i - 1), end: i };
}

/** Split an argument list on top-level commas (string/bracket aware). */
export function splitArgs(argsText: string): string[] {
	const args: string[] = [];
	const stack: string[] = [];
	let last = "";
	let i = 0;
	while (i < argsText.length) {
		const ch = argsText[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			const end = skipString(argsText, i);
			last += argsText.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "(" || ch === "{" || ch === "[") stack.push(ch);
		else if (ch === ")" || ch === "}" || ch === "]") stack.pop();
		if (ch === "," && stack.length === 0) {
			args.push(last);
			last = "";
		} else {
			last += ch;
		}
		i++;
	}
	if (last.trim() !== "" || args.length > 0) args.push(last);
	return args.map((a) => a.trim());
}

interface ResolvedParams {
	/** Concatenated literal text of the params object + collected mutations. */
	text: string;
	/** Params could not be resolved to static text (call expr, conditional, …). */
	unresolvable: boolean;
	/** Statically resolved but contains a spread `...` whose keys are opaque. */
	opaque: boolean;
}

/** Extract a balanced {…}/[…] or read a bare expression to end-of-statement. */
function expressionText(code: string, start: number): string {
	let i = start;
	while (i < code.length && /\s/.test(code[i] as string)) i++;
	const first = code[i];
	if (first === "{" || first === "[") {
		const stack = [first];
		let j = i + 1;
		while (j < code.length && stack.length > 0) {
			const ch = code[j];
			if (ch === '"' || ch === "'" || ch === "`") {
				j = skipString(code, j);
				continue;
			}
			if (ch === "{" || ch === "[" || ch === "(") stack.push(ch);
			else if (ch === "}" || ch === "]" || ch === ")") stack.pop();
			j++;
		}
		return code.slice(i, j);
	}
	let j = i;
	while (j < code.length && code[j] !== ";" && code[j] !== "\n" && j - i < 300) j++;
	return code.slice(i, j);
}

/**
 * Resolve a seam call's params argument to static object text.
 * Inline `{…}` resolves directly; a `const <id> = {…}` identifier resolves to
 * its initializer plus every `<id>.k = v` / `<id>["k"] = v` mutation between
 * declaration and call site (normalized to `k: v` so key checks apply).
 */
export function resolveParams(
	code: string,
	args: string[],
	paramsIndex: number,
	callIndex: number,
): ResolvedParams {
	const raw = (args[paramsIndex] ?? "").trim();
	if (raw === "" || raw === "{}" || raw === "null" || raw === "undefined") {
		return { text: "", unresolvable: false, opaque: false };
	}
	if (raw.startsWith("{")) {
		return { text: raw, unresolvable: false, opaque: raw.includes("...") };
	}
	if (!/^[A-Za-z_$][\w$]*$/.test(raw)) {
		return { text: raw, unresolvable: true, opaque: true };
	}
	// latest `const|let|var <id> =` before the call site
	const declRe = new RegExp(`\\b(?:const|let|var)\\s+${raw}\\b[^=\\n]*=(?!=)`, "g");
	let declEnd = -1;
	for (let m = declRe.exec(code); m !== null && m.index < callIndex; m = declRe.exec(code)) {
		declEnd = m.index + m[0].length;
	}
	if (declEnd < 0) return { text: "", unresolvable: true, opaque: true };
	const init = expressionText(code, declEnd);
	if (!init.startsWith("{")) {
		return { text: init, unresolvable: true, opaque: true };
	}
	let text = init;
	// `<id>.key = value` and `<id>["key"] = value` mutations between the
	// declaration and the call site, normalized to `key: value`
	const mutRe = new RegExp(
		`\\b${raw}\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*)|\\[\\s*["']([^"']+)["']\\s*\\])\\s*=(?!=)`,
		"g",
	);
	const mutStart = declEnd + init.length;
	for (let m = mutRe.exec(code); m !== null && m.index < callIndex; m = mutRe.exec(code)) {
		if (m.index < mutStart) continue;
		const key = m[1] ?? m[2] ?? "";
		const value = expressionText(code, m.index + m[0].length).replace(/;\s*$/, "");
		text += `\n${key}: ${value}`;
	}
	return { text, unresolvable: false, opaque: text.includes("...") };
}

/** Unquote a `"literal"` / `'literal'` / `` `literal` `` argument; null if it
 * is not a plain string literal. */
function literalContent(arg: string): string | null {
	const m = /^["'`]([\s\S]*)["'`]$/.exec(arg.trim());
	return m === null ? null : (m[1] as string);
}

function push(
	findings: ScanFinding[],
	rule: string,
	path: string,
	code: string,
	at: number,
	detail: string,
): void {
	findings.push({ rule, path, line: code.slice(0, at).split("\n").length, detail });
}

/**
 * Wire seams whose method argument must be a literal — except where
 * `forwardOk` marks internal plumbing that may forward the enclosing
 * function's `method` parameter verbatim (that caller is itself checked by
 * this scan or by the runtime guard). guardedRequest and openStream are the
 * public seams: they always require a literal so the scan sees every method.
 * methodIdx/paramsIdx index the call's arguments.
 */
const WIRE_SEAMS: { re: RegExp; methodIdx: number; paramsIdx: number; forwardOk: boolean }[] = [
	{ re: /\bguardedRequest\s*\(/g, methodIdx: 1, paramsIdx: 2, forwardOk: false },
	{ re: /\.\s*request\s*\(/g, methodIdx: 0, paramsIdx: 1, forwardOk: true },
	{ re: /\bopenStream\s*\(/g, methodIdx: 1, paramsIdx: 2, forwardOk: false },
	{ re: /\bopenEventStream\s*\(/g, methodIdx: 1, paramsIdx: 2, forwardOk: true },
	{ re: /\bsocketRequest\s*\(/g, methodIdx: 1, paramsIdx: 2, forwardOk: true },
];

/** Methods whose params the scan can (and must) verify by content. */
const CONTENT_CHECKED_METHODS: Record<string, true> = {
	"layout.apply": true,
	"tab.create": true,
	"pane.split": true,
	"pane.send_input": true,
	"pane.report_metadata": true,
};

function checkCall(
	findings: ScanFinding[],
	path: string,
	code: string,
	callIndex: number,
	forwardOk: boolean,
	methodArg: string,
	params: ResolvedParams,
): void {
	const method = literalContent(methodArg);
	if (method === null) {
		if (!(forwardOk && methodArg.trim() === "method")) {
			push(
				findings,
				"non-literal-method",
				path,
				code,
				callIndex,
				`non-literal method argument (${methodArg.trim().slice(0, 40)}); the scan cannot prove it safe`,
			);
		}
		return;
	}
	if ((FORBIDDEN_METHODS as readonly string[]).includes(method) || method.endsWith(".focus")) {
		push(findings, "denied-method", path, code, callIndex, `emits denied method "${method}"`);
	}
	if (/^pane\.report_/.test(method) && method !== "pane.report_metadata") {
		push(
			findings,
			"report-not-metadata",
			path,
			code,
			callIndex,
			`emits "${method}"; metadata may only go through pane.report_metadata (V-HDR-7)`,
		);
	}
	if (CONTENT_CHECKED_METHODS[method] === true && params.unresolvable) {
		push(
			findings,
			"unresolvable-params",
			path,
			code,
			callIndex,
			`"${method}" params could not be resolved; the scan cannot prove it safe`,
		);
		return;
	}
	if (CONTENT_CHECKED_METHODS[method] === true && params.opaque) {
		push(
			findings,
			"opaque-params",
			path,
			code,
			callIndex,
			`"${method}" params contain a spread; keys cannot be fully verified`,
		);
	}
	switch (method) {
		case "layout.apply":
			if (/\btab_id\b/.test(params.text)) {
				push(
					findings,
					"layout-apply-tab-id",
					path,
					code,
					callIndex,
					"layout.apply params carry tab_id — destroys the live tab (V-HDR-5)",
				);
			}
			break;
		case "tab.create":
		case "pane.split":
			if (!/focus\s*:\s*false\b/.test(params.text)) {
				push(
					findings,
					"missing-focus-false",
					path,
					code,
					callIndex,
					`"${method}" params do not statically pin focus: false (U-HDR-4)`,
				);
			}
			break;
		case "pane.send_input":
			if (/\bfocus\s*:/.test(params.text)) {
				push(
					findings,
					"send-input-focus",
					path,
					code,
					callIndex,
					"pane.send_input params carry a focus key it must not have (U-HDR-4)",
				);
			}
			break;
		case "pane.report_metadata":
			if (!/\bsource\s*:/.test(params.text)) {
				push(
					findings,
					"metadata-missing-source",
					path,
					code,
					callIndex,
					"pane.report_metadata params lack the required source field (V-HDR-7)",
				);
			}
			break;
		default:
			break;
	}
	if (
		CONTENT_CHECKED_METHODS[method] !== true &&
		params.unresolvable &&
		method !== "events.subscribe"
	) {
		// Even for methods with no required keys, unseen params cannot be proven
		// free of focus/tab_id — fail closed. events.subscribe is exempt: its
		// params forward a module constant the runtime guard checks.
		push(
			findings,
			"unresolvable-params",
			path,
			code,
			callIndex,
			`"${method}" params could not be resolved to static text`,
		);
	}
}

export function scanSources(files: SourceFile[], options: ScanOptions = {}): ScanFinding[] {
	const findings: ScanFinding[] = [];
	let sawGuards = false;
	for (const file of files) {
		const code = stripComments(file.content);
		if (file.path.endsWith(GUARDS_PATH_SUFFIX)) {
			sawGuards = true;
			// The enforcer file is exempt from emission rules (it names forbidden
			// methods plus tab_id/focus as comparisons, not calls) — but under
			// requireDenylist it must still list every forbidden method.
			if (options.requireDenylist === true) {
				for (const m of FORBIDDEN_METHODS) {
					if (!new RegExp(`["'\`]${m.replace(/\./g, "\\.")}["'\`]`).test(code)) {
						findings.push({
							rule: "denylist-missing",
							path: file.path,
							line: 0,
							detail: `src/herdr/guards.ts DENIED_METHODS no longer lists "${m}"`,
						});
					}
				}
			}
			continue;
		}

		// --- per-line rules ---------------------------------------------------
		const lines = code.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] as string;
			const lineNo = i + 1;
			const add = (rule: string, detail: string): void => {
				findings.push({ rule, path: file.path, line: lineNo, detail });
			};
			for (const m of FORBIDDEN_METHODS) {
				if (new RegExp(`["'\`]${m.replace(/\./g, "\\.")}["'\`]`).test(line)) {
					add("denied-method-literal", `literal "${m}" outside src/herdr/guards.ts`);
				}
			}
			if (/["'`][a-z_]+(?:\.[a-z_]+)*\.focus["'`]/.test(line)) {
				add("focus-method-literal", "a *.focus method literal (focus theft, U-HDR-4)");
			}
			if (/["'`]pane\.report_(?!metadata["'`])/.test(line)) {
				add("report-not-metadata", "pane.report_* literal other than pane.report_metadata (V-HDR-7)");
			}
			if (/\bfocus\s*:(?!\s*false\b)/.test(line)) {
				add("focus-prop", "a `focus:` param that is not statically `false` (U-HDR-4)");
			}
			if (/\b\w+\s*(?:\.\s*tab_id|\[\s*["']tab_id["']\s*\])\s*=(?!=)/.test(line)) {
				add("tab-id-mutation", "tab_id assigned onto a params object");
			}
			for (const lit of line.matchAll(
				/["'`]([^"'`]*\bherdr\s+(?:tab\s+create|pane\s+split|pane\s+run|agent\s+start|agent\s+view\.set)\b[^"'`]*)["'`]/g,
			)) {
				if (!/\s--no-focus\b/.test(lit[1] as string)) {
					add(
						"cli-missing-no-focus",
						`herdr CLI call without --no-focus: "${(lit[1] as string).slice(0, 60)}"`,
					);
				}
			}
			if (/\.write\s*\([^)]*JSON\.stringify/.test(line) && file.path !== FRAME_WRITE_FILE) {
				add(
					"raw-frame-write",
					"request frame written to a socket outside src/herdr/transport.ts",
				);
			}
			if (/\bBun\.connect\s*\(/.test(line) && ALLOWED_CONNECT_FILES[file.path] !== true) {
				add(
					"raw-socket",
					"Bun.connect outside the known transport/bridge/viewer socket clients",
				);
			}
			// "layout.apply" + "tab_id" in one statement (V-HDR-5) — catches raw
			// frame/CLI constructions the seam analysis cannot see
			if (/["'`]layout\.apply["'`]/.test(line) && /\btab_id\b/.test(line)) {
				add("layout-apply-tab-id", `"layout.apply" and "tab_id" in one statement (V-HDR-5)`);
			}
		}

		// --- wire-seam call analysis ------------------------------------------
		for (const seam of WIRE_SEAMS) {
			seam.re.lastIndex = 0;
			for (let m = seam.re.exec(code); m !== null; m = seam.re.exec(code)) {
				// skip declarations (function socketRequest(…) signatures)
				if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 16), m.index))) continue;
				const extracted = argList(code, m.index + m[0].length - 1);
				if (extracted === null) continue;
				const args = splitArgs(extracted.argsText);
				const methodArg = args[seam.methodIdx];
				if (methodArg === undefined) continue;
				const params = resolveParams(code, args, seam.paramsIdx, m.index);
				checkCall(findings, file.path, code, m.index, seam.forwardOk, methodArg, params);
			}
		}
	}
	if (options.requireDenylist === true && !sawGuards) {
		findings.push({
			rule: "denylist-missing",
			path: "(scan set)",
			line: 0,
			detail: "src/herdr/guards.ts was not in the scan set; the runtime denylist cannot be verified",
		});
	}
	return findings;
}

/** Recursively collect all `.ts` files under root (paths rebased to "src/…"). */
export function collectSrcFiles(root: string): SourceFile[] {
	const out: SourceFile[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				walk(full);
			} else if (name.endsWith(".ts")) {
				// lastIndexOf: the repo root itself may live under a ".../src/" dir
				const srcIdx = full.lastIndexOf("/src/");
				out.push({
					path: srcIdx >= 0 ? full.slice(srcIdx + 1) : full,
					content: readFileSync(full, "utf8"),
				});
			}
		}
	};
	walk(root);
	return out;
}

if (import.meta.main) {
	const root = process.argv[2] ?? join(import.meta.dir, "../src");
	const findings = scanSources(collectSrcFiles(root), { requireDenylist: true });
	for (const f of findings) {
		console.log(`${f.rule} ${f.path}:${f.line} — ${f.detail}`);
	}
	console.log(`${findings.length} finding(s)`);
	process.exit(findings.length === 0 ? 0 : 1);
}
