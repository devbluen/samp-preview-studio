// Simulates the "snapshot" the SA-MP client renders for TEXT_DRAW_FONT_MODEL_PREVIEW:
// the model is rotated (rx, ry, rz) around its bounding-box center and captured
// by a fixed camera whose distance is proportional to the model radius * zoom.
import * as THREE from '/vendor/three/build/three.module.js';
import { parseDff, textureNames } from './dff.js';
import { VEHICLE_COLORS } from './colors.js';

const DEG = Math.PI / 180;
const WHEEL_DUMMIES = ['wheel_rf_dummy', 'wheel_lf_dummy', 'wheel_rb_dummy', 'wheel_lb_dummy', 'wheel_rm_dummy', 'wheel_lm_dummy'];

// "Magic" vehicle material colors
const PRIMARY = '60,255,0';
const SECONDARY = '255,0,175';
const LIGHTS = new Set(['255,175,0', '0,255,200', '185,255,200', '255,0,175']);

export const DEFAULT_CALIBRATION = {
    order: 'ZYX', // ZYX = X applied first, then Y, then Z (world axes)
    cameraSide: 1, // +1: camera on the model's +Y side (sees the front of skins/vehicles at rot 0)
    fov: 40,
    distance: 1.0,
    stretch: true, // the square image is stretched to fit the textdraw size
};

export class Snapshot {
    constructor(onChange) {
        this.onChange = onChange;
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 5000);
        this.camera.up.set(0, 0, 1);
        this.pose = new THREE.Group();
        this.scene.add(this.pose);
        this.ambient = new THREE.AmbientLight(0xffffff, 1.35);
        this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
        this.scene.add(this.ambient, this.sun, this.sun.target);
        this.model = null;
        this.loadToken = 0;
        this.textureCache = new Map();
    }

    get canvas() {
        return this.renderer.domElement;
    }

    // ---------------- loading ----------------

    async load(id, source) {
        const token = ++this.loadToken;
        const q = source ? `?source=${source}` : '';
        const infoRes = await fetch(`/api/model/${id}${q}`);
        const info = await infoRes.json();
        if (!infoRes.ok) throw new Error(info.error || 'Falha ao buscar o modelo');
        const dffRes = await fetch(info.dff);
        if (!dffRes.ok) throw new Error(`Modelo "${info.model}" não está disponível (${dffRes.status}).`);
        const dff = parseDff(await dffRes.arrayBuffer());
        const textures = await this.loadTextures(info, dff);
        if (token !== this.loadToken) return null;
        this.setModel(this.build(dff, textures, info.kind), info);
        return info;
    }

    async loadTextures(info, dff) {
        const map = new Map();
        if (info.source === 'local') {
            for (const txd of info.txds) {
                const res = await fetch(`/api/local/txd/${txd}`);
                if (!res.ok) continue;
                for (const [name, tex] of decodeTxdPayload(await res.arrayBuffer())) if (!map.has(name)) map.set(name, tex);
            }
            return map;
        }
        for (const name of textureNames(dff)) {
            const key = 'openmp:' + name;
            if (!this.textureCache.has(key)) {
                const tex = new THREE.TextureLoader().load(`/api/openmp/tex/${encodeURIComponent(name)}.png`, () => this.onChange?.(), undefined, () => {
                    tex.userData.missing = true;
                    this.onChange?.();
                });
                prepareTexture(tex);
                this.textureCache.set(key, tex);
            }
            map.set(name, this.textureCache.get(key));
        }
        return map;
    }

    build(dff, textures, kind) {
        const root = new THREE.Group();
        // Peds: the DFF bind pose is "lying down" (the standing pose comes from in-game animation).
        // Correct it to head at +Z and front at +Y, as the ped stands in the world.
        const body = new THREE.Group();
        if (kind === 'skin') body.rotation.set(SKIN_FIX.x, SKIN_FIX.y, SKIN_FIX.z, 'ZYX');
        root.add(body);
        const world = [];
        dff.frames.forEach((f, i) => {
            const local = new THREE.Matrix4().fromArray(f.matrix);
            world[i] = f.parent >= 0 && world[f.parent] ? world[f.parent].clone().multiply(local) : local;
        });
        const hidden = (name) => /(_dam|_vlo)$/i.test(name) || /^chassis_vlo/i.test(name);
        const materials = new Map();
        const getMaterial = (m) => {
            const rgb = m.color.slice(0, 3).join(',');
            const key = `${m.texture.toLowerCase()}|${m.color.join(',')}`;
            if (materials.has(key)) return materials.get(key);
            const map = m.texture ? textures.get(m.texture.toLowerCase()) : null;
            const alpha = m.color[3] / 255;
            const mat = new THREE.MeshLambertMaterial({
                map: map || null,
                side: THREE.DoubleSide,
                transparent: alpha < 1,
                opacity: alpha,
                alphaTest: 0.35,
                depthWrite: alpha >= 1,
            });
            if (kind === 'vehicle' && rgb === PRIMARY) mat.userData.vehColor = 0;
            else if (kind === 'vehicle' && rgb === SECONDARY) mat.userData.vehColor = 1;
            else if (kind === 'vehicle' && LIGHTS.has(rgb)) mat.color.setRGB(1, 1, 1);
            else mat.color.setRGB(m.color[0] / 255, m.color[1] / 255, m.color[2] / 255, THREE.SRGBColorSpace);
            materials.set(key, mat);
            return mat;
        };

        const meshFor = (geo) => {
            if (!geo.positions || !geo.splits.length) return null;
            const g = new THREE.BufferGeometry();
            const positions = geo.skin?.boneFrames ? skinPositions(geo, world) : geo.positions;
            g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            if (geo.uvs) g.setAttribute('uv', new THREE.BufferAttribute(geo.uvs, 2));
            const index = [];
            const mats = [];
            geo.splits.forEach((split, si) => {
                const start = index.length;
                const idx = split.indices;
                if (geo.strip) {
                    for (let i = 0; i + 2 < idx.length; i++) {
                        const a = idx[i], b = idx[i + 1], c = idx[i + 2];
                        if (a === b || b === c || a === c) continue;
                        if (i & 1) index.push(a, c, b);
                        else index.push(a, b, c);
                    }
                } else {
                    for (let i = 0; i + 2 < idx.length; i += 3) index.push(idx[i], idx[i + 1], idx[i + 2]);
                }
                g.addGroup(start, index.length - start, si);
                mats.push(getMaterial(geo.materials[split.materialIndex] || { color: [255, 255, 255, 255], texture: '' }));
            });
            g.setIndex(index);
            g.computeVertexNormals();
            const mesh = new THREE.Mesh(g, mats);
            mesh.matrixAutoUpdate = false;
            return mesh;
        };

        let wheel = null;
        const wheelOwners = new Set();
        for (const a of dff.atomics) {
            const frame = dff.frames[a.frame];
            if (!frame || hidden(frame.name)) continue;
            const mesh = meshFor(a.geometry);
            if (!mesh) continue;
            // Skinned geometry is already in model space after skinning
            if (!a.geometry.skin?.boneFrames) mesh.matrix.copy(world[a.frame]);
            // Optional components (extra1..6): the game shows at most one
            if (/^extra\d+$/i.test(frame.name)) mesh.userData.extra = frame.name.toLowerCase();
            body.add(mesh);
            if (frame.name.toLowerCase() === 'wheel') {
                wheel = mesh;
                const parent = dff.frames[frame.parent];
                if (parent) wheelOwners.add(parent.name.toLowerCase());
            }
        }
        // Wheels exist on only one dummy in the DFF; the game copies them to the others
        if (wheel) {
            dff.frames.forEach((f, i) => {
                const name = f.name.toLowerCase();
                if (!WHEEL_DUMMIES.includes(name) || wheelOwners.has(name)) return;
                const copy = new THREE.Mesh(wheel.geometry, wheel.material);
                copy.matrixAutoUpdate = false;
                copy.matrix.copy(world[i]);
                if (name.includes('_l')) copy.matrix.multiply(new THREE.Matrix4().makeRotationZ(Math.PI));
                body.add(copy);
            });
        }
        root.updateMatrixWorld(true);
        return root;
    }

    clear() {
        this.removeModel();
        this.model = null;
        this.info = null;
    }

    removeModel() {
        if (this.model) {
            this.pose.remove(this.model);
            this.model.traverse((o) => {
                if (o.isMesh && o.geometry) o.geometry.dispose();
            });
        }
    }

    setModel(root, info) {
        this.removeModel();
        this.model = root;
        this.info = info;
        this.extras = [];
        root.traverse((o) => {
            if (o.userData.extra) {
                o.visible = false;
                if (!this.extras.includes(o.userData.extra)) this.extras.push(o.userData.extra);
            }
        });
        this.extras.sort();
        const box = new THREE.Box3().setFromObject(root);
        this.center = box.getCenter(new THREE.Vector3());
        this.radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.05);
        root.position.copy(this.center).negate();
        this.pose.add(root);
    }

    // ---------------- render ----------------

    /**
     * state: { rx, ry, rz, zoom, bg:[r,g,b,a], c1, c2, width, height }
     * Returns the rendered canvas (textdraw aspect ratio when calib.stretch=false).
     */
    render(state, calib, maxSize = 512) {
        let w = maxSize, h = maxSize;
        if (!calib.stretch) {
            const ar = Math.abs(state.width) / Math.max(Math.abs(state.height), 0.0001) || 1;
            if (ar >= 1) h = Math.max(1, Math.round(maxSize / ar));
            else w = Math.max(1, Math.round(maxSize * ar));
        }
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(w, h, false);
        const [r, g, b, a] = state.bg;
        this.renderer.setClearColor(new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace), a / 255);

        if (!this.model) {
            this.renderer.clear();
            return this.canvas;
        }

        this.pose.rotation.set(state.rx * DEG, state.ry * DEG, state.rz * DEG, calib.order);
        this.applyVehicleColors(state.c1, state.c2);
        this.model.traverse((o) => {
            if (o.userData.extra) o.visible = o.userData.extra === state.extra;
        });

        const fov = calib.fov;
        const cam = this.camera;
        cam.fov = fov;
        cam.aspect = w / h;
        const fit = this.radius / Math.sin((fov * DEG) / 2) / Math.min(1, cam.aspect);
        const dist = Math.max(fit * calib.distance * state.zoom, 0.001);
        cam.position.set(0, dist * calib.cameraSide, 0);
        cam.near = Math.max(dist / 1000, 0.001);
        cam.far = dist + this.radius * 4 + 10;
        cam.lookAt(0, 0, 0);
        cam.updateProjectionMatrix();
        this.sun.position.set(-dist * 0.6, dist * calib.cameraSide, dist * 0.8);

        this.renderer.render(this.scene, cam);
        return this.canvas;
    }

    applyVehicleColors(c1, c2) {
        if (!this.model) return;
        const ids = [c1, c2];
        this.model.traverse((o) => {
            if (!o.isMesh) return;
            for (const m of o.material) {
                if (m.userData.vehColor === undefined) continue;
                const id = ids[m.userData.vehColor];
                const v = VEHICLE_COLORS[((id % 256) + 256) % 256] ?? 0xffffffff;
                m.color.setRGB(((v >>> 24) & 255) / 255, ((v >>> 16) & 255) / 255, ((v >>> 8) & 255) / 255, THREE.SRGBColorSpace);
            }
        });
    }
}

const SKIN_FIX = { x: Math.PI / 2, y: 0, z: Math.PI };

// CPU skinning using the DFF's own bind pose
function skinPositions(geo, world) {
    const { indices, weights, inverse, boneFrames } = geo.skin;
    const mats = inverse.map((ib, k) => {
        const w = world[boneFrames[k]];
        return w ? w.clone().multiply(new THREE.Matrix4().fromArray(ib)) : new THREE.Matrix4();
    });
    const src = geo.positions;
    const out = new Float32Array(src.length);
    const v = new THREE.Vector3();
    const acc = new THREE.Vector3();
    for (let i = 0; i < geo.vertexCount; i++) {
        acc.set(0, 0, 0);
        let total = 0;
        for (let j = 0; j < 4; j++) {
            const wgt = weights[i * 4 + j];
            if (!wgt) continue;
            const m = mats[indices[i * 4 + j]];
            if (!m) continue;
            v.set(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]).applyMatrix4(m);
            acc.addScaledVector(v, wgt);
            total += wgt;
        }
        if (total > 0) acc.divideScalar(total);
        else acc.set(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
        out[i * 3] = acc.x;
        out[i * 3 + 1] = acc.y;
        out[i * 3 + 2] = acc.z;
    }
    return out;
}

function prepareTexture(tex) {
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
}

function decodeTxdPayload(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const out = new Map();
    let o = 4;
    const n = view.getUint32(0, true);
    for (let i = 0; i < n; i++) {
        const len = bytes[o];
        const name = new TextDecoder('latin1').decode(bytes.subarray(o + 1, o + 1 + len));
        o += 1 + len;
        const w = view.getUint16(o, true);
        const h = view.getUint16(o + 2, true);
        o += 4;
        const data = bytes.slice(o, o + w * h * 4);
        o += w * h * 4;
        const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        prepareTexture(tex);
        tex.needsUpdate = true;
        out.set(name, tex);
    }
    return out;
}
