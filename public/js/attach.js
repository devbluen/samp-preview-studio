// 3D editor for SetPlayerAttachedObject: a skin in its bind pose with objects attached to SA-MP bones.
// Each attachment is a holder group parented to the bone's frame, so the holder's local
// position / rotation / scale are exactly the offset / rot / scale values used by SA-MP.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ModelLoader, disposeModel } from './models.js';

const DEG = Math.PI / 180;

// SA-MP attachment bones -> GTA SA ped bone ids (HAnim) and frame names
export const BONES = [
    { id: 1, name: 'Coluna', boneId: 3, frame: 'spine1' },
    { id: 2, name: 'Cabeça', boneId: 5, frame: 'head' },
    { id: 3, name: 'Braço esquerdo', boneId: 32, frame: 'l upperarm' },
    { id: 4, name: 'Braço direito', boneId: 22, frame: 'r upperarm' },
    { id: 5, name: 'Mão esquerda', boneId: 34, frame: 'l hand' },
    { id: 6, name: 'Mão direita', boneId: 24, frame: 'r hand' },
    { id: 7, name: 'Coxa esquerda', boneId: 41, frame: 'l thigh' },
    { id: 8, name: 'Coxa direita', boneId: 51, frame: 'r thigh' },
    { id: 9, name: 'Pé esquerdo', boneId: 43, frame: 'l foot' },
    { id: 10, name: 'Pé direito', boneId: 53, frame: 'r foot' },
    { id: 11, name: 'Panturrilha direita', boneId: 52, frame: 'r calf' },
    { id: 12, name: 'Panturrilha esquerda', boneId: 42, frame: 'l calf' },
    { id: 13, name: 'Antebraço esquerdo', boneId: 33, frame: 'l forearm' },
    { id: 14, name: 'Antebraço direito', boneId: 23, frame: 'r forearm' },
    { id: 15, name: 'Ombro esquerdo', boneId: 31, frame: 'bip01 l clavicle' },
    { id: 16, name: 'Ombro direito', boneId: 21, frame: 'bip01 r clavicle' },
    { id: 17, name: 'Pescoço', boneId: 4, frame: 'neck' },
    { id: 18, name: 'Mandíbula', boneId: 8, frame: 'jaw' },
];

export class AttachEditor {
    constructor(canvas, { loader = new ModelLoader(), onTransform, onSelect, onStatus } = {}) {
        this.canvas = canvas;
        this.loader = loader;
        this.loader.onChange = () => this.render();
        this.onTransform = onTransform;
        this.onSelect = onSelect;
        this.onStatus = onStatus;
        // SA-MP applies rotX, then rotY, then rotZ on the object's local axes (three.js order 'XYZ').
        // Verified against well-known in-game values (helmet 18645 88,75,0; santa hat 19065 0,100,100).
        this.order = 'XYZ';

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
        this.camera.up.set(0, 0, 1);
        this.camera.position.set(0, 2.6, 0.35);

        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444450, 1.6));
        const sun = new THREE.DirectionalLight(0xffffff, 1.4);
        sun.position.set(-2, 3, 4);
        this.scene.add(sun);

        this.grid = new THREE.GridHelper(4, 16, 0x3a404c, 0x262a33);
        this.grid.rotation.x = Math.PI / 2;
        this.grid.position.z = -1;
        this.scene.add(this.grid);

        this.orbit = new OrbitControls(this.camera, canvas);
        this.orbit.target.set(0, 0, 0);
        this.orbit.enableDamping = false;
        // Keep the camera inside the near/far range so the scene (and gizmo) never get clipped away
        this.orbit.minDistance = 0.15;
        this.orbit.maxDistance = 12;
        // Default wheel zoom (~5% per notch) is too fast at this scale
        this.orbit.zoomSpeed = 0.35;
        this.orbit.addEventListener('change', () => {
            this.render();
            this.onCamera?.(this.getZoom());
        });

        this.gizmo = new TransformControls(this.camera, canvas);
        this.gizmo.setSpace('local');
        this.gizmo.setSize(0.8);
        this.gizmo.addEventListener('change', () => this.render());
        this.gizmo.addEventListener('dragging-changed', (e) => { this.orbit.enabled = !e.value; });
        this.gizmo.addEventListener('mouseDown', () => this.startUniformScale());
        this.gizmo.addEventListener('mouseUp', () => { this.uniformScale = null; });
        this.gizmo.addEventListener('objectChange', () => this.emitTransform());
        this.scene.add(this.gizmo);

        // Marker on the selected slot's bone
        this.boneMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.014, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xf2a93b, depthTest: false, transparent: true, opacity: 0.9 }),
        );
        this.boneMarker.renderOrder = 999;
        this.boneMarker.add(new THREE.AxesHelper(0.12));
        this.boneMarker.children[0].material.depthTest = false;
        this.boneMarker.children[0].renderOrder = 999;

        this.skin = null; // { root, anchors: Map<boneNumber, Group> }
        this.items = new Map(); // slot index -> { holder, model, root, token }
        this.selected = null;
        this.showMarker = true;

        this.bindPicking();
        new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
        this.resize();
    }

    // ---------------- skin ----------------

    async setSkin(id) {
        const token = (this.skinToken = (this.skinToken || 0) + 1);
        this.onStatus?.('Carregando skin…', 'loading');
        try {
            const { info, root } = await this.loader.load(id, '');
            if (token !== this.skinToken) return disposeModel(root);
            if (info.kind !== 'skin') {
                disposeModel(root);
                throw new Error(`O modelo ${id} não é uma skin.`);
            }
            if (this.skin) {
                this.scene.remove(this.skin.root);
                disposeModel(this.skin.root);
            }
            const { body, world, dff } = root.userData;
            const anchors = new Map();
            for (const bone of BONES) {
                let fi = dff.frames.findIndex((f) => f.boneId === bone.boneId);
                if (fi < 0) fi = dff.frames.findIndex((f) => f.name.trim().toLowerCase() === bone.frame);
                const anchor = new THREE.Group();
                anchor.matrixAutoUpdate = false;
                if (fi >= 0) anchor.matrix.copy(world[fi]);
                anchor.userData.found = fi >= 0;
                body.add(anchor);
                anchors.set(bone.id, anchor);
            }
            this.scene.add(root);
            root.updateMatrixWorld(true);
            this.grid.position.z = new THREE.Box3().setFromObject(root).min.z;
            this.skin = { root, anchors, info };
            // Re-parent existing attachments to the new skeleton
            for (const item of this.items.values()) this.parentHolder(item);
            this.updateMarker();
            this.onStatus?.('');
            this.render();
            return info;
        } catch (e) {
            if (token === this.skinToken) this.onStatus?.(e.message, 'error');
            throw e;
        }
    }

    parentHolder(item) {
        const anchor = this.skin?.anchors.get(item.bone) ?? this.scene;
        if (item.holder.parent !== anchor) anchor.add(item.holder);
    }

    // ---------------- attachments ----------------

    /** slot: { index, model, bone, x, y, z, rx, ry, rz, sx, sy, sz, mc1, mc2 } */
    async setSlot(slot) {
        let item = this.items.get(slot.index);
        if (!item) {
            const holder = new THREE.Group();
            holder.userData.slotIndex = slot.index;
            item = { holder, model: null, root: null, token: 0, bone: slot.bone };
            this.items.set(slot.index, item);
        }
        item.bone = slot.bone;
        this.parentHolder(item);
        this.applyTransform(item.holder, slot);
        item.colors = [slot.mc1, slot.mc2];
        if (item.root) applyMaterialColors(item.root, slot.mc1, slot.mc2);
        if (this.selected === slot.index) this.updateMarker();
        this.render();

        if (item.model !== slot.model) {
            item.model = slot.model;
            const token = ++item.token;
            if (item.root) {
                item.holder.remove(item.root);
                disposeModel(item.root);
                item.root = null;
            }
            this.render();
            try {
                const { info, root } = await this.loader.load(slot.model, '');
                if (token !== item.token || this.items.get(slot.index) !== item) return disposeModel(root);
                item.root = root;
                item.info = info;
                root.traverse((o) => {
                    if (o.userData.extra) o.visible = o.userData.extra === root.userData.extras[0];
                });
                applyMaterialColors(root, ...item.colors);
                item.holder.add(root);
                item.error = null;
            } catch (e) {
                if (token !== item.token) return;
                item.error = e.message;
                item.info = null;
                this.onStatus?.(`Slot ${slot.index}: ${e.message}`, 'error');
            }
            this.render();
        }
        return item;
    }

    removeSlot(index) {
        const item = this.items.get(index);
        if (!item) return;
        if (this.gizmo.object === item.holder) this.gizmo.detach();
        item.holder.parent?.remove(item.holder);
        disposeModel(item.root);
        this.items.delete(index);
        if (this.selected === index) this.selected = null;
        this.updateMarker();
        this.render();
    }

    applyTransform(holder, s) {
        holder.position.set(s.x, s.y, s.z);
        holder.rotation.set(s.rx * DEG, s.ry * DEG, s.rz * DEG, this.order);
        holder.scale.set(s.sx || 0.0001, s.sy || 0.0001, s.sz || 0.0001);
    }

    select(index) {
        this.selected = index;
        const item = this.items.get(index);
        if (item) this.gizmo.attach(item.holder);
        else this.gizmo.detach();
        this.updateMarker();
        this.render();
    }

    setMode(mode) {
        this.gizmo.setMode(mode);
        this.render();
    }

    setSpace(space) {
        this.gizmo.setSpace(space);
        this.render();
    }

    setMarkerVisible(v) {
        this.showMarker = v;
        this.updateMarker();
        this.render();
    }

    updateMarker() {
        const item = this.items.get(this.selected);
        const anchor = item && this.skin?.anchors.get(item.bone);
        this.boneMarker.parent?.remove(this.boneMarker);
        if (anchor && this.showMarker) anchor.add(this.boneMarker);
    }

    // TransformControls scales uniformly by |cursor - center| / |grab point - center|. Grabbing the
    // center handle makes the divisor ~0 (the scale explodes) and moving past the center flips the
    // sign. For the center handle we use a predictable rule instead: drag right = bigger, left = smaller.
    startUniformScale() {
        const g = this.gizmo;
        this.uniformScale = g.mode === 'scale' && g.axis === 'XYZ' && g.object
            ? { x0: this.pointerX, scale: g.object.scale.clone() }
            : null;
    }

    emitTransform() {
        const item = this.items.get(this.selected);
        if (!item) return;
        const h = item.holder;
        if (this.uniformScale && this.gizmo.dragging && this.gizmo.object === h) {
            h.scale.copy(this.uniformScale.scale).multiplyScalar(Math.exp((this.pointerX - this.uniformScale.x0) / 200));
        }
        // Safety net: never let a drag produce an invalid or absurd scale
        for (const k of ['x', 'y', 'z']) {
            let v = h.scale[k];
            if (!Number.isFinite(v)) v = 1;
            v = Math.sign(v || 1) * Math.min(Math.max(Math.abs(v), 0.01), 50);
            h.scale[k] = v;
        }
        const r = (v) => Math.round(v * 10000) / 10000;
        const deg = (v) => Math.round((v / DEG) * 100) / 100;
        this.onTransform?.(this.selected, {
            x: r(h.position.x), y: r(h.position.y), z: r(h.position.z),
            rx: deg(h.rotation.x), ry: deg(h.rotation.y), rz: deg(h.rotation.z),
            sx: r(h.scale.x), sy: r(h.scale.y), sz: r(h.scale.z),
        });
    }

    // ---------------- camera ----------------

    // Zoom as 0..1 on a log scale of the camera distance (1 = closest, 0 = farthest)
    getZoom() {
        const { minDistance: min, maxDistance: max } = this.orbit;
        const d = this.camera.position.distanceTo(this.orbit.target);
        return 1 - Math.log(d / min) / Math.log(max / min);
    }

    setZoom(z) {
        const { minDistance: min, maxDistance: max } = this.orbit;
        z = Math.min(1, Math.max(0, z));
        const d = min * Math.pow(max / min, 1 - z);
        const t = this.orbit.target;
        const dir = this.camera.position.clone().sub(t);
        if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
        this.camera.position.copy(t).add(dir.setLength(d));
        this.orbit.update();
    }

    view(name) {
        const t = this.orbit.target;
        const d = Math.max(this.camera.position.distanceTo(t), 0.6);
        const dirs = { front: [0, 1, 0.12], back: [0, -1, 0.12], left: [-1, 0, 0.12], right: [1, 0, 0.12], top: [0, 0.02, 1] };
        if (name === 'focus') {
            const item = this.items.get(this.selected);
            const target = new THREE.Vector3();
            if (item) item.holder.getWorldPosition(target);
            const offset = this.camera.position.clone().sub(t).setLength(0.9);
            t.copy(target);
            this.camera.position.copy(target).add(offset);
        } else if (name === 'reset') {
            t.set(0, 0, 0);
            this.camera.position.set(0, 2.6, 0.35);
        } else {
            const v = new THREE.Vector3(...dirs[name]).normalize().multiplyScalar(d);
            this.camera.position.copy(t).add(v);
        }
        this.orbit.update();
        this.render();
    }

    // ---------------- picking / rendering ----------------

    /** Slot index of the attached object under the pointer, or null */
    pickItem(e) {
        const rect = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        this.raycaster.setFromCamera(ndc, this.camera);
        const targets = [...this.items.values()].map((i) => i.holder);
        const hit = this.raycaster.intersectObjects(targets, true).find((h) => h.object.isMesh && h.object.visible);
        let o = hit?.object;
        while (o && o.userData.slotIndex === undefined) o = o.parent;
        return o ? o.userData.slotIndex : null;
    }

    // Clicking an object selects it; in "move" mode, dragging the object itself (not a gizmo
    // handle) moves it on the plane facing the camera, so you don't have to hit the small arrows.
    bindPicking() {
        this.raycaster = new THREE.Raycaster();
        const plane = new THREE.Plane();
        const point = new THREE.Vector3();
        let down = null;
        let drag = null;

        const rayPoint = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
            this.raycaster.setFromCamera(ndc, this.camera);
            return this.raycaster.ray.intersectPlane(plane, point);
        };

        this.canvas.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            down = { x: e.clientX, y: e.clientY };
            if (this.gizmo.axis !== null) return; // a gizmo handle is under the pointer: let it handle the drag
            const index = this.pickItem(e);
            if (index === null) return;
            if (index !== this.selected) this.onSelect?.(index);
            const item = this.items.get(index);
            if (!item || this.gizmo.mode !== 'translate') return;
            this.camera.updateMatrixWorld();
            const start = item.holder.getWorldPosition(new THREE.Vector3());
            plane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), start);
            const p0 = rayPoint(e);
            if (!p0) return;
            drag = { item, start, p0: p0.clone() };
            this.orbit.enabled = false;
            this.canvas.setPointerCapture(e.pointerId);
        });

        // Registered before TransformControls adds its own pointermove listener (on pointerdown),
        // so pointerX is already current when the gizmo fires objectChange
        this.pointerX = 0;
        this.canvas.addEventListener('pointermove', (e) => {
            this.pointerX = e.clientX;
            if (!drag) return;
            const p = rayPoint(e);
            if (!p) return;
            const target = drag.start.clone().add(p.clone().sub(drag.p0));
            const parent = drag.item.holder.parent;
            parent.updateWorldMatrix(true, false);
            drag.item.holder.position.copy(parent.worldToLocal(target));
            this.emitTransform();
            this.render();
        });

        const endDrag = (e) => {
            if (!drag) return false;
            drag = null;
            this.orbit.enabled = true;
            if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
            return true;
        };
        this.canvas.addEventListener('pointercancel', endDrag);
        this.canvas.addEventListener('pointerup', (e) => {
            if (endDrag(e)) return;
            if (!down || this.gizmo.dragging) return;
            const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
            down = null;
            if (moved > 4) return;
            const index = this.pickItem(e);
            if (index !== null && index !== this.selected) this.onSelect?.(index);
        });
    }

    resize() {
        const parent = this.canvas.parentElement;
        const w = parent.clientWidth, h = parent.clientHeight;
        if (!w || !h) return;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.render();
    }

    render() {
        if (this.frameQueued) return;
        this.frameQueued = true;
        requestAnimationFrame(() => {
            this.frameQueued = false;
            this.renderer.render(this.scene, this.camera);
        });
    }
}

// SA-MP materialcolor1/2 (ARGB, 0 = keep) replace the color of material slots 0 and 1
function applyMaterialColors(root, mc1, mc2) {
    const colors = [mc1 >>> 0, mc2 >>> 0];
    root.traverse((o) => {
        if (!o.isMesh || !o.userData.matIndices) return;
        o.userData.origMats ??= [...o.material];
        o.material = o.userData.origMats.map((mat, k) => {
            const slot = o.userData.matIndices[k];
            const argb = colors[slot];
            if (slot > 1 || !argb) return mat;
            const c = mat.clone();
            c.color.setRGB(((argb >>> 16) & 255) / 255, ((argb >>> 8) & 255) / 255, (argb & 255) / 255, THREE.SRGBColorSpace);
            const a = (argb >>> 24) / 255;
            c.transparent = a < 1;
            c.opacity = a;
            return c;
        });
    });
}
