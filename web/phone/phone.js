(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const token = new URLSearchParams(location.search).get('t') || '';

  let cfg = null;           // reçu du serveur : résolution, fps, débit, codec
  let facing = 'environment';
  let stream = null;
  let track = null;
  let sender = null;
  let pc = null;
  let gen = 0;              // numéro de négociation en cours
  let answerSet = Promise.resolve();
  let cameraPromise = null;
  let retryTimer = null;
  let wakeLock = null;

  function setStatus(text, st) {
    $('#status').textContent = text;
    document.body.dataset.state = st;
  }

  function showError(text, canRetry = true) {
    $('#error-text').textContent = text;
    $('#retry').hidden = !canRetry;
    $('#error').hidden = false;
    setStatus('Erreur', 'error');
  }

  /* ======================================================================
   *  1. SIGNALISATION (Server-Sent Events + POST)
   * ==================================================================== */
  let sendChain = Promise.resolve();
  function send(msg) {
    // Envoi strictement ordonné (l'offre doit arriver avant ses candidats ICE).
    sendChain = sendChain
      .then(() => fetch('/signal?t=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      }))
      .catch(() => {});
  }

  let resolveConfig;
  const configReady = new Promise((r) => { resolveConfig = r; });

  const es = new EventSource('/events?t=' + encodeURIComponent(token));
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      showError('Lien refusé par l\'ordinateur. Le serveur a peut-être été relancé : rescanne le QR code.', false);
    } else {
      setStatus('Connexion à l\'ordinateur perdue, nouvelle tentative…', 'connecting');
    }
  };

  on('config', (c) => { cfg = c; resolveConfig(); });
  on('peer-ready', () => negotiate());   // la page de présentation est prête : on envoie la vidéo
  on('phone-status', () => {});
  on('answer', (m) => {
    if (m.gen !== gen || !pc) return;
    const p = pc;
    answerSet = p.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    answerSet.catch((e) => console.error('answer refusée', e));
  });
  on('candidate', (m) => {
    if (m.gen !== gen || !pc) return;
    const p = pc;
    answerSet.then(() => p.addIceCandidate(m.candidate)).catch(() => {});
  });

  /* ======================================================================
   *  2. CAMÉRA
   * ==================================================================== */
  function openCamera() {
    if (!cameraPromise) cameraPromise = startCamera().catch((e) => { cameraPromise = null; throw e; });
    return cameraPromise;
  }

  async function startCamera() {
    await configReady;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('Ce navigateur refuse la caméra sur cette page (connexion non sécurisée). Ouvre le lien https:// du QR code.', false);
      throw new Error('no getUserMedia');
    }
    setStatus('Ouverture de la caméra…', 'connecting');
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: cfg.width },
          height: { ideal: cfg.height },
          frameRate: { ideal: cfg.fps },
        },
      });
    } catch (e) {
      showError(
        e.name === 'NotAllowedError'
          ? 'Accès à la caméra refusé. Autorise la caméra pour ce site dans les réglages du navigateur, puis réessaie.'
          : 'Impossible d\'ouvrir la caméra : ' + e.message
      );
      throw e;
    }
    $('#error').hidden = true;

    const old = stream;
    stream = s;
    track = s.getVideoTracks()[0];
    track.contentHint = 'motion';
    track.onended = () => { if (track.readyState === 'ended') restartCamera(); }; // appel entrant, etc.
    $('#preview').srcObject = s;
    if (old) old.getTracks().forEach((t) => t.stop());
    if (sender) await sender.replaceTrack(track); // pas de renégociation nécessaire
    return s;
  }

  async function restartCamera() {
    cameraPromise = null;
    try { await openCamera(); } catch (_) {}
  }

  $('#flip').onclick = () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    restartCamera();
  };
  $('#retry').onclick = () => { $('#error').hidden = true; restartCamera().then(() => negotiate()); };
  $('#info').onclick = () => { $('#stats').hidden = !$('#stats').hidden; };

  /* ======================================================================
   *  3. WEBRTC : envoi de la vidéo (le téléphone est toujours "offreur")
   * ==================================================================== */
  function preferCodec(transceiver) {
    const names = { h264: 'video/h264', vp8: 'video/vp8', vp9: 'video/vp9', av1: 'video/av1' };
    const want = names[cfg.codec];
    if (!want || !transceiver.setCodecPreferences || !window.RTCRtpSender) return;
    const all = RTCRtpSender.getCapabilities('video').codecs;
    const first = all.filter((c) => c.mimeType.toLowerCase() === want);
    if (!first.length) return; // codec absent sur ce téléphone : on laisse le choix par défaut
    const rest = all.filter((c) => c.mimeType.toLowerCase() !== want);
    try { transceiver.setCodecPreferences([...first, ...rest]); } catch (_) {}
  }

  async function negotiate() {
    clearTimeout(retryTimer);
    try { await openCamera(); } catch (_) { return; }
    if (pc) pc.close();

    const g = ++gen;
    // Réseau local : pas de serveur STUN/TURN, ça marche même sans internet.
    const p = (pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' }));
    setStatus('Connexion à la présentation…', 'connecting');

    p.onicecandidate = (e) => {
      if (e.candidate && p === pc) send({ type: 'candidate', gen: g, candidate: e.candidate.toJSON() });
    };
    p.onconnectionstatechange = () => {
      if (p !== pc) return;
      const st = p.connectionState;
      if (st === 'connected') {
        setStatus('En direct vers la présentation', 'live');
      } else if (st === 'failed') {
        setStatus('Connexion échouée, nouvel essai…', 'connecting');
        retryTimer = setTimeout(negotiate, 1000);
      } else if (st === 'disconnected') {
        setStatus('Connexion instable…', 'connecting');
        retryTimer = setTimeout(() => { if (p === pc && p.connectionState !== 'connected') negotiate(); }, 3000);
      }
    };

    const tr = p.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      // Qualité max : on relève le plafond de débit (Chrome bride à ~2,5 Mb/s sinon)
      sendEncodings: [{ maxBitrate: cfg.bitrateMbps * 1e6, maxFramerate: cfg.fps, priority: 'high', networkPriority: 'high' }],
    });
    sender = tr.sender;
    preferCodec(tr);

    await p.setLocalDescription(await p.createOffer());
    // IMPORTANT : on envoie l'offre tout de suite, avant que les candidats ICE ne partent.
    send({ type: 'offer', gen: g, sdp: p.localDescription.sdp });

    // En cas de réseau chargé : on préfère perdre des images plutôt que de la netteté.
    try {
      const prm = sender.getParameters();
      prm.degradationPreference = 'maintain-resolution';
      await sender.setParameters(prm);
    } catch (_) {}
  }

  /* ======================================================================
   *  4. STATS (bouton "Infos")
   * ==================================================================== */
  let prev = null;
  setInterval(async () => {
    if (!pc || $('#stats').hidden) { prev = null; return; }
    let report;
    try { report = await pc.getStats(); } catch (_) { return; }
    report.forEach((r) => {
      if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
      const now = performance.now();
      const mbps = prev ? ((r.bytesSent - prev.bytes) * 8) / ((now - prev.t) / 1000) / 1e6 : 0;
      prev = { t: now, bytes: r.bytesSent };
      const codec = (report.get(r.codecId) || {}).mimeType || '?';
      $('#stats').textContent = [
        `envoi    ${r.frameWidth}×${r.frameHeight} @ ${Math.round(r.framesPerSecond || 0)} fps`,
        `débit    ${mbps.toFixed(1)} Mb/s`,
        `codec    ${codec}`,
        `encodeur ${r.encoderImplementation || '?'}`,
        `bridage  ${r.qualityLimitationReason || 'none'}`,
      ].join('\n');
    });
  }, 1000);

  /* ======================================================================
   *  5. ÉCRAN ALLUMÉ (sinon le téléphone se met en veille et coupe la caméra)
   * ==================================================================== */
  async function keepAwake() {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    keepAwake();
    if (track && track.readyState === 'ended') restartCamera();
  });
  keepAwake();

  openCamera().catch(() => {}); // démarre la caméra tout de suite, sans attendre la présentation
})();
