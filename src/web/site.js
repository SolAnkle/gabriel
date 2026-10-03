// Shared helpers for / and /trading. Each page defines render(state) and calls Site.start(render).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n, d) => {
  if (n == null || !isFinite(n)) return '—';
  const f = d ?? (Math.abs(n) >= 1000 ? 0 : 2);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: f, maximumFractionDigits: f });
};
const pct = (n) => n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(1)}%`;
const cls = (n) => (n >= 0 ? 'up' : 'down');
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const hms = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
const stamp = (iso) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const splitDisclosure = (t) => t.split(/\n\n(?=\[holding)/);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const GLOW = { up: '60 200 110', down: '255 50 70', neutral: '70 110 255' };

/** Fit one line of display type to a width. */
function fit(el, width, max = 600) {
  if (!el || !el.textContent.trim() || !width) return;
  let size = 100;
  el.style.fontSize = `${size}px`;
  // Two passes: the second corrects for anything non-linear (kerning, inline-block clamping).
  for (let i = 0; i < 2; i++) {
    const w = el.scrollWidth;
    if (!w) return;
    size = Math.min(max, (size * width) / w);
    el.style.fontSize = `${size}px`;
  }
}
const fitters = [];
function fitAll() {
  fitters.forEach((f) => f());
}
addEventListener('resize', fitAll);
document.fonts?.ready.then(fitAll);
document.fonts?.addEventListener?.('loadingdone', fitAll);

/** Rolling number. */
function roll(el, to, digits) {
  if (!el) return;
  const from = Number(el.dataset.v ?? to * 0.97);
  el.dataset.v = to;
  if (reduced || from === to) { el.textContent = usd(to, digits); return; }
  const t0 = performance.now(), dur = 1600;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
    el.textContent = usd(from + (to - from) * e, digits);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Eased mouse parallax, exposed as --mx / --my (-1..1). */
if (!reduced && matchMedia('(pointer: fine)').matches) {
  let tx = 0, ty = 0, x = 0, y = 0;
  addEventListener('pointermove', (e) => { tx = e.clientX / innerWidth * 2 - 1; ty = e.clientY / innerHeight * 2 - 1; });
  (function loop() {
    x += (tx - x) * .06; y += (ty - y) * .06;
    document.documentElement.style.setProperty('--mx', x.toFixed(4));
    document.documentElement.style.setProperty('--my', y.toFixed(4));
    requestAnimationFrame(loop);
  })();
}

/** Scroll reveals. */
const revealer = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); revealer.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
const observeReveals = () => document.querySelectorAll('.reveal:not(.in)').forEach((el) => revealer.observe(el));

/** Shared chrome: palette accent, mood light, presence dot, handle, footer. */
function renderChrome(s) {
  if (s.visual?.palette?.[2]) document.documentElement.style.setProperty('--accent', s.visual.palette[2]);
  document.documentElement.style.setProperty('--glow', GLOW[s.mood?.tone] || GLOW.neutral);
  if ($('handle')) $('handle').textContent = s.identity ? `@${s.identity.username}` : '';
  const p = $('presence');
  if (p) {
    const mins = s.lastActiveAt ? (Date.now() - Date.parse(s.lastActiveAt)) / 60000 : Infinity;
    p.classList.toggle('on', mins < 30);
    p.querySelector('span').textContent = mins < 30 ? 'Online' : Number.isFinite(mins) ? `Last seen ${ago(s.lastActiveAt)}` : 'Offline';
  }
  const name = s.identity?.name || 'Him';
  if ($('foot-name')) $('foot-name').textContent = name.toUpperCase();
  if ($('foot-disc')) $('foot-disc').textContent = `${name} is a virtual character made with Higgsfield. His posts and trades run automatically. Nothing here is financial advice.`;
  if ($('foot-wallet')) $('foot-wallet').textContent = `Public wallet ${s.wallet}`;
}

/** Treasury chart: area + line + hover readout. */
function drawChart(h) {
  const svg = $('chart'), wrap = $('chartwrap');
  if (!svg) return;
  const W = wrap.clientWidth || 1000, H = wrap.clientHeight || 260;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (h.length < 2) {
    svg.innerHTML = `<line x1="0" x2="${W}" y1="${H - 1}" y2="${H - 1}" stroke="rgba(241,238,230,.2)"/><text x="0" y="${H - 14}" fill="#8a877f" font-family="Geist Mono, monospace" font-size="12">The line starts after his first full day</text>`;
    wrap.onpointermove = null;
    return;
  }
  const ys = h.map((p) => p.treasuryUsd), min = Math.min(...ys), max = Math.max(...ys), span = (max - min) || max * 0.02 || 1;
  const X = (i) => (i / (h.length - 1)) * W, Y = (v) => H - 8 - ((v - min) / span) * (H - 28);
  const line = h.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.treasuryUsd).toFixed(1)}`).join('');
  const up = ys.at(-1) >= ys[0];
  svg.innerHTML = `<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${up ? '#7ee08a' : '#ff5b5b'}" stop-opacity=".22"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
    ${[0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${H * f}" y2="${H * f}" stroke="rgba(241,238,230,.06)"/>`).join('')}
    <path d="${line}L${W},${H}L0,${H}Z" fill="url(#ag)"/>
    <path d="${line}" fill="none" stroke="${up ? 'var(--up)' : 'var(--down)'}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <line id="cx" x1="0" x2="0" y1="0" y2="${H}" stroke="rgba(241,238,230,.4)" stroke-dasharray="2 3" opacity="0"/>
    <circle id="cd" r="4" fill="var(--paper)" opacity="0"/>`;
  wrap.onpointermove = (e) => {
    const r = wrap.getBoundingClientRect();
    const i = Math.max(0, Math.min(h.length - 1, Math.round(((e.clientX - r.left) / r.width) * (h.length - 1))));
    const x = X(i), y = Y(h[i].treasuryUsd);
    for (const [k, v] of [['x1', x], ['x2', x], ['opacity', 1]]) $('cx').setAttribute(k, v);
    for (const [k, v] of [['cx', x], ['cy', y], ['opacity', 1]]) $('cd').setAttribute(k, v);
    const tip = $('tip');
    tip.style.left = `${Math.max(8, Math.min(92, (x / W) * 100))}%`;
    tip.style.opacity = 1;
    tip.textContent = `${usd(h[i].treasuryUsd, 2)} · ${stamp(h[i].at)}`;
  };
  wrap.onpointerleave = () => { $('tip').style.opacity = 0; $('cx')?.setAttribute('opacity', 0); $('cd')?.setAttribute('opacity', 0); };
}

/** Fetch state, render, keep it live. onEvent gets every new ledger event. */
const Site = {
  state: null,
  async start(render, onEvent) {
    const refresh = async () => {
      Site.state = await fetch('/api/state').then((r) => r.json());
      renderChrome(Site.state);
      render(Site.state);
      fitAll();
      observeReveals();
    };
    await refresh();
    requestAnimationFrame(() => document.body.classList.add('ready'));
    setInterval(refresh, 30_000);
    let pending;
    new EventSource('/api/events').onmessage = (m) => {
      onEvent?.(JSON.parse(m.data));
      clearTimeout(pending);
      pending = setTimeout(refresh, 800);
    };
  },
};
