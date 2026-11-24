// Builds a dark-themed, mobile-friendly static docs site for herdr-omp-lens.
// Usage: bun build.mjs <repoRoot> <outDir>   (requires `marked` installed in cwd)
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const repoRoot = process.argv[2] || process.cwd();
const outDir = process.argv[3] || join(process.cwd(), "site");
mkdirSync(outDir, { recursive: true });
marked.setOptions({ gfm: true, breaks: false });

const groups = [
  { name: "Start here", docs: [
    { src: "README.md", out: "readme.html", title: "README — what & why" },
  ]},
  { name: "Design", docs: [
    { src: "docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md", out: "sdd.html", title: "Software Design Document" },
    { src: "docs/adr/0001-observation-seam.md", out: "adr-0001.html", title: "ADR-0001 — Observation seam" },
  ]},
  { name: "Long-horizon plan", docs: [
    { src: "docs/plans/00-master-plan.md", out: "master-plan.html", title: "Master plan — v1/v2 + DoD" },
    { src: "docs/plans/specs/00-reconciliation.md", out: "reconciliation.html", title: "Cross-spec reconciliation" },
  ]},
  { name: "v1 phase specs", docs: [
    { src: "docs/plans/specs/phase-01-foundation-spec.md", out: "phase-01.html", title: "P1 — Foundation" },
    { src: "docs/plans/specs/phase-02-observation-spec.md", out: "phase-02.html", title: "P2 — Observation" },
    { src: "docs/plans/specs/phase-03-viewer-spec.md", out: "phase-03.html", title: "P3 — Viewer" },
    { src: "docs/plans/specs/phase-04-topology-spec.md", out: "phase-04.html", title: "P4 — Topology" },
    { src: "docs/plans/specs/phase-05-history-spec.md", out: "phase-05.html", title: "P5 — History & restart" },
    { src: "docs/plans/specs/phase-06-hardening-spec.md", out: "phase-06.html", title: "P6 — Hardening & release" },
  ]},
  { name: "Evidence", docs: [
    { src: "docs/analysis/research-seams.md", out: "research-seams.html", title: "Seam research (cited)" },
    { src: "docs/analysis/phase-0-probe-report.md", out: "probe-report.html", title: "Phase 0 probe report" },
    { src: "docs/analysis/review-agy-hydrogen-2026-11-24.md", out: "review-agy.html", title: "Adversarial review (agy-hydrogen)" },
  ]},
  { name: "Contributing", docs: [
    { src: "CONTRIBUTING.md", out: "contributing.html", title: "Contributing guide" },
  ]},
];

const all = groups.flatMap((g) => g.docs);
const byBase = new Map(all.map((d) => [basename(d.src), d.out]));

function rewriteLinks(html) {
  return html.replace(/href="([^"]*?)"/g, (m, href) => {
    if (/^(https?:|mailto:|#)/.test(href)) return m;
    const [pathPart, anchor] = href.split("#");
    const base = basename(pathPart);
    if (byBase.has(base)) {
      return `href="${byBase.get(base)}${anchor ? "#" + anchor : ""}"`;
    }
    return m;
  });
}

const css = `
:root{--bg:#0d1117;--bg-alt:#161b22;--bg-inset:#010409;--border:#30363d;--text:#c9d1d9;--heading:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--accent-2:#7ee787;--warn:#d29922;--code:#161b22}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;padding:12px 20px;background:rgba(13,17,23,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
.topbar .brand{font-weight:700;color:var(--heading);letter-spacing:.2px}
.topbar .brand span{color:var(--accent-2)}
.topbar .spacer{flex:1}
.topbar a.index{font-size:14px;color:var(--muted);border:1px solid var(--border);padding:5px 12px;border-radius:999px}
.topbar a.index:hover{color:var(--heading);border-color:var(--accent);text-decoration:none}
.layout{display:grid;grid-template-columns:270px minmax(0,1fr);gap:32px;max-width:1180px;margin:0 auto;padding:28px 24px 80px}
nav.side{position:sticky;top:72px;align-self:start;max-height:calc(100vh - 96px);overflow:auto;font-size:14px}
nav.side .grp{margin:0 0 18px}
nav.side .grp h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
nav.side a{display:block;padding:5px 10px;border-radius:7px;color:var(--text);border-left:2px solid transparent}
nav.side a:hover{background:var(--bg-alt);text-decoration:none}
nav.side a.active{color:var(--heading);background:var(--bg-alt);border-left-color:var(--accent)}
main{min-width:0}
.doc{background:transparent}
.doc h1,.doc h2,.doc h3,.doc h4{color:var(--heading);line-height:1.3;margin:1.6em 0 .6em}
.doc h1{font-size:1.9em;margin-top:.2em;padding-bottom:.3em;border-bottom:1px solid var(--border)}
.doc h2{font-size:1.45em;padding-bottom:.25em;border-bottom:1px solid var(--border)}
.doc h3{font-size:1.2em}
.doc p{margin:.7em 0}
.doc ul,.doc ol{padding-left:1.5em}
.doc li{margin:.3em 0}
.doc code{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:.88em;background:var(--code);border:1px solid var(--border);padding:.15em .4em;border-radius:5px}
.doc pre{background:var(--code);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow:auto}
.doc pre code{background:none;border:none;padding:0;font-size:.85em;line-height:1.5}
.doc blockquote{margin:1em 0;padding:.4em 1em;border-left:3px solid var(--accent);background:var(--bg-alt);border-radius:0 8px 8px 0;color:var(--muted)}
.doc table{border-collapse:collapse;width:100%;margin:1em 0;display:block;overflow:auto}
.doc th,.doc td{border:1px solid var(--border);padding:7px 12px;text-align:left}
.doc th{background:var(--bg-alt);color:var(--heading)}
.doc tr:nth-child(2n) td{background:rgba(22,27,34,.5)}
.doc hr{border:none;border-top:1px solid var(--border);margin:2em 0}
.doc img{max-width:100%}
.pager{display:flex;justify-content:space-between;gap:12px;margin-top:48px;padding-top:20px;border-top:1px solid var(--border);font-size:14px}
.pager a{border:1px solid var(--border);padding:8px 14px;border-radius:8px;color:var(--text)}
.pager a:hover{border-color:var(--accent);text-decoration:none}
footer{max-width:1180px;margin:0 auto;padding:24px;color:var(--muted);font-size:13px;border-top:1px solid var(--border)}
.hero{padding:8px 0 8px}
.hero h1{font-size:2.3em;border:none;margin:.1em 0}
.hero .tag{color:var(--muted);font-size:1.15em;margin:.2em 0 1em}
.badge{display:inline-block;font-size:12px;color:var(--accent-2);border:1px solid var(--border);background:var(--bg-alt);padding:3px 10px;border-radius:999px;margin-bottom:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin:18px 0}
.card{display:block;border:1px solid var(--border);background:var(--bg-alt);border-radius:12px;padding:16px 18px;color:var(--text)}
.card:hover{border-color:var(--accent);text-decoration:none;transform:translateY(-1px)}
.card .k{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.card .t{color:var(--heading);font-weight:600;margin-top:4px}
.group-title{color:var(--heading);font-size:1.05em;margin:26px 0 4px}
@media (max-width:900px){.layout{grid-template-columns:1fr;gap:18px;padding:18px 16px 60px}nav.side{position:static;max-height:none;order:-1;border:1px solid var(--border);border-radius:12px;padding:12px 14px;background:var(--bg-alt)}nav.side .grp{margin-bottom:10px}.doc h1{font-size:1.6em}}
`;

function navHtml(activeOut) {
  return groups.map((g) =>
    `<div class="grp"><h3>${g.name}</h3>` +
    g.docs.map((d) => `<a href="${d.out}"${d.out === activeOut ? ' class="active"' : ""}>${d.title}</a>`).join("") +
    `</div>`
  ).join("");
}

function page(title, bodyHtml, activeOut, idx) {
  const prev = idx > 0 ? all[idx - 1] : null;
  const next = idx < all.length - 1 ? all[idx + 1] : null;
  const pager = `<div class="pager">${prev ? `<a href="${prev.out}">← ${prev.title}</a>` : "<span></span>"}${next ? `<a href="${next.out}">${next.title} →</a>` : "<span></span>"}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>${title} · herdr-omp-lens</title>
<link rel="stylesheet" href="style.css"></head><body>
<div class="topbar"><a class="brand" href="index.html">herdr<span>·</span>omp<span>·</span>lens</a><div class="spacer"></div><a class="index" href="index.html">☰ All docs</a></div>
<div class="layout"><nav class="side">${navHtml(activeOut)}</nav>
<main><article class="doc">${bodyHtml}</article>${pager}</main></div>
<footer>herdr-omp-lens · design &amp; planning docs · dark theme · generated ${new Date().toISOString().slice(0, 10)}</footer>
</body></html>`;
}

let count = 0;
all.forEach((d, i) => {
  const p = join(repoRoot, d.src);
  if (!existsSync(p)) { console.error("MISSING", d.src); return; }
  const md = readFileSync(p, "utf8");
  const html = rewriteLinks(marked.parse(md));
  writeFileSync(join(outDir, d.out), page(d.title, html, d.out, i));
  count++;
});

const cards = groups.map((g) =>
  `<div class="group-title">${g.name}</div><div class="cards">` +
  g.docs.map((d) => `<a class="card" href="${d.out}"><div class="k">${g.name}</div><div class="t">${d.title}</div></a>`).join("") +
  `</div>`
).join("");

const index = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>herdr-omp-lens · docs</title>
<link rel="stylesheet" href="style.css"></head><body>
<div class="topbar"><a class="brand" href="index.html">herdr<span>·</span>omp<span>·</span>lens</a><div class="spacer"></div><a class="index" href="readme.html">README →</a></div>
<div class="layout"><nav class="side">${navHtml(null)}</nav>
<main><div class="hero"><span class="badge">design phase · v1 specs ready for review</span>
<h1>A window into OMP's subagents, from inside Herdr.</h1>
<p class="tag">Read-only live views of OMP's native task workers — no duplicate agents, no focus theft, nothing leaves your machine. These are the design &amp; planning docs, ready to read on the go.</p></div>
${cards}
<div class="group-title">Suggested reading order</div>
<div class="doc"><ol>
<li><a href="readme.html">README</a> — the idea in one minute.</li>
<li><a href="sdd.html">SDD</a> — requirements &amp; architecture.</li>
<li><a href="master-plan.html">Master plan</a> — v1/v2 horizon and Definition of Done.</li>
<li><a href="probe-report.html">Phase 0 probe</a> — the evidence that de-risks it all.</li>
<li><a href="phase-01.html">Phase specs P1–P6</a> — the build plan, step by step.</li>
</ol></div>
</main></div>
<footer>herdr-omp-lens · design &amp; planning docs · dark theme · generated ${new Date().toISOString().slice(0, 10)}</footer>
</body></html>`;
writeFileSync(join(outDir, "index.html"), index);
writeFileSync(join(outDir, "style.css"), css);
console.log(`Built ${count} doc pages + index.html + style.css → ${outDir}`);
