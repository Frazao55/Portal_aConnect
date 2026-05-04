// app.js — Orquestração principal

import {
  showScreen, setWelcomeName, setDoneName,
  setRegisterPhoto, getRegisterName, clearRegisterName,
  log, clearLog, buttons, startParticles, stopParticles
} from "./ui.js";

import {
  loadModels, loadRegisteredFaces, startCamera, stopCamera,
  startDetection, stopDetection, registerFace,
  getCurrentDescriptor, getCurrentPhoto, getFaceCount
} from "./faceRecognition.js";

import {
  startInterview, stopInterview, getTranscript
} from "./openaiRealtime.js";

function firstName(fullName) {
  if (!fullName) return "";
  return fullName.trim().split(/\s+/)[0];
}

// ── Estado ──────────────────────────────────────────────────────
let state = "entry";
let currentUser = null;
let currentDescriptor = null;
let currentPhoto = null;
let interviewStartTime = null;
let currentFaceCount = 0;
let welcomeTimeout = null;

// ── Inicialização ───────────────────────────────────────────────
function init() {
  clearLog();
  log("App inicializada.", "system");
  startParticles();

  buttons.enter.addEventListener("click", onEnter);
  buttons.register.addEventListener("click", onRegisterFace);
  buttons.cancelRegister.addEventListener("click", onCancelRegister);
  buttons.stopInterview.addEventListener("click", onStopInterview);
  buttons.restart.addEventListener("click", onRestart);

  window.addEventListener("beforeunload", () => {
    stopCamera();
    stopInterview();
    stopParticles();
  });
}

// ── Fluxo: Entrada → Pipeline ───────────────────────────────────
async function onEnter() {
  setState("loading");
  clearLog();
  log("A iniciar pipeline...", "system");

  try {
    await loadModels();
    log("Modelos carregados.", "system");

    await loadRegisteredFaces();

    await startCamera();
    log("Câmara iniciada.", "system");

    startDetection(
      (match) => onFaceRecognized(match),
      () => { /* sem feedback visual */ }
    );
  } catch (err) {
    log(`Erro: ${err.message}`, "error");
    stopCamera();
    setState("entry");
  }
}

// ── Reconhecimento ──────────────────────────────────────────────
function onFaceRecognized(match) {
  if (state !== "loading") return;

  currentDescriptor = getCurrentDescriptor();
  currentPhoto = getCurrentPhoto();
  currentFaceCount = getFaceCount();
  stopDetection();

  if (!match) {
    if (currentDescriptor && currentPhoto) {
      log("Face detetada, não reconhecida. Pedir nome.", "system");
      setRegisterPhoto(currentPhoto);
      clearRegisterName();
      setState("register");
      return;
    }

    log("Face detetada sem dados suficientes.", "error");
    setState("loading");
    startDetection(
      (nextMatch) => onFaceRecognized(nextMatch),
      () => {}
    );
    return;
  }

  currentUser = {
    id: match.userId,
    name: firstName(match.label)
  };

  log(`Utilizador reconhecido: ${match.label} (dist=${match.distance.toFixed(3)})`, "system");
  setWelcomeName(currentUser.name);
  setState("welcome");

  // Auto-avançar para entrevista após 3s
  if (welcomeTimeout) clearTimeout(welcomeTimeout);
  welcomeTimeout = setTimeout(() => {
    onStartInterview();
  }, 3000);
}

// ── Registo ─────────────────────────────────────────────────────
async function onRegisterFace() {
  const name = getRegisterName();
  if (!name) {
    log("Insere um nome.", "error");
    return;
  }

  if (!currentDescriptor || !currentPhoto) {
    log("Dados da face em falta.", "error");
    return;
  }

  try {
    log(`A registar ${name}...`, "system");
    const user = await registerFace(name, currentDescriptor, currentPhoto);
    log(`Registado: ${user.name}`, "system");

    currentUser = {
      id: user.id,
      name: firstName(user.name)
    };

    setWelcomeName(currentUser.name);
    setState("welcome");

    if (welcomeTimeout) clearTimeout(welcomeTimeout);
    welcomeTimeout = setTimeout(() => {
      onStartInterview();
    }, 3000);
  } catch (err) {
    log(`Erro no registo: ${err.message}`, "error");
  }
}

function onCancelRegister() {
  currentDescriptor = null;
  currentPhoto = null;
  setState("loading");
  startDetection(
    (match) => onFaceRecognized(match),
    () => {}
  );
}

// ── Conversa ────────────────────────────────────────────────────
async function onStartInterview() {
  if (!currentUser) {
    log("Nenhum utilizador identificado.", "error");
    return;
  }

  if (welcomeTimeout) clearTimeout(welcomeTimeout);

  stopDetection();
  stopCamera();
  setState("interview");
  interviewStartTime = Date.now();
  log(`A Mia vai falar com ${currentUser.name}...`, "system");

  try {
    await startInterview(
      currentUser.name,
      currentFaceCount,
      (result) => onInterviewComplete(result),
      (err) => onInterviewError(err)
    );
  } catch (err) {
    log(`Erro ao iniciar conversa: ${err.message}`, "error");
    setState("entry");
  }
}

function onStopInterview() {
  stopInterview();
  log("Conversa interrompida.", "system");
  currentUser = null;
  currentDescriptor = null;
  currentPhoto = null;
  currentFaceCount = 0;
  setState("entry");
}

async function onInterviewComplete(result) {
  log("Conversa completa! A guardar...", "system");

  const endedAt = Date.now();
  const durationSeconds = interviewStartTime ? Math.round((endedAt - interviewStartTime) / 1000) : 0;

  const payload = {
    userId: currentUser.id,
    userName: currentUser.name,
    startedAt: new Date(interviewStartTime || endedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSeconds,
    completed: true,
    responses: {
      ambiente: result.ambiente || "não especificado",
      problemas: result.problemas,
      visao_futuro: result.visao_futuro,
      transcript: result.transcript || getTranscript()
    },
    metadata: {
      model: "gpt-realtime",
      timeout: false,
      interviewState: result.interviewState || null
    }
  };

  try {
    const res = await fetch("/interview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error("Falha ao guardar");
    const data = await res.json();
    log(`Conversa guardada: ${data.file}`, "system");
  } catch (err) {
    log(`Erro ao guardar: ${err.message}`, "error");
  }

  setDoneName(currentUser.name);
  setState("done");
}

function onInterviewError(err) {
  log(`Conversa falhou: ${err.message}`, "error");
  currentUser = null;
  currentDescriptor = null;
  currentPhoto = null;
  currentFaceCount = 0;
  setState("entry");
}

// ── Reiniciar ───────────────────────────────────────────────────
function onRestart() {
  currentUser = null;
  currentDescriptor = null;
  currentPhoto = null;
  currentFaceCount = 0;
  if (welcomeTimeout) clearTimeout(welcomeTimeout);
  stopCamera();
  stopInterview();
  setState("entry");
  clearLog();
  log("Pronto para nova conversa.", "system");
}

// ── Gestão de estado ─────────────────────────────────────────────
function setState(newState) {
  state = newState;
  showScreen(newState);

  switch (newState) {
    case "entry":
      stopCamera();
      break;

    case "loading":
      // Tudo gerido pelo pipeline; sem feedback textual
      break;

    case "welcome":
      // Auto-avança via setTimeout em onFaceRecognized
      break;

    case "register":
      break;

    case "interview":
      break;

    case "done":
      break;
  }
}

// ── Arrancar ────────────────────────────────────────────────────
init();
