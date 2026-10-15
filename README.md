# SA-MP Preview Studio

Offline previewer for SA-MP / open.mp. Set up textdraw model previews (`TEXT_DRAW_FONT_MODEL_PREVIEW`) and attached objects (`SetPlayerAttachedObject`), then copy the generated PAWN code. You don't need to connect to a server.

```bash
npm install
npm start          # http://localhost:3000
```

## Model sources

1. **assets.open.mp** (default): downloads the `.dff` files and textures used by [openmp-models](https://github.com/AmyrAhmady/openmp-models) and caches them in `cache/`. The catalog (`data/*.json`) comes from the same repository.
2. **Your GTA SA install** (optional): set `gtaPath` in `config.json` to the game folder. The server reads `gta.dat`/`default.dat`, the IDE files, `gta3.img`, `gta_int.img`, `SAMP/SAMP.img` and `SAMP/CUSTOM.img`, and decodes the TXD textures (DXT1/3/5, 8888, 565, palettized, ...). This adds every SA-MP object (18631+) and any modified model in your game. The "Auto / open.mp / Local game" selector chooses the source.

```json
{ "port": 3000, "gtaPath": "C:/Program Files (x86)/Rockstar Games/GTA San Andreas" }
```

See `config.example.json` for the defaults. You can also set `PORT` and `GTA_PATH` as environment variables.

## TextDraw preview

- Drag the preview to rotate (horizontal = Z, vertical = X, Shift + drag = Y). The mouse wheel controls zoom.
- In "Import code", paste your textdraw block (`TextDraw*` or `PlayerTextDraw*`). It loads the rotation, model, size, color and position.
- In the "On screen 640×448" tab, load an in-game screenshot as the background to see the textdraw in its real position.
- Shareable URL: `/?model=411&rot=-16,0,-55,1&size=160,160`. Add `&view=screen` to open the screen tab.

## Attached object editor

The "Attached object" tab is a 3D editor for `SetPlayerAttachedObject`:

- Pick a skin, then add up to 10 slots (indexes 0-9). For each slot, choose the object model, the bone (all 18 SA-MP bones) and its offset, rotation, scale and material colors.
- Drag the object to move it, or use the gizmo to move (W), rotate (E) or scale (R) it along one axis. The gizmo works in the bone's local axes by default. Click an object to select it and press F to focus the camera on it. Zoom with the mouse wheel or the zoom slider.
- The values update live in the generated `SetPlayerAttachedObject(playerid, index, modelid, bone, ...)` lines. You can also paste existing lines into "Import code" to edit them.
- Open it directly with `/?mode=attach`. Add `&view=front|back|left|right|top|focus` to choose the camera.

Each attachment is parented to the bone's frame, so the editor's local offset, rotation and scale are exactly the values SA-MP uses. Rotations are applied in SA-MP's order: X, then Y, then Z, on the object's local axes. This was verified against well-known in-game values (helmet 18645, santa hat 19065, sunglasses 19022). The skin is shown in the DFF bind pose (arms slightly open), not the in-game animated pose. The object's position relative to the bone is the same either way.

## TextDraw accuracy

The SA-MP client's rendering code is closed source, so the textdraw preview camera is an approximation:

- The model rotates around its bounding-box center. The rotation order is X, then Y, then Z, on world axes.
- The camera sits on the +Y side, which is the front of skins and vehicles. A skin at rotation `0,0,0` faces the camera. A vehicle at `-16,0,-55` is seen from the front-left, slightly from above.
- The camera distance is proportional to the model radius × `zoom`. A smaller zoom value moves the camera closer, as in SA-MP.

If a result doesn't match the game, compare it once against a real textdraw and adjust it under "Calibration". You can change the rotation order, camera side, FOV, distance and stretching. These settings are saved in the browser.
