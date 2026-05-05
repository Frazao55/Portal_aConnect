import { buildCameraConstraints } from "./cameraConfig.js";

const MODEL_URL = "/models";
const DETECTION_INTERVAL_MS = 350;
const REQUIRED_STABLE_FRAMES = 3;
const GREETING_COOLDOWN_MS = 25000;
const GREETING_RESET_EMPTY_MS = 3000;
const GREETINGS_SINGLE = [
  "Olá, bem-vindo à Arentia. A MIA já está por aqui.",
  "Olá, bem-vindo. Entra à vontade, a conquista do futuro começa já.",
  "Olá, ainda bem que chegaste. A MIA está pronta para te receber.",
  "Bem-vindo à Arentia. Hoje juntamos pessoas, cultura e IA.",
  "Olá, bom ter-te por cá. Daqui a pouco a MIA conversa contigo."
];
const GREETINGS_GROUP = [
  "Olá, sejam bem-vindos à Arentia. A MIA já está por aqui.",
  "Bem-vindos. Entrem à vontade, a conquista do futuro começa já.",
  "Olá a todos, ainda bem que chegaram. A MIA está pronta para vos receber.",
  "Bem-vindos à Arentia. Hoje juntamos pessoas, cultura e IA.",
  "Olá, bom ter-vos por cá. Daqui a pouco a MIA conversa convosco."
];

const els = {
  video: document.getElementById("camera"),
  start: document.getElementById("btn-start"),
  stop: document.getElementById("btn-stop"),
  status: document.getElementById("status-text"),
  orb: document.getElementById("presence-orb")
};

let stream = null;
let detectionTimer = null;
let stableFrames = 0;
let lastGreetingAt = 0;
let lastEmptyAt = Date.now();
let speaking = false;
let active = false;
let greetingIndex = 0;

function setStatus(text) {
  els.status.textContent = text;
}

function setOrb(state) {
  els.orb.dataset.state = state;
}

async function waitForFaceApi() {
  if (window.faceapi) return;

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (window.faceapi) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}

async function loadModels() {
  setStatus("A preparar a receção");
  await waitForFaceApi();
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
}

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: buildCameraConstraints(),
    audio: false
  });

  els.video.srcObject = stream;

  await new Promise((resolve) => {
    els.video.onloadedmetadata = () => {
      els.video.play();
      resolve();
    };
  });
}

function chooseVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];

  return voices.find((voice) => voice.lang === "pt-PT")
    || voices.find((voice) => voice.lang?.startsWith("pt"))
    || null;
}

function speak(text) {
  if (!window.speechSynthesis) {
    setStatus(text);
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = chooseVoice();

  if (voice) utterance.voice = voice;
  utterance.lang = voice?.lang || "pt-PT";
  utterance.rate = 0.96;
  utterance.pitch = 1.02;

  speaking = true;
  setOrb("speaking");
  setStatus("A Mia está a receber convidados");

  utterance.onend = () => {
    speaking = false;
    setOrb("awake");
    setStatus("Receção ativa");
  };

  utterance.onerror = () => {
    speaking = false;
    setOrb("awake");
    setStatus("Receção ativa");
  };

  window.speechSynthesis.speak(utterance);
}

function canGreet(faceCount) {
  if (!active || speaking) return false;
  if (faceCount <= 0) return false;

  const now = Date.now();
  const cooldownReady = now - lastGreetingAt >= GREETING_COOLDOWN_MS;
  const returnedAfterEmpty = now - lastEmptyAt >= GREETING_RESET_EMPTY_MS;

  return cooldownReady && returnedAfterEmpty;
}

function nextGreeting(faceCount) {
  const options = faceCount > 1 ? GREETINGS_GROUP : GREETINGS_SINGLE;
  const message = options[greetingIndex % options.length];
  greetingIndex += 1;
  return message;
}

async function detectPresence() {
  if (!active || !els.video || els.video.paused || els.video.ended) return;

  const detections = await faceapi.detectAllFaces(
    els.video,
    new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
  );

  const faceCount = detections.length;

  if (faceCount === 0) {
    stableFrames = 0;
    lastEmptyAt = Date.now();
    if (!speaking) {
      setOrb("idle");
      setStatus("Receção ativa");
    }
    return;
  }

  stableFrames += 1;

  if (stableFrames < REQUIRED_STABLE_FRAMES) {
    setOrb("awake");
    setStatus("A preparar boas-vindas");
    return;
  }

  if (!canGreet(faceCount)) {
    if (!speaking) {
      setOrb("awake");
      setStatus("Receção ativa");
    }
    return;
  }

  lastGreetingAt = Date.now();
  speak(nextGreeting(faceCount));
}

async function startGreeter() {
  try {
    els.start.disabled = true;
    setStatus("A preparar a receção");
    setOrb("awake");

    await loadModels();
    await startCamera();

    active = true;
    stableFrames = 0;
    lastGreetingAt = 0;
    lastEmptyAt = Date.now() - GREETING_RESET_EMPTY_MS;

    els.start.classList.add("hidden");
    els.stop.classList.remove("hidden");
    setStatus("Receção ativa");

    detectionTimer = setInterval(detectPresence, DETECTION_INTERVAL_MS);
  } catch (err) {
    active = false;
    els.start.disabled = false;
    setOrb("idle");
    setStatus(`Não foi possível iniciar: ${err.message}`);
  }
}

function stopGreeter() {
  active = false;
  stableFrames = 0;
  window.speechSynthesis?.cancel?.();
  speaking = false;

  if (detectionTimer) {
    clearInterval(detectionTimer);
    detectionTimer = null;
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  els.video.srcObject = null;
  els.start.disabled = false;
  els.start.classList.remove("hidden");
  els.stop.classList.add("hidden");
  setOrb("idle");
  setStatus("Receção em pausa");
}

els.start.addEventListener("click", startGreeter);
els.stop.addEventListener("click", stopGreeter);

window.addEventListener("beforeunload", stopGreeter);

if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    chooseVoice();
  };
}
