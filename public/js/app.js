import { Snapshot, DEFAULT_CALIBRATION } from './snapshot.js';
import { VEHICLE_COLORS } from './colors.js';
import * as pawn from './pawn.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const store = {
    get(key, fallback) {
        try { const v = localStorage.getItem(key); return v ? { ...fallback, ...JSON.parse(v) } : { ...fallback }; } catch { return { ...fallback }; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* no storage */ }
    },
};

const DEFAULT_STATE = {
    model: 411, kind: 'vehicle', source: '',
    rx: -16, ry: 0, rz: -55, zoom: 1,
    bg: [0, 0, 0, 0x99], c1: 1, c2: 1,
    x: 240, y: 150, width: 160, height: 160,
    player: false, selectable: false, varName: 'td', extra: '',
};
const state = store.get('td-preview-state', DEFAULT_STATE);
const calib = store.get('td-preview-calib', DEFAULT_CALIBRATION);

let catalog = [];
let kindFilter = '';
let screenBg = null;

const snapshot = new Snapshot(() => requestRender());

// ---------------- render ----------------

let renderQueued = false;
function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        draw();
    });
}

function draw() {
    const shot = snapshot.render(state, calib, 512);
    const w = Math.abs(state.width) || 1, h = Math.abs(state.height) || 1;

    // Large preview: same aspect ratio as the textdraw
    const pv = $('#preview');
    const ar = w / h;
    const PW = ar >= 1 ? 512 : Math.round(512 * ar);
    const PH = ar >= 1 ? Math.round(512 / ar) : 512;
    if (pv.width !== PW || pv.height !== PH) { pv.width = PW; pv.height = PH; }
    const pctx = pv.getContext('2d');
    pctx.clearRect(0, 0, PW, PH);
    pctx.drawImage(shot, 0, 0, PW, PH);

    // 640x448 screen
    const sc = $('#screen-canvas');
    const ctx = sc.getContext('2d');
    const k = sc.width / 640;
    if (screenBg) ctx.drawImage(screenBg, 0, 0, sc.width, sc.height);
    else {
        const g = ctx.createLinearGradient(0, 0, 0, sc.height);
        g.addColorStop(0, '#6d8fb3'); g.addColorStop(0.55, '#c9b48d'); g.addColorStop(0.56, '#5d5a4f'); g.addColorStop(1, '#2f2e2a');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, sc.width, sc.height);
    }
    ctx.drawImage(shot, state.x * k, state.y * k, w * k, h * k);
    ctx.strokeStyle = 'rgba(240,168,60,.6)';
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(state.x * k + 0.5, state.y * k + 0.5, w * k, h * k);
    ctx.setLineDash([]);

    $('#code').innerHTML = highlight(pawn.generate(state));
    store.set('td-preview-state', state);
}

// ---------------- model ----------------

let loadSeq = 0;
async function loadModel(id) {
    id = Number(id);
    if (!Number.isInteger(id)) return;
    const seq = ++loadSeq;
    state.model = id;
    $('#model-id').value = id;
    setStatus('Carregando modelo…', 'loading');
    try {
        const info = await snapshot.load(id, state.source);
        if (seq !== loadSeq || !info) return;
        state.kind = info.kind;
        const extras = snapshot.extras;
        if (!extras.includes(state.extra)) state.extra = extras[0] ?? '';
        $('#extra').innerHTML = '<option value="">nenhum</option>' + extras.map((e) => `<option>${e}</option>`).join('');
        $('#extra').value = state.extra;
        $('#extra-row').hidden = !extras.length;
        const label = { skin: 'Skin', vehicle: 'Veículo', object: 'Objeto' }[info.kind];
        $('#model-name').innerHTML = `<span class="tag">${label}</span><b></b><span class="model-file"></span><span class="tag src">${info.source === 'local' ? 'jogo local' : 'open.mp'}</span>`;
        $('#model-name b').textContent = info.name;
        $('#model-name .model-file').textContent = info.name !== info.model ? ` · ${info.model}.dff` : '';
        setStatus('');
    } catch (e) {
        if (seq !== loadSeq) return;
        snapshot.clear();
        state.kind = id >= 400 && id <= 611 ? 'vehicle' : id >= 0 && id <= 311 ? 'skin' : 'object';
        $('#model-name').textContent = '';
        setStatus(e.message, 'error');
    }
    $('#vehcol-row').hidden = state.kind !== 'vehicle';
    syncInputs();
    requestRender();
}

function setStatus(text, kind = '') {
    const el = $('#status');
    el.textContent = text;
    el.className = kind || 'muted';
}

const escapeHtml = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
function highlight(code) {
    return escapeHtml(code)
        .replace(/("[^"]*")|\b(TEXT_DRAW_FONT_MODEL_PREVIEW|true|false)\b|\b(\w+)(?=\()|(-?\b0x[0-9A-F]+\b|-?\b\d+(?:\.\d+)?\b)/gi, (m, str, cst, fn, num) =>
            str ? `<span class="str">${str}</span>` : cst ? `<span class="cst">${cst}</span>` : fn ? `<span class="fn">${fn}</span>` : `<span class="num">${num}</span>`);
}

function step(dir) {
    const list = catalog.filter((c) => !kindFilter || c[3] === kindFilter);
    if (!list.length) return;
    let i = list.findIndex((c) => (dir > 0 ? c[0] > state.model : c[0] >= state.model));
    if (dir > 0) i = i === -1 ? 0 : i;
    else i = (i === -1 ? list.length : i) - 1;
    loadModel(list[(i + list.length) % list.length][0]);
}

// ---------------- search ----------------

function renderResults() {
    const q = $('#search').value.trim().toLowerCase();
    const ul = $('#results');
    ul.innerHTML = '';
    if (!q) return;
    const isNum = /^\d+$/.test(q);
    const hits = [];
    for (const c of catalog) {
        if (kindFilter && c[3] !== kindFilter) continue;
        if (isNum ? String(c[0]).startsWith(q) : c[1].includes(q) || c[2].toLowerCase().includes(q)) hits.push(c);
        if (hits.length >= 200) break;
    }
    for (const [id, model, name, kind] of hits) {
        const li = document.createElement('li');
        li.innerHTML = `<b>${id}</b><span></span><i>${{ s: 'skin', v: 'veículo', o: 'objeto' }[kind]}</i>`;
        li.querySelector('span').textContent = name ? `${name} (${model})` : model;
        li.onclick = () => { closeResults(); loadModel(id); };
        ul.appendChild(li);
    }
}

function closeResults() {
    $('#search').value = '';
    $('#results').innerHTML = '';
}

function moveActive(dir) {
    const items = $$('#results li');
    if (!items.length) return;
    let i = items.findIndex((li) => li.classList.contains('active'));
    items[i]?.classList.remove('active');
    i = Math.max(0, Math.min(items.length - 1, i + dir));
    items[i].classList.add('active');
    items[i].scrollIntoView({ block: 'nearest' });
}

// ---------------- inputs ----------------

const wrapAngle = (a) => {
    a = ((((a + 180) % 360) + 360) % 360) - 180;
    return Math.round(a * 100) / 100;
};

function syncInputs() {
    for (const el of $$('.slider')) {
        const key = el.dataset.key;
        for (const input of el.querySelectorAll('input')) if (document.activeElement !== input) input.value = state[key];
    }
    const hexColor = '#' + state.bg.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
    $('#bg-color').value = hexColor;
    $('#bg-alpha').value = state.bg[3];
    $('#c1').value = state.c1;
    $('#c2').value = state.c2;
    $('#c1-swatch').style.background = vehColorCss(state.c1);
    $('#c2-swatch').style.background = vehColorCss(state.c2);
    $('#td-x').value = state.x;
    $('#td-y').value = state.y;
    $('#td-w').value = state.width;
    $('#td-h').value = state.height;
    $('#td-player').checked = state.player;
    $('#td-selectable').checked = state.selectable;
    $('#td-var').value = state.varName;
    $('#source-select').value = state.source;
    $('#cal-order').value = calib.order;
    $('#cal-side').value = String(calib.cameraSide);
    $('#cal-fov').value = calib.fov;
    $('#cal-dist').value = calib.distance;
    $('#cal-stretch').checked = calib.stretch;
}

function vehColorCss(id) {
    const v = VEHICLE_COLORS[((id % 256) + 256) % 256] ?? 0xffffffff;
    return '#' + (v >>> 8).toString(16).padStart(6, '0');
}

function bind() {
    for (const el of $$('.slider')) {
        const key = el.dataset.key;
        for (const input of el.querySelectorAll('input')) {
            input.addEventListener('input', () => {
                const v = parseFloat(input.value);
                if (!Number.isFinite(v)) return;
                state[key] = key === 'zoom' ? Math.max(0.01, v) : v;
                syncInputs();
                requestRender();
            });
        }
    }
    for (const b of $$('[data-quick]')) {
        b.onclick = () => {
            const [key, delta] = b.dataset.quick.split(':');
            state[key] = wrapAngle(state[key] + Number(delta));
            syncInputs();
            requestRender();
        };
    }
    $('#reset-rot').onclick = () => {
        Object.assign(state, state.kind === 'vehicle' ? { rx: -16, ry: 0, rz: -55, zoom: 1 } : { rx: 0, ry: 0, rz: 0, zoom: 1 });
        syncInputs();
        requestRender();
    };

    $('#model-id').addEventListener('change', (e) => loadModel(e.target.value));
    $('#prev-model').onclick = () => step(-1);
    $('#next-model').onclick = () => step(1);
    $('#source-select').onchange = (e) => { state.source = e.target.value; loadModel(state.model); };
    $('#search').addEventListener('input', renderResults);
    $('#search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') ($('#results li.active') || $('#results li'))?.click();
        else if (e.key === 'Escape') closeResults();
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveActive(e.key === 'ArrowDown' ? 1 : -1); }
    });
    document.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('.search')) $('#results').innerHTML = '';
    });
    $('#search').addEventListener('focus', renderResults);

    // Stage tabs: preview / on screen
    for (const b of $$('#stage-tabs button')) {
        b.onclick = () => {
            $$('#stage-tabs button').forEach((x) => x.classList.toggle('active', x === b));
            $$('.view').forEach((v) => v.classList.toggle('active', v.classList.contains('view-' + b.dataset.view)));
            $('.screen-tools').hidden = b.dataset.view !== 'screen';
        };
    }
    for (const b of $$('#kind-tabs button')) {
        b.onclick = () => {
            kindFilter = b.dataset.kind;
            $$('#kind-tabs button').forEach((x) => x.classList.toggle('active', x === b));
            renderResults();
        };
    }

    const num = (sel, key, parse = parseFloat) => $(sel).addEventListener('input', (e) => {
        const v = parse(e.target.value);
        if (!Number.isFinite(v)) return;
        state[key] = v;
        if (key === 'c1' || key === 'c2') syncInputs();
        requestRender();
    });
    num('#td-x', 'x'); num('#td-y', 'y'); num('#td-w', 'width'); num('#td-h', 'height');
    num('#c1', 'c1', (v) => parseInt(v, 10)); num('#c2', 'c2', (v) => parseInt(v, 10));
    const bgUpdate = () => {
        const hex = $('#bg-color').value;
        const a = Math.max(0, Math.min(255, parseInt($('#bg-alpha').value, 10) || 0));
        state.bg = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), a];
        requestRender();
    };
    $('#bg-color').addEventListener('input', bgUpdate);
    $('#bg-alpha').addEventListener('input', bgUpdate);
    $('#extra').onchange = (e) => { state.extra = e.target.value; requestRender(); };
    $('#td-player').onchange = (e) => { state.player = e.target.checked; requestRender(); };
    $('#td-selectable').onchange = (e) => { state.selectable = e.target.checked; requestRender(); };
    $('#td-var').addEventListener('input', (e) => { state.varName = e.target.value.replace(/[^\w\[\]]/g, '') || 'td'; requestRender(); });

    // Vehicle color palette
    const palette = $('#palette');
    let paletteTarget = null;
    VEHICLE_COLORS.forEach((_, id) => {
        const b = document.createElement('button');
        b.style.background = vehColorCss(id);
        b.title = String(id);
        b.onclick = () => { state[paletteTarget] = id; palette.hidden = true; syncInputs(); requestRender(); };
        palette.appendChild(b);
    });
    for (const key of ['c1', 'c2']) {
        $(`#${key}-swatch`).onclick = () => {
            palette.hidden = !palette.hidden && paletteTarget === key;
            paletteTarget = key;
        };
    }

    // Calibration
    const calUpdate = () => {
        calib.order = $('#cal-order').value;
        calib.cameraSide = Number($('#cal-side').value);
        calib.fov = Math.min(120, Math.max(5, parseFloat($('#cal-fov').value) || DEFAULT_CALIBRATION.fov));
        calib.distance = Math.max(0.05, parseFloat($('#cal-dist').value) || 1);
        calib.stretch = $('#cal-stretch').checked;
        store.set('td-preview-calib', calib);
        requestRender();
    };
    for (const id of ['#cal-order', '#cal-side', '#cal-fov', '#cal-dist', '#cal-stretch']) $(id).addEventListener('change', calUpdate);
    $('#cal-reset').onclick = () => { Object.assign(calib, DEFAULT_CALIBRATION); store.set('td-preview-calib', calib); syncInputs(); requestRender(); };

    // Copy / import
    const copy = async (text) => {
        try { await navigator.clipboard.writeText(text); } catch {
            const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
        }
        toast('Copiado!');
    };
    $('#copy-code').onclick = () => copy(pawn.generate(state));
    $('#copy-rot').onclick = () => copy(pawn.rotLine(state));
    $('#import-btn').onclick = () => {
        const parsed = pawn.parse($('#import').value);
        if (!Object.keys(parsed).length) return toast('Nada reconhecido no código colado');
        const modelChanged = parsed.model !== undefined && parsed.model !== state.model;
        Object.assign(state, parsed);
        syncInputs();
        if (modelChanged) loadModel(state.model); else requestRender();
        toast(`Importado: ${Object.keys(parsed).join(', ')}`);
    };

    // Screen background
    $('#screen-bg').onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            setScreenBg(reader.result);
            try { localStorage.setItem('td-preview-screen', reader.result); } catch { /* image too large for storage */ }
        };
        reader.readAsDataURL(file);
    };
    $('#screen-bg-clear').onclick = () => {
        screenBg = null;
        try { localStorage.removeItem('td-preview-screen'); } catch { /* */ }
        requestRender();
    };

    // Drag to rotate / wheel to zoom
    const pv = $('#preview');
    let drag = null;
    pv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; pv.setPointerCapture(e.pointerId); });
    pv.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag = { x: e.clientX, y: e.clientY };
        if (e.shiftKey) state.ry = wrapAngle(state.ry + dx * 0.5);
        else {
            state.rz = wrapAngle(state.rz + dx * 0.5 * calib.cameraSide * -1);
            state.rx = wrapAngle(state.rx + dy * 0.5 * calib.cameraSide);
        }
        syncInputs();
        requestRender();
    });
    pv.addEventListener('pointerup', () => { drag = null; });
    pv.addEventListener('wheel', (e) => {
        e.preventDefault();
        state.zoom = Math.max(0.05, Math.round(state.zoom * (e.deltaY > 0 ? 1.05 : 1 / 1.05) * 100) / 100);
        syncInputs();
        requestRender();
    }, { passive: false });
}

function setScreenBg(src) {
    const img = new Image();
    img.onload = () => { screenBg = img; requestRender(); };
    img.src = src;
}

function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1600);
}

// ---------------- init ----------------

function applyUrlParams() {
    const q = new URLSearchParams(location.search);
    if (q.has('model')) state.model = parseInt(q.get('model'), 10) || 0;
    if (q.has('rot')) {
        const [rx, ry, rz, zoom] = q.get('rot').split(',').map(Number);
        Object.assign(state, { rx: rx || 0, ry: ry || 0, rz: rz || 0, zoom: zoom || 1 });
    }
    if (q.get('view') === 'screen') queueMicrotask(() => document.querySelector('#stage-tabs [data-view=screen]')?.click());
    if (q.has('size')) {
        const [w, h] = q.get('size').split(',').map(Number);
        if (w && h) Object.assign(state, { width: w, height: h });
    }
}

async function init() {
    applyUrlParams();
    bind();
    syncInputs();
    try {
        const saved = localStorage.getItem('td-preview-screen');
        if (saved) setScreenBg(saved);
    } catch { /* */ }
    try {
        const res = await fetch('/api/catalog');
        const data = await res.json();
        catalog = data.items;
        $('#source-badge').textContent = data.local ? 'fontes: open.mp + jogo local' : 'fonte: assets.open.mp';
        if (!data.local) $('#source-select option[value=local]').remove();
        if (!data.local && state.source === 'local') state.source = '';
    } catch {
        setStatus('Não foi possível carregar o catálogo', true);
    }
    loadModel(state.model);
}

init();
