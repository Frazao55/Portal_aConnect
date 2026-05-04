// openaiRealtime.js — Integração WebRTC com OpenAI Realtime API

import {
  setInterviewStatus,
  setInterviewTimer,
  log,
  setStatePill,
  setMiaPresence
} from "./ui.js";

let pc = null;
let dc = null;
let localStream = null;
let remoteAudio = null;
let timerInterval = null;
let startTime = null;
let onCompleteCallback = null;
let onErrorCallback = null;
let transcript = [];
let completed = false;
let currentUserName = "";
let currentFaceCount = 0;
let nextAssistantStep = "greeting";
let interviewState = null;
let assistantResponseInProgress = false;
let assistantAudioStarted = false;
let pendingUserTranscript = null;
let ignoredInputItemIds = new Set();
let responseDoneFallbackTimer = null;
let iceDisconnectedTimer = null;

const MAX_DURATION_SECONDS = 300;
const MAX_ATTEMPTS_PER_GOAL = 3;
const MIN_WORDS_FOR_DIRECT_ACCEPT = 3;
const RESPONSE_DONE_AUDIO_FALLBACK_MS = 30000;
const ICE_DISCONNECTED_GRACE_MS = 5000;
const INTERVIEW_GOALS = ["ambiente", "problemas", "visao_futuro"];
const DEBUG_REALTIME = new URLSearchParams(window.location.search).get("debug") === "1";

function createInterviewState() {
  return {
    warmup_done: false,
    ambiente: null,
    problemas: null,
    visao_futuro: null,
    current_goal: "warmup",
    attempts_per_goal: {
      ambiente: 0,
      problemas: 0,
      visao_futuro: 0
    },
    unspecified_fields: []
  };
}

export async function startInterview(userName, faceCount, onComplete, onError) {
  onCompleteCallback = onComplete;
  onErrorCallback = onError;
  transcript = [];
  completed = false;
  currentUserName = userName || "";
  currentFaceCount = Number(faceCount) || 0;
  nextAssistantStep = "greeting";
  interviewState = createInterviewState();
  assistantResponseInProgress = false;
  assistantAudioStarted = false;
  pendingUserTranscript = null;
  ignoredInputItemIds = new Set();
  if (responseDoneFallbackTimer) {
    clearTimeout(responseDoneFallbackTimer);
    responseDoneFallbackTimer = null;
  }
  clearIceDisconnectedTimer();

  try {
    setMiaPresence("connecting", "A preparar a ligação");
    setInterviewStatus("A preparar a conversa...");
    log("[realtime] a pedir token efémero", "system");

    const tokenRes = await fetch("/token");
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      throw new Error(tokenData.error || "Erro ao obter token");
    }

    const ephemeralKey = tokenData.client_secret;
    const iceConfigRes = await fetch("/ice-config");
    const iceConfig = iceConfigRes.ok
      ? await iceConfigRes.json()
      : {
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          iceTransportPolicy: "all",
          turnConfigured: false
        };

    if (!iceConfig.turnConfigured) {
      log("[webrtc] TURN nao configurado; WebRTC pode falhar em redes empresariais", "error");
    }

    setMiaPresence("connecting", "A aproximar a Mia");
    setInterviewStatus("A preparar a conversa...");
    log("[realtime] token obtido, a criar PeerConnection", "system");

    pc = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      iceTransportPolicy: iceConfig.iceTransportPolicy || "all"
    });

    pc.oniceconnectionstatechange = () => {
      if (!pc) return;
      log(`[webrtc] iceConnectionState=${pc.iceConnectionState}`, "system");

      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        clearIceDisconnectedTimer();
      }

      if (pc.iceConnectionState === "disconnected") {
        scheduleIceDisconnectedWarning();
      }

      if (pc.iceConnectionState === "failed") {
        handleRealtimeConnectionFailure(new Error("A ligacao WebRTC falhou"));
      }
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      log(`[webrtc] connectionState=${pc.connectionState}`, "system");

      if (pc.connectionState === "connected") {
        clearIceDisconnectedTimer();
      }

      if (pc.connectionState === "disconnected") {
        scheduleIceDisconnectedWarning();
      }

      if (pc.connectionState === "failed") {
        handleRealtimeConnectionFailure(new Error("A ligacao WebRTC falhou"));
      }
    };

    pc.onicecandidateerror = (event) => {
      log(`[webrtc] ICE candidate error: ${event.errorText || event.errorCode}`, "error");
    };

    remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;
    pc.ontrack = (event) => {
      if (remoteAudio.srcObject !== event.streams[0]) {
        remoteAudio.srcObject = event.streams[0];
        log("[realtime] áudio remoto ligado", "system");
      }
    };

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });
    localStream.getAudioTracks().forEach((track) => pc.addTrack(track, localStream));

    dc = pc.createDataChannel("oai-events");
    dc.onopen = () => {
      log("[realtime] canal de eventos aberto", "system");
      sendAssistantResponse("greeting");
    };

    dc.onmessage = handleRealtimeMessage;
    dc.onclose = () => {
      if (!completed) {
        handleRealtimeConnectionFailure(new Error("O canal Realtime fechou"));
      }
    };
    dc.onerror = () => {
      if (!completed) {
        handleRealtimeConnectionFailure(new Error("Erro no canal Realtime"));
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    setMiaPresence("connecting", "Quase pronto");
    setInterviewStatus("Quase pronto...");
    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp"
      }
    });

    if (!sdpResponse.ok) {
      const text = await sdpResponse.text();
      throw new Error(`Erro SDP: ${text}`);
    }

    const answerSdp = await sdpResponse.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    setMiaPresence("thinking", "A Mia vai aparecer");
    setInterviewStatus("A Mia vai começar");
    setStatePill("Mia", "success");
    log("[realtime] conversa iniciada; aguarda a saudação da Mia", "system");

    startTime = Date.now();
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      setInterviewTimer(elapsed);

      if (elapsed >= MAX_DURATION_SECONDS) {
        log("[realtime] tempo máximo atingido (5 min)", "error");
        stopInterview();
        if (onErrorCallback) onErrorCallback(new Error("Timeout de 5 minutos"));
      }
    }, 1000);
  } catch (err) {
    log(`Erro Realtime: ${err.message}`, "error");
    setInterviewStatus(`Erro: ${err.message}`);
    cleanup();
    if (onErrorCallback) onErrorCallback(err);
  }
}

export function stopInterview() {
  cleanup();
  log("[realtime] conversa terminada", "system");
  setInterviewStatus("Conversa terminada");
  setMiaPresence("idle", "Conversa terminada");
  setStatePill("Terminado", "");
}

function cleanup() {
  if (responseDoneFallbackTimer) {
    clearTimeout(responseDoneFallbackTimer);
    responseDoneFallbackTimer = null;
  }

  clearIceDisconnectedTimer();

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  if (dc) {
    try {
      dc.onclose = null;
      dc.onerror = null;
      dc.close();
    } catch {
      // ignore
    }
    dc = null;
  }

  if (pc) {
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.onicecandidateerror = null;
    pc.getSenders().forEach((sender) => {
      if (sender.track) sender.track.stop();
    });
    pc.close();
    pc = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  if (remoteAudio) {
    remoteAudio.srcObject = null;
    remoteAudio = null;
  }

  startTime = null;
}

function clearIceDisconnectedTimer() {
  if (iceDisconnectedTimer) {
    clearTimeout(iceDisconnectedTimer);
    iceDisconnectedTimer = null;
  }
}

function scheduleIceDisconnectedWarning() {
  if (iceDisconnectedTimer) return;

  iceDisconnectedTimer = setTimeout(() => {
    iceDisconnectedTimer = null;

    if (!pc || pc.iceConnectionState !== "disconnected") return;

    setMiaPresence("connecting", "Ligacao instavel");
    setInterviewStatus("A ligacao esta instavel...");
  }, ICE_DISCONNECTED_GRACE_MS);
}

function markAssistantOutputStopped(reason = "audio_buffer_stopped") {
  if (responseDoneFallbackTimer) {
    clearTimeout(responseDoneFallbackTimer);
    responseDoneFallbackTimer = null;
  }

  assistantResponseInProgress = false;
  assistantAudioStarted = false;
  setMiaPresence("listening", "Agora podes responder");
  setInterviewStatus("Agora podes responder");
  markInternalDecision("assistant_output_stopped", { reason });
  processPendingTranscriptIfReady();
}

function scheduleResponseDoneFallback() {
  if (responseDoneFallbackTimer || !assistantResponseInProgress) return;

  responseDoneFallbackTimer = setTimeout(() => {
    responseDoneFallbackTimer = null;

    if (!assistantResponseInProgress) return;

    markAssistantOutputStopped("response_done_without_audio_buffer_stopped");
  }, RESPONSE_DONE_AUDIO_FALLBACK_MS);
}

function handleRealtimeConnectionFailure(err) {
  if (completed) return;

  log(`[webrtc] ${err.message}`, "error");
  cleanup();
  setMiaPresence("idle", "Ligacao perdida");
  setInterviewStatus("Ligacao perdida. Recomeça a conversa.");
  setStatePill("Erro", "error");

  if (onErrorCallback) {
    onErrorCallback(err);
  }
}

function sendEvent(event) {
  if (dc && dc.readyState === "open") {
    dc.send(JSON.stringify(event));
  }
}

function buildSubmitInterviewTool() {
  return {
    type: "function",
    name: "submit_interview",
    description: "Submeter respostas quando a conversa estiver completa",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ambiente: {
          type: "string",
          description: "Área, momento ou contexto dentro da empresa mencionado pela pessoa"
        },
        problemas: {
          type: "string",
          description: "Tarefa, processo ou problema concreto do dia a dia na empresa que a pessoa gostava que a IA ajudasse a resolver ou automatizar"
        },
        visao_futuro: {
          type: "string",
          description: "Visão da pessoa sobre a IA no futuro dentro do contexto profissional referido"
        }
      },
      required: ["ambiente", "problemas", "visao_futuro"]
    }
  };
}

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(" ").length : 0;
}

function hasAny(normalizedText, terms) {
  return terms.some((term) => normalizedText.includes(term));
}

function isShortFragment(text) {
  return wordCount(text) > 0 && wordCount(text) < MIN_WORDS_FOR_DIRECT_ACCEPT;
}

function looksReadyToStart(text) {
  const normalized = normalizeText(text);

  return hasAny(normalized, [
    "sim",
    "estou",
    "pronto",
    "pronta",
    "podemos",
    "vamos",
    "forca",
    "claro",
    "ok",
    "bora",
    "pode ser"
  ]);
}

function looksLikeWarmupOption(text) {
  const normalized = normalizeText(text);

  return hasAny(normalized, [
    "email",
    "emails",
    "documento",
    "documentos",
    "tarefa",
    "tarefas",
    "repetitiva",
    "repetitivas",
    "relatorio",
    "relatorios",
    "excel",
    "dados"
  ]);
}

function isVagueAnswer(text, goal) {
  const normalized = normalizeText(text);
  const words = wordCount(text);

  if (!normalized || words === 0) return true;

  const vagueExact = new Set([
    "nao sei",
    "nao faco ideia",
    "sem ideia",
    "qualquer coisa",
    "tanto faz",
    "depende",
    "talvez",
    "sim",
    "nao",
    "ok",
    "pois",
    "isso",
    "nada",
    "normal"
  ]);

  if (vagueExact.has(normalized)) return true;

  if (words <= 2 && hasAny(normalized, ["nao sei", "talvez", "depende", "normal", "melhor"])) {
    return true;
  }

  if (goal === "visao_futuro" && normalized.includes("vai ser melhor") && words <= 4) {
    return true;
  }

  return false;
}

function looksLikeAmbiente(text) {
  const normalized = normalizeText(text);
  const terms = [
    "trabalho",
    "empresa",
    "escritorio",
    "cliente",
    "clientes",
    "equipa",
    "departamento",
    "arentia",
    "reunioes",
    "processos",
    "dia a dia profissional",
    "emails",
    "email",
    "documentos",
    "tarefas",
    "relatorios",
    "dados",
    "software",
    "programacao",
    "desenvolvimento",
    "informatica",
    "tecnologia",
    "chatgpt",
    "ia",
    "inteligencia artificial",
    "clientes"
  ];

  return hasAny(normalized, terms);
}

function looksLikeProblema(text) {
  const normalized = normalizeText(text);
  const terms = [
    "organizar",
    "emails",
    "email",
    "tarefas",
    "resumir",
    "documentos",
    "estudar",
    "clientes",
    "atender",
    "automatizar",
    "agenda",
    "tempo",
    "reunioes",
    "relatorios",
    "resolver",
    "ajudar",
    "planear",
    "marcar",
    "responder",
    "preencher",
    "copiar",
    "validar",
    "procurar",
    "excel",
    "dados",
    "faturas",
    "pedidos",
    "stock",
    "inventario",
    "repetitivo",
    "manual",
    "demora",
    "perco tempo",
    "automatizar",
    "automatizasse",
    "automacao"
  ];

  return hasAny(normalized, terms);
}

function looksLikeFuture(text) {
  const normalized = normalizeText(text);
  const terms = [
    "futuro",
    "daqui",
    "anos",
    "automatic",
    "autonoma",
    "autonomo",
    "integrada",
    "integrado",
    "melhorar",
    "mais util",
    "ajudar mais",
    "substituir",
    "prever",
    "personalizada",
    "assistente"
  ];

  return hasAny(normalized, terms) || wordCount(text) >= 5;
}

function hasEnoughDetailForGoal(text, goal) {
  const cleanText = (text || "").trim();

  if (isVagueAnswer(cleanText, goal)) return false;
  if (wordCount(cleanText) >= MIN_WORDS_FOR_DIRECT_ACCEPT) return true;

  markInternalDecision("short_fragment_needs_clarification", {
    goal,
    text: cleanText || "<vazio>"
  });

  return false;
}

function markInternalDecision(type, details = {}) {
  const item = {
    role: "system",
    type,
    details,
    time: new Date().toISOString()
  };

  transcript.push(item);
  log(`[decision] ${type}: ${JSON.stringify(details)}`, "system");
}

function nextGoalAfter(goal) {
  if (goal === "ambiente") return "problemas";
  if (goal === "problemas") return "visao_futuro";
  return "close";
}

function setGoalAsUnspecified(goal, state) {
  state[goal] = "não especificado";
  if (!state.unspecified_fields.includes(goal)) {
    state.unspecified_fields.push(goal);
  }
  markInternalDecision("fallback_after_attempts", {
    goal,
    attempts: state.attempts_per_goal[goal]
  });
}

function acceptField(goal, value, state) {
  const cleanValue = (value || "").trim() || "não especificado";
  state[goal] = cleanValue;
  state.attempts_per_goal[goal] = 0;
  markInternalDecision(`accepted_${goal}`, {
    value: cleanValue
  });
}

function canFinishInterview(state) {
  return INTERVIEW_GOALS.every((goal) => Boolean(state[goal]));
}

function processUserTranscript(text) {
  if (!interviewState) {
    interviewState = createInterviewState();
  }

  if (!text.trim()) {
    if (nextAssistantStep === "greeting") {
      sendAssistantResponse("greeting", "", {
        reason: "empty_transcription"
      });
      return;
    }

    if (nextAssistantStep === "warmup") {
      sendAssistantResponse("warmup", "", {
        reason: "empty_transcription"
      });
      return;
    }
  }

  if (nextAssistantStep === "greeting") {
    if (looksReadyToStart(text)) {
      interviewState.current_goal = "warmup";
      sendAssistantResponse("warmup", text);
      return;
    }

    if (looksLikeAmbiente(text)) {
      interviewState.current_goal = "ambiente";
      markInternalDecision("early_context_fragment", {
        text: text || "<vazio>"
      });
      sendAssistantResponse("clarify", text, {
        reason: isShortFragment(text) ? "short_context_fragment" : "early_context_fragment"
      });
      return;
    }

    markInternalDecision("greeting_not_confirmed", {
      text: text || "<vazio>"
    });
    sendAssistantResponse("greeting", text, {
      reason: "not_ready_confirmation"
    });
    return;
  }

  if (nextAssistantStep === "warmup") {
    interviewState.warmup_done = true;
    if (looksLikeWarmupOption(text) || (looksLikeAmbiente(text) && hasEnoughDetailForGoal(text, "ambiente"))) {
      acceptField("ambiente", text, interviewState);
      interviewState.current_goal = "problemas";
      markInternalDecision("warmup_done", {
        text: text || "<vazio>",
        acceptedAmbiente: true
      });
      sendAssistantResponse("problemas", text);
      return;
    }

    interviewState.current_goal = "ambiente";
    markInternalDecision("warmup_done", {
      text: text || "<vazio>",
      needsContextClarification: looksLikeAmbiente(text) && isShortFragment(text)
    });
    sendAssistantResponse(
      looksLikeAmbiente(text) && isShortFragment(text) ? "clarify" : "ambiente",
      text,
      looksLikeAmbiente(text) && isShortFragment(text)
        ? { reason: "short_context_fragment" }
        : null
    );
    return;
  }

  if (nextAssistantStep === "close") {
    return;
  }

  const decision = evaluateAnswer(text, interviewState);
  interviewState.current_goal = decision.nextGoal;
  sendAssistantResponse(decision.nextStep, text, decision);
}

function processPendingTranscriptIfReady() {
  if (assistantResponseInProgress || !pendingUserTranscript) return;

  const text = pendingUserTranscript;
  pendingUserTranscript = null;
  markInternalDecision("processed_pending_transcript", {
    text
  });
  processUserTranscript(text);
}

function evaluateAnswer(text, state) {
  const goal = state.current_goal;
  const cleanText = (text || "").trim();

  if (!INTERVIEW_GOALS.includes(goal)) {
    return {
      accepted: true,
      nextStep: goal === "warmup" ? "bridge" : "close",
      nextGoal: goal === "warmup" ? "ambiente" : goal,
      reason: "social_step"
    };
  }

  state.attempts_per_goal[goal] += 1;

  const vague = isVagueAnswer(cleanText, goal);
  let accepted = false;

  if (!vague && goal === "ambiente" && looksLikeAmbiente(cleanText) && hasEnoughDetailForGoal(cleanText, goal)) {
    acceptField("ambiente", cleanText, state);
    accepted = true;
  } else if (!vague && goal === "problemas" && looksLikeProblema(cleanText) && hasEnoughDetailForGoal(cleanText, goal)) {
    acceptField("problemas", cleanText, state);
    accepted = true;
  } else if (!vague && goal === "visao_futuro" && looksLikeFuture(cleanText) && hasEnoughDetailForGoal(cleanText, goal)) {
    acceptField("visao_futuro", cleanText, state);
    accepted = true;
  }

  if (accepted) {
    const nextGoal = canFinishInterview(state)
      ? "close"
      : INTERVIEW_GOALS.find((item) => !state[item]) || nextGoalAfter(goal);

    return {
      accepted: true,
      nextStep: nextGoal === "close" ? "close" : nextGoal,
      nextGoal,
      reason: "accepted"
    };
  }

  markInternalDecision("needs_clarification", {
    goal,
    attempt: state.attempts_per_goal[goal],
    text: cleanText || "<vazio>"
  });

  if (state.attempts_per_goal[goal] >= MAX_ATTEMPTS_PER_GOAL) {
    setGoalAsUnspecified(goal, state);
    const nextGoal = canFinishInterview(state)
      ? "close"
      : INTERVIEW_GOALS.find((item) => !state[item]) || nextGoalAfter(goal);

    return {
      accepted: false,
      nextStep: nextGoal === "close" ? "close" : nextGoal,
      nextGoal,
      reason: "fallback_after_attempts"
    };
  }

  return {
    accepted: false,
    nextStep: "clarify",
    nextGoal: goal,
    reason: state.attempts_per_goal[goal] >= 2 ? "needs_example" : "needs_clarification"
  };
}

function buildResponsePrompt(step, userText = "", decision = null) {
  const isGroup = currentFaceCount > 1;
  const hasName = currentUserName && currentUserName !== "desconhecido";
  const intro = isGroup
    ? `Estão ${currentFaceCount} pessoas presentes na experiência.`
    : `Está uma pessoa presente na experiência.`;
  const nameLine = hasName
    ? `O utilizador chama-se ${currentUserName}.`
    : "Não sei o nome da pessoa.";
  const greeting = isGroup
    ? "Olá a todos, sou a Mia. Vou só conversar convosco um bocadinho antes de começarmos. Estão prontos?"
    : hasName
      ? `Olá ${currentUserName}, sou a Mia. Vou só conversar contigo um bocadinho antes de começarmos. Estás pronto?`
      : "Olá, sou a Mia. Vou só conversar contigo um bocadinho antes de começarmos. Estás pronto?";
  const state = interviewState || createInterviewState();
  const attempt = state.current_goal && state.attempts_per_goal[state.current_goal]
    ? state.attempts_per_goal[state.current_goal]
    : 0;
  const includeExample = decision?.reason === "needs_example" || attempt >= 2;
  const collected = [
    `ambiente: ${state.ambiente || "em falta"}`,
    `problema: ${state.problemas || "em falta"}`,
    `visão de futuro: ${state.visao_futuro || "em falta"}`
  ].join("\n");

  const base = [
    "Tu és a Mia.",
    "Tu és a entrevistadora/facilitadora. O tema é a IA no geral, não a Mia.",
    intro,
    nameLine,
    "Objetivo da experiência: criar conforto primeiro e depois recolher ideias úteis sobre IA no contexto da empresa.",
    "As duas respostas finais são: 1) que tarefa, processo ou problema concreto no dia a dia da empresa a IA podia ajudar a resolver ou automatizar; 2) como a pessoa imagina a IA nesse contexto profissional daqui a alguns anos.",
    "Fala sempre em português europeu de Portugal.",
    "Usa 'tu'.",
    "Sê curto, natural e falado.",
    "Não digas que és ChatGPT.",
    "Não uses expressões do Brasil.",
    "Não uses 'olha', 'a Mia pode ser útil', 'a Mia devia ajudar', 'posso fazer-te', 'gostava de te fazer' nem 'duas perguntas rápidas'.",
    "Quando falares do tema, diz sempre 'a IA', 'uma IA' ou 'inteligência artificial', nunca 'a Mia'.",
    "Máximo uma pergunta por resposta.",
    "O frontend decide quando há dados suficientes. Não digas que vais avançar por tua iniciativa.",
    "Só podes chamar submit_interview quando este prompt disser explicitamente para fechar.",
    "Dados recolhidos até agora:",
    collected
  ];

  if (step === "greeting") {
    if (decision?.reason === "not_ready_confirmation") {
      return [
        ...base,
        `Ultima resposta do utilizador: ${userText || "sem resposta"}.`,
        "A pessoa nao confirmou que esta pronta para comecar.",
        "Nao mudes de tema e nao perguntes sobre IA ainda.",
        "Pede desculpa em meia frase se nao percebeste bem e pergunta se podemos comecar.",
        "Faz uma unica pergunta curta."
      ].join("\n").trim();
    }

    return [
      ...base,
      "PRIMEIRA FALA:",
      "Diz quase exactamente a frase de exemplo.",
      "A tua voz deve soar simpática, leve e natural.",
      "Não faças perguntas sobre IA, objetivo ou autorização.",
      `Exemplo: \"${greeting}\"`,
      "Não acrescentes mais nada nesta primeira fala.",
      "Se a pessoa reclamar que foste direto, pede desculpa e volta a uma saudação curta."
    ].join("\n").trim();
  }

  if (step === "warmup") {
    return [
      ...base,
      "SEGUNDA TROCA SOCIAL:",
      "Responde de forma curta e natural ao que a pessoa disse, sem abrir um tema novo.",
      "Depois faz uma pergunta muito fácil de responder e já orientada para o trabalho.",
      isGroup
        ? "Exemplo: \"Perfeito. Antes de irmos ao tema, no vosso trabalho é mais comum perderem tempo com emails, documentos ou tarefas repetitivas?\""
        : "Exemplo: \"Perfeito. Antes de irmos ao tema, no teu trabalho é mais comum perderes tempo com emails, documentos ou tarefas repetitivas?\"",
      "Se a pessoa reclamar do ritmo, responde: \"Tens razão, desculpa. Comecemos com calma: está tudo bem contigo?\"",
      "Ainda não expliques o objetivo da experiência.",
      "A Mia deve soar leve, quase como uma conversa de corredor, mas deve dar opções para a pessoa não ficar sem saber o que dizer."
    ].join("\n").trim();
  }

  if (step === "ambiente" || step === "bridge") {
    return [
      ...base,
      `Última resposta do utilizador: ${userText || "sem resposta"}.`,
      "OBJETIVO ATUAL: CONTEXTO PROFISSIONAL.",
      "Começa com uma frase leve que ligue a conversa ao dia a dia na empresa.",
      "Não uses tom de formulário nem digas 'perguntas rápidas'.",
      "Explica em meia frase que estás a recolher ideias sobre onde a IA pode ajudar no trabalho.",
      isGroup
        ? "Pergunta: \"No vosso dia a dia na empresa, em que área ou momento faria mais sentido usar IA?\""
        : "Pergunta: \"No teu dia a dia na empresa, em que área ou momento faria mais sentido usar IA?\"",
      "Não abras opções fora da empresa; mantém sempre o foco no trabalho.",
      "Não perguntes ainda pela visão de futuro.",
      "Mantém um tom calmo, leve e humano."
    ].join("\n").trim();
  }

  if (step === "problemas" || step === "problem") {
    return [
      ...base,
      `Última resposta do utilizador: ${userText || "sem resposta"}.`,
      "OBJETIVO ATUAL: PROBLEMA CONCRETO.",
      "Pergunta de forma curta e natural que tarefa, processo ou parte repetitiva do trabalho a IA devia ajudar a resolver ou automatizar.",
      "Exemplos de ajuda: organizar tarefas, responder ou resumir emails, resumir documentos, preparar relatórios, preencher dados, apoiar clientes, procurar informação interna.",
      "A resposta tem de permitir preencher um problema concreto do dia a dia na empresa.",
      "Não perguntes ainda pela visão de futuro."
    ].join("\n").trim();
  }

  if (step === "visao_futuro" || step === "future") {
    return [
      ...base,
      `Última resposta do utilizador: ${userText || "sem resposta"}.`,
      "OBJETIVO ATUAL: VISÃO DE FUTURO.",
      "Pergunta de forma curta e natural como a pessoa imagina a IA no futuro no mesmo contexto profissional.",
      isGroup
        ? "Exemplo: \"E pensando nesse contexto, como imaginas a IA daqui a 5 ou 10 anos?\""
        : "Exemplo: \"E pensando nesse contexto, como imaginas a IA daqui a 5 ou 10 anos?\"",
      "A resposta deve capturar uma visão ou expectativa, não apenas 'vai ser melhor'.",
      "Não feches a conversa nesta fala."
    ].join("\n").trim();
  }

  if (step === "clarify") {
    const goal = state.current_goal;
    const goalLabel = {
      ambiente: "a área ou momento do trabalho onde a IA faria sentido",
      problemas: "a tarefa, processo ou problema concreto que a IA devia ajudar a resolver ou automatizar",
      visao_futuro: "a forma como imagina a IA no futuro nesse contexto profissional"
    }[goal] || "o detalhe em falta";

    const shortFragmentLine = decision?.reason === "short_context_fragment"
      ? "A resposta foi uma palavra curta. Usa essa palavra como contexto e pede para a pessoa concretizar, sem a tratar como resposta completa."
      : null;

    const exampleLine = includeExample
      ? {
          ambiente: "Dá exemplos curtos só dentro da empresa: atendimento a clientes, relatórios, operações, gestão interna ou trabalho de equipa.",
          problemas: "Dá exemplos curtos: emails, relatórios, dados em Excel, tarefas repetitivas, documentos ou apoio a clientes.",
          visao_futuro: "Dá exemplos curtos: uma IA mais autónoma, integrada nas ferramentas, ou capaz de antecipar necessidades."
        }[goal]
      : "Não dês exemplos ainda; apenas reformula de forma mais simples.";

    return [
      ...base,
      `Última resposta do utilizador: ${userText || "sem resposta"}.`,
      `OBJETIVO ATUAL: CLARIFICAR ${goalLabel}.`,
      "A resposta anterior não foi específica o suficiente para avançar.",
      shortFragmentLine,
      exampleLine,
      "Responde com empatia em meia frase e faz uma única pergunta curta.",
      "Não avances para outro tema."
    ].filter(Boolean).join("\n").trim();
  }

  return [
    ...base,
    `Última resposta do utilizador: ${userText || "sem resposta"}.`,
    "FECHO:",
    "Todos os campos já foram preenchidos ou marcados como não especificado pelo frontend.",
    `Chama submit_interview com estes valores exactos:
ambiente: ${state.ambiente || "não especificado"}
problemas: ${state.problemas || "não especificado"}
visao_futuro: ${state.visao_futuro || "não especificado"}`,
    "Antes da chamada, agradece numa frase curta.",
    "Quando chamares submit_interview, usa frases curtas e fiéis ao que a pessoa disse. Não inventes detalhes."
  ].join("\n").trim();
}

function sendAssistantResponse(step, userText = "", decision = null) {
  if (!dc || dc.readyState !== "open") return;

  nextAssistantStep = step;
  assistantResponseInProgress = true;
  assistantAudioStarted = false;
  setMiaPresence("thinking", "A Mia está quase a falar");
  log(`[realtime] response.create step=${step}`, "system");
  log(`[realtime] prompt step=${step}; userText=${userText || "<vazio>"}`, "system");

  sendEvent({
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      tools: [buildSubmitInterviewTool()],
      instructions: buildResponsePrompt(step, userText, decision)
    }
  });

  if (step === "greeting" && decision?.reason === "not_ready_confirmation") {
    setInterviewStatus("A Mia vai confirmar se podes comecar");
  } else if (step === "greeting") {
    setInterviewStatus("A Mia vai começar");
  } else if (step === "warmup") {
    setInterviewStatus("A Mia vai responder");
  } else if (step === "ambiente" || step === "bridge") {
    setInterviewStatus("A Mia vai perguntar pelo contexto");
  } else if (step === "problemas" || step === "problem") {
    setInterviewStatus("A Mia vai fazer a pergunta principal");
  } else if (step === "visao_futuro" || step === "future") {
    setInterviewStatus("A Mia vai perguntar pelo futuro");
  } else if (step === "clarify") {
    setInterviewStatus("A Mia vai clarificar antes de avançar");
  } else if (step === "close") {
    setInterviewStatus("A Mia vai fechar a conversa");
  }
}

function completeInterview(args) {
  if (completed) return;

  if (!interviewState || !canFinishInterview(interviewState)) {
    const recoveryGoal = interviewState
      ? INTERVIEW_GOALS.find((goal) => !interviewState[goal]) || "ambiente"
      : "ambiente";

    if (interviewState) {
      interviewState.current_goal = recoveryGoal;
    }

    markInternalDecision("blocked_premature_submit", {
      args,
      recoveryGoal,
      state: interviewState
    });
    sendAssistantResponse(recoveryGoal, "", {
      reason: "premature_submit_blocked"
    });
    return;
  }

  completed = true;

  const result = {
    ambiente: interviewState.ambiente || args.ambiente || "não especificado",
    problemas: interviewState.problemas || args.problemas || "não especificado",
    visao_futuro: interviewState.visao_futuro || args.visao_futuro || "não especificado",
    transcript: [...transcript],
    interviewState: {
      warmup_done: interviewState.warmup_done,
      current_goal: interviewState.current_goal,
      attempts_per_goal: { ...interviewState.attempts_per_goal },
      unspecified_fields: [...interviewState.unspecified_fields]
    }
  };

  cleanup();

  if (onCompleteCallback) {
    onCompleteCallback(result);
  }
}

function handleRealtimeMessage(event) {
  try {
    const msg = JSON.parse(event.data);

    if (
      msg.type &&
      msg.type !== "response.output_audio_transcript.delta" &&
      msg.type !== "response.audio_transcript.delta" &&
      msg.type !== "conversation.item.input_audio_transcription.delta"
    ) {
      if (DEBUG_REALTIME) {
        console.log("Realtime:", msg.type, msg);
      }
    }

    if (msg.type === "output_audio_buffer.started") {
      assistantAudioStarted = true;
      setMiaPresence("speaking", "");
      setInterviewStatus("A Mia está a falar");
      return;
    }

    if (msg.type === "output_audio_buffer.stopped") {
      markAssistantOutputStopped();
      return;
    }

    if (msg.type === "output_audio_buffer.cleared") {
      markAssistantOutputStopped("output_audio_buffer_cleared");
      return;
    }

    if (msg.type === "conversation.item.truncated") {
      markInternalDecision("assistant_output_truncated", {
        itemId: msg.item_id || "<sem id>",
        audioEndMs: msg.audio_end_ms ?? null,
        nextAssistantStep
      });
      return;
    }

    if (msg.type === "input_audio_buffer.speech_started") {
      if (assistantResponseInProgress || assistantAudioStarted) {
        ignoredInputItemIds.add(msg.item_id);
        markInternalDecision("ignored_speech_during_assistant", {
          itemId: msg.item_id || "<sem id>",
          nextAssistantStep
        });
      }
      return;
    }

    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const text = msg.transcript || "";

      if (ignoredInputItemIds.has(msg.item_id)) {
        ignoredInputItemIds.delete(msg.item_id);
        markInternalDecision("ignored_transcript_during_assistant", {
          text: text || "<vazio>",
          nextAssistantStep
        });
        return;
      }

      if (text) {
        log(`Pessoa: ${text}`, "user");
        transcript.push({ role: "user", text, time: new Date().toISOString() });
      } else {
        markInternalDecision("empty_transcription", {
          goal: interviewState?.current_goal || nextAssistantStep
        });
      }

      if (completed) return;

      if (assistantResponseInProgress) {
        pendingUserTranscript = text;
        markInternalDecision("queued_user_transcript", {
          text: text || "<vazio>",
          nextAssistantStep
        });
        return;
      }

      processUserTranscript(text);
      return;
    }

    if (
      msg.type === "response.output_audio_transcript.done" ||
      msg.type === "response.audio_transcript.done"
    ) {
      const text = msg.transcript || "";

      if (text) {
        log(`IA: ${text}`, "assistant");
        transcript.push({ role: "assistant", text, time: new Date().toISOString() });
        if (nextAssistantStep === "greeting") {
          log("[realtime] Mia cumprimentou, vai passar ao warmup", "system");
        }
      }

      return;
    }

    if (msg.type === "response.function_call_arguments.done" && msg.name === "submit_interview") {
      try {
        const args = JSON.parse(msg.arguments || "{}");
        log(`Dados recebidos: ${JSON.stringify(args)}`, "system");
        completeInterview(args);
      } catch (parseErr) {
        log(`Erro ao parsear argumentos: ${parseErr.message}`, "error");
      }
      return;
    }

    if (msg.type === "response.done" && msg.response?.output) {
      if (assistantResponseInProgress && !assistantAudioStarted) {
        markAssistantOutputStopped("response_done_without_audio_started");
      } else if (assistantResponseInProgress) {
        scheduleResponseDoneFallback();
      }

      for (const item of msg.response.output) {
        if (item.type === "function_call" && item.name === "submit_interview") {
          try {
            const args = JSON.parse(item.arguments || "{}");
            log(`Dados recebidos (via response.done): ${JSON.stringify(args)}`, "system");
            completeInterview(args);
          } catch (parseErr) {
            log(`Erro ao parsear argumentos: ${parseErr.message}`, "error");
          }
        }
      }
      return;
    }

    if (msg.type === "error") {
      const err = msg.error || {};
      const details = [
        err.message,
        err.code ? `code=${err.code}` : null,
        err.param ? `param=${err.param}` : null
      ].filter(Boolean).join(" | ");

      log(`Erro Realtime: ${details || JSON.stringify(err)}`, "error");
    }
  } catch {
    if (DEBUG_REALTIME) {
      console.log("Realtime raw:", event.data);
    }
  }
}

export function getTranscript() {
  return [...transcript];
}
