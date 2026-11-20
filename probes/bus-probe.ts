// Phase 0 throwaway probe — confirms whether pi.events carries task:subagent:* on OMP 19.0.1.
// NOT part of the shipped extension. Writes frames to PROBE_OUT for inspection.
// The bus surface is undocumented; it is introspected reflectively as `unknown`.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const OUT = process.env.PROBE_OUT || "/tmp/lens-probe";
mkdirSync(OUT, { recursive: true });
const frames = OUT + "/frames.jsonl";
const meta = OUT + "/meta.json";

function rec(channel: string, payload: unknown): void {
  let safe: unknown = payload;
  try {
    safe = JSON.parse(
      JSON.stringify(payload, (_k, v: unknown) =>
        typeof v === "string" && v.length > 1500 ? v.slice(0, 1500) + "…[trunc]" : v,
      ),
    );
  } catch {
    safe = String(payload);
  }
  try {
    appendFileSync(frames, JSON.stringify({ channel, t: Date.now(), payload: safe }) + "\n");
  } catch {
    /* ignore */
  }
}

export default function busProbe(pi: ExtensionAPI): void {
  const busRaw: unknown = pi.events;
  const subscribed: string[] = [];
  const info: Record<string, unknown> = {
    hasEvents: busRaw != null,
    typeofEvents: typeof busRaw,
    subscribed,
  };

  if (busRaw && typeof busRaw === "object") {
    // Undocumented bus boundary: named cast for dynamic introspection only; no schema exists.
    const busObj = busRaw as Record<string, unknown>;
    const ctor = busObj.constructor;
    if (typeof ctor === "function") info.constructor = ctor.name;

    const methods = new Set<string>();
    let o: unknown = busRaw;
    while (o && typeof o === "object") {
      Object.getOwnPropertyNames(o).forEach((n) => methods.add(n));
      o = Object.getPrototypeOf(o);
    }
    info.methods = [...methods].sort();

    const channels = [
      "task:subagent:event",
      "task:subagent:progress",
      "task:subagent:lifecycle",
    ];
    for (const ch of channels) {
      for (const m of ["on", "subscribe", "addListener", "addEventListener"]) {
        const fn = busObj[m];
        if (typeof fn === "function") {
          try {
            Reflect.apply(fn, busRaw, [ch, (p: unknown) => rec(ch, p)]);
            subscribed.push(`${ch}:${m}`);
            break;
          } catch (e) {
            info[`err_${ch}_${m}`] = String(e);
          }
        }
      }
    }
  }
  writeFileSync(meta, JSON.stringify(info, null, 2));

  pi.on("before_subagent_spawn", (event) => rec("hook:before_subagent_spawn", event));
  pi.on("session_shutdown", () => rec("__shutdown__", { ok: true }));
}
