(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const body = document.body;
  const video = $('#cam');
  const slides = [...document.querySelectorAll('.slide')];
  const camIndex = slides.findIndex((s) => s.hasAttribute('data-camera'));

  /* ======================================================================
   *  1. NAVIGATION ENTRE LES SLIDES
   * ==================================================================== */
  let cur = 0;
  let hudForced = false;

  function go(i) {
    cur = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, k) => s.classList.toggle('active', k === cur));
    body.classList.toggle('on-camera', cur === camIndex);
    body.classList.toggle('on-connect', cur === 0);
    history.replaceState(null, '', '#' + cur); // un F5 ne fait pas perdre la slide
    $('#counter').textContent = `${cur + 1} / ${slides.length}`;
    updateHud();
  }

  const KEYS_NEXT = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'];
  const KEYS_PREV = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'];

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    video.play().catch(() => {}); // au cas où le navigateur aurait bloqué l'autoplay
    if (KEYS_NEXT.includes(e.key)) go(cur + 1);
    else if (KEYS_PREV.includes(e.key)) go(cur - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(slides.length - 1);
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if (e.key === 's' || e.key === 'S') $('#stats').hidden = !$('#stats').hidden;
    else if (e.key === 'h' || e.key === 'H') { hudForced = !hudForced; updateHud(); }
    else if (e.key === 'm' || e.key === 'M') body.classList.toggle('mirror');
    else if (e.key === 'c' || e.key === 'C') body.classList.toggle('cover');
    else if (e.key === 'r' || e.key === 'R') send({ type: 'renegotiate' });
    else return;
    e.preventDefault();
  });

  window.addEventListener('hashchange', () => {
    const n = parseInt(location.hash.slice(1), 10);
    if (Number.isFinite(n) && n !== cur) go(n);
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  /* ======================================================================
   *  2. ÉTAT DE LA CONNEXION (affichage)
   * ==================================================================== */
  const LABELS = {
    offline: 'Serveur injoignable',
    waiting: 'En attente du téléphone…',
    phone: 'Téléphone connecté — démarrage de la vidéo…',
    live: 'Caméra en direct',
    stalled: 'Plus d\'image reçue !',
  };
  let phoneConnected = false;
  let framesOk = false;
  let stalled = false;
  let serverUp = false;
  let liveInfo = '';

  function state() {
    if (!serverUp) return 'offline';
    if (!phoneConnected) return 'waiting';
    if (!framesOk) return 'phone';
    return stalled ? 'stalled' : 'live';
  }

  function render() {
    const st = state();
    body.dataset.state = st;
    const label = LABELS[st] + (st === 'live' && liveInfo ? ` — ${liveInfo}` : '');
    document.querySelector('#connect-status .txt').textContent = label;
    document.querySelector('#hud .txt').textContent = label;
    updateHud();
  }

  // Le HUD n'apparaît pendant la présentation que si quelque chose ne va pas
  // (ou si on le force avec la touche H).
  function updateHud() {
    const problem = state() !== 'live' && cur !== 0;
    $('#hud').hidden = !(hudForced || problem);
  }

  /* ======================================================================
   *  3. SIGNALISATION (Server-Sent Events + POST) vers le téléphone
   * ==================================================================== */
  let sendChain = Promise.resolve();
  function send(msg) {
    // Les messages partent strictement dans l'ordre (offre avant candidats...).
    sendChain = sendChain
      .then(() => fetch('/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      }))
      .catch(() => {});
  }

  const es = new EventSource('/events');
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));

  es.onopen = () => { serverUp = true; render(); };
  es.onerror = () => { serverUp = false; render(); };

  on('init', (d) => {
    serverUp = true;
    drawQr(d.phoneUrl);
    setPhone(d.phone);
  });
  on('phone-status', (d) => setPhone(d.connected));
  on('offer', onOffer);
  on('candidate', onCandidate);

  function setPhone(connected) {
    phoneConnected = connected;
    if (!connected) {
      closePc();
      video.srcObject = null;
      framesOk = false;
    }
    render();
  }

  function drawQr(url) {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
    $('#phone-url').textContent = url.replace(/\?t=.*/, '');
  }

  /* ======================================================================
   *  4. WEBRTC : réception du flux (le PC est toujours "répondeur")
   * ==================================================================== */
  let pc = null;
  let gen = -1;               // numéro de négociation en cours
  let ready = Promise.resolve();
  let earlyCandidates = [];   // candidats reçus avant l'offre correspondante

  function closePc() {
    if (pc) { pc.close(); pc = null; }
    ready = Promise.resolve();
    framesOk = false; stalled = false; frozenTicks = 0; prev = null;
  }

  function onOffer(m) {
    closePc();
    gen = m.gen;
    // Réseau local : pas besoin de serveur STUN, ça marche même sans internet.
    const p = (pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' }));

    p.onicecandidate = (e) => {
      if (e.candidate && p === pc) send({ type: 'candidate', gen: m.gen, candidate: e.candidate.toJSON() });
    };
    p.ontrack = (e) => {
      // Latence minimale : on demande au récepteur de ne PAS retarder la lecture.
      try { e.receiver.jitterBufferTarget = 0; } catch (_) {}
      try { e.receiver.playoutDelayHint = 0; } catch (_) {}
      video.srcObject = e.streams[0] || new MediaStream([e.track]);
      video.play().catch(() => {});
    };
    p.onconnectionstatechange = () => {
      if (p !== pc) return;
      if (p.connectionState === 'failed' || p.connectionState === 'closed') { framesOk = false; render(); }
    };

    ready = (async () => {
      await p.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      for (const c of earlyCandidates.filter((c) => c.gen === m.gen)) p.addIceCandidate(c.candidate).catch(() => {});
      earlyCandidates = [];
      const answer = await p.createAnswer();
      await p.setLocalDescription(answer);
      send({ type: 'answer', gen: m.gen, sdp: p.localDescription.sdp });
    })().catch((err) => console.error('négociation échouée', err));
  }

  function onCandidate(m) {
    if (m.gen > gen) { earlyCandidates.push(m); return; } // arrivé avant son offre
    if (m.gen < gen || !pc) return;                       // vieux candidat : on ignore
    const p = pc;
    ready.then(() => p.addIceCandidate(m.candidate)).catch(() => {});
  }

  /* ======================================================================
   *  5. STATISTIQUES + DÉTECTION DE FLUX GELÉ (1 fois par seconde)
   * ==================================================================== */
  let prev = null;
  let frozenTicks = 0;

  setInterval(async () => {
    if (!pc) { prev = null; return; }
    let report;
    try { report = await pc.getStats(); } catch (_) { return; }

    let inbound, pair;
    const codecs = {};
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r;
      else if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r;
      else if (r.type === 'codec') codecs[r.id] = r;
    });
    if (!inbound) return;

    const now = performance.now();
    let bitrate = 0, jitterMs = 0, decodeMs = 0;
    if (prev) {
      const dt = (now - prev.t) / 1000;
      bitrate = ((inbound.bytesReceived - prev.bytes) * 8) / dt / 1e6;
      const frames = inbound.framesDecoded - prev.frames;
      const emitted = inbound.jitterBufferEmittedCount - prev.emitted;
      if (emitted > 0) jitterMs = ((inbound.jitterBufferDelay - prev.jbDelay) / emitted) * 1000;
      if (frames > 0) decodeMs = ((inbound.totalDecodeTime - prev.decode) / frames) * 1000;
      frozenTicks = frames > 0 ? 0 : frozenTicks + 1;
    }
    prev = {
      t: now, bytes: inbound.bytesReceived, frames: inbound.framesDecoded,
      emitted: inbound.jitterBufferEmittedCount || 0, jbDelay: inbound.jitterBufferDelay || 0,
      decode: inbound.totalDecodeTime || 0,
    };

    framesOk = inbound.framesDecoded > 0;
    stalled = frozenTicks >= 3;
    const w = inbound.frameWidth, h = inbound.frameHeight, fps = Math.round(inbound.framesPerSecond || 0);
    liveInfo = w ? `${w}×${h} @ ${fps} fps` : '';
    render();

    if (!$('#stats').hidden) {
      const codec = (codecs[inbound.codecId] || {}).mimeType || '?';
      const rtt = pair && pair.currentRoundTripTime != null ? (pair.currentRoundTripTime * 1000).toFixed(0) : '?';
      $('#stats').textContent = [
        `état            ${state()}`,
        `image           ${w}×${h} @ ${fps} fps`,
        `codec           ${codec}`,
        `débit           ${bitrate.toFixed(1)} Mb/s`,
        `RTT réseau      ${rtt} ms`,
        `jitter buffer   ${jitterMs.toFixed(0)} ms`,
        `décodage        ${decodeMs.toFixed(1)} ms/image`,
        `paquets perdus  ${inbound.packetsLost}`,
        `images perdues  ${inbound.framesDropped || 0}`,
      ].join('\n');
    }
  }, 1000);

  /* ======================================================================
   *  DÉMARRAGE
   * ==================================================================== */
  const start = parseInt(location.hash.slice(1), 10);
  go(Number.isFinite(start) ? start : 0);
  render();
})();
