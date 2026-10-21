# SA-MP Preview Studio

Previewer for SA-MP / open.mp. Set up textdraw model previews (`TEXT_DRAW_FONT_MODEL_PREVIEW`) and attached objects (`SetPlayerAttachedObject`), then copy the generated PAWN code. You don't need to connect to a server.

It runs in three ways, all with the same features:

| | How | Notes |
|---|---|---|
| **Website** | Open the GitHub Pages site | Nothing to install. Everything runs in your browser. |
| **Desktop app** | Download the `.exe` (Windows) or `.AppImage` (Linux) from [Releases](../../releases) | Its own window. Remembers the game folder and caches open.mp models for offline use. |
| **Local server** | `npm install` then `npm start` → http://localhost:3000 | For development. `npm run desktop` opens the desktop app from the source. |

## Model sources

1. **assets.open.mp** (always on): the original `.dff` files and textures used by [openmp-models](https://github.com/AmyrAhmady/openmp-models). The catalog (`data/*.json`) comes from the same repository.
2. **Your GTA SA folder** (optional): click **Choose GTA SA folder** at the top right. The folder is read on your computer (nothing is uploaded): `gta.dat`/`default.dat`, the IDE files, `gta3.img`, `gta_int.img`, `SAMP/SAMP.img` and `SAMP/CUSTOM.img`, and the TXD textures (DXT1/3/5, 8888, 565, palettized, ...). This adds every model your game has, including SA-MP objects (18631+) and your mods.

In the browser the folder is remembered in Chrome and Edge (you confirm access once per visit). If the browser refuses the folder (Chrome blocks folders inside `Program Files`), use **Compatibility mode**. It works in every browser, but you pick the folder again on each visit. The desktop app uses the normal Windows folder dialog and remembers the folder.

### Modified models (modloader)

Loose `.dff` and `.txd` files anywhere inside `modloader/` replace the files of the same name in the IMG archives, like modloader does in the game (folders starting with `.` are ignored). Models with a modified version show a green **mod** tag in the search results. Use the switch at the top to choose which version you see:

- **Modified**: your game's files including modloader mods, then open.mp for anything your game doesn't have.
- **Default**: the original model from open.mp, then your game's IMG archives without modloader.

Under the preview, a tag shows where the model was loaded from (`open.mp`, `gta3.img`, `modloader/.../file.dff`).

### Local server configuration

With `npm start` you can also set the folder in `config.json` instead of picking it in the page:

```json
{ "port": 3000, "gtaPath": "C:/Program Files (x86)/Rockstar Games/GTA San Andreas" }
```

See `config.example.json` for the defaults. You can also set `PORT`, `HOST` (default `127.0.0.1`) and `GTA_PATH` as environment variables. The server caches open.mp files in `cache/`.

### Troubleshooting

- **Nothing loads, not even the skin**: the page was probably opened as a file (double-clicking `index.html`). Browsers block the page's scripts there. Use the website, the desktop app or `npm start`.
- **Choosing the folder does nothing in Chrome**: Chrome refuses folders inside `Program Files`. Use **Compatibility mode**, the desktop app or `npm start` with `gtaPath`.

## Building

- `npm run build:web` creates the static site in `dist/`. The **Deploy to GitHub Pages** workflow does this on every push to `main`. To turn it on, go to Settings → Pages and set Source to **GitHub Actions**.
- `npm run dist:win` / `npm run dist:linux` create the desktop app in `release/` (Windows: portable `.exe` and installer). The **Build desktop app** workflow builds both. You can run it from the Actions tab, and pushing a tag such as `v1.1.0` publishes the builds on a GitHub Release.
- `npm run build:catalog` regenerates `public/data/catalog.json` after you update `data/*.json`.

## TextDraw preview

- Drag the preview to rotate (horizontal = Z, vertical = X, Shift + drag = Y). The mouse wheel controls zoom.
- In "Import code", paste your textdraw block (`TextDraw*` or `PlayerTextDraw*`). It loads the rotation, model, size, color and position.
- In the "On screen 640×448" tab, load an in-game screenshot as the background to see the textdraw in its real position.
- Shareable URL: `/?model=411&rot=-16,0,-55,1&size=160,160`. Add `&view=screen` to open the screen tab.

## Attached object editor

The "Attached object" tab (the first tab, opened by default) is a 3D editor for `SetPlayerAttachedObject` and `AttachObjectToVehicle`. Use **Attach to: Player / Vehicle** to switch. Each one keeps its own list of objects.

- Pick a skin, then add up to 10 slots (indexes 0-9). For each slot, choose the object model, the bone (all 18 SA-MP bones) and its offset, rotation, scale and material colors.
- **Browse** opens the object browser next to the 3D view, with thumbnails and categories (hats and caps, helmets, glasses, masks and bandanas, hair, watches, phones and tools, weapons, your modified objects, all objects). Click an object to use it in the selected slot, or **+** to add it as a new slot. Star (☆) the ones you use often, and the ones you used recently show up under **Recent**. SA-MP's own objects (18631+, where most accessories are) are not on open.mp, so they need your GTA SA folder.
- Drag the object to move it, or use the gizmo to move (W), rotate (E) or scale (R) it along one axis. The gizmo works in the bone's local axes by default. Click an object to select it and press F to focus the camera on it. Zoom with the mouse wheel or the zoom slider.
- The values update live in the generated `SetPlayerAttachedObject(playerid, index, modelid, bone, ...)` lines. You can also paste existing lines into "Import code" to edit them.
- Open it directly with `/?mode=attach`. Add `&view=front|back|left|right|top|focus` to choose the camera.

### Objects on vehicles

With **Vehicle** selected, pick the vehicle (and its colors) and add objects the same way. The offset and rotation are relative to the vehicle's origin, like `AttachObjectToVehicle`, which has no scale or bone. The code creates each object and attaches it to `vehicleid`. Tick **Streamer plugin** to get `CreateDynamicObject` + `AttachDynamicObjectToVehicle` instead. "Import code" reads those lines back. It takes the model from the `CreateObject`/`CreateDynamicObject` assigned to the same variable.

Objects on vehicles are rotated like any GTA object (`CMatrix::SetRotate`: Rz · Rx · Ry, the "ZXY" order). This comes from the game's code and was not checked against values in the game yet. If a rotated object doesn't match, compare it once and switch the order under Options.

### Player attachments

Each attachment is parented to the bone's frame, so the editor's local offset, rotation and scale are exactly the values SA-MP uses. Rotations are applied in SA-MP's order: X, then Y, then Z, on the object's local axes. This was verified against well-known in-game values (helmet 18645, santa hat 19065, sunglasses 19022). The skin is shown in the DFF bind pose (arms slightly open), not the in-game animated pose. The object's position relative to the bone is the same either way.

## TextDraw accuracy

The SA-MP client's rendering code is closed source, so the textdraw preview camera is an approximation:

- The model rotates around its bounding-box center. The rotation order is X, then Y, then Z, on world axes.
- The camera sits on the +Y side, which is the front of skins and vehicles. A skin at rotation `0,0,0` faces the camera. A vehicle at `-16,0,-55` is seen from the front-left, slightly from above.
- The camera distance is proportional to the model radius × `zoom`. A smaller zoom value moves the camera closer, as in SA-MP.

If a result doesn't match the game, compare it once against a real textdraw and adjust it under "Calibration". You can change the rotation order, camera side, FOV, distance and stretching. These settings are saved in the browser.

## Credits

- **[devbluen](https://github.com/devbluen)**: creator and maintainer.
- **Claude** ([Anthropic](https://www.anthropic.com/claude)): AI pair programmer. Helped build the web version, the desktop app and mod support.

Built with [openmp-models](https://github.com/AmyrAhmady/openmp-models) (model catalog and assets.open.mp files), [three.js](https://threejs.org) and [Electron](https://www.electronjs.org).

The **Credits** button at the top right of the app shows the same list.

## Preview
<img width="2089" height="1078" alt="Captura de tela 2026-10-20 235354" src="https://github.com/user-attachments/assets/e7b830d4-6e43-45b9-8504-8f04d52872bd" />
<img width="2088" height="1076" alt="Captura de tela 2026-10-20 235441" src="https://github.com/user-attachments/assets/b44e645c-e784-4d18-974d-ba23002d4bb5" />

