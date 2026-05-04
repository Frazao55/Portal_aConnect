// app.js — Orquestração principal

import {
  showScreen, hideVideo, setFacePill, setStatePill,
  setStatus, setRecognizedName, setInterviewStatus,
  setRegisterPhoto, getRegisterName, clearRegisterName,
  log, clearLog, buttons
} from "./ui.js";

import {
  loadModels, loadRegisteredFaces, startCamera, stopCamera,
  startDetection, stopDetection, capturePhoto, registerFace,
  getCurrentDescriptor, getCurrentPhoto, getFaceCount, isFacePresent
} from "./faceRecognition.js";

import {
  startInterview, stopInterview, getTranscript
} from "./openaiRealtime.js";

// ── Estado ──────────────────────────────────────────────────────────────────
let state = "idle";
let currentUser = null;
let currentDescriptor = null;
let currentPhoto = null;
let interviewStartTime = null;
let currentFaceCount = 0;

// ── Inicialização ───────────────────────────────────────────────────────────
function init() {
  clearLog();
  log("App inicializada.", "system");

  buttons.startId.addEventListener("click", onStartIdentification);
  buttons.startInterview.addEventListener("click", onStartInterview);
  buttons.newUser.addEventListener("click", onNewUser);
  buttons.register.addEventListener("click", onRegisterFace);
  buttons.cancelRegister.addEventListener("click", onCancelRegister);
  buttons.stopInterview.addEventListener("click", onStopInterview);
  buttons.restart.addEventListener("click", onRestart);

  window.addEventListener("beforeunload", () => {
    stopCamera();
    stopInterview();
  });
}

// ── Fluxo: Identificação ────────────────────────────────────────────────────
async function onStartIdentification() {
  setState("identifying");
  clearLog();
  log("A preparar sistema...", "system");

  try {
    // 1. Carregar modelos (se ainda não carregados)
    await loadModels();

    // 2. Carregar rostos registados
    await loadRegisteredFaces();

    // 3. Ligar câmara
    setStatus("A alinhar o sistema");
    await startCamera();

    // 4. Iniciar deteção
    setStatus("A preparar o encontro");
    startDetection(
      (match) => onFaceRecognized(match),
      () => onFaceLost()
    );
  } catch (err) {
    log(`Erro: ${err.message}`, "error");
    setStatus(`Erro: ${err.message}`);
    stopCamera();
  }
}

function onFaceRecognized(match) {
  if (state !== "identifying") return;

  // Guardar os dados atuais antes de parar deteção
  currentDescriptor = getCurrentDescriptor();
  currentPhoto = getCurrentPhoto();
  currentFaceCount = getFaceCount();

  stopDetection();

  if (!match) {
    if (currentDescriptor && currentPhoto) {
      log("Face detetada, mas ainda não reconhecida. Pede o nome para registar.", "system");
      setRegisterPhoto(currentPhoto);
      clearRegisterName();
      setState("register");
      return;
    }

    log("Face detetada, mas sem dados suficientes para registar.", "error");
    setState("identifying");
    startDetection(
      (nextMatch) => onFaceRecognized(nextMatch),
      () => onFaceLost()
    );
    return;
  }

  currentUser = {
    id: match.userId,
    name: match.label
  };

  log(`Utilizador reconhecido: ${match.label} (dist=${match.distance.toFixed(3)})`, "system");
  setRecognizedName(match.label);
  setState("recognized");
}

function onFaceLost() {
  // Nada especial, continua a procurar
}

function onNewUser() {
  // Usar os dados guardados no reconhecimento
  currentDescriptor = getCurrentDescriptor();
  currentPhoto = getCurrentPhoto();

  if (!currentDescriptor || !currentPhoto) {
    log("Ainda não consegui preparar esta sessão. Aproxima-te do ponto de interação.", "error");
    return;
  }

  setRegisterPhoto(currentPhoto);
  clearRegisterName();
  setState("register");
  log("Novo utilizador. Preenche o nome.", "system");
}

// ── Fluxo: Registo ──────────────────────────────────────────────────────────
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
    currentUser = user;
    log(`Registado com sucesso: ${user.name}`, "system");

    // Mostra o ecrã para começar a conversa
    setRecognizedName(user.name);
    setState("recognized");
  } catch (err) {
    log(`Erro no registo: ${err.message}`, "error");
  }
}

function onCancelRegister() {
  currentDescriptor = null;
  currentPhoto = null;
  setState("identifying");
  startDetection(
    (match) => onFaceRecognized(match),
    () => onFaceLost()
  );
}

// ── Fluxo: Conversa ─────────────────────────────────────────────────────────
async function onStartInterview() {
  if (!currentUser) {
    log("Nenhum utilizador identificado.", "error");
    return;
  }

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
    setState("recognized");
  }
}

function onStopInterview() {
  stopInterview();
  log("Conversa interrompida manualmente.", "system");
  currentUser = null;
  currentDescriptor = null;
  currentPhoto = null;
  currentFaceCount = 0;
  setState("idle");
}

async function onInterviewComplete(result) {
  log("Conversa completa! A guardar dados...", "system");

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
    log(`Erro ao guardar conversa: ${err.message}`, "error");
  }

  setState("done");
}

function onInterviewError(err) {
  log(`Conversa falhou: ${err.message}`, "error");
  currentUser = null;
  currentDescriptor = null;
  currentPhoto = null;
  currentFaceCount = 0;
  setState("idle");
}

// ── Fluxo: Reiniciar ────────────────────────────────────────────────────────
function onRestart() {
  currentUser = null;
  currentDescriptor = null;
  currentPhoto = null;
  currentFaceCount = 0;
  stopCamera();
  stopInterview();
  setState("idle");
  clearLog();
  log("Pronto para nova conversa.", "system");
}

// ── Gestão de estado ────────────────────────────────────────────────────────
function setState(newState) {
  state = newState;
  document.body.dataset.state = newState;

  // Esconder todos os ecrãs
  showScreen(newState);

  switch (newState) {
    case "idle":
      hideVideo();
      setFacePill("Face: ---", "");
      setStatePill("Inativo", "");
      break;

    case "identifying":
      hideVideo();
      setFacePill("A preparar...", "");
      setStatePill("A preparar", "info");
      break;

    case "recognized":
      hideVideo();
      setFacePill("Pronto", "success");
      setStatePill("Pronto", "success");
      break;

    case "register":
      hideVideo();
      setFacePill("Novo utilizador", "warn");
      setStatePill("Registo", "warn");
      break;

    case "interview":
      hideVideo();
      setFacePill("Mia", "success");
      setStatePill("Ativo", "success");
      break;

    case "done":
      hideVideo();
      setFacePill("---", "");
      setStatePill("Concluído", "success");
      break;
  }
}

// ── Arrancar ────────────────────────────────────────────────────────────────
init();
