(() => {
  const SIGNAL_URL = 'wss://inai-col3.fishrungames.com/signaling/';
  const $ = (id) => document.getElementById(id);
  const localVideo = $('localVideo');
  const remoteVideo = $('remoteVideo');
  const roomId = new URLSearchParams(location.search).get('room') || Math.random().toString(36).slice(2, 8).toUpperCase();
  if (!new URLSearchParams(location.search).has('room')) {
    const url = new URL(location.href); url.searchParams.set('room', roomId); history.replaceState(null, '', url);
  }
  $('roomCode').innerHTML = `Код комнаты: <b>${escapeHtml(roomId)}</b>`;

  let ws = null, pc = null, localStream = null, remoteStream = null, screenTrack = null;
  let started = false, micOn = false, cameraOn = false, remoteReady = false;
  let clientId = Math.random().toString(36).slice(2, 10);
  let pendingCandidates = [];
  let connectedAt = null, clockTimer = null, toastTimer = null;

  function escapeHtml(value) { return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function toast(message) {
    const box = $('toast'); box.textContent = message; box.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('show'), 2600);
  }
  function setStatus(text, connected = false) {
    $('sessionState').textContent = text;
    document.querySelector('.live-dot').classList.toggle('connected', connected);
    $('qualityText').textContent = connected ? 'Подключено' : (remoteReady ? 'Соединяемся' : 'Ожидание');
    document.querySelector('.quality-dot').classList.toggle('connected', connected);
  }
  function setRemotePlaceholder(show, title, subtitle) {
    const p = $('remotePlaceholder'); p.style.display = show ? 'flex' : 'none';
    p.querySelector('strong').textContent = title;
    p.querySelector('span').textContent = subtitle;
    remoteVideo.style.display = show ? 'none' : 'block';
  }
  function updateControls() {
    $('micButton').classList.toggle('active', micOn);
    $('micButton').classList.toggle('off', !micOn);
    $('micLabel').textContent = micOn ? 'Выключить звук' : 'Включить звук';
    $('micButton').setAttribute('aria-label', micOn ? 'Выключить микрофон' : 'Включить микрофон');
    $('cameraButton').classList.toggle('active', cameraOn);
    $('cameraButton').classList.toggle('off', !cameraOn);
    $('cameraLabel').textContent = cameraOn ? 'Выключить видео' : 'Включить видео';
    $('cameraButton').setAttribute('aria-label', cameraOn ? 'Выключить камеру' : 'Включить камеру');
    $('localPlaceholder').style.display = cameraOn ? 'none' : 'flex';
    $('localAudioIcon').classList.toggle('muted-indicator', !micOn);
  }
  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }
  async function openDevices() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      micOn = cameraOn = true;
      localVideo.srcObject = localStream;
    } catch (error) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        micOn = true; localVideo.srcObject = localStream;
        toast('Камера недоступна. Вы можете продолжить без видео.');
      } catch (_) {
        localStream = new MediaStream(); micOn = cameraOn = false;
        toast('Нет доступа к камере и микрофону. Можно подключиться без них.');
      }
    }
    updateControls();
  }
  function createPeer() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    remoteStream = new MediaStream(); remoteVideo.srcObject = remoteStream;
    if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    pc.ontrack = event => {
      event.streams[0]?.getTracks().forEach(track => {
        if (!remoteStream.getTracks().some(t => t.id === track.id)) remoteStream.addTrack(track);
      });
      if (!event.streams.length && !remoteStream.getTracks().some(t => t.id === event.track.id)) remoteStream.addTrack(event.track);
      setRemotePlaceholder(false);
      $('remoteAudioIcon').classList.toggle('muted-indicator', event.track.kind === 'audio' && event.track.muted);
      event.track.onmute = () => $('remoteAudioIcon').classList.add('muted-indicator');
      event.track.onunmute = () => $('remoteAudioIcon').classList.remove('muted-indicator');
    };
    pc.onicecandidate = event => { if (event.candidate) send({ type: 'ice-candidate', candidate: event.candidate }); };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        setStatus('Собеседник подключён', true);
        if (!connectedAt) { connectedAt = Date.now(); clockTimer = setInterval(updateClock, 1000); }
      } else if (pc.connectionState === 'connecting') setStatus('Устанавливаем соединение…');
      else if (pc.connectionState === 'failed') { setStatus('Не удалось соединиться'); toast('Не удалось установить соединение. Попробуйте переподключиться.'); }
      else if (pc.connectionState === 'disconnected') setStatus('Соединение прервано');
    };
    return pc;
  }
  async function makeOffer() {
    if (!pc || pc.signalingState !== 'stable') return;
    try {
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      send({ type: 'offer', sdp: pc.localDescription });
    } catch (e) { console.error(e); toast('Не удалось создать предложение звонка.'); }
  }
  async function flushCandidates() {
    while (pendingCandidates.length && pc?.remoteDescription) {
      const c = pendingCandidates.shift();
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn('ICE candidate rejected', e); }
    }
  }
  async function onSignal(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      if (message.clientId === clientId) return;
      remoteReady = true; createPeer(); setRemotePlaceholder(true, 'Собеседник', 'Подключаемся к звонку…');
      setStatus('Собеседник в комнате');
      if (clientId < String(message.clientId || '')) await makeOffer();
    } else if (message.type === 'offer') {
      const peer = createPeer();
      try {
        await peer.setRemoteDescription(new RTCSessionDescription(message.sdp)); await flushCandidates();
        const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
        send({ type: 'answer', sdp: peer.localDescription });
      } catch (e) { console.error(e); toast('Не удалось принять звонок.'); }
    } else if (message.type === 'answer') {
      if (!pc) return;
      try { await pc.setRemoteDescription(new RTCSessionDescription(message.sdp)); await flushCandidates(); }
      catch (e) { console.error(e); }
    } else if (message.type === 'ice-candidate' || message.type === 'candidate') {
      const candidate = message.candidate || message.iceCandidate;
      if (!candidate) return;
      if (!pc?.remoteDescription) pendingCandidates.push(candidate);
      else { try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.warn('ICE candidate rejected', e); } }
    } else if (message.type === 'peer-left') {
      remoteReady = false; cleanupPeer(); setRemotePlaceholder(true, 'Собеседник', 'Ожидаем подключения');
      setStatus('Собеседник отключился'); toast('Собеседник покинул звонок.');
    }
  }
  function cleanupPeer() {
    if (pc) { pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null; pc.close(); pc = null; }
    remoteStream = null; remoteVideo.srcObject = null; pendingCandidates = [];
    connectedAt = null; clearInterval(clockTimer); $('clock').textContent = '00:00';
  }
  function updateClock() {
    if (!connectedAt) return;
    const seconds = Math.floor((Date.now() - connectedAt) / 1000);
    $('clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
  }
  async function startCall() {
    if (started) return;
    if (!window.isSecureContext || !navigator.mediaDevices) { toast('Откройте страницу по HTTPS или через localhost.'); return; }
    started = true; $('joinLabel').textContent = 'Подключение…'; $('joinButton').disabled = true;
    await openDevices();
    try {
      ws = new WebSocket(SIGNAL_URL);
      ws.onopen = () => {
        $('joinLabel').textContent = 'Ожидаем собеседника'; $('joinButton').classList.add('connected');
        $('joinButton').disabled = false; $('endButton').disabled = false;
        setStatus('Ожидаем собеседника'); send({ type: 'ready', clientId, room: roomId });
      };
      ws.onmessage = event => {
        try { const data = JSON.parse(event.data); onSignal(data); }
        catch (_) { console.warn('Unknown signaling message', event.data); }
      };
      ws.onerror = () => { toast('Не удалось подключиться к signaling-серверу.'); setStatus('Ошибка подключения'); };
      ws.onclose = () => {
        if (!started) return;
        cleanupPeer(); started = false; remoteReady = false;
        $('joinLabel').textContent = 'Начать звонок'; $('joinButton').classList.remove('connected'); $('joinButton').disabled = false; $('endButton').disabled = true;
        setStatus('Связь с сервером потеряна'); toast('Связь с сервером потеряна. Запустите звонок снова.');
      };
    } catch (e) {
      started = false; $('joinLabel').textContent = 'Начать звонок'; $('joinButton').disabled = false; toast('Браузер не смог открыть signaling-соединение.');
    }
  }
  function endCall() {
    started = false; remoteReady = false;
    cleanupPeer();
    if (ws) { const socket = ws; ws = null; socket.onclose = null; socket.close(); }
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    if (screenTrack) screenTrack.stop();
    localStream = null; screenTrack = null; localVideo.srcObject = null; micOn = cameraOn = false; updateControls();
    $('joinLabel').textContent = 'Начать звонок'; $('joinButton').classList.remove('connected'); $('joinButton').disabled = false; $('endButton').disabled = true;
    setRemotePlaceholder(true, 'Собеседник', 'Ожидаем подключения'); setStatus('Звонок завершён'); toast('Звонок завершён.');
  }
  async function toggleTrack(kind) {
    if (!started) { toast('Сначала нажмите «Начать звонок».'); return; }
    const isAudio = kind === 'audio';
    const current = isAudio ? micOn : cameraOn;
    let track = localStream?.getTracks().find(t => t.kind === kind);
    if (!track && !current) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(isAudio ? { audio: true, video: false } : { audio: false, video: true });
        track = stream.getTracks()[0];
        if (!localStream) localStream = new MediaStream(); localStream.addTrack(track);
        if (pc) pc.addTrack(track, localStream);
        if (!isAudio) localVideo.srcObject = localStream;
      } catch (_) { toast(isAudio ? 'Не удалось получить доступ к микрофону.' : 'Не удалось получить доступ к камере.'); return; }
    }
    if (track) track.enabled = !current;
    if (isAudio) micOn = !current; else cameraOn = !current;
    updateControls();
  }
  async function shareScreen() {
    if (!started || !pc) { toast('Сначала подключитесь к звонку.'); return; }
    if (!navigator.mediaDevices.getDisplayMedia) { toast('Демонстрация экрана недоступна в этом браузере.'); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenTrack = stream.getVideoTracks()[0];
      let sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (!sender) sender = pc.addTrack(screenTrack, stream); else await sender.replaceTrack(screenTrack);
      $('screenButton').classList.add('active');
      screenTrack.onended = async () => {
        const cam = localStream?.getVideoTracks()[0];
        const videoSender = pc?.getSenders().find(s => s.track?.kind === 'video');
        if (videoSender) await videoSender.replaceTrack(cameraOn ? cam : null);
        $('screenButton').classList.remove('active'); screenTrack = null;
      };
    } catch (e) { if (e.name !== 'AbortError') toast('Не удалось начать демонстрацию экрана.'); }
  }
  $('joinButton').addEventListener('click', startCall);
  $('endButton').addEventListener('click', endCall);
  $('micButton').addEventListener('click', () => toggleTrack('audio'));
  $('cameraButton').addEventListener('click', () => toggleTrack('video'));
  $('screenButton').addEventListener('click', shareScreen);
  $('copyLink').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Ссылка на комнату скопирована.'); }
    catch (_) { toast(location.href); }
  });
  $('helpButton').addEventListener('click', () => $('infoModal').hidden = false);
  $('closeModal').addEventListener('click', () => $('infoModal').hidden = true);
  $('infoModal').addEventListener('click', e => { if (e.target === $('infoModal')) $('infoModal').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('infoModal').hidden = true; });
  setRemotePlaceholder(true, 'Собеседник', 'Ожидаем подключения'); updateControls();
})();
