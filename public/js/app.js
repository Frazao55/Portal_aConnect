// app.js — Orquestração principal

import {
  showScreen, setWelcomeName, setDoneName,
  setRegisterPhoto, getRegisterName, clearRegisterName,
  log, clearLog, buttons, startParticles, stopParticles,
  setCameraPreviewStream, setMiaPresence,
  setPreviewAnalyzing, hidePreviewOverlay, showPreviewOverlay
} from "./ui.js";

import {
  loadModels, loadRegisteredFaces, startCamera, stopCamera,
  startDetection, stopDetection, registerFace,
  getCurrentDescriptor, getCurrentPhoto, getFaceCount,
  getCameraStream
} from "./faceRecognition.js";

import {
  startInterview, stopInterview, getTranscript
} from "./openaiRealtime.js";

function firstName(fullName) {
  if (!fullName) return "";
  return fullName.trim().split(/\s+/)[0];
}

// ── Estado ──────────────────────────────────────────────────────
let state = "preview";
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

  buttons.startConversation.addEventListener("click", onStartConversation);
  buttons.register.addEventListener("click", onRegisterFace);
  buttons.cancelRegister.addEventListener("click", onCancelRegister);
  buttons.stopInterview.addEventListener("click", onStopInterview);
  buttons.restart.addEventListener("click", onRestart);

  window.addEventListener("beforeunload", () => {
    stopCamera();
    stopInterview();
    stopParticles();
  });

  // Iniciar diretamente no preview
  startPreview();
}

// ── Fluxo: Preview inicial ──────────────────────────────────────
async function startPreview() {
  setState("preview");
  clearLog();
  log("A iniciar preview...", "system");

  try {
    const stream = await startCamera();
    setCameraPreviewStream(stream);
    log("Câmara iniciada.", "system");

    // Carregar modelos e rostos em background
    Promise.all([loadModels(), loadRegisteredFaces()])
      .then(() => log("Modelos e rostos carregados.", "system"))
      .catch(err => log(`Erro ao carregar modelos: ${err.message}`, "error"));
  } catch (err) {
    log(`Erro: ${err.message}`, "error");
    stopCamera();
    setState("preview");
  }
}

async function onStartConversation() {
  if (state !== "preview") return;

  state = "analyzing";
  setPreviewAnalyzing(true);
  log("A iniciar reconhecimento facial...", "system");

  try {
    startDetection(
      (match) => onFaceRecognized(match),
      () => { /* sem feedback visual */ }
    );
  } catch (err) {
    log(`Erro: ${err.message}`, "error");
    stopCamera();
    state = "preview";
    setPreviewAnalyzing(false);
  }
}

// ── Reconhecimento ──────────────────────────────────────────────
function onFaceRecognized(match) {
  if (state !== "analyzing") return;

  currentDescriptor = getCurrentDescriptor();
  currentPhoto = getCurrentPhoto();
  currentFaceCount = getFaceCount();
  stopDetection();

  if (!match) {
    if (currentDescriptor && currentPhoto) {
      log("Face detetada, não reconhecida. Pedir nome.", "system");
      setRegisterPhoto(currentPhoto);
      clearRegisterName();
      setPreviewAnalyzing(false);
      setState("register");
      return;
    }

    log("Face detetada sem dados suficientes.", "error");
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
  
  // Transição suave: esconder overlay do preview
  hidePreviewOverlay();
  
  // Pequeno delay para a transição visual antes de iniciar a conversa
  setTimeout(() => {
    onStartInterview();
  }, 500);
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

    onStartInterview();
  } catch (err) {
    log(`Erro no registo: ${err.message}`, "error");
  }
}

function onCancelRegister() {
  currentDescriptor = null;
  currentPhoto = null;
  setPreviewAnalyzing(true);
  state = "analyzing";
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
  setMiaPresence("connecting");
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
    setState("preview");
  }
}

function onStopInterview() {
  stopInterview();
  log("Conversa interrompida.", "system");
  currentUser = null;
  currentDescriptor = null;
  currentPhoto = null;
  currentFaceCount = 0;
  showPreviewOverlay();
  setState("preview");
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
  showPreviewOverlay();
  setState("preview");
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
  
  // Garantir que a UI e textos voltam ao estado base antes da câmara
  setPreviewAnalyzing(false); 
  showPreviewOverlay();
  
  clearLog();
  log("Pronto para nova conversa.", "system");

  // Re-iniciar o ecrã inicial de novo
  startPreview();
}

// ── Gestão de estado ─────────────────────────────────────────────
function setState(newState) {
  state = newState;
  showScreen(newState);

  switch (newState) {
    case "preview":
      // Vídeo da Mia parado no frame inicial
      {
        const previewVideo = document.getElementById("mia-preview");
        if (previewVideo) {
          previewVideo.currentTime = 0;
          previewVideo.pause();
        }
      }
      break;

    case "register":
      break;

    case "interview":
      // Sincronizar vídeo da Mia no frame inicial para transição suave
      {
        const interviewVideo = document.getElementById("mia-video");
        if (interviewVideo) {
          interviewVideo.currentTime = 0;
        }
      }
      break;

    case "done":
      break;
  }
}

// ── Arrancar ────────────────────────────────────────────────────
init();
