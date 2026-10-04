// The live market page. One self-contained HTML document: it polls
// /api/<token> every few seconds and redraws. Same palette as the PNG cards.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function livePage(meta: { token: string; title: string; description: string; image: string; url: string }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(meta.title)}</title>
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:image" content="${esc(meta.image)}">
<meta property="og:url" content="${esc(meta.url)}">
<meta name="theme-color" content="#FAFAF7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0E0F12" media="(prefers-color-scheme: dark)">
<style>
  :root {
    --bg: #FAFAF7; --card: #FFFFFF; --ink: #111111; --muted: #8C8C88; --line: #E6E5E0;
    --yes: #1E8E5A; --no: #D2453F; --ext: #5B6CF0; --yes-soft: #1E8E5A1A; --no-soft: #D2453F1A;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0E0F12; --card: #16181D; --ink: #F2F2EF; --muted: #8A8B90; --line: #26282E;
      --yes: #2BD47A; --no: #FF5B55; --ext: #7C8CFF; --yes-soft: #2BD47A1F; --no-soft: #FF5B551F;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 560px; margin: 0 auto; padding: 20px 16px calc(32px + env(safe-area-inset-bottom)); }
  .top { display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 600; letter-spacing: .04em; color: var(--muted); }
  .live { display: inline-flex; align-items: center; gap: 6px; color: var(--yes); }
  .live i { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: pulse 1.6s infinite; }
  .live.off { color: var(--muted); } .live.off i { animation: none; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
  h1 { font: 650 26px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; margin: 10px 0 18px; letter-spacing: -.01em; }
  .hero { display: flex; justify-content: space-between; align-items: flex-end; }
  .big { font: 750 72px/1 -apple-system, "SF Pro Display", sans-serif; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
  .pot { text-align: right; }
  .pot b { display: block; font: 700 32px/1 -apple-system, "SF Pro Display", sans-serif; font-variant-numeric: tabular-nums; }
  .sub { color: var(--muted); font-size: 14px; margin-top: 6px; }
  .pays { display: flex; gap: 10px; margin: 18px 0 6px; }
  .pays span { flex: 1; padding: 10px 12px; border-radius: 12px; font-weight: 600; font-size: 15px; }
  .pays .y { background: var(--yes-soft); color: var(--yes); } .pays .n { background: var(--no-soft); color: var(--no); }
  .chart { position: relative; margin: 16px 0 4px; touch-action: none; }
  .chart svg { display: block; width: 100%; height: 200px; overflow: visible; }
  .tip { position: absolute; top: -6px; transform: translateX(-50%); background: var(--ink); color: var(--bg); font-size: 12px; font-weight: 600; padding: 4px 8px; border-radius: 8px; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .15s; }
  .legend { display: flex; gap: 16px; font-size: 13px; color: var(--muted); }
  .legend i { display: inline-block; width: 18px; height: 0; border-top: 3px solid var(--ink); vertical-align: middle; margin-right: 6px; }
  .legend .e i { border-top: 3px dashed var(--ext); }
  .bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: var(--line); margin: 22px 0 8px; }
  .bar div { transition: width .5s ease; } .bar .y { background: var(--yes); } .bar .n { background: var(--no); }
  .split { display: flex; justify-content: space-between; font-weight: 600; font-size: 15px; }
  .split .y { color: var(--yes); } .split .n { color: var(--no); }
  h2 { font-size: 13px; letter-spacing: .06em; color: var(--muted); margin: 28px 0 10px; font-weight: 600; }
  .people { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 20px; }
  .person { display: flex; align-items: center; gap: 8px; font-size: 15px; }
  .person i { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .person b { margin-left: auto; font-variant-numeric: tabular-nums; }
  .empty { color: var(--muted); font-size: 15px; }
  .case { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .case div { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
  .case b { display: block; font-size: 13px; margin-bottom: 6px; }
  .case .y b { color: var(--yes); } .case .n b { color: var(--no); }
  .case ul { margin: 0; padding-left: 16px; font-size: 14px; color: var(--ink); }
  .case li { margin: 3px 0; }
  .why { color: var(--muted); font-size: 14px; margin: -2px 0 12px; }
  .bet { display: flex; gap: 10px; margin-top: 28px; }
  .bet button { flex: 1; border: 0; border-radius: 14px; padding: 14px; font: 650 16px -apple-system, sans-serif; color: #fff; cursor: pointer; }
  .bet .y { background: var(--yes); } .bet .n { background: var(--no); }
  .bet button:active { transform: scale(.98); }
  .note { color: var(--muted); font-size: 13px; text-align: center; margin-top: 10px; }
  footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 28px; }
  .done .bet { display: none; }
</style>
</head>
<body>
<main id="app">
  <div class="top"><span id="tag">#</span><span class="live" id="live"><i></i><span id="status">LIVE</span></span></div>
  <h1 id="q"></h1>
  <div class="hero">
    <div><div class="big" id="pct">—</div><div class="sub">chance of YES</div></div>
    <div class="pot"><b id="pot">—</b><div class="sub" id="potsub">pot</div></div>
  </div>
  <div class="pays"><span class="y" id="py"></span><span class="n" id="pn"></span></div>
  <div class="chart" id="chart"><svg id="svg" viewBox="0 0 600 200" preserveAspectRatio="none"></svg><div class="tip" id="tip"></div></div>
  <div class="legend"><span><i></i>this group</span><span class="e" id="extleg" hidden><i></i><span id="extname"></span></span></div>
  <div class="bar"><div class="y" id="by"></div><div class="n" id="bn"></div></div>
  <div class="split"><span class="y" id="sy"></span><span class="n" id="sn"></span></div>
  <section id="casebox" hidden>
    <h2>WHY IT OPENED AT <span id="prior"></span></h2>
    <div class="why" id="why"></div>
    <div class="case"><div class="y"><b>For YES</b><ul id="cy"></ul></div><div class="n"><b>For NO</b><ul id="cn"></ul></div></div>
  </section>
  <h2>WHO'S IN</h2>
  <div class="people" id="people"></div>
  <div class="bet"><button class="y" id="bety">Bet YES</button><button class="n" id="betn">Bet NO</button></div>
  <div class="note" id="note">Copies the command. Paste it in the group chat.</div>
  <footer id="foot">Connecting…</footer>
</main>
<script>
const TOKEN = ${JSON.stringify(meta.token)};
const $ = (id) => document.getElementById(id);
let data = null, lastOk = 0, shownPct = null;

const fmt = (n) => data.unit === "usd"
  ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 })
  : n.toLocaleString("en-US", { maximumFractionDigits: 2 }) + " coins";
const pct = (p) => Math.round(p * 100) + "%";
const mult = (x) => x == null ? "wins the pot" : "pays " + x.toFixed(x < 10 ? 1 : 0) + "x";
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function until(ms) {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return d + "d " + (h % 24) + "h";
  if (h) return h + "h " + (m % 60) + "m";
  return m + "m " + Math.floor(ms / 1000) % 60 + "s";
}

function animatePct(to) {
  const el = $("pct");
  const from = shownPct ?? to, t0 = performance.now();
  shownPct = to;
  el.style.color = to >= .5 ? css("--yes") : css("--no");
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 600), e = 1 - Math.pow(1 - k, 3);
    el.textContent = pct(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function list(el, items) {
  el.replaceChildren(...items.map((t) => { const li = document.createElement("li"); li.textContent = t; return li; }));
}

function renderStatic() {
  const d = data;
  $("tag").textContent = "#" + d.id;
  $("q").textContent = d.question;
  document.title = "#" + d.id + " " + d.question + " · " + pct(d.yes);
  animatePct(d.yes);
  $("pot").textContent = fmt(d.pot);
  $("potsub").textContent = "pot · " + new Set(d.people.map((p) => p.name)).size + " in";
  $("py").textContent = "YES " + mult(d.pays.yes);
  $("pn").textContent = "NO " + mult(d.pays.no);
  const tot = d.pools.yes + d.pools.no;
  $("by").style.width = tot ? (d.pools.yes / tot * 100) + "%" : "0";
  $("bn").style.width = tot ? (d.pools.no / tot * 100) + "%" : "0";
  $("sy").textContent = "YES " + fmt(d.pools.yes);
  $("sn").textContent = "NO " + fmt(d.pools.no);
  $("extleg").hidden = !d.ext;
  if (d.ext) $("extname").textContent = d.ext.name + (d.ext.history.length ? " " + pct(d.ext.history.at(-1).yes) : "");
  const hasCase = d.reasons || d.why;
  $("casebox").hidden = !hasCase;
  if (hasCase) {
    $("prior").textContent = d.prior != null ? pct(d.prior) : "";
    $("why").textContent = d.why ?? "";
    list($("cy"), d.reasons?.yes ?? []);
    list($("cn"), d.reasons?.no ?? []);
  }
  const people = $("people");
  if (!d.people.length) {
    const e = document.createElement("div"); e.className = "empty"; e.textContent = "No bets yet.";
    people.replaceChildren(e);
  } else {
    people.replaceChildren(...d.people.map((p) => {
      const row = document.createElement("div"); row.className = "person";
      const dot = document.createElement("i"); dot.style.background = css(p.side === "yes" ? "--yes" : "--no");
      const name = document.createElement("span"); name.textContent = p.name;
      const amt = document.createElement("b"); amt.textContent = fmt(p.amount);
      row.append(dot, name, amt); return row;
    }));
  }
  document.body.classList.toggle("done", d.status !== "open");
  drawChart();
}

// ---- chart: step lines over time, with a touch/hover readout ----
const W = 600, H = 200, PADR = 34;
let geom = null;
function drawChart() {
  const d = data, svg = $("svg");
  const t0 = d.createdAt, t1 = Math.max(d.now, t0 + 60000);
  const x = (t) => (Math.max(t, t0) - t0) / (t1 - t0) * (W - PADR);
  const y = (p) => H - 8 - p * (H - 16);
  const path = (pts) => pts.map((p, i) => (i ? "H" + x(p.t).toFixed(1) + " V" : "M" + x(p.t).toFixed(1) + ",") + y(p.yes).toFixed(1)).join(" ") + " H" + x(t1).toFixed(1);
  const grid = [0, .5, 1].map((g) =>
    '<line x1="0" x2="' + (W - PADR) + '" y1="' + y(g) + '" y2="' + y(g) + '" stroke="' + css("--line") + '" stroke-width="1" vector-effect="non-scaling-stroke"/>' +
    '<text x="' + W + '" y="' + (y(g) + 4) + '" text-anchor="end" font-size="11" fill="' + css("--muted") + '">' + g * 100 + '%</text>').join("");
  const ext = d.ext && d.ext.history.length
    ? '<path d="' + path(d.ext.history) + '" fill="none" stroke="' + css("--ext") + '" stroke-width="2.5" stroke-dasharray="7 6" vector-effect="non-scaling-stroke"/>'
    : "";
  const last = d.history.at(-1).yes;
  svg.innerHTML = grid + ext +
    '<path d="' + path(d.history) + '" fill="none" stroke="' + css("--ink") + '" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
    '<circle cx="' + x(t1) + '" cy="' + y(last) + '" r="5" fill="' + css("--ink") + '"/>' +
    '<line id="cross" y1="0" y2="' + H + '" stroke="' + css("--muted") + '" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0"/>' +
    '<circle id="hdot" r="5" fill="' + css("--ink") + '" opacity="0"/>';
  geom = { t0, t1, x, y };
}

function valueAt(points, t) {
  let v = points[0].yes;
  for (const p of points) { if (p.t <= t) v = p.yes; else break; }
  return v;
}

function readout(ev) {
  if (!geom) return;
  const box = $("svg").getBoundingClientRect();
  const fx = Math.min(1, Math.max(0, (ev.clientX - box.left) / (box.width * (W - PADR) / W)));
  const t = geom.t0 + fx * (geom.t1 - geom.t0);
  const v = valueAt(data.history, t);
  const sx = fx * (W - PADR);
  const cross = $("cross"), dot = $("hdot"), tip = $("tip");
  cross.setAttribute("x1", sx); cross.setAttribute("x2", sx); cross.setAttribute("opacity", 1);
  dot.setAttribute("cx", sx); dot.setAttribute("cy", geom.y(v)); dot.setAttribute("opacity", 1);
  const ext = data.ext && data.ext.history.length ? " · " + data.ext.name + " " + pct(valueAt(data.ext.history, t)) : "";
  tip.textContent = pct(v) + ext + " · " + new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  tip.style.left = (fx * box.width * (W - PADR) / W) + "px";
  tip.style.opacity = 1;
}
function hideReadout() {
  for (const id of ["cross", "hdot"]) $(id)?.setAttribute("opacity", 0);
  $("tip").style.opacity = 0;
}
$("chart").addEventListener("pointermove", readout);
$("chart").addEventListener("pointerdown", readout);
$("chart").addEventListener("pointerleave", hideReadout);
$("chart").addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") setTimeout(hideReadout, 1200); });

// ---- bet buttons copy the command ----
async function copy(side) {
  const cmd = "!" + side + " " + data.id + " " + data.hint;
  try { await navigator.clipboard.writeText(cmd); $("note").textContent = "Copied “" + cmd + "”. Paste it in the group chat."; }
  catch { $("note").textContent = "Send “" + cmd + "” in the group chat."; }
}
$("bety").onclick = () => copy("yes");
$("betn").onclick = () => copy("no");

// ---- live loop ----
function tick() {
  if (!data) return;
  const live = $("live"), st = $("status");
  const open = data.status === "open";
  live.classList.toggle("off", !open || Date.now() - lastOk > 15000);
  st.textContent = data.status === "resolved" ? "RESOLVED " + (data.outcome || "").toUpperCase()
    : data.status === "closed" ? "LOCKED"
    : data.closesAt ? "LIVE · CLOSES IN " + until(data.closesAt - Date.now()).toUpperCase()
    : "LIVE";
  const ago = Math.round((Date.now() - lastOk) / 1000);
  $("foot").textContent = Date.now() - lastOk > 15000 ? "Reconnecting…" : "Updated " + (ago < 2 ? "just now" : ago + "s ago");
}
async function poll() {
  try {
    const r = await fetch("/api/" + TOKEN, { cache: "no-store" });
    if (r.ok) { data = await r.json(); lastOk = Date.now(); renderStatic(); }
  } catch {}
  tick();
}
poll();
setInterval(poll, 3000);
setInterval(tick, 1000);
addEventListener("resize", () => data && drawChart());
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => data && renderStatic());
</script>
</body>
</html>`;
}
