// Object browser for the attached object editor: categories, search, favorites, recent objects and
// lazily rendered thumbnails. Opens as a side panel so the 3D view stays visible while browsing.
import { Snapshot, DEFAULT_CALIBRATION } from './snapshot.js';
import { sources, isSampObject } from './sources.js';

const $ = (s) => document.querySelector(s);
const PAGE = 90;
const THUMB = 112;
const THUMB_STATE = { rx: -20, ry: 0, rz: 35, zoom: 1, bg: [0, 0, 0, 0], c1: 1, c2: 1, width: 1, height: 1, extra: '' };
const RECENT_KEY = 'td-attach-recent';
const FAV_KEY = 'td-attach-fav';

// Wearable categories only look at SA-MP's own objects, which is where the attachable accessories are
const sampMatch = (re) => (row) => isSampObject(row[0]) && re.test(row[1]);
const CATEGORIES = [
    { id: 'fav', name: '★ Favorites', rows: () => listRows(favorites) },
    { id: 'recent', name: 'Recent', rows: () => listRows(recent) },
    { id: 'hats', name: 'Hats & caps', test: sampMatch(/hat|cap|beret|boater|bowler/) },
    { id: 'helmets', name: 'Helmets', test: sampMatch(/helmet/) },
    { id: 'glasses', name: 'Glasses', test: sampMatch(/glasses|eyepatch/) },
    { id: 'masks', name: 'Masks & bandanas', test: sampMatch(/mask|bandana/) },
    { id: 'hair', name: 'Hair', test: sampMatch(/^hair/) },
    { id: 'watches', name: 'Watches', test: sampMatch(/watch/) },
    { id: 'tools', name: 'Phones & tools', test: sampMatch(/phone|pager|wrench|crowbar|hammer|screwdriver|flashlight|taser|laserpointer|fishingrod|rake|shield|parrot|pompom|rope/) },
    { id: 'weapons', name: 'Weapons', test: (row) => row[0] >= 321 && row[0] <= 372 },
    { id: 'mods', name: 'Modified', test: (row) => row[3] === 'o' && row[4] },
    { id: 'samp', name: 'All SA-MP objects', test: (row) => isSampObject(row[0]) },
    { id: 'all', name: 'All objects', test: (row) => row[3] === 'o' },
];

let ctx, snapshot, catalogMap = new Map();
let category = 'hats';
let rows = [];
let shown = 0;
let recent = readList(RECENT_KEY);
let favorites = readList(FAV_KEY);
const thumbs = new Map(); // `${generation}:${variant}:${id}` -> data URL | { error }
const queue = [];
let busy = false;

/** context: { getCatalog, getSelectedModel, onUse(id), onAdd(id) } */
export function initBrowser(context) {
    ctx = context;
    snapshot = new Snapshot();
    if (recent.length) category = 'recent';
    bind();
}

export function openBrowser() {
    const dlg = $('#obj-browser');
    if (!dlg.open) dlg.show();
    refresh();
    $('#ob-search').focus();
}

export function closeBrowser() {
    $('#obj-browser')?.close();
}

/** Remembers a model the user picked (Recent category). */
export function noteUsed(id) {
    recent = [id, ...recent.filter((r) => r !== id)].slice(0, 30);
    writeList(RECENT_KEY, recent);
}

/** Catalog or model source changed. */
export function refresh() {
    catalogMap = new Map(ctx.getCatalog().map((c) => [c[0], c]));
    if ($('#obj-browser').open) render();
}

// ---------------- rendering ----------------

function render() {
    const q = $('#ob-search').value.trim().toLowerCase();
    $('#ob-cats').innerHTML = '';
    for (const c of CATEGORIES) {
        if (c.id === 'mods' && !sources.modCount) continue;
        const b = document.createElement('button');
        b.className = 'chip' + (c.id === category && !q ? ' active' : '');
        b.textContent = c.name;
        b.onclick = () => {
            category = c.id;
            $('#ob-search').value = '';
            render();
        };
        $('#ob-cats').appendChild(b);
    }

    if (q) {
        const isNum = /^\d+$/.test(q);
        rows = ctx.getCatalog().filter((c) => c[3] === 'o' && (isNum ? String(c[0]).startsWith(q) : c[1].includes(q) || c[2].toLowerCase().includes(q)));
    } else {
        const cat = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[2];
        rows = cat.rows ? cat.rows() : ctx.getCatalog().filter(cat.test);
    }

    const needsGame = !sources.game && rows.some((r) => isSampObject(r[0]));
    $('#ob-hint').textContent = !rows.length
        ? (category === 'fav' && !q ? 'No favorites yet: click ☆ on an object to keep it here.' : category === 'recent' && !q ? 'Objects you use show up here.' : 'No objects found.')
        : `${rows.length} object${rows.length > 1 ? 's' : ''}${needsGame ? ' · SA-MP objects need your GTA SA folder (top right)' : ''}`;

    const grid = $('#ob-grid');
    grid.innerHTML = '';
    grid.scrollTop = 0;
    shown = 0;
    queue.length = 0;
    showMore();
}

function showMore() {
    const grid = $('#ob-grid');
    grid.querySelector('.ob-more')?.remove();
    const selected = ctx.getSelectedModel();
    for (const row of rows.slice(shown, shown + PAGE)) grid.appendChild(tile(row, selected));
    shown = Math.min(rows.length, shown + PAGE);
    if (shown < rows.length) {
        const more = document.createElement('div');
        more.className = 'ob-more';
        grid.appendChild(more);
        moreObserver.observe(more);
    }
}

function tile([id, model, name], selected) {
    const el = document.createElement('div');
    el.className = 'ob-tile' + (id === selected ? ' active' : '');
    el.title = `${id} · ${name || model}\nClick: use in the selected slot`;
    el.innerHTML = `<div class="ob-thumb"></div><b>${id}</b><span></span>
        <button class="ob-fav" title="Favorite"></button><button class="ob-add" title="Add as a new slot">+</button>`;
    el.querySelector('span').textContent = name || model;
    const fav = el.querySelector('.ob-fav');
    const paintFav = () => {
        fav.textContent = favorites.includes(id) ? '★' : '☆';
        fav.classList.toggle('on', favorites.includes(id));
    };
    paintFav();
    fav.onclick = (e) => {
        e.stopPropagation();
        favorites = favorites.includes(id) ? favorites.filter((f) => f !== id) : [id, ...favorites];
        writeList(FAV_KEY, favorites);
        paintFav();
    };
    el.querySelector('.ob-add').onclick = (e) => {
        e.stopPropagation();
        ctx.onAdd(id);
        markActive(id);
    };
    el.onclick = () => {
        ctx.onUse(id);
        markActive(id);
    };
    el.dataset.id = id;
    thumbObserver.observe(el);
    return el;
}

/** The selected slot changed: highlight its model. */
export function syncSelection() {
    if ($('#obj-browser').open) markActive(ctx.getSelectedModel());
}

function markActive(id) {
    for (const t of document.querySelectorAll('#ob-grid .ob-tile')) t.classList.toggle('active', Number(t.dataset.id) === id);
}

// ---------------- thumbnails ----------------

const thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
        if (!e.isIntersecting) continue;
        thumbObserver.unobserve(e.target);
        paintThumb(e.target);
    }
}, { rootMargin: '200px' });

const moreObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
        moreObserver.disconnect();
        showMore();
    }
}, { rootMargin: '400px' });

const thumbKey = (id) => `${sources.generation}:${sources.variant}:${id}`;

function paintThumb(el) {
    const id = Number(el.dataset.id);
    const box = el.querySelector('.ob-thumb');
    const show = (t) => {
        if (typeof t === 'string') box.innerHTML = `<img src="${t}" alt="">`;
        else {
            box.innerHTML = '<span class="ob-missing">?</span>';
            box.title = t.error;
        }
    };
    if (isSampObject(id) && !sources.game) return show({ error: 'Needs your GTA SA folder' });
    const cached = thumbs.get(thumbKey(id));
    if (cached) return show(cached);
    box.classList.add('loading');
    queue.push({ id, done: (t) => { box.classList.remove('loading'); show(t); } });
    pump();
}

async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
        const { id, done } = queue.shift();
        const key = thumbKey(id);
        if (!thumbs.has(key)) {
            try {
                await snapshot.load(id);
                await texturesReady(snapshot.model);
                thumbs.set(key, snapshot.render(THUMB_STATE, { ...DEFAULT_CALIBRATION, stretch: true }, THUMB).toDataURL());
            } catch (e) {
                thumbs.set(key, { error: e.message });
            }
            snapshot.clear();
        }
        done(thumbs.get(key));
    }
    busy = false;
}

// open.mp textures load asynchronously: wait for them (or give up) before taking the picture
function texturesReady(root, timeout = 4000) {
    const maps = [];
    root?.traverse((o) => {
        if (o.isMesh) for (const m of o.material) if (m.map) maps.push(m.map);
    });
    const start = performance.now();
    return new Promise((resolve) => {
        const check = () => (maps.every((t) => t.image || t.userData.missing) || performance.now() - start > timeout ? resolve() : setTimeout(check, 50));
        check();
    });
}

// ---------------- helpers ----------------

function listRows(ids) {
    return ids.map((id) => catalogMap.get(id) ?? [id, `model ${id}`, '', 'o']);
}

function readList(key) {
    try { return (JSON.parse(localStorage.getItem(key)) || []).filter(Number.isInteger); } catch { return []; }
}

function writeList(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* no storage */ }
}

function bind() {
    $('#ob-close').onclick = closeBrowser;
    let timer = 0;
    $('#ob-search').addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(render, 120);
    });
    $('#obj-browser').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeBrowser();
    });
}
