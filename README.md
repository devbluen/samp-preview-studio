# TextDraw Model Preview (SA-MP / open.mp)

Offline simulator for `TEXT_DRAW_FONT_MODEL_PREVIEW`. Rotate, zoom and position skins, vehicles and objects, then copy the generated PAWN code. You don't need to connect to a server.

```bash
npm install
npm start          # http://localhost:3000
```

## Model sources

1. **assets.open.mp** (default): downloads the `.dff` files and textures used by [openmp-models](https://github.com/AmyrAhmady/openmp-models) and caches them in `cache/`. The catalog (`data/*.json`) comes from the same repository.
2. **Your GTA SA install** (optional): set `gtaPath` in `config.json` to the game folder. The server reads `gta.dat`/`default.dat`, the IDE files, `gta3.img`, `gta_int.img`, `SAMP/SAMP.img` and `SAMP/CUSTOM.img`, and decodes the TXD textures (DXT1/3/5, 8888, 565, palettized, ...). This adds every SA-MP object (18631+) and any modified model in your game. The "Auto / open.mp / Jogo local" selector chooses the source.

```json
{ "port": 3000, "gtaPath": "C:/Program Files (x86)/Rockstar Games/GTA San Andreas" }
```

See `config.example.json` for the defaults. You can also set `PORT` and `GTA_PATH` as environment variables.

## Usage

- Drag the preview to rotate (horizontal = Z, vertical = X, Shift + drag = Y). The mouse wheel controls zoom.
- In "Importar código" (import code), paste your textdraw block (`TextDraw*` or `PlayerTextDraw*`). It loads the rotation, model, size, color and position.
- In the "Na tela 640×448" (on screen) tab, load an in-game screenshot as the background to see the textdraw in its real position.
- Shareable URL: `/?model=411&rot=-16,0,-55,1&size=160,160`. Add `&view=screen` to open the screen tab.

## Accuracy

The SA-MP client's rendering code is closed source, so the camera is an approximation:

- The model rotates around its bounding-box center. The rotation order is X, then Y, then Z, on world axes.
- The camera sits on the +Y side, which is the front of skins and vehicles. A skin at rotation `0,0,0` faces the camera. A vehicle at `-16,0,-55` is seen from the front-left, slightly from above.
- The camera distance is proportional to the model radius × `zoom`. A smaller zoom value moves the camera closer, as in SA-MP.

If a result doesn't match the game, compare it once against a real textdraw and adjust it under "Calibração" (calibration). You can change the rotation order, camera side, FOV, distance and stretching. These settings are saved in the browser.
