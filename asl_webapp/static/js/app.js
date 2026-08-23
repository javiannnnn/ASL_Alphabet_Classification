/* ============================================================
   ASL QUEST — frontend logic
   Vanilla ES2020+, single file, no frameworks.
   Sections: config/state · dom · utils · audio · boot · meta/
   model-select · camera · capture · predictions/hud · sentence
   · live loop · controls · init
   ============================================================ */
(() => {
  'use strict';

  /* ---------------------- 1. CONFIG & STATE ---------------------- */

  const META_URL = '/api/meta';
  const PREDICT_URL = '/api/predict';
  const TICK_MS = 180;            // target ms between live predictions
  const HOLD_FRAMES_NEEDED = 5;   // steady frames before auto-type commits
  const HOLD_MIN_CONF = 0.85;     // min confidence to count as "steady"
  const COOLDOWN_FRAMES = 15;     // frames required between repeat commits
  const LOW_CONF_CUTOFF = 0.6;    // below this the big letter becomes "?"
  const MAX_LEN = 64;             // sentence buffer cap

  const state = {
    booted: false,
    classes: [],
    models: [],
    currentModel: 'scratch',
    streaming: false,
    live: false,
    pendingLive: false,
    inFlight: false,
    awaitingFirstPredict: false,
    requestToken: 0,
    loopTimer: null,
    abortCtrl: null,
    lastLabel: null,       // last predicted label (for combo streak)
    agreeStreak: 0,        // consecutive frames agreeing on one label
    stableLabel: null,     // label currently being held steady
    stableCount: 0,        // consecutive qualifying frames of stableLabel
    cooldownFrames: 0,     // frames left before repeat commit allowed
    lastCommitted: null,   // last label auto-typed
    lastPrediction: null,  // {label, confidence}
    mirror: true,
    typeOnHold: true,
    cropToFrame: false,
    handGuide: true,
    handBox: null,         // {x,y,w,h,t} raw-video px crop rect from MediaPipe
    soundOn: true,
    sentence: '',
  };

  const modelCards = new Map(); // model id -> card element

  /* --------------------------- 2. DOM ---------------------------- */

  const $id = (id) => document.getElementById(id);

  const els = {}; // filled in cacheDom()

  function cacheDom() {
    [
      'errorBanner', 'errorBannerText',
      'bootOverlay', 'pressStart',
      'classCount', 'modelGrid',
      'cam', 'snapCanvas', 'crtScreen', 'aimBrackets', 'handOverlay',
      'handGuideToggle',
      'loadingOverlay', 'gameOver', 'gameOverMsg', 'retryBtn',
      'predLetter', 'signPanel', 'powerMeter', 'comboCounter', 'speedReadout',
      'top5List',
      'dialogBox', 'sentenceText', 'lenCounter',
      'backspaceBtn', 'spaceBtn', 'clearBtn', 'copyBtn',
      'captureBtn', 'addLetterBtn', 'liveBtn', 'recDot', 'mirrorBtn', 'recLed',
      'typeHoldToggle', 'cropToggle', 'soundToggle',
    ].forEach((id) => { els[id] = $id(id); });

    els.snapCtx = els.snapCanvas.getContext('2d');
  }

  /* -------------------------- 3. UTILS --------------------------- */

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function span(className, text) {
    const s = document.createElement('span');
    s.className = className;
    s.textContent = text;
    return s;
  }

  // Re-trigger a CSS animation class.
  function bump(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // force reflow so the animation restarts
    el.classList.add(cls);
  }

  let errorTimer = null;
  function flashError(msg) {
    els.errorBannerText.textContent = msg;
    els.errorBanner.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { els.errorBanner.hidden = true; }, 3000);
  }

  /* --------------------- 4. AUDIO (Web Audio synth) -------------- */

  const sfx = (() => {
    let ctx = null;

    function ac() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { try { ctx = new AC(); } catch (e) { ctx = null; } }
      }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    function tone(freq, dur, type = 'square', vol = 0.04, delay = 0) {
      if (!state.soundOn) return;
      const c = ac();
      if (!c) return;
      const t = c.currentTime + delay;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }

    return {
      unlock() { ac(); },
      jingle() { // boot: three ascending notes
        tone(392.0, 0.12, 'square', 0.05, 0.00);
        tone(523.25, 0.12, 'square', 0.05, 0.13);
        tone(783.99, 0.22, 'square', 0.05, 0.26);
      },
      blip() { tone(660, 0.07, 'square', 0.04); },
      typed() { tone(880, 0.06, 'square', 0.045); tone(1318.5, 0.05, 'square', 0.03, 0.06); },
      buzz() { tone(110, 0.28, 'sawtooth', 0.05); },
      shutter() { tone(1500, 0.03, 'square', 0.05); tone(300, 0.05, 'square', 0.04, 0.045); },
    };
  })();

  /* ----------------------- 5. BOOT OVERLAY ----------------------- */

  function dismissBoot() {
    if (state.booted) return;
    state.booted = true;
    els.bootOverlay.hidden = true;
    sfx.unlock();      // first user gesture: lazily create AudioContext
    sfx.jingle();
    startCamera();     // needs the gesture anyway (autoplay policy)
  }

  /* ------------------ 6. META / MODEL SELECT --------------------- */

  async function loadMeta() {
    try {
      const res = await fetch(META_URL);
      if (!res.ok) throw new Error(`META ERROR ${res.status}`);
      const data = await res.json();
      state.classes = Array.isArray(data.classes) ? data.classes : [];
      state.models = Array.isArray(data.models) ? data.models : [];
      els.classCount.textContent = state.classes.length ? String(state.classes.length) : '--';
      renderModelCards();
      const preferred = state.models.some((m) => m.id === state.currentModel)
        ? state.currentModel
        : (state.models[0] ? state.models[0].id : null);
      if (preferred) {
        state.currentModel = preferred;
        markSelectedCard(preferred);
      }
    } catch (err) {
      els.modelGrid.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'model-loading';
      p.textContent = 'META UNREACHABLE - RELOAD PAGE';
      els.modelGrid.appendChild(p);
      flashError(err.message || 'CANNOT REACH SERVER');
    }
  }

  function accToStars(acc) {
    if (!Number.isFinite(acc)) return 0;
    return Math.max(0, Math.min(5, Math.round(acc / 20)));
  }

  function renderModelCards() {
    els.modelGrid.innerHTML = '';
    modelCards.clear();

    if (!state.models.length) {
      const p = document.createElement('p');
      p.className = 'model-loading';
      p.textContent = 'NO MODELS FOUND';
      els.modelGrid.appendChild(p);
      return;
    }

    state.models.forEach((m) => {
      const acc = Number(m.testAccuracy);
      const stars = accToStars(acc);
      const params = Number.isFinite(Number(m.params)) ? Number(m.params).toLocaleString('en-US') : '--';

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'model-card';
      card.dataset.model = m.id;
      card.innerHTML = `
        <span class="selected-tag">&#9654; SELECTED</span>
        <h3 class="mc-name">${esc(m.label || m.id)}</h3>
        <p class="mc-stat"><span>TEST ACC</span><b>${Number.isFinite(acc) ? acc.toFixed(2) : '--'}%
          <span class="mc-stars">${'\u2605'.repeat(stars)}${'\u2606'.repeat(5 - stars)}</span></b></p>
        <p class="mc-stat"><span>PARAMS</span><b>${params}</b></p>
        <p class="mc-stat"><span>EPOCHS</span><b>${m.epochs == null ? '--' : esc(m.epochs)}</b></p>
        <div class="hp-meter" role="img" aria-label="Accuracy meter">
          <i class="hp-fill" style="width:${Number.isFinite(acc) ? Math.min(100, Math.max(0, acc)) : 0}%"></i>
        </div>
        <p class="mc-foot">ACC METER</p>`;
      card.addEventListener('click', () => selectModel(m.id));
      els.modelGrid.appendChild(card);
      modelCards.set(m.id, card);
    });
  }

  function markSelectedCard(id) {
    modelCards.forEach((card, mid) => card.classList.toggle('is-selected', mid === id));
  }

  function selectModel(id) {
    if (!state.models.length || id === state.currentModel) return;
    if (!modelCards.has(id)) return;

    state.currentModel = id;
    if (state.abortCtrl) state.abortCtrl.abort(); // drop stale request

    markSelectedCard(id);
    resetPredictionHud();

    state.awaitingFirstPredict = true;
    els.loadingOverlay.hidden = false; // LOADING... until first success
    sfx.blip();
  }

  function stepModel(dir) {
    if (state.models.length < 2) return;
    const idx = state.models.findIndex((m) => m.id === state.currentModel);
    const next = ((idx < 0 ? 0 : idx) + dir + state.models.length) % state.models.length;
    selectModel(state.models[next].id);
  }

  /* ------------------------- 7. CAMERA --------------------------- */

  async function startCamera() {
    els.gameOver.hidden = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showGameOver('UNSUPPORTED', 'WEBCAM API NOT SUPPORTED IN THIS BROWSER');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      els.cam.srcObject = stream;
      await els.cam.play().catch(() => {});
      state.streaming = true;
      els.gameOver.hidden = true;
      updateBrackets();
      if (state.handGuide) ensureLandmarker();
      if (state.pendingLive) {
        state.pendingLive = false;
        startLive();
      }
    } catch (err) {
      state.streaming = false;
      showGameOver(err && err.name, err && err.message);
    }
  }

  function showGameOver(errName, rawMessage) {
    let msg;
    switch (errName) {
      case 'NotAllowedError':
      case 'SecurityError':
        msg = 'PERMISSION DENIED<br>CAMERA IS BLOCKED BY THE BROWSER';
        break;
      case 'NotFoundError':
      case 'OverconstrainedError':
        msg = 'CAMERA UNPLUGGED<br>CONNECT A WEBCAM AND RETRY';
        break;
      case 'NotReadableError':
      case 'AbortError':
        msg = 'CAMERA BUSY<br>ANOTHER APP IS USING IT';
        break;
      default:
        msg = esc(String(rawMessage || errName || 'UNKNOWN FAULT')).slice(0, 120) || 'UNKNOWN FAULT';
    }
    els.gameOverMsg.innerHTML = msg;
    els.gameOver.hidden = false;
    flashError('CAMERA FAULT');
    sfx.buzz();
  }

  /* -------------------- 8. FRAME CAPTURE ------------------------- */

  // Positions the aiming brackets over the exact region grabFrame() sends,
  // mapping the raw-video crop rect through object-fit: cover onto the screen.
  function updateBrackets() {
    const wrap = els.crtScreen;
    if (!wrap || !els.aimBrackets) return;
    const dw = wrap.clientWidth;
    const dh = wrap.clientHeight;
    const vw = els.cam.videoWidth;
    const vh = els.cam.videoHeight;
    if (!dw || !dh || !vw || !vh) return;

    // raw-video source rect that grabFrame() actually sends
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (state.cropToFrame) {
      const side = Math.min(vw, vh);
      sx = (vw - side) / 2;
      sy = (vh - side) / 2;
      sw = side;
      sh = side;
    }

    // cover: scale so raw frame fills display, centered; may overflow edges
    const scale = Math.max(dw / vw, dh / vh);
    const offX = (dw - vw * scale) / 2;
    const offY = (dh - vh * scale) / 2;

    Object.assign(els.aimBrackets.style, {
      inset: 'auto',
      top: `${sy * scale + offY}px`,
      left: `${sx * scale + offX}px`,
      width: `${sw * scale}px`,
      height: `${sh * scale}px`,
    });
  }

  // Grabs the RAW (unmirrored — mirroring is CSS-only) frame as a JPEG data URL.
  function grabFrame() {
    const vw = els.cam.videoWidth;
    const vh = els.cam.videoHeight;
    if (!vw || !vh) return null;

    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;

    const box = state.handBox;
    if (state.handGuide && box && performance.now() - box.t < HAND_BOX_TTL) {
      // MediaPipe found a hand recently — send a hand-centred square
      sx = Math.round(box.x);
      sy = Math.round(box.y);
      sw = Math.round(box.w);
      sh = Math.round(box.h);
    } else if (state.cropToFrame) {
      // central square matching the aiming brackets
      const side = Math.min(vw, vh);
      sx = Math.round((vw - side) / 2);
      sy = Math.round((vh - side) / 2);
      sw = side;
      sh = side;
    }

    els.snapCanvas.width = sw;
    els.snapCanvas.height = sh;
    els.snapCtx.drawImage(els.cam, sx, sy, sw, sh, 0, 0, sw, sh);
    return els.snapCanvas.toDataURL('image/jpeg', 0.8);
  }

  /* --------------- 8b. MEDIAPIPE HAND GUIDE ---------------------- */
  // Draws landmark lines on the preview and tracks a hand-centred crop
  // rect. Only RAW pixels are ever sent to the model — never the drawing.

  const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const HAND_MODEL_URL =
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],          // thumb
    [0, 5], [5, 6], [6, 7], [7, 8],          // index
    [5, 9], [9, 10], [10, 11], [11, 12],     // middle
    [9, 13], [13, 14], [14, 15], [15, 16],   // ring
    [13, 17], [17, 18], [18, 19], [19, 20],  // pinky
    [0, 17],                                 // palm base
  ];
  const HAND_BOX_TTL = 600;   // ms a detection stays valid for capture
  const HAND_LOOP_MS = 110;   // detection cadence

  let landmarker = null;
  let landmarkerLoading = false;
  let handLoopTimer = null;
  let lastDetectTs = -1;
  let goldColor = null;

  async function ensureLandmarker() {
    if (landmarker || landmarkerLoading) return;
    landmarkerLoading = true;
    try {
      const mp = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await mp.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      landmarker = await mp.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
      });
      startHandLoop();
    } catch (err) {
      console.error('MediaPipe failed to load:', err);
      flashError('HAND GUIDE OFFLINE');
      state.handGuide = false;
      els.handGuideToggle.checked = false;
    } finally {
      landmarkerLoading = false;
    }
  }

  function startHandLoop() {
    if (handLoopTimer) return;
    handLoopTimer = setInterval(detectAndDraw, HAND_LOOP_MS);
  }

  function stopHandLoop() {
    clearInterval(handLoopTimer);
    handLoopTimer = null;
  }

  function coverGeometry() {
    const dw = els.crtScreen.clientWidth;
    const dh = els.crtScreen.clientHeight;
    const vw = els.cam.videoWidth;
    const vh = els.cam.videoHeight;
    if (!dw || !dh || !vw || !vh) return null;
    const scale = Math.max(dw / vw, dh / vh);
    return {
      dw, dh, vw, vh, scale,
      offX: (dw - vw * scale) / 2,
      offY: (dh - vh * scale) / 2,
    };
  }

  function detectAndDraw() {
    const canvas = els.handOverlay;
    if (!canvas || !state.streaming || !landmarker) return;
    const geo = coverGeometry();
    if (!geo) return;

    if (canvas.width !== geo.dw || canvas.height !== geo.dh) {
      canvas.width = geo.dw;
      canvas.height = geo.dh;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let lm = null;
    try {
      const ts = Math.max(lastDetectTs + 1, performance.now());
      lastDetectTs = ts;
      const res = landmarker.detectForVideo(els.cam, ts);
      if (res.landmarks && res.landmarks.length) lm = res.landmarks[0];
    } catch (_) {
      return;
    }

    if (!lm) {
      state.handBox = null;
      return;
    }

    // normalized landmarks -> raw video px
    const px = lm.map((p) => ({ x: p.x * geo.vw, y: p.y * geo.vh }));

    // hand-centred square crop rect (raw px), padded like dataset framing
    const xs = px.map((p) => p.x);
    const ys = px.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    let side = Math.max(maxX - minX, maxY - minY) * 1.9;
    side = Math.min(side, geo.vw, geo.vh);
    let bx = (minX + maxX) / 2 - side / 2;
    let by = (minY + maxY) / 2 - side / 2;
    bx = Math.max(0, Math.min(bx, geo.vw - side));
    by = Math.max(0, Math.min(by, geo.vh - side));
    state.handBox = { x: bx, y: by, w: side, h: side, t: performance.now() };

    if (!goldColor) {
      goldColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--gold').trim() || '#ffd23f';
    }
    const toDisp = (p) => ({ x: p.x * geo.scale + geo.offX, y: p.y * geo.scale + geo.offY });
    const pts = px.map(toDisp);

    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;

    ctx.strokeStyle = goldColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
    }
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // dashed rect over the exact region being captured
    const box = toDisp({ x: bx, y: by });
    ctx.strokeStyle = 'rgba(85, 255, 136, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(box.x, box.y, side * geo.scale, side * geo.scale);
    ctx.setLineDash([]);
  }

  /* ------------------ 9. PREDICTIONS & HUD ----------------------- */

  async function predictOnce(preCapturedImage) {
    if (state.inFlight) return;
    const image = preCapturedImage || grabFrame();
    if (!image) { flashError('CAMERA OFFLINE'); return; }

    state.inFlight = true;
    const token = ++state.requestToken;
    const ctrl = new AbortController();
    state.abortCtrl = ctrl;

    try {
      const res = await fetch(PREDICT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: state.currentModel, image, top_k: 5 }),
        signal: ctrl.signal,
      });

      let data = null;
      try { data = await res.json(); } catch (e) { /* non-JSON body */ }
      if (!res.ok) {
        throw new Error((data && data.error) ? data.error : `SERVER ERROR ${res.status}`);
      }
      if (token !== state.requestToken) return; // stale response after model switch

      handlePrediction(data);
    } catch (err) {
      if (err && err.name === 'AbortError') return; // aborted on purpose
      flashError((err && err.message) || 'PREDICTION FAILED');
      sfx.buzz();
    } finally {
      state.inFlight = false;
      if (state.abortCtrl === ctrl) state.abortCtrl = null;
    }
  }

  function handlePrediction(data) {
    els.loadingOverlay.hidden = true;
    state.awaitingFirstPredict = false;

    const label = String(data.label != null ? data.label : '?');
    const conf = Number(data.confidence) || 0;
    state.lastPrediction = { label, confidence: conf };

    // Big letter ("?" when unsure)
    if (conf < LOW_CONF_CUTOFF) {
      els.predLetter.textContent = '?';
      els.signPanel.classList.add('is-low');
    } else {
      els.predLetter.textContent = label;
      els.signPanel.classList.remove('is-low');
    }

    // Combo: consecutive frames agreeing on the same label
    state.agreeStreak = (label === state.lastLabel) ? state.agreeStreak + 1 : 1;
    state.lastLabel = label;
    els.comboCounter.textContent = `COMBO x${state.agreeStreak}`;
    bump(els.comboCounter, 'bump');

    // Stability tracking for TYPE ON HOLD
    const qualifies = conf >= HOLD_MIN_CONF && label !== 'nothing';
    if (qualifies && label === state.stableLabel) {
      state.stableCount += 1;
    } else {
      state.stableLabel = qualifies ? label : null;
      state.stableCount = qualifies ? 1 : 0;
    }
    if (state.cooldownFrames > 0) state.cooldownFrames -= 1;

    if (
      state.typeOnHold &&
      qualifies &&
      state.stableCount >= HOLD_FRAMES_NEEDED &&
      (state.cooldownFrames <= 0 || label !== state.lastCommitted)
    ) {
      if (commitLetter(label)) {
        state.lastCommitted = label;
        state.cooldownFrames = COOLDOWN_FRAMES;
      }
      state.stableCount = 0;
    }

    setPower(conf);
    renderTop5(Array.isArray(data.predictions) ? data.predictions : []);
    els.speedReadout.textContent = `SPEED: ${Math.round(Number(data.latency_ms) || 0)}MS`;
  }

  function buildPowerMeter() {
    for (let i = 0; i < 10; i++) {
      const seg = document.createElement('i');
      seg.style.setProperty('--i', String(i));
      seg.classList.add(i < 6 ? 'seg-g' : i < 8 ? 'seg-y' : 'seg-r');
      els.powerMeter.appendChild(seg);
    }
  }

  function setPower(conf) {
    const lit = Math.max(0, Math.min(10, Math.round((Number(conf) || 0) * 10)));
    Array.from(els.powerMeter.children).forEach((seg, i) => {
      seg.classList.toggle('on', i < lit);
    });
  }

  const RANKS = ['1ST', '2ND', '3RD', '4TH', '5TH'];

  function renderTop5(rows) {
    els.top5List.innerHTML = '';

    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'top5-empty';
      li.textContent = 'NO DATA YET';
      els.top5List.appendChild(li);
      return;
    }

    const max = Math.max(1e-9, ...rows.map((r) => Math.max(0, Number(r.probability) || 0)));
    rows.slice(0, 5).forEach((row, i) => {
      const p = Math.max(0, Number(row.probability) || 0);

      const li = document.createElement('li');
      li.className = 'top5-row' + (i === 0 ? ' r1' : '');

      const dots = document.createElement('span');
      dots.className = 't5-leader';

      const bar = document.createElement('span');
      bar.className = 't5-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round((p / max) * 100)}%`;
      bar.appendChild(fill);

      li.append(
        span('t5-rank', RANKS[i]),
        span('t5-label', String(row.label)),
        dots,
        span('t5-pct', `${(p * 100).toFixed(1)}%`),
        bar
      );
      els.top5List.appendChild(li);
    });
  }

  function resetPredictionHud() {
    state.lastLabel = null;
    state.agreeStreak = 0;
    state.stableLabel = null;
    state.stableCount = 0;
    state.cooldownFrames = 0;
    state.lastCommitted = null;
    state.lastPrediction = null;

    els.comboCounter.textContent = 'COMBO x0';
    els.predLetter.textContent = '?';
    els.signPanel.classList.add('is-low');
    setPower(0);
    els.speedReadout.textContent = 'SPEED: ---MS';
    renderTop5([]);
  }

  /* -------------------- 10. SENTENCE BUILDER --------------------- */

  function renderSentence(popLast) {
    els.sentenceText.innerHTML = '';
    [...state.sentence].forEach((ch, i) => {
      const s = span(null, ch === ' ' ? '\u00A0' : ch);
      if (popLast && i === state.sentence.length - 1) s.classList.add('char-pop');
      els.sentenceText.appendChild(s);
    });
    els.lenCounter.textContent = `LEN ${String(state.sentence.length).padStart(3, '0')}/${MAX_LEN}`;
  }

  function shakeDialog() { bump(els.dialogBox, 'shake'); }

  function commitLetter(label) {
    if (label === 'nothing') return false;

    if (label === 'del') {
      if (!state.sentence.length) return false;
      state.sentence = state.sentence.slice(0, -1);
      renderSentence(false);
      sfx.typed();
      shakeDialog();
      return true;
    }

    if (state.sentence.length >= MAX_LEN) {
      flashError('BUFFER FULL! MAX 64 CHARS');
      sfx.buzz();
      return false;
    }

    state.sentence += (label === 'space') ? ' ' : label;
    renderSentence(true);
    bump(els.predLetter, 'pop');
    sfx.typed();
    shakeDialog();
    return true;
  }

  async function copySentence() {
    const text = state.sentence;
    if (!text) {
      flashCopy(copyBtnLabel(), 'EMPTY!');
      return;
    }
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e2) { ok = false; }
    }
    flashCopy(copyBtnLabel(), ok ? 'COPIED!' : 'FAILED!');
    if (ok) sfx.blip();
  }

  let copyTimer = null;
  function copyBtnLabel() {
    return els.copyBtn.dataset.label || (els.copyBtn.dataset.label = els.copyBtn.textContent);
  }
  function flashCopy(original, msg) {
    els.copyBtn.textContent = msg;
    els.copyBtn.classList.add('is-flashing');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      els.copyBtn.textContent = original;
      els.copyBtn.classList.remove('is-flashing');
    }, 1200);
  }

  /* ------------------------ 11. LIVE LOOP ------------------------ */

  function startLive() {
    if (state.live) return;
    if (!state.streaming) { // camera dead/never granted -> (re)request first
      state.pendingLive = true;
      startCamera();
      return;
    }
    state.live = true;
    updateLiveUi();
    scheduleTick();
  }

  function stopLive() {
    state.live = false;
    state.pendingLive = false;
    clearTimeout(state.loopTimer);
    state.loopTimer = null;
    if (state.abortCtrl) state.abortCtrl.abort();
    updateLiveUi();
  }

  // setTimeout chain (NOT setInterval): skip a tick while a request is in flight.
  function scheduleTick() {
    state.loopTimer = setTimeout(() => {
      if (!state.live) return;
      if (!state.inFlight && state.streaming) predictOnce();
      scheduleTick();
    }, TICK_MS);
  }

  function updateLiveUi() {
    els.liveBtn.classList.toggle('is-live', state.live);
    els.liveBtn.setAttribute('aria-pressed', String(state.live));
    els.recLed.classList.toggle('led-live-on', state.live); // CSS drives REC dot visibility
  }

  /* --------------------- 12. CONTROLS WIRING --------------------- */

  function wireControls() {
    // boot screen: click anywhere (or Enter/Space globally) starts the game
    els.bootOverlay.addEventListener('click', dismissBoot);

    // game over retry
    els.retryBtn.addEventListener('click', () => {
      els.gameOver.hidden = true;
      startCamera();
    });

    // NES pad
    els.captureBtn.addEventListener('click', () => {
      const image = grabFrame();
      if (!image) { flashError('CAMERA OFFLINE'); return; }
      sfx.shutter();
      predictOnce(image); // single shot regardless of live state
    });

    els.addLetterBtn.addEventListener('click', () => {
      const lp = state.lastPrediction;
      if (lp && lp.label !== 'nothing' && lp.confidence >= HOLD_MIN_CONF) {
        if (commitLetter(lp.label)) {
          state.lastCommitted = lp.label;
          state.cooldownFrames = COOLDOWN_FRAMES;
        }
      } else {
        flashError('NO STABLE SIGN YET');
        sfx.buzz();
      }
    });

    els.liveBtn.addEventListener('click', () => {
      if (state.live) stopLive();
      else startLive();
    });

    els.mirrorBtn.addEventListener('click', () => {
      state.mirror = !state.mirror;
      els.cam.classList.toggle('mirrored', state.mirror);
      els.handOverlay.classList.toggle('mirrored', state.mirror);
      els.mirrorBtn.classList.toggle('is-on', state.mirror);
      els.mirrorBtn.setAttribute('aria-pressed', String(state.mirror));
      sfx.blip();
    });

    // dialog buttons
    els.backspaceBtn.addEventListener('click', () => commitLetter('del'));
    els.spaceBtn.addEventListener('click', () => commitLetter('space'));
    els.clearBtn.addEventListener('click', () => {
      if (!state.sentence.length) return;
      state.sentence = '';
      renderSentence(false);
      sfx.blip();
    });
    els.copyBtn.addEventListener('click', copySentence);

    // switches
    els.typeHoldToggle.addEventListener('change', (e) => { state.typeOnHold = e.target.checked; });
    els.cropToggle.addEventListener('change', (e) => {
      state.cropToFrame = e.target.checked;
      updateBrackets();
    });
    els.handGuideToggle.addEventListener('change', (e) => {
      state.handGuide = e.target.checked;
      if (state.handGuide) {
        if (landmarker) startHandLoop();
        else ensureLandmarker();
      } else {
        stopHandLoop();
        state.handBox = null;
        const c = els.handOverlay;
        c.getContext('2d').clearRect(0, 0, c.width, c.height);
      }
    });

    // keep brackets aligned with the true capture region
    els.cam.addEventListener('loadedmetadata', updateBrackets);
    window.addEventListener('resize', updateBrackets);
    els.soundToggle.addEventListener('change', (e) => {
      state.soundOn = e.target.checked;
      if (state.soundOn) sfx.unlock();
    });

    // global keys: Enter/Space dismisses boot, arrows/A-D pick fighters
    window.addEventListener('keydown', (e) => {
      if (!state.booted) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          dismissBoot();
        }
        return;
      }
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') stepModel(-1);
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') stepModel(1);
    });
  }

  /* -------------------------- 13. INIT --------------------------- */

  function init() {
    cacheDom();
    buildPowerMeter();
    renderSentence(false);
    resetPredictionHud();
    wireControls();
    loadMeta();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
