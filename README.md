# ASL Alphabet Classification

## Project description

This project trains and compares two deep learning models that classify static images of the American Sign Language (ASL) alphabet, then serves the better one behind a playable, retro-styled webcam demo.

The underlying goal is "AI for social good": accurate ASL letter recognition is a building block for sign-to-text translation, sign language learning apps, and tools that help non-signers communicate with the Deaf and hard-of-hearing community.

Two models are trained on the [Kaggle ASL Alphabet dataset](https://www.kaggle.com/datasets/grassknoted/asl-alphabet) (~87k images, 29 classes: A–Z plus `del`, `nothing`, `space`) and compared head-to-head:

| Model | Test accuracy | Macro-F1 | Params | Export size | Mean latency |
|---|---|---|---|---|---|
| Scratch CNN (VGG-style) | 99.99% | 0.9999 | 1.17M | 14.1 MB | ~78.5 ms |
| EfficientNetB0 (fine-tuned, last 30 layers) | 99.91% | 0.9991 | 4.38M | 33.0 MB | ~86.1 ms |

On this dataset the small from-scratch CNN matches (and slightly beats) the fine-tuned EfficientNetB0 while being smaller and faster — see the notebook's conclusion section for the full analysis of why, and where the trade-off would likely flip.

### What's in the repo

```
.
├── ASL_Alphabet_Classifier.ipynb   # Data prep, training, evaluation, and comparison of both models
├── models/                         # Exported .keras models used by the web app
│   ├── asl_scratch_cnn.keras
│   └── asl_efficientnetb0_finetuned.keras
├── model-comparison/               # Metrics + class list exported by the notebook
│   ├── class_names.json
│   └── model_comparison.json
├── asl_webapp/                     # Flask + vanilla JS webcam demo
│   ├── app.py
│   ├── requirements.txt
│   ├── templates/ , static/
│   └── README.md                   # Web app-specific details (gameplay controls, deploy notes)
└── render.yaml                     # One-click Render deployment blueprint for the web app
```

## Running it locally

There are two independent pieces: the **training notebook** (optional — trained models are already committed under `models/`) and the **web app** (the actual demo).

### 1. Web app (webcam demo)

Requires Python 3.11.

```powershell
cd asl_webapp
pip install -r requirements.txt
python app.py
```

Then open `http://127.0.0.1:5000` in a browser and allow camera access. The first prediction after picking a model takes a few seconds while its weights load; after that inference is fast (~100 ms on CPU). See `asl_webapp/README.md` for gameplay controls and Render deployment steps.

### 2. Training notebook (optional)

`ASL_Alphabet_Classifier.ipynb` was built for Google Colab (it mounts Google Drive and expects a GPU runtime). To rerun it:

1. Download the [ASL Alphabet dataset](https://www.kaggle.com/datasets/grassknoted/asl-alphabet) from Kaggle.
2. Open the notebook in Colab (or locally with Jupyter + a GPU), pointing the data-loading cell at your copy of the dataset instead of Google Drive if running outside Colab.
3. Install the core dependencies if running locally: `tensorflow`, `numpy`, `pandas`, `matplotlib`, `scikit-learn`, `pillow`.
4. Run all cells. Section 13 exports the trained models, class list, and comparison JSON into the same layout used by `models/` and `model-comparison/` above.

## Author

Javian Ng — built for IT3381 Applied Deep Learning, Part 1 (Computer Vision).
