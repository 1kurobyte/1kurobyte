// desktop.js - a small Hyprland-style tiling session for the portfolio.
//
// Every project is a standalone page under apps/<id>/; opening it tiles an
// <iframe> into the current workspace with the dwindle layout (each new
// window splits the last one along its longer side). An app only runs while
// its window exists: closing the window destroys the iframe, and with it the
// app's workers or emulator.

(async function () {
  'use strict';
  const $ = (sel, el = document) => el.querySelector(sel);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid);
    return el;
  };

  const cfg = await (await fetch('apps.json')).json();
  const ABOUT = { id: 'about', name: 'README.md', icon: '~/', color: '#cdd6f4', kind: 'about' };
  const apps = Object.fromEntries([ABOUT, ...cfg.apps].map((a) => [a.id, a]));
  const WORKSPACES = 5;
  const small = () => matchMedia('(max-width: 720px)').matches;

  // --- neofetch-style summary ---------------------------------------------------
  function fetchBlock() {
    const logo = [
      '      /\\      ', '     /  \\     ', '    / /\\ \\    ', '   / /  \\ \\   ',
      '  / /    \\ \\  ', ' / / ____ \\ \\ ', '/_/ /____\\ \\_\\',
    ];
    const kernels = 'kaname (Zig, x86) · Linux 6.x in v86';
    const info = [
      `<span class="k">${cfg.owner}</span>@<span class="k">portfolio</span>`,
      '-'.repeat(cfg.owner.length + 10),
      `<span class="k">OS</span>: WebAssembly on ${navigator.userAgentData?.platform || navigator.platform || 'the web'}`,
      `<span class="k">WM</span>: dwindle.js (Hyprland-ish)`,
      `<span class="k">Kernel</span>: ${kernels}`,
      `<span class="k">Shell</span>: trash (bytecode VM)`,
      `<span class="k">Projects</span>: ${cfg.apps.map((a) => a.name).join(', ')}`,
      `<span class="k">CPU</span>: ${navigator.hardwareConcurrency || '?'} threads${self.crossOriginIsolated ? ' (shared memory on)' : ''}`,
      '',
      cfg.apps.map((a) => `<span class="sw" style="background:${a.color}"></span>`).join(''),
    ];
    const art = [...Array(Math.max(0, (info.length - logo.length) >> 1)).fill(''), ...logo];
    return art.map((l, i) => `<span class="l">${l.padEnd(14).replace(/</g, '&lt;')}</span>   ${info[i] || ''}`).concat(info.slice(art.length).map((l) => ' '.repeat(17) + l)).join('\n');
  }

  // --- boot log (the TTY before the compositor) ----------------------------------
  async function boot() {
    const el = $('#boot'), log = $('#bootlog');
    let skip = false;
    try { skip = sessionStorage.getItem('booted') === '1'; } catch (e) { /* storage blocked */ }
    const done = () => { el.classList.add('done'); setTimeout(() => el.remove(), 400); };
    if (skip || matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
    const finish = () => { skip = true; };
    addEventListener('keydown', finish, { once: true });
    el.addEventListener('pointerdown', finish, { once: true });
    const t0 = performance.now();
    const stamp = () => `[${((performance.now() - t0) / 1000).toFixed(6).padStart(12)}]`;
    const lines = [
      `<span class="hl">${cfg.owner}</span> login: guest (automatic login)`,
      `${stamp()} wasm: ${typeof WebAssembly === 'object' ? 'supported' : 'MISSING'}`,
      `${stamp()} SharedArrayBuffer: ${self.crossOriginIsolated ? 'available (cross-origin isolated)' : 'pending isolation'}`,
      ...cfg.apps.map((a) => `${stamp()} mount /apps/${a.id.padEnd(7)} ${a.kind.padEnd(18, '.')} <span class="ok">ok</span>`),
      `${stamp()} exec-once = dwindle.js`,
    ];
    for (const l of lines) {
      if (skip) break;
      log.innerHTML += l + '\n';
      await new Promise((r) => setTimeout(r, 110));
    }
    try { sessionStorage.setItem('booted', '1'); } catch (e) { /* ignore */ }
    done();
  }

  // --- bar ---------------------------------------------------------------------------
  $('#owner').textContent = cfg.owner;
  const coi = $('#coi');
  coi.textContent = self.crossOriginIsolated ? '● threads' : '… threads';
  coi.className = 'chip ' + (self.crossOriginIsolated ? 'ok' : 'warn');
  coi.title = self.crossOriginIsolated
    ? 'Cross-origin isolated: SharedArrayBuffer and WebAssembly threads are available.'
    : 'Waiting for cross-origin isolation (the service worker reloads the page once). Cub3D and FdF need it.';
  $('#cpu').textContent = `cpu ${navigator.hardwareConcurrency || '?'}`;
  const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  tick(); setInterval(tick, 10000);
  $('#empty .fetch').innerHTML = fetchBlock() + '\n\n' + ' '.repeat(17) + '<span class="dim">workspace is empty — Alt+D to launch something</span>';

  // --- state -------------------------------------------------------------------------------
  const wins = {};                  // id -> { el, ws }
  const ws = Array.from({ length: WORKSPACES + 1 }, () => ({ order: [], focus: null, full: false }));
  let current = 1;

  function renderWorkspaces() {
    const nav = $('#workspaces');
    nav.replaceChildren(...Array.from({ length: WORKSPACES }, (_, i) => {
      const n = i + 1;
      return h('button', { class: (n === current ? 'active ' : '') + (ws[n].order.length ? 'used' : ''),
        title: ws[n].order.map((id) => apps[id].name).join(', ') || 'empty', onclick: () => switchTo(n) }, String(n));
    }));
  }

  function renderTitle() {
    const w = ws[current], id = w.focus;
    $('#wintitle').innerHTML = id ? `<span class="app">${apps[id].name}</span>${apps[id].kind && id !== 'about' ? ' — ' + apps[id].kind : ''}` : `workspace ${current}`;
    $('#winctl').hidden = !id;
    $('#empty').hidden = w.order.length > 0;
  }

  // --- layout: dwindle -------------------------------------------------------------------------
  const GAP = 10;
  function dwindle(ids, r, out) {
    if (!ids.length) return out;
    if (ids.length === 1) { out[ids[0]] = r; return out; }
    const [first, ...rest] = ids;
    if (r.w >= r.h) {
      const w1 = (r.w - GAP) / 2;
      out[first] = { x: r.x, y: r.y, w: w1, h: r.h };
      return dwindle(rest, { x: r.x + w1 + GAP, y: r.y, w: r.w - w1 - GAP, h: r.h }, out);
    }
    const h1 = (r.h - GAP) / 2;
    out[first] = { x: r.x, y: r.y, w: r.w, h: h1 };
    return dwindle(rest, { x: r.x, y: r.y + h1 + GAP, w: r.w, h: r.h - h1 - GAP }, out);
  }

  function layout() {
    const area = $('#tiles').getBoundingClientRect();
    const full = { x: 0, y: 0, w: area.width, h: area.height };
    for (const [id, win] of Object.entries(wins)) win.el.classList.toggle('hidden', win.ws !== current);
    const w = ws[current];
    let rects;
    if (w.full || small()) {
      rects = {};
      for (const id of w.order) rects[id] = full;
      for (const id of w.order) wins[id].el.classList.toggle('hidden', id !== w.focus);
    } else rects = dwindle(w.order, full, {});
    for (const [id, r] of Object.entries(rects)) {
      Object.assign(wins[id].el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    }
    for (const [id, win] of Object.entries(wins)) win.el.classList.toggle('active', id === w.focus);
    renderWorkspaces();
    renderTitle();
  }
  addEventListener('resize', layout);

  // --- windows ------------------------------------------------------------------------------------
  function focus(id) {
    if (!wins[id]) return;
    if (wins[id].ws !== current) { current = wins[id].ws; }
    ws[current].focus = id;
    layout();
    const frame = $('iframe', wins[id].el);
    setTimeout(() => { try { frame ? frame.contentWindow.focus() : wins[id].el.focus(); } catch (e) { /* ignore */ } }, 0);
    history.replaceState(null, '', id === 'about' ? location.pathname : '#' + id);
  }

  function open(id) {
    if (wins[id]) return focus(id);
    const a = apps[id];
    if (!a) return;
    const inner = h('div', { class: 'inner' });
    if (a.src) {
      const frame = h('iframe', { src: a.src, title: a.name, allow: 'fullscreen; pointer-lock; clipboard-write' });
      frame.addEventListener('load', () => hookKeys(frame));
      inner.append(frame);
    } else inner.append(renderAbout());
    const el = h('section', { class: 'win opening', role: 'region', 'aria-label': a.name, tabindex: '-1' }, inner);
    el.addEventListener('pointerdown', () => { if (ws[current].focus !== id) focus(id); }, true);
    $('#tiles').append(el);
    wins[id] = { el, ws: current };
    const w = ws[current];
    w.order.push(id);
    w.full = false;
    focus(id);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('opening')));
  }

  function close(id = ws[current].focus) {
    const win = wins[id];
    if (!win) return;
    const w = ws[win.ws];
    const i = w.order.indexOf(id);
    w.order.splice(i, 1);
    win.el.remove(); // drops the iframe: its workers and emulator go with it
    delete wins[id];
    w.focus = w.order[Math.min(i, w.order.length - 1)] || null;
    if (!w.order.length) w.full = false;
    layout();
    if (w.focus) focus(w.focus); else history.replaceState(null, '', location.pathname);
  }

  function switchTo(n) {
    current = n;
    layout();
    if (ws[n].focus) focus(ws[n].focus); else history.replaceState(null, '', location.pathname);
  }

  function moveTo(n) {
    const id = ws[current].focus;
    if (!id || n === current) return;
    const from = ws[current];
    from.order.splice(from.order.indexOf(id), 1);
    from.focus = from.order[from.order.length - 1] || null;
    wins[id].ws = n;
    ws[n].order.push(id);
    ws[n].focus = id;
    layout();
  }

  function toggleFull() { if (ws[current].focus) { ws[current].full = !ws[current].full; layout(); } }

  function moveFocus(dir) {
    const w = ws[current];
    if (!w.focus || w.order.length < 2) return;
    if (w.full || small()) { // monocle: cycle
      const i = w.order.indexOf(w.focus), d = dir === 'l' || dir === 'u' ? -1 : 1;
      return focus(w.order[(i + d + w.order.length) % w.order.length]);
    }
    const c = (id) => { const r = wins[id].el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const [fx, fy] = c(w.focus);
    let best = null, bestD = Infinity;
    for (const id of w.order) {
      if (id === w.focus) continue;
      const [x, y] = c(id), dx = x - fx, dy = y - fy;
      const ok = { l: dx < -1, r: dx > 1, u: dy < -1, d: dy > 1 }[dir];
      const d = Math.abs(dx) + Math.abs(dy) * (dir === 'l' || dir === 'r' ? 2 : 0.5);
      if (ok && d < bestD) { best = id; bestD = d; }
    }
    if (best) focus(best);
  }

  function swap(d) {
    const w = ws[current], i = w.order.indexOf(w.focus), j = i + d;
    if (i < 0 || j < 0 || j >= w.order.length) return;
    [w.order[i], w.order[j]] = [w.order[j], w.order[i]];
    layout();
  }

  // --- keybinds (Alt as the mod key) -------------------------------------------------------------------
  function onKey(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase(), code = e.code;
    let handled = true;
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit && +digit[1] <= WORKSPACES) e.shiftKey ? moveTo(+digit[1]) : switchTo(+digit[1]);
    else if (code === 'KeyD') toggleLauncher(true);
    else if (code === 'KeyQ') close();
    else if (code === 'KeyF') toggleFull();
    else if (code === 'Enter') open('trash');
    else if (e.shiftKey && (k === 'arrowleft' || code === 'KeyH')) swap(-1);
    else if (e.shiftKey && (k === 'arrowright' || code === 'KeyL')) swap(1);
    else if (k === 'arrowleft' || code === 'KeyH') moveFocus('l');
    else if (k === 'arrowright' || code === 'KeyL') moveFocus('r');
    else if (k === 'arrowup' || code === 'KeyK') moveFocus('u');
    else if (k === 'arrowdown' || code === 'KeyJ') moveFocus('d');
    else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  }
  addEventListener('keydown', onKey, true);
  // Apps are same-origin, so the binds also work while an app has focus.
  function hookKeys(frame) {
    try { frame.contentWindow.addEventListener('keydown', onKey, true); } catch (e) { /* not same-origin */ }
  }

  // --- launcher (wofi) ------------------------------------------------------------------------------------
  const launcher = $('#launcher'), q = $('#launcher-q'), list = $('#launcher-list');
  let sel = 0, shown = [];
  function renderLauncher() {
    const term = q.value.trim().toLowerCase();
    shown = Object.values(apps).filter((a) => !term || (a.name + ' ' + (a.kind || '') + ' ' + (a.tags || []).join(' ')).toLowerCase().includes(term));
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((a, i) => h('li', { class: i === sel ? 'sel' : '', onclick: () => { toggleLauncher(false); open(a.id); } },
      h('span', { class: 'g', style: { color: a.color } }, a.icon), a.name, h('span', { class: 'd' }, (wins[a.id] ? '● ' : '') + (a.kind || '')))));
  }
  function toggleLauncher(show) {
    launcher.hidden = !show;
    if (show) { q.value = ''; sel = 0; renderLauncher(); q.focus(); }
  }
  q.addEventListener('input', () => { sel = 0; renderLauncher(); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { sel = (sel + 1) % Math.max(1, shown.length); renderLauncher(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { sel = (sel - 1 + shown.length) % Math.max(1, shown.length); renderLauncher(); e.preventDefault(); }
    else if (e.key === 'Enter' && shown[sel]) { toggleLauncher(false); open(shown[sel].id); }
    else if (e.key === 'Escape') toggleLauncher(false);
  });
  launcher.addEventListener('pointerdown', (e) => { if (e.target === launcher) toggleLauncher(false); });
  $('#launcher-btn').onclick = () => toggleLauncher(launcher.hidden);

  const binds = $('#binds');
  $('#keys-btn').onclick = () => { binds.hidden = !binds.hidden; };
  binds.addEventListener('pointerdown', () => { binds.hidden = true; });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { binds.hidden = true; toggleLauncher(false); } });
  $('#btn-close').onclick = () => close();
  $('#btn-float').onclick = toggleFull;

  // --- README window -------------------------------------------------------------------------------------
  function renderAbout() {
    const node = $('#tpl-about').content.cloneNode(true);
    $('.fetch', node).innerHTML = fetchBlock();
    $('.tagline', node).textContent = cfg.tagline;
    $('.cards', node).append(...cfg.apps.map((a) => h('article', { class: 'card' },
      h('header', {}, h('span', { class: 'glyph', style: { color: a.color } }, a.icon), h('h2', {}, a.name), h('span', { class: 'kind' }, a.kind)),
      h('p', {}, a.summary),
      h('p', { class: 'how' }, a.how),
      h('div', { class: 'tags' }, a.tags.map((t) => h('span', {}, t))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => open(a.id) }, '▶ launch'),
        h('a', { class: 'btn', href: a.repo, target: '_blank', rel: 'noopener' }, 'source ↗'),
        h('a', { class: 'btn', href: a.src, target: '_blank', rel: 'noopener', title: 'Open alone in a new tab' }, 'tab ↗')))));
    return node.firstElementChild;
  }

  addEventListener('hashchange', () => { const id = location.hash.slice(1); if (apps[id]) open(id); });

  await boot();
  const start = location.hash.slice(1);
  open('about');
  if (apps[start] && start !== 'about') open(start);
})();
