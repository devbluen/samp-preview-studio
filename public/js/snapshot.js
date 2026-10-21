// Simulates the "snapshot" the SA-MP client renders for TEXT_DRAW_FONT_MODEL_PREVIEW:
// the model is rotated (rx, ry, rz) around its bounding-box center and captured
// by a fixed camera whose distance is proportional to the model radius * zoom.
import * as THREE from 'three';
import { ModelLoader, disposeModel, applyVehicleColors } from './models.js';

const DEG = Math.PI / 180;

export const DEFAULT_CALIBRATION = {
    order: 'ZYX', // ZYX = X applied first, then Y, then Z (world axes)
    cameraSide: 1, // +1: camera on the model's +Y side (sees the front of skins/vehicles at rot 0)
    fov: 40,
    distance: 1.0,
    stretch: true, // the square image is stretched to fit the textdraw size
};

export class Snapshot {
    constructor(onChange, loader = new ModelLoader(onChange)) {
        this.loader = loader;
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
        this.extras = [];
        this.loadToken = 0;
    }

    get canvas() {
        return this.renderer.domElement;
    }

    async load(id) {
        const token = ++this.loadToken;
        const { info, root } = await this.loader.load(id);
        if (token !== this.loadToken) {
            disposeModel(root);
            return null;
        }
        this.setModel(root, info);
        return info;
    }

    clear() {
        this.removeModel();
        this.model = null;
        this.info = null;
        this.extras = [];
    }

    removeModel() {
        if (this.model) {
            this.pose.remove(this.model);
            disposeModel(this.model);
        }
    }

    setModel(root, info) {
        this.removeModel();
        this.model = root;
        this.info = info;
        this.extras = root.userData.extras;
        root.traverse((o) => {
            if (o.userData.extra) o.visible = false;
        });
        const box = new THREE.Box3().setFromObject(root);
        this.center = box.getCenter(new THREE.Vector3());
        this.radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.05);
        root.position.copy(this.center).negate();
        this.pose.add(root);
    }

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
        applyVehicleColors(this.model, state.c1, state.c2);
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
}
