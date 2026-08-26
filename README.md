# ASL Alphabet Classification with Deep Learning

Author: Javian Ng

A CNN trained from scratch and a fine-tuned EfficientNetB0 are built and compared on the task of classifying static hand-sign images of the American Sign Language (ASL) alphabet, then wired up into a playable webcam demo.

## Why this project

ASL is the primary language for many Deaf and hard-of-hearing people, and a model that can recognise ASL letters from an image has real uses: sign-to-text translation, sign-language learning apps, or tools that let non-signers communicate with signers. It falls under "AI for Social Good" for that reason.

Letters like M, N, and S look almost identical (closed fists with small finger differences), so hand-crafted features don't hold up well across lighting, skin tones, and backgrounds. CNNs learn those local finger/knuckle patterns straight from pixels instead, which is why they're the approach here.

## What's in this repo

```
.
├── ASL_Alphabet_Classification.ipynb # Jupyter notebook 
├── asl_scratch_cnn.keras             # trained scratch CNN, exported
├── asl_efficientnetb0_finetuned.keras  # trained fine-tuned EfficientNetB0, exported
├── class_names.json                  # ordered list of the 29 output classes
├── model_comparison.json             # accuracy/params/epochs summary for both models
├── render.yaml                       # Render Blueprint for one-click webapp deployment
└── asl_webapp/                       # Flask + JS webcam demo that serves both models
    ├── app.py
    ├── requirements.txt
    ├── templates/index.html
    └── static/{css,js}
```

## Dataset

[Kaggle ASL Alphabet](https://www.kaggle.com/datasets/grassknoted/asl-alphabet) ~87,000 images across 29 classes (A–Z plus `del`, `nothing`, `space`), roughly balanced. Split stratified 80/10/10 into train/validation/test so every class is proportionally represented in all three.

## Models

| | Scratch CNN | EfficientNetB0 (fine-tuned) |
|---|---|---|
| Architecture | VGG-style: 4 conv blocks (BatchNorm + ReLU), global average pooling, dropout, dense head | ImageNet-pretrained backbone, last 30 layers fine-tuned, new dense head |
| Test accuracy | 100.0% | 99.92% |
| Macro-F1 | 1.000 | 0.999 |
| Parameters | 1.17M | 4.38M |
| Epochs trained | 21 (of 25, early stopped) | 20 (10 frozen + 10 fine-tuned) |
| Mean inference latency | ~76 ms | ~83 ms |
| Export size | 14.1 MB | 33.0 MB |

Both models share the same augmentation stack (small random rotation, zoom, translation, brightness, contrast) and the same training callbacks: checkpointing on best validation accuracy, early stopping, LR reduction on plateau, and CSV history logging. During EfficientNetB0 fine-tuning, BatchNorm sub-layers in the unfrozen block are explicitly kept frozen to preserve the ImageNet running statistics.

**Takeaway:** the two models land within 0.1% accuracy of each other, so the extra size and complexity of EfficientNetB0 doesn't clearly pay off here. The ASL Alphabet dataset (plain background, one subject, consistent framing) is constrained enough that the much smaller, faster scratch CNN already solves it near-perfectly. EfficientNetB0 would likely pull ahead on messier, real-world data (see limitations below), which is part of why the webapp still lets you pick either model.

## Limitations

1. **J and Z are motion letters**: they involve a finger trace/wiggle, which no static-frame classifier can represent; only an approximate handshape is captured.
2. **Studio-vs-webcam domain gap**: training images are clean, centred, and consistently lit, while live webcam frames are noisier, so expect some accuracy drop in the live demo.
3. **No hand ROI cropping**: full frames include sleeves and background, so some signal leaks in from context rather than the hand itself.

## The notebook

`ASL_Alphabet_Classification` walks through the full pipeline end to end: EDA and class balance checks → stratified split → `tf.data` input pipelines → shared augmentation → both model architectures → training (single-phase for the scratch CNN, two-phase frozen/fine-tuned for EfficientNetB0) → final evaluation on the held-out test set (confusion matrices, per-class F1, most-confused pairs, misclassification gallery, latency benchmark) → head-to-head comparison charts → export of both `.keras` models, `class_names.json`, and `model_comparison.json`.

To run it, open in Jupyter/Colab/VS Code with a GPU runtime recommended (CPU works but training will be slow), point it at a local copy of the Kaggle dataset, and run top to bottom. I used an L4 GPU runtime and it took around 3 hours for the whole notebook to run. 

## The webapp

`asl_webapp/` turns both trained models into "ASL QUEST", a retro Nintendo-style webcam demo: sign a letter, get a live prediction, and build up a sentence by holding signs steady. See [`asl_webapp/README.md`](asl_webapp/README.md) for how to run it locally and how to deploy it to Render with the included `render.yaml` blueprint.

Quick start:

```bash
cd asl_webapp
pip install -r requirements.txt
python app.py   # http://127.0.0.1:5000
```

## Tech stack

TensorFlow/Keras, EfficientNetB0 (ImageNet weights), Flask, vanilla JS, deployed via Render.

## Reference

Tan, M., & Le, Q. (2019). EfficientNet: Rethinking Model Scaling for Convolutional Neural Networks.

Kaggle *ASL Alphabet* dataset (grassknoted): https://www.kaggle.com/datasets/grassknoted/asl-alphabet
