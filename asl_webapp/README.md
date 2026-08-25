# ASL QUEST — webcam demo

A Flask + vanilla JS webapp that turns Task 1's two trained models into a playable,
retro Nintendo-style demo: sign a letter to your webcam and the selected model
classifies it live (A–Z plus `del` / `nothing` / `space`), while a sentence builder
auto-types letters you hold steady.

## Run it

```powershell
cd asl_webapp
pip install -r requirements.txt   # Python 3.11 + TensorFlow 2.x recommended
python app.py                     # http://127.0.0.1:5000
```

Models load lazily — the **first prediction per model takes a few seconds**
(weights are deserialized on demand); after that it's fast (~100 ms on CPU).

## Deploy to Render

The repo root has a `render.yaml` Blueprint (New → Blueprint, point it at this repo),
so deployment is one click: Render installs `requirements.txt`, starts gunicorn
(`app:app`, 1 worker / 4 threads), Python 3.11. HTTPS is automatic — required for
webcam access. The two `.keras` model files (~46 MB combined) are committed to the
repo so Render has them at build time.
Note: the free plan's 512 MB RAM is tight for TensorFlow; if the service OOMs,
switch to the Starter plan. `requirements.txt` uses `tensorflow-cpu` to keep the
install smaller than the full GPU-enabled package.

## How to play

1. Click **PRESS START** (this also grants the camera permission prompt).
2. **PLAYER SELECT**: pick your fighter — *Scratch CNN* or *EfficientNetB0*.
3. Press **START** on the NES pad for continuous prediction, or **A** for a single shot.
4. Hold your hand inside the gold brackets like the Kaggle dataset photos
   (right hand, plain background works best).
5. **MESSAGE LOG**: hold a sign at ≥85% confidence for ~5 frames and the letter
   auto-types (`space` adds a gap, `del` backspaces, `nothing` is ignored) —
   or press **B** to commit manually. Copy the sentence when you're done.
6. Extras: **HAND GUIDE** overlays MediaPipe landmark lines and auto-crops
   around your hand (only raw pixels are sent to the model — never the lines),
   **SELECT** mirrors the preview (frames sent are always raw),
   **CROP TO FRAME** sends just the bracketed square, **♪ SFX** toggles chiptune blips.

## Architecture

```
asl_webapp/
├── app.py                  # Flask API: /api/meta, /api/predict, lazy model loading
├── requirements.txt        # flask · tensorflow · numpy · pillow · gunicorn
├── templates/index.html    # boot screen, CRT TV, HUD, RPG dialog box, NES pad
└── static/
    ├── css/style.css       # pixel-art theme (Press Start 2P / VT323), no border-radius
    └── js/app.js           # webcam capture loop, stability tracking, Web Audio SFX
```

- Both `.keras` models bundle their preprocessing layers, so the server just decodes
  the JPEG data URL, resizes to 224×224 RGB and runs `model.predict` under a lock
  (thread-safe for gunicorn).
- Everything runs locally — no frame ever leaves your machine.
- If port 5000 is taken, change the last line of `app.py`.
