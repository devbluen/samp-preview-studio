// UI for the attached object editor: skin selection, attachment slots, inspector, code and import.
import * as THREE from 'three';
import { AttachEditor, BONES } from './attach.js';
import * as pawn from './pawn.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const MAX_SLOTS = 10;
const VEC_KEYS = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'];
const DEFAULT_STATE = {
    skin: 7,
    order: 'XYZ',
    orderVersion: 2,
    selected: 0,
    uniform: false,
    marker: true,
    slots: [{ index: 0, model: 18645, bone: 2, x: 0.07, y: 0, z: 0, rx: 88, ry: 75, rz: 0, sx: 1, sy: 1, sz: 1, mc1: 0, mc2: 0 }],
};

const newSlot = (index, base = {}) => ({
    index, model: 18645, bone: 2, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, mc1: 0, mc2: 0, ...base, index,
});

let state, editor, ctx, catalogMap = new Map();

export async function initAttach(context) {
    ctx = context; // { store, toast, highlight, getCatalog }
    state = ctx.store.get('td-attach-state', DEFAULT_STATE);
    state.slots = (state.slots || []).map((s) => newSlot(s.index, s));
    migrateRotationOrder();

    editor = new AttachEditor($('#at-canvas'), {
        loader: ctx.loader,
        onTransform: (index, values) => {
            const slot = slotAt(index);
            if (!slot) return;
            Object.assign(slot, values);
            renderEditor();
            changed(false);
        },
        onSelect: (index) => select(index),
        onStatus: setStatus,
    });
    editor.setMarkerVisible(state.marker);

    fillStaticSelects();
    bind();
    refreshCatalog();
    await loadSkin(state.skin);
    for (const s of state.slots) syncSlot(s);
    select(slotAt(state.selected) ? state.selected : state.slots[0]?.index ?? null);
    renderAll();
    // ?view=front|back|left|right|top|focus opens the editor with that camera
    const view = new URLSearchParams(location.search).get('view');
    if (view) setTimeout(() => editor.view(view), 300);
}

export function refreshCatalog() {
    const catalog = ctx.getCatalog();
    catalogMap = new Map(catalog.map((c) => [c[0], c]));
    renderSlots();
    renderEditor();
}

export function onShow() {
    editor?.resize();
}

// The first version composed rotations in the wrong order (ZYX), so the rotX/Y/Z it produced only
// matched the editor, not the game. Convert saved slots to the SA-MP order (XYZ) keeping the same
// visual orientation, so what was positioned in the editor now generates correct values.
// The check uses the raw saved JSON because store.get() fills in orderVersion from the defaults.
function migrateRotationOrder() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem('td-attach-state')); } catch { /* */ }
    if (!raw || raw.orderVersion >= 2) return;
    const from = raw.order || 'ZYX';
    if (from !== 'XYZ') {
        const D = Math.PI / 180;
        const round = (v) => Math.round((v / D) * 100) / 100;
        for (const s of state.slots) {
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rx * D, s.ry * D, s.rz * D, from));
            const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
            [s.rx, s.ry, s.rz] = [round(e.x), round(e.y), round(e.z)];
        }
    }
    state.order = 'XYZ';
    state.orderVersion = 2;
    ctx.store.set('td-attach-state', state);
}

// ---------------- state helpers ----------------

const slotAt = (index) => state.slots.find((s) => s.index === index);
const selectedSlot = () => slotAt(state.selected);
const freeIndex = () => {
    for (let i = 0; i < MAX_SLOTS; i++) if (!slotAt(i)) return i;
    return -1;
};
const modelLabel = (id) => {
    const c = catalogMap.get(id);
    return c ? (c[2] || c[1]) : `modelo ${id}`;
};
const boneName = (id) => BONES.find((b) => b.id === id)?.name ?? `bone ${id}`;

function changed(full = true) {
    ctx.store.set('td-attach-state', state);
    renderCode();
    if (full) renderSlots();
}

function syncSlot(slot) {
    editor.setSlot(slot).then(() => renderSlots());
}

function select(index) {
    state.selected = index;
    editor.select(index);
    renderSlots();
    renderEditor();
    changed(false);
}

async function loadSkin(id) {
    id = Number(id);
    if (!Number.isInteger(id)) return;
    state.skin = id;
    $('#at-skin').value = id;
    try {
        const info = await editor.setSkin(id);
        $('#at-skin-name').textContent = `${info.name} · ${info.model}.dff`;
        changed(false);
    } catch {
        $('#at-skin-name').textContent = '';
    }
}

function stepSkin(dir) {
    const skins = ctx.getCatalog().filter((c) => c[3] === 's').map((c) => c[0]);
    if (!skins.length) return;
    let i = skins.indexOf(state.skin);
    i = i < 0 ? 0 : (i + dir + skins.length) % skins.length;
    loadSkin(skins[i]);
}

function syncZoom(z) {
    const v = Math.round(z * 1000) / 10;
    const slider = $('#at-zoom');
    if (document.activeElement !== slider) slider.value = v;
    $('#at-zoom-val').textContent = `${Math.round(v)}%`;
}

// ---------------- rendering ----------------

function setStatus(text, kind = '') {
    const el = $('#at-status');
    el.textContent = text;
    el.className = kind || 'muted';
}

function renderAll() {
    renderSlots();
    renderEditor();
    renderCode();
}

function renderSlots() {
    const ul = $('#at-slots');
    ul.innerHTML = '';
    for (const s of [...state.slots].sort((a, b) => a.index - b.index)) {
        const li = document.createElement('li');
        li.classList.toggle('active', s.index === state.selected);
        const item = editor?.items.get(s.index);
        li.innerHTML = `<span class="slot-idx">${s.index}</span><span class="slot-main"><b></b><span></span></span><button class="slot-del" title="Remover">×</button>`;
        li.querySelector('b').textContent = `${s.model} · ${modelLabel(s.model)}`;
        const sub = li.querySelector('.slot-main span');
        sub.textContent = item?.error ? item.error : boneName(s.bone);
        if (item?.error) sub.className = 'err';
        li.onclick = () => select(s.index);
        li.querySelector('.slot-del').onclick = (e) => {
            e.stopPropagation();
            removeSlot(s.index);
        };
        ul.appendChild(li);
    }
    $('#at-add').disabled = freeIndex() < 0;
    const sel = selectedSlot();
    $('#at-info').innerHTML = sel ? `<span class="tag">Slot ${sel.index}</span><b></b> · ${boneName(sel.bone)}` : '<span class="muted">Nenhum slot selecionado</span>';
    if (sel) $('#at-info b').textContent = `${sel.model} ${modelLabel(sel.model)}`;
}

function renderEditor() {
    const s = selectedSlot();
    const card = $('#at-editor');
    card.classList.toggle('disabled', !s);
    for (const el of card.querySelectorAll('input, select, button')) el.disabled = !s;
    if (!s) return;
    const setVal = (el, v) => { if (document.activeElement !== el) el.value = v; };
    $('#at-index').innerHTML = Array.from({ length: MAX_SLOTS }, (_, i) => {
        const used = slotAt(i) && i !== s.index;
        return `<option value="${i}">${i}${used ? ' (trocar)' : ''}</option>`;
    }).join('');
    $('#at-index').value = s.index;
    $('#at-bone').value = s.bone;
    setVal($('#at-model'), s.model);
    $('#at-model-name').textContent = modelLabel(s.model);
    for (const input of $$('#at-editor .vec input')) setVal(input, s[input.dataset.k]);
    $('#at-uniform').checked = state.uniform;
    for (const n of [1, 2]) {
        const v = s['mc' + n] >>> 0;
        $(`#at-mc${n}-on`).checked = v !== 0;
        if (v !== 0) {
            setVal($(`#at-mc${n}`), '#' + (v & 0xffffff).toString(16).padStart(6, '0'));
            setVal($(`#at-mc${n}-a`), v >>> 24);
        }
        $(`#at-mc${n}`).disabled = $(`#at-mc${n}-a`).disabled = v === 0;
    }
}

function renderCode() {
    $('#at-code').innerHTML = state.slots.length ? ctx.highlight(pawn.generateAttached(state.slots)) : '<span class="muted">// nenhum objeto</span>';
}

function fillStaticSelects() {
    $('#at-bone').innerHTML = BONES.map((b) => `<option value="${b.id}">${b.id} · ${b.name}</option>`).join('');
    $('#at-marker').checked = state.marker;
}

// ---------------- slot operations ----------------

function addSlot(base) {
    const index = freeIndex();
    if (index < 0) return ctx.toast('Todos os 10 slots estão em uso');
    const sel = selectedSlot();
    const slot = newSlot(index, base ?? (sel ? { model: sel.model, bone: sel.bone } : {}));
    state.slots.push(slot);
    syncSlot(slot);
    select(index);
    changed();
}

function removeSlot(index) {
    state.slots = state.slots.filter((s) => s.index !== index);
    editor.removeSlot(index);
    if (state.selected === index) select(state.slots[0]?.index ?? null);
    changed();
    renderEditor();
}

function changeIndex(slot, newIndex) {
    if (newIndex === slot.index) return;
    const other = slotAt(newIndex);
    editor.removeSlot(slot.index);
    if (other) {
        editor.removeSlot(newIndex);
        other.index = slot.index;
        syncSlot(other);
    }
    slot.index = newIndex;
    syncSlot(slot);
    select(newIndex);
    changed();
}

function updateSelected(patch) {
    const s = selectedSlot();
    if (!s) return;
    Object.assign(s, patch);
    syncSlot(s);
    renderEditor();
    changed();
}

// ---------------- search dropdowns ----------------

function makeSearch(input, list, kind, onPick) {
    const close = () => { input.value = ''; list.innerHTML = ''; };
    const render = () => {
        const q = input.value.trim().toLowerCase();
        list.innerHTML = '';
        if (!q) return;
        const isNum = /^\d+$/.test(q);
        let n = 0;
        for (const [id, model, name, k] of ctx.getCatalog()) {
            if (kind && k !== kind) continue;
            if (!(isNum ? String(id).startsWith(q) : model.includes(q) || name.toLowerCase().includes(q))) continue;
            const li = document.createElement('li');
            li.innerHTML = `<b>${id}</b><span></span>`;
            li.querySelector('span').textContent = name ? `${name} (${model})` : model;
            li.onclick = () => { close(); onPick(id); };
            list.appendChild(li);
            if (++n >= 150) break;
        }
    };
    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('keydown', (e) => {
        const items = [...list.children];
        let i = items.findIndex((li) => li.classList.contains('active'));
        if (e.key === 'Enter') (items[i] || items[0])?.click();
        else if (e.key === 'Escape') close();
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            items[i]?.classList.remove('active');
            i = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
            items[i]?.classList.add('active');
            items[i]?.scrollIntoView({ block: 'nearest' });
        }
    });
    document.addEventListener('pointerdown', (e) => {
        if (!input.parentElement.contains(e.target)) list.innerHTML = '';
    });
}

// ---------------- bindings ----------------

function bind() {
    $('#at-skin').addEventListener('change', (e) => loadSkin(e.target.value));
    $('#at-skin-prev').onclick = () => stepSkin(-1);
    $('#at-skin-next').onclick = () => stepSkin(1);
    makeSearch($('#at-skin-search'), $('#at-skin-results'), 's', loadSkin);
    makeSearch($('#at-model-search'), $('#at-model-results'), '', (id) => updateSelected({ model: id }));

    $('#at-add').onclick = () => addSlot();
    $('#at-dup').onclick = () => {
        const s = selectedSlot();
        if (s) addSlot({ ...s });
    };
    $('#at-del').onclick = () => state.selected !== null && removeSlot(state.selected);
    $('#at-index').onchange = (e) => {
        const s = selectedSlot();
        if (s) changeIndex(s, Number(e.target.value));
    };
    $('#at-bone').onchange = (e) => updateSelected({ bone: Number(e.target.value) });
    $('#at-model').addEventListener('change', (e) => {
        const v = parseInt(e.target.value, 10);
        if (Number.isInteger(v) && v >= 0) updateSelected({ model: v });
    });

    for (const input of $$('#at-editor .vec input')) {
        input.addEventListener('input', () => {
            const s = selectedSlot();
            const v = parseFloat(input.value);
            if (!s || !Number.isFinite(v)) return;
            const k = input.dataset.k;
            s[k] = v;
            if (state.uniform && k.startsWith('s')) s.sx = s.sy = s.sz = v;
            editor.setSlot(s);
            renderEditor();
            changed(false);
        });
    }
    $('#at-uniform').onchange = (e) => { state.uniform = e.target.checked; changed(false); };

    for (const n of [1, 2]) {
        const update = () => {
            const on = $(`#at-mc${n}-on`).checked;
            const hex = $(`#at-mc${n}`).value;
            const a = Math.max(0, Math.min(255, parseInt($(`#at-mc${n}-a`).value, 10) || 0));
            updateSelected({ ['mc' + n]: on ? (((a << 24) | parseInt(hex.slice(1), 16)) >>> 0) || 0xffffffff : 0 });
        };
        $(`#at-mc${n}-on`).onchange = update;
        $(`#at-mc${n}`).addEventListener('input', update);
        $(`#at-mc${n}-a`).addEventListener('input', update);
    }

    $('#at-marker').onchange = (e) => {
        state.marker = e.target.checked;
        editor.setMarkerVisible(state.marker);
        changed(false);
    };

    const segmented = (sel, attr, fn) => {
        for (const b of $$(`${sel} button`)) {
            b.onclick = () => {
                if (attr !== 'view') $$(`${sel} button`).forEach((x) => x.classList.toggle('active', x === b));
                fn(b.dataset[attr]);
            };
        }
    };
    segmented('#at-gizmo', 'mode', (m) => editor.setMode(m));
    segmented('#at-space', 'space', (s) => editor.setSpace(s));
    segmented('#at-views', 'view', (v) => editor.view(v));

    // Zoom without the mouse wheel: slider + buttons (5 steps of the 0-100 scale)
    const zoomTo = (v) => editor.setZoom(Math.min(100, Math.max(0, v)) / 100);
    $('#at-zoom').addEventListener('input', (e) => zoomTo(Number(e.target.value)));
    $('#at-zoom-in').onclick = () => zoomTo(Number($('#at-zoom').value) + 5);
    $('#at-zoom-out').onclick = () => zoomTo(Number($('#at-zoom').value) - 5);
    editor.onCamera = syncZoom;
    syncZoom(editor.getZoom());

    document.addEventListener('keydown', (e) => {
        if ($('#attach-app').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
        const mode = { w: 'translate', e: 'rotate', r: 'scale' }[e.key.toLowerCase()];
        if (mode) $(`#at-gizmo [data-mode=${mode}]`).click();
        else if (e.key.toLowerCase() === 'f') editor.view('focus');
        else if (e.key === 'Delete' && state.selected !== null) removeSlot(state.selected);
    });

    $('#at-copy-all').onclick = () => ctx.copy(pawn.generateAttached(state.slots));
    $('#at-copy-one').onclick = () => {
        const s = selectedSlot();
        if (s) ctx.copy(pawn.attachedLine(s));
    };
    const doImport = (replace) => {
        const parsed = pawn.parseAttached($('#at-import').value);
        if (!parsed.length) return ctx.toast('Nenhum SetPlayerAttachedObject encontrado');
        if (replace) {
            for (const s of state.slots) editor.removeSlot(s.index);
            state.slots = [];
        }
        for (const p of parsed) {
            if (p.index < 0 || p.index >= MAX_SLOTS) p.index = freeIndex();
            if (p.index < 0) break;
            const existing = slotAt(p.index);
            if (existing) Object.assign(existing, p);
            else state.slots.push(newSlot(p.index, p));
            syncSlot(slotAt(p.index));
        }
        select(parsed[0].index);
        changed();
        ctx.toast(`${parsed.length} objeto(s) importado(s)`);
    };
    $('#at-import-add').onclick = () => doImport(false);
    $('#at-import-replace').onclick = () => doImport(true);
}
