"""Flask backend for the ASL alphabet webcam demo.

Serves a single-page frontend and exposes JSON endpoints that run
inference with the Keras models saved in ../asl_trained_models.
Models are lazy-loaded under a lock so the app stays thread-safe
under gunicorn's multi-threaded worker, and no model is touched by
the liveness probe.
"""

import base64
import io
import json
import threading
import time
from pathlib import Path

import numpy as np
import tensorflow as tf
from flask import Flask, jsonify, render_template, request
from PIL import Image

tf.get_logger().setLevel("ERROR")

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR.parent

MODEL_FILES = {
    "scratch": ("Scratch CNN", "asl_scratch_cnn.keras"),
    "efficientnet": ("EfficientNetB0 (fine-tuned)", "asl_efficientnetb0_finetuned.keras"),
}

IMG_SIZE = 224

try:
    with open(MODELS_DIR / "class_names.json", encoding="utf-8") as f:
        _class_names = json.load(f)
except OSError:
    _class_names = [chr(c) for c in range(ord("A"), ord("Z") + 1)] + ["del", "nothing", "space"]

_lock = threading.Lock()
_models = {}


def get_model(key):
    """Return the cached model for `key`, loading it on first use.

    Only one model is kept resident at a time (evicting any other) to stay
    under Render free-tier's 512 MB RAM cap when a user switches models.
    """
    if key in _models:
        return _models[key]
    label, fname = MODEL_FILES[key]
    print(f"[model] loading {label} ...")
    with _lock:
        if key not in _models:
            _models.clear()
            _models[key] = tf.keras.models.load_model(MODELS_DIR / fname, compile=False)
    return _models[key]


def decode_frame(data_url):
    """Decode a base64 data URL into an RGB PIL image."""
    payload = data_url.split(",", 1)[1]
    img_bytes = base64.b64decode(payload)
    return Image.open(io.BytesIO(img_bytes)).convert("RGB")


def prepare(img):
    """Resize to the network input size and add a batch dimension."""
    img = img.resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
    arr = np.asarray(img, dtype=np.float32)
    return arr[np.newaxis, ...]


app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/meta")
def meta():
    stats = {}
    try:
        with open(MODELS_DIR / "model_comparison.json", encoding="utf-8") as f:
            rows = json.load(f)
        for row in rows:
            key = "efficientnet" if "EfficientNet" in row["Model"] else "scratch"
            stats[key] = {
                "testAccuracy": round(row["Test Accuracy"] * 100, 2),
                "params": row["Total Params"],
                "epochs": row["Epochs Trained"],
            }
    except OSError:
        pass

    models = []
    for key, (label, _) in MODEL_FILES.items():
        entry = {"id": key, "label": label}
        entry.update(stats.get(key, {}))
        models.append(entry)

    return jsonify(classes=_class_names, models=models)


@app.route("/api/predict", methods=["POST"])
def predict():
    body = request.get_json(silent=True) or {}
    key = body.get("model")
    data_url = body.get("image")
    if key not in MODEL_FILES or not data_url:
        return jsonify(error="bad request"), 400

    top_k = body.get("top_k", 5)
    try:
        top_k = max(1, min(29, int(top_k)))
    except (TypeError, ValueError):
        top_k = 5

    try:
        t0 = time.perf_counter()
        img = decode_frame(data_url)
        x = prepare(img)
        model = get_model(key)
        preds = model.predict(x, verbose=0)[0]
        latency_ms = round((time.perf_counter() - t0) * 1000)

        ranked = sorted(
            (
                {"label": name, "probability": round(float(p), 4)}
                for name, p in zip(_class_names, preds)
            ),
            key=lambda item: item["probability"],
            reverse=True,
        )[:top_k]

        best = ranked[0]
        return jsonify(
            label=best["label"],
            confidence=best["probability"],
            predictions=ranked,
            latency_ms=latency_ms,
        )
    except Exception as e:
        return jsonify(error=str(e)), 500


@app.route("/api/healthz")
def healthz():
    return jsonify(status="ok")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=3000, debug=False)
