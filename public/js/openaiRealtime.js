// openaiRealtime.js — Integração WebRTC com OpenAI Realtime API

import { setInterviewTimer, log, setMiaPresence } from "./ui.js";
import { MIA_BASE_PERSONA, MIA_EVENT_NAME } from "./miaPersona.js";

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
let pendingUserTranscripts = [];
let ignoredInputItemIds = new Set();
let responseDoneFallbackTimer = null;
let iceDisconnectedTimer = null;
let awaitingAssessment = false;
let pendingAssessmentArgs = null;
let pendingAssessmentInput = null;

const MAX_DURATION_SECONDS = 300;
const MAX_ATTEMPTS_PER_GOAL = 2;
const RESPONSE_DONE_AUDIO_FALLBACK_MS = 30000;
const ICE_DISCONNECTED_GRACE_MS = 5000;
const INTERVIEW_GOALS = ["problemas", "visao_futuro"];
const SOCIAL_STEP = "quebra_gelo";
const NON_PENALIZING_ANSWER_TYPES = new Set(["confirmation_only", "question_back", "smalltalk", "skip"]);
const PENALIZING_ANSWER_TYPES = new Set(["dont_know", "noise"]);
const DEBUG_REALTIME = new URLSearchParams(window.location.search).get("debug") === "1";

function createInterviewState() {
  return {
    warmup_done: false,
    ambiente: "não especificado",
    problemas: null,
    visao_futuro: null,
    current_goal: SOCIAL_STEP,
    attempts_per_goal: { problemas: 0, visao_futuro: 0 },
    clarifications_per_goal: { problemas: 0, visao_futuro: 0 },
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
  pendingUserTranscripts = [];
  ignoredInputItemIds = new Set();
  awaitingAssessment = false;
  pendingAssessmentArgs = null;
  pendingAssessmentInput = null;
  if (responseDoneFallbackTimer) {
    clearTimeout(responseDoneFallbackTimer);
    responseDoneFallbackTimer = null;
  }
  clearIceDisconnectedTimer();

  try {
    setMiaPresence("connecting");
    log("[realtime] a pedir token efémero", "system");

    const tokenRes = await fetch("/token");
    log(`[realtime] tokenRes status=${tokenRes.status}`, "system");
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      throw new Error(tokenData.error || "Erro ao obter token");
    }

    const ephemeralKey = tokenData.client_secret;
    log("[realtime] token obtido", "system");

    const iceConfigRes = await fetch("/ice-config");
    log(`[realtime] iceConfigRes status=${iceConfigRes.status}`, "system");
    const iceConfig = iceConfigRes.ok
      ? await iceConfigRes.json()
      : {
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          iceTransportPolicy: "all",
          turnConfigured: false
        };

    if (!iceConfig.turnConfigured) {
      log("[webrtc] TURN nao configurado", "error");
    }

    log("[realtime] a criar PeerConnection", "system");

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

      if (pc.connectionState === "connected") clearIceDisconnectedTimer();
      if (pc.connectionState === "disconnected") scheduleIceDisconnectedWarning();
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

    log("[realtime] a pedir microfone...", "system");
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    log(`[realtime] microfone obtido, tracks=${localStream.getAudioTracks().length}`, "system");
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

    log("[realtime] a criar SDP offer...", "system");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    log("[realtime] SDP offer criada e localDescription definida", "system");

    log("[realtime] a enviar SDP para OpenAI...", "system");
    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp"
      }
    });

    log(`[realtime] SDP response status=${sdpResponse.status}`, "system");
    if (!sdpResponse.ok) {
      const text = await sdpResponse.text();
      log(`[realtime] SDP erro: ${text}`, "error");
      throw new Error(`Erro SDP: ${text}`);
    }

    const answerSdp = await sdpResponse.text();
    log(`[realtime] SDP answer recebida, length=${answerSdp.length}`, "system");
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    log("[realtime] remoteDescription definida", "system");

    setMiaPresence("thinking");
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
    log(`[realtime] Erro no startInterview: ${err.message}`, "error");
    if (err.stack) log(`[realtime] Stack: ${err.stack}`, "error");
    cleanup();
    if (onErrorCallback) onErrorCallback(err);
  }
}

export function stopInterview() {
  cleanup();
  log("[realtime] conversa terminada", "system");
}

function cleanup() {
  pendingAssessmentArgs = null;
  pendingAssessmentInput = null;
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
    try { dc.onclose = null; dc.onerror = null; dc.close(); } catch {}
    dc = null;
  }
  if (pc) {
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.onicecandidateerror = null;
    pc.getSenders().forEach((sender) => { if (sender.track) sender.track.stop(); });
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
    setMiaPresence("connecting");
  }, ICE_DISCONNECTED_GRACE_MS);
}

function markAssistantOutputStopped(reason = "audio_buffer_stopped") {
  if (responseDoneFallbackTimer) {
    clearTimeout(responseDoneFallbackTimer);
    responseDoneFallbackTimer = null;
  }
  assistantResponseInProgress = false;
  assistantAudioStarted = false;
  setLocalAudioEnabled(true);
  setMiaPresence("listening");
  markInternalDecision("assistant_output_stopped", { reason });
  if (nextAssistantStep === "close" && canFinishInterview(interviewState)) {
    completeInterviewFromState("close_audio_finished");
    return;
  }
  if (!awaitingAssessment) processPendingTranscriptIfReady();
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
  setMiaPresence("idle");
  if (onErrorCallback) onErrorCallback(err);
}

function sendEvent(event) {
  if (dc && dc.readyState === "open") {
    dc.send(JSON.stringify(event));
  }
}

function setLocalAudioEnabled(enabled) {
  if (!localStream) return;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
}

function buildAssessAnswerTool() {
  return {
    type: "function",
    name: "assess_interview_answer",
    description: "Classificar semanticamente a resposta da pessoa e devolver uma síntese limpa se for útil",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: {
          type: "string",
          enum: INTERVIEW_GOALS,
          description: "Campo atualmente em avaliação"
        },
        userText: {
          type: "string",
          description: "Transcrição original da resposta avaliada"
        },
        answer_type: {
          type: "string",
          enum: ["useful_answer", "confirmation_only", "question_back", "dont_know", "noise", "smalltalk", "skip"],
          description: "Tipo semântico da resposta"
        },
        accepted: {
          type: "boolean",
          description: "Só true quando a resposta contém informação suficiente para preencher o campo atual"
        },
        normalized_value: {
          type: "string",
          description: "Síntese curta, limpa e fiel. Se accepted=false, usar 'não especificado' salvo quando a resposta contenha uma pista útil para outro campo"
        },
        needs_clarification: {
          type: "boolean",
          description: "True quando a MIA deve pedir detalhe antes de avançar"
        },
        clarifying_question: {
          type: "string",
          description: "Pergunta curta sugerida para clarificar, em português europeu"
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Confiança na classificação"
        }
      },
      required: [
        "goal",
        "userText",
        "answer_type",
        "accepted",
        "normalized_value",
        "needs_clarification",
        "clarifying_question",
        "confidence"
      ]
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

function hasAnyWord(normalizedText, terms) {
  const words = new Set(normalizedText.split(/\s+/).filter(Boolean));
  return terms.some((term) => {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) return false;
    if (normalizedTerm.includes(" ")) return normalizedText.includes(normalizedTerm);
    return words.has(normalizedTerm);
  });
}

function pickVariant(options, seed = "") {
  if (!options.length) return "";
  const normalizedSeed = normalizeText(seed);
  let hash = options.length;

  for (const char of normalizedSeed) {
    hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  }

  return options[hash % options.length];
}

function looksReadyToStart(text) {
  const normalized = normalizeText(text);
  return hasAnyWord(normalized, [
    "sim", "estou", "pronto", "pronta", "podemos", "vamos",
    "forca", "claro", "ok", "bora", "pode ser"
  ]);
}

function wantsToSkipSmallTalk(text) {
  const normalized = normalizeText(text);
  return hasAnyWord(normalized, [
    "avancar", "avanca", "vamos ao que interessa", "sem conversa",
    "nao tenho tempo", "tenho pressa", "salta"
  ]);
}

function isVagueAnswer(text, goal) {
  const normalized = normalizeText(text);
  const words = wordCount(text);
  if (!normalized || words === 0) return true;

  if (/^[^\p{L}\p{N}]*$/u.test(text || "")) return true;
  if (/^[^\p{Script=Latin}\p{N}]+$/u.test(normalized)) return true;
  if (hasAnyWord(normalized, ["gut"])) return true;

  const vagueExact = new Set([
    "nao sei", "nao faco ideia", "sem ideia", "qualquer coisa",
    "tanto faz", "depende", "talvez", "sim", "nao", "ok", "pois", "isso", "nada", "normal"
  ]);
  if (vagueExact.has(normalized)) return true;
  if (words <= 2 && hasAnyWord(normalized, ["nao sei", "talvez", "depende", "normal", "melhor"])) return true;
  if (goal === "visao_futuro" && normalized.includes("vai ser melhor") && words <= 4) return true;
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
  if (goal === "problemas") return "visao_futuro";
  return "close";
}

function setGoalAsUnspecified(goal, state) {
  const attempts = state.attempts_per_goal[goal] || 0;
  const clarifications = state.clarifications_per_goal[goal] || 0;
  state[goal] = "não especificado";
  state.attempts_per_goal[goal] = 0;
  state.clarifications_per_goal[goal] = 0;
  if (!state.unspecified_fields.includes(goal)) {
    state.unspecified_fields.push(goal);
  }
  markInternalDecision("fallback_after_attempts", {
    goal,
    attempts,
    clarifications
  });
}

function polishAcceptedValue(goal, value) {
  const cleanValue = (value || "").trim();
  const normalized = normalizeText(cleanValue);

  if (goal === "problemas") {
    if (
      normalized === "mandar mails" ||
      normalized === "mandar emails" ||
      normalized === "enviar mails" ||
      normalized === "enviar emails"
    ) {
      return "automatizar ou apoiar o envio de emails";
    }
    if (normalized.includes("mail") || normalized.includes("email")) {
      return cleanValue
        .replace(/\bmandar mails?\b/gi, "automatizar ou apoiar o envio de emails")
        .replace(/\benviar emails?\b/gi, "automatizar ou apoiar o envio de emails")
        .replace(/\be-mails?\b/gi, "emails");
    }
  }

  if (goal === "visao_futuro") {
    return cleanValue
      .replace(/\bcomandar tudo\b/gi, "coordenar processos")
      .replace(/\bcomandar processos\b/gi, "coordenar processos")
      .replace(/\bcoisas chatas\b/gi, "tarefas repetitivas ou administrativas");
  }

  return cleanValue;
}

function acceptField(goal, value, state, raw = "") {
  const cleanValue = polishAcceptedValue(goal, value) || "não especificado";
  state[goal] = cleanValue;
  state.attempts_per_goal[goal] = 0;
  state.clarifications_per_goal[goal] = 0;
  markInternalDecision(`accepted_${goal}`, {
    value: cleanValue,
    raw: (raw || value || "").trim() || "<vazio>"
  });
}

function canFinishInterview(state) {
  return INTERVIEW_GOALS.every((goal) => Boolean(state[goal]));
}

function processUserTranscript(text) {
  if (!interviewState) interviewState = createInterviewState();
  if (awaitingAssessment) {
    pendingUserTranscripts.push(text);
    markInternalDecision("queued_user_transcript_during_assessment", {
      text: text || "<vazio>",
      goal: interviewState.current_goal
    });
    return;
  }

  if (!text.trim()) {
    if (nextAssistantStep === "greeting") {
      sendAssistantResponse("greeting", "", { reason: "empty_transcription" });
      return;
    }
    if (nextAssistantStep === SOCIAL_STEP) {
      sendAssistantResponse(SOCIAL_STEP, "", { reason: "empty_transcription" });
      return;
    }
  }

  if (nextAssistantStep === "greeting") {
    if (wantsToSkipSmallTalk(text)) {
      interviewState.warmup_done = true;
      interviewState.current_goal = "problemas";
      markInternalDecision("quebra_gelo_skipped", { text: text || "<vazio>" });
      sendAssistantResponse("problemas", text, { reason: "skip_small_talk" });
      return;
    }

    if (looksReadyToStart(text)) {
      interviewState.current_goal = SOCIAL_STEP;
      sendAssistantResponse(SOCIAL_STEP, text);
      return;
    }

    interviewState.current_goal = SOCIAL_STEP;
    markInternalDecision("greeting_acknowledged", { text: text || "<vazio>" });
    sendAssistantResponse(SOCIAL_STEP, text);
    return;
  }

  if (nextAssistantStep === SOCIAL_STEP) {
    interviewState.warmup_done = true;
    interviewState.current_goal = "problemas";
    markInternalDecision("quebra_gelo_done", {
      text: text || "<vazio>",
      skipped: wantsToSkipSmallTalk(text)
    });
    sendAssistantResponse("problemas", text, {
      reason: wantsToSkipSmallTalk(text) ? "skip_small_talk" : "social_done"
    });
    return;
  }

  if (nextAssistantStep === "close") return;

  if (INTERVIEW_GOALS.includes(interviewState.current_goal)) {
    sendAssessmentRequest(interviewState.current_goal, text);
    return;
  }

  sendAssistantResponse("clarify", text, { reason: "unexpected_state" });
}

function processPendingTranscriptIfReady() {
  if (assistantResponseInProgress || pendingUserTranscripts.length === 0) return;
  const text = pendingUserTranscripts.shift();
  markInternalDecision("processed_pending_transcript", { text });
  processUserTranscript(text);
}

function buildRecentContext() {
  return transcript
    .filter((item) => item.role === "user" || item.role === "assistant")
    .slice(-8)
    .map((item) => `${item.role === "user" ? "Pessoa" : "MIA"}: ${item.text}`)
    .join("\n");
}

function buildAssessmentPrompt(goal, userText) {
  const state = interviewState || createInterviewState();
  const fieldLabel = {
    problemas: "tarefa, processo ou problema concreto que a IA devia ajudar a resolver ou automatizar",
    visao_futuro: "visão de futuro sobre como a IA pode ajudar a Arentia"
  }[goal];

  return [
    MIA_BASE_PERSONA,
    "TAREFA SILENCIOSA: não fales com a pessoa agora.",
    "Chama obrigatoriamente a função assess_interview_answer. Não devolvas texto normal.",
    `Campo atual: ${goal} (${fieldLabel}).`,
    `Resposta da pessoa a avaliar: ${userText || "<vazio>"}`,
    "Campos já recolhidos:",
    `problemas: ${state.problemas || "em falta"}`,
    `visao_futuro: ${state.visao_futuro || "em falta"}`,
    "Histórico recente:",
    buildRecentContext() || "sem histórico",
    "Classifica semanticamente a resposta.",
    "accepted só pode ser true se answer_type for useful_answer.",
    "Não aceites confirmações como 'sim' como resposta útil.",
    "Não aceites perguntas da pessoa como resposta útil; usa answer_type question_back.",
    "Não aceites 'não sei', 'boa questão mas não sei' ou equivalentes como resposta útil.",
    "Para problemas, avalia se a resposta identifica um problema, tarefa ou processo que a IA poderia resolver ou automatizar.",
    "Para visao_futuro, avalia se a resposta descreve uma expectativa para o futuro da IA na Arentia, mesmo que mencione o problema anterior.",
    "Se a resposta responder claramente a outro campo que não o atual, accepted=false, mas conserva a pista em normalized_value.",
    "Se a resposta for curta mas útil no contexto, como 'marcações' para problema, aceita.",
    "normalized_value deve ser uma síntese curta, limpa e útil para análise posterior; nunca uma transcrição literal quebrada.",
    "Usa linguagem profissional e suave: prefere 'apoiar', 'coordenar', 'automatizar', 'simplificar' e 'libertar equipas'.",
    "Evita termos fortes como 'comandar tudo' ou 'substituir pessoas', salvo se forem essenciais; quando possível, suaviza para 'coordenar processos' ou 'automatizar tarefas repetitivas'.",
    "Troca expressões vagas como 'coisas chatas' por 'tarefas repetitivas ou administrativas'.",
    "Exemplos de normalização:",
    "- 'Eu responderam eles por mim' => 'responder mensagens ou pedidos pela pessoa'",
    "- 'mandar mails' => 'automatizar ou apoiar o envio de emails'",
    "- 'a comandar tudo' => 'coordenar processos e automatizar tarefas repetitivas'",
    "- 'automatizar coisas chatas' => 'automatizar tarefas repetitivas ou administrativas'",
    "- 'OK, como é que eu penso que ela vai funcionar?' => accepted=false, answer_type=question_back",
    "clarifying_question deve ser curta, oral e adequada ao tipo de resposta."
  ].join("\n").trim();
}

function fallbackAssessAnswer(goal, userText, state) {
  const cleanText = (userText || "").trim();
  const normalized = normalizeText(cleanText);
  const exactConfirmation = new Set(["sim", "sim claro", "claro", "ok", "pois", "ya"]);

  if (!cleanText || isVagueAnswer(cleanText, goal)) {
    return {
      goal,
      userText: cleanText,
      answer_type: exactConfirmation.has(normalized) ? "confirmation_only" : "noise",
      accepted: false,
      normalized_value: "não especificado",
      needs_clarification: true,
      clarifying_question: exactConfirmation.has(normalized)
        ? "Certo. Qual é a primeira coisa que te vem à cabeça?"
        : "Não apanhei bem. Dizes-me de outra forma?",
      confidence: 0.35
    };
  }

  if (normalized.endsWith("como e que eu penso que ela vai funcionar") || normalized.includes("como e que eu penso")) {
    return {
      goal,
      userText: cleanText,
      answer_type: "question_back",
      accepted: false,
      normalized_value: "não especificado",
      needs_clarification: true,
      clarifying_question: "É mesmo isso: imagina-a a funcionar. O que fazia por ti?",
      confidence: 0.5
    };
  }

  return {
    goal,
    userText: cleanText,
    answer_type: "dont_know",
    accepted: false,
    normalized_value: "não especificado",
    needs_clarification: true,
    clarifying_question: "Vamos simplificar: que tarefa gostavas de despachar mais depressa?",
    confidence: 0.2
  };
}

function applyAssessment(rawAssessment) {
  if (!interviewState) interviewState = createInterviewState();

  const goal = INTERVIEW_GOALS.includes(rawAssessment?.goal)
    ? rawAssessment.goal
    : interviewState.current_goal;
  const answerType = rawAssessment?.answer_type || "noise";
  const accepted = Boolean(rawAssessment?.accepted) && answerType === "useful_answer";
  const normalizedValue = (rawAssessment?.normalized_value || "").trim();
  const userText = (rawAssessment?.userText || "").trim();
  const state = interviewState;
  if (!state.clarifications_per_goal) {
    state.clarifications_per_goal = { problemas: 0, visao_futuro: 0 };
  }

  awaitingAssessment = false;

  markInternalDecision("semantic_assessment", {
    goal,
    answerType,
    accepted,
    normalizedValue: normalizedValue || "<vazio>",
    confidence: rawAssessment?.confidence ?? null
  });

  if (accepted && normalizedValue && normalizedValue !== "não especificado") {
    acceptField(goal, normalizedValue, state, userText);
    const nextGoal = canFinishInterview(state)
      ? "close"
      : INTERVIEW_GOALS.find((item) => !state[item]) || nextGoalAfter(goal);
    state.current_goal = nextGoal;
    sendAssistantResponse(nextGoal === "close" ? "close" : nextGoal, userText, {
      reason: "accepted",
      assessment: rawAssessment
    });
    return;
  }

  if (answerType === "skip") {
    setGoalAsUnspecified(goal, state);
    const nextGoal = canFinishInterview(state)
      ? "close"
      : INTERVIEW_GOALS.find((item) => !state[item]) || nextGoalAfter(goal);
    state.current_goal = nextGoal;
    sendAssistantResponse(nextGoal === "close" ? "close" : nextGoal, userText, {
      reason: "skip",
      assessment: rawAssessment
    });
    return;
  }

  if (PENALIZING_ANSWER_TYPES.has(answerType) || answerType === "useful_answer") {
    state.attempts_per_goal[goal] += 1;
  }

  if (answerType !== "skip") {
    state.clarifications_per_goal[goal] = (state.clarifications_per_goal[goal] || 0) + 1;
  }

  markInternalDecision("needs_clarification", {
    goal,
    answerType,
    attempt: state.attempts_per_goal[goal],
    clarification: state.clarifications_per_goal[goal],
    text: userText || "<vazio>"
  });

  if (
    state.attempts_per_goal[goal] >= MAX_ATTEMPTS_PER_GOAL ||
    state.clarifications_per_goal[goal] >= MAX_ATTEMPTS_PER_GOAL
  ) {
    setGoalAsUnspecified(goal, state);
    const nextGoal = canFinishInterview(state)
      ? "close"
      : INTERVIEW_GOALS.find((item) => !state[item]) || nextGoalAfter(goal);
    state.current_goal = nextGoal;
    sendAssistantResponse(nextGoal === "close" ? "close" : nextGoal, userText, {
      reason: "fallback_after_attempts",
      assessment: rawAssessment
    });
    return;
  }

  state.current_goal = goal;
  sendAssistantResponse("clarify", userText, {
    reason: NON_PENALIZING_ANSWER_TYPES.has(answerType) ? answerType : "needs_clarification",
    assessment: rawAssessment
  });
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
  const hour = new Date().getHours();
  const dayGreeting = hour < 12 ? "Bom dia" : hour < 19 ? "Boa tarde" : "Boa noite";
  const greeting = isGroup
    ? pickVariant([
        `${dayGreeting} a todos, sou a MIA. Podemos fazer um aquecimento rápido para a aConquista?`,
        `Olá a todos, sou a MIA. Estão prontos para uma pergunta rápida antes da aConquista?`,
        `${dayGreeting}, sejam bem-vindos. Sou a MIA. Posso começar com uma pergunta simples?`
      ], `${currentFaceCount}-grupo`)
    : hasName
      ? pickVariant([
          `${dayGreeting}, ${currentUserName}. Sou a MIA. Podemos fazer um aquecimento rápido para a aConquista?`,
          `Olá ${currentUserName}, sou a MIA. Posso fazer-te uma pergunta rápida antes da aConquista?`,
          `Olá ${currentUserName}! Sou a MIA. Tens um minuto para começarmos?`
        ], currentUserName)
      : pickVariant([
          `${dayGreeting}, sou a MIA. Podemos fazer um aquecimento rápido para a aConquista?`,
          `Olá, sou a MIA. Posso fazer-te uma pergunta rápida antes da aConquista?`,
          "Olá! Sou a MIA. Tens um minuto para começarmos?"
        ], "sem-nome");
  const state = interviewState || createInterviewState();
  const attempt = state.current_goal && state.attempts_per_goal[state.current_goal]
    ? state.attempts_per_goal[state.current_goal]
    : 0;
  const clarification = state.current_goal && state.clarifications_per_goal?.[state.current_goal]
    ? state.clarifications_per_goal[state.current_goal]
    : 0;
  const includeExample = decision?.reason === "needs_example" || attempt >= 1 || clarification >= 1;
  const collected = [
    `problema: ${state.problemas || "em falta"}`,
    `visão de futuro: ${state.visao_futuro || "em falta"}`
  ].join("\n");

  const base = [
    MIA_BASE_PERSONA,
    intro,
    nameLine,
    `Evento: ${MIA_EVENT_NAME}.`,
    "Objetivo da experiência: criar conforto primeiro e depois recolher duas ideias úteis sobre IA na Arentia.",
    "As duas respostas finais são: 1) que problema, tarefa ou processo no dia a dia da Arentia a IA podia ajudar a resolver ou automatizar; 2) como a pessoa imagina a IA no futuro da Arentia.",
    "Fala de forma natural, curta e humana, como numa conversa de evento.",
    "Faz no máximo uma pergunta por resposta.",
    "Quando falares do tema, usa 'a IA', 'uma IA' ou 'inteligência artificial'.",
    "Segue apenas o objetivo atual, sem antecipar a próxima fase.",
    "Podes fazer uma micro-reação de no máximo uma frase antes da pergunta, ligada ao que a pessoa disse.",
    "Varia ligeiramente a formulação para não soar a formulário.",
    "Dados recolhidos até agora:",
    collected
  ];

  if (step === "greeting") {
    if (decision?.reason === "empty_transcription") {
      return [
        ...base,
        "A pessoa ainda não respondeu ou o microfone não apanhou bem.",
        "Não repitas exatamente a mesma frase.",
        "Faz uma pergunta curta e tranquila para confirmar se a pessoa está pronta.",
        "Exemplos: \"Estás aí comigo?\", \"Podemos começar?\", \"Queres que avance?\"",
        "Não fales ainda de IA, trabalho ou processos."
      ].join("\n").trim();
    }

    return [
      ...base,
      "PRIMEIRA FALA:",
      "Diz uma saudação próxima, curta e com convite claro à resposta.",
      "A primeira fala deve ter duas partes: apresentação breve + pergunta simples para começar.",
      "Podes mencionar a aConquista apenas como contexto de aquecimento.",
      "Não faças ainda a pergunta de expectativa sobre o evento.",
      "Não fales ainda de IA, trabalho, processos ou objetivo da recolha.",
      "Termina obrigatoriamente com uma pergunta curta, para a pessoa saber que deve responder.",
      `Exemplo: \"${greeting}\"`,
      "Não acrescentes mais nada além dessa saudação com pergunta.",
      "Se a pessoa reclamar que foste direta, pede desculpa e faz uma entrada mais suave."
    ].join("\n").trim();
  }

  if (step === SOCIAL_STEP) {
    return [
      ...base,
      `Última resposta do utilizador: ${userText || "sem resposta"}.`,
      "QUEBRA-GELO DE PRÉ-EVENTO:",
      "Este é o segundo momento da conversa, depois da saudação inicial.",
      "Esta fase é só acolhimento antes da aConquista. Ainda não recolhas respostas sobre IA nem sobre processos de trabalho.",
      "Responde de forma curta, próxima e natural ao que a pessoa disse.",
      "Depois faz uma única pergunta leve sobre a expectativa da pessoa para a aConquista.",
      isGroup
        ? "Fala para o grupo. Pergunta algo como: que expectativa têm para a aConquista, que tema gostavam de ver explorado, ou o que gostavam de levar convosco no fim."
        : hasName
          ? `Fala diretamente com ${currentUserName}. Pergunta algo como: que expectativa tens para a aConquista, que tema gostavas de ver explorado, ou o que gostavas de levar contigo no fim.`
          : "Pergunta algo como: que expectativa tens para a aConquista, que tema gostavas de ver explorado, ou o que gostavas de levar contigo no fim.",
      "Evita perguntas sobre 'hoje', porque a experiência pode acontecer antes do dia da aConquista.",
      "Evita soar demasiado animada ou forçada. Não exageres no entusiasmo.",
      "Evita expressões informais como 'Boa' no início da fala; prefere 'Certo', 'Percebo', 'Obrigado' ou uma reação curta ao conteúdo.",
      "Não uses sempre a palavra 'curioso'; varia entre expectativa, interesse, tema, utilidade ou surpresa.",
      "Se a pessoa estiver sem vontade de conversa fiada, aceita com naturalidade e passa ao assunto.",
      "Não expliques ainda o objetivo da experiência."
    ].join("\n").trim();
  }

  if (step === "problemas" || step === "problem") {
    return [
      ...base,
      `Última resposta do utilizador: ${userText || "sem resposta"}.`,
      "OBJETIVO ATUAL: descobrir uma tarefa, problema ou processo concreto do dia a dia da Arentia que a IA podia ajudar a resolver ou automatizar.",
      decision?.reason === "social_done"
        ? "A resposta anterior veio do quebra-gelo sobre o evento. Reage primeiro em uma frase curta e genuína à expectativa da pessoa. Depois faz uma ponte suave: 'ligando isto ao tema da IA', 'trazendo isso para o dia a dia', ou equivalente. Não pareças estar a despachar."
        : decision?.reason === "skip_small_talk"
          ? "A pessoa quis avançar. Respeita isso com uma frase curta e vai diretamente à primeira pergunta principal."
          : "Se a resposta anterior já trouxe contexto útil, reconhece-o numa frase curta antes de perguntar.",
      "Formula a pergunta com palavras tuas, sem soar a questionário.",
      "Pergunta por um problema, tarefa ou processo concreto do dia a dia onde a IA pudesse ajudar.",
      isGroup
        ? "Fala para o grupo, mas pede uma ideia concreta."
        : "Fala diretamente com a pessoa e pede uma ideia concreta.",
      "Podes dar 2 ou 3 exemplos simples se ajudar: emails, relatórios, documentos, tarefas repetitivas, dados ou apoio a clientes.",
      "Se a pessoa responder só com uma palavra mas ela fizer sentido no contexto, como 'marcações', aceita e avança.",
      "Mantém a resposta curta e faz só uma pergunta.",
      "Não perguntes ainda pela visão de futuro."
    ].join("\n").trim();
  }

  if (step === "visao_futuro" || step === "future") {
    return [
      ...base,
      `Última resposta do utilizador: ${userText || "sem resposta"}.`,
      "OBJETIVO ATUAL: perceber como a pessoa imagina a IA no futuro da Arentia.",
      "Faz uma transição curta: reage ao problema registado e abre a pergunta para uma visão mais ampla.",
      "Usa a versão normalizada do problema, não a transcrição bruta.",
      "Pergunta de forma aberta como a IA pode ajudar equipas, processos ou a forma de trabalhar daqui para a frente.",
      "Varia a formulação e não repitas sempre o exemplo de 'daqui a uns anos'.",
      "Mantém a resposta curta e faz só uma pergunta.",
      "Não feches a conversa nesta fala."
    ].join("\n").trim();
  }

  if (step === "clarify") {
    const goal = state.current_goal;
    const assessment = decision?.assessment || null;
    const goalLabel = {
      problemas: "a tarefa, processo ou problema concreto que a IA devia ajudar a resolver ou automatizar",
      visao_futuro: "a visão sobre a IA no futuro da Arentia"
    }[goal] || "o detalhe em falta";

    const shortFragmentLine = decision?.reason === "short_context_fragment"
      ? "A resposta foi uma palavra curta. Usa essa palavra como contexto e pede para a pessoa concretizar, sem a tratar como resposta completa."
      : null;

    const exampleLine = includeExample
      ? {
          problemas: "Dá exemplos curtos: emails, relatórios, dados em Excel, tarefas repetitivas, documentos ou apoio a clientes.",
          visao_futuro: "Dá exemplos curtos: IA mais integrada nas ferramentas, a apoiar equipas, a antecipar necessidades ou a simplificar processos."
        }[goal]
      : "Não dês exemplos ainda; apenas reformula de forma mais simples.";

    return [
      ...base,
      `Última resposta do utilizador: ${userText || "sem resposta"}.`,
      `OBJETIVO ATUAL: CLARIFICAR ${goalLabel}.`,
      assessment ? `Classificação semântica: ${assessment.answer_type}.` : "A resposta anterior não foi específica o suficiente para avançar.",
      assessment?.clarifying_question ? `Pergunta sugerida: "${assessment.clarifying_question}"` : null,
      shortFragmentLine,
      exampleLine,
      "Evita soar a interrogatório. Se já houver uma pista útil, confirma a pista e faz uma pergunta muito simples.",
      "Se a resposta foi só confirmação, pergunta qual é a tarefa ou momento concreto sem dizer que a resposta foi insuficiente.",
      "Se a pessoa devolveu uma pergunta, esclarece em meia frase e volta a pedir um exemplo.",
      "Responde com empatia em meia frase e faz uma única pergunta curta.",
      "Não avances para outro tema."
    ].filter(Boolean).join("\n").trim();
  }

  return [
    ...base,
    `Última resposta do utilizador: ${userText || "sem resposta"}.`,
    "FECHO:",
    "Todos os campos já foram preenchidos ou marcados como não especificado pelo frontend.",
    "Usa apenas os valores limpos nos campos recolhidos. Nunca repitas transcrições brutas ou frases quebradas da pessoa.",
    `Valores que serão guardados automaticamente pelo frontend:
problemas: ${state.problemas || "não especificado"}
visao_futuro: ${state.visao_futuro || "não especificado"}`,
    "Não chames nenhuma função.",
    "Faz um fecho curto, caloroso e com mini-resumo do que ficou registado.",
    "No fecho, resume só o problema e a visão de futuro. Não menciones o campo ambiente nem digas que ficou não especificado.",
    "Se algum valor vier com linguagem forte, suaviza no resumo: 'comandar processos' deve soar como 'coordenar processos'.",
    "Exemplo de tom: \"Obrigado, Diogo. Fica registado: IA a apoiar o envio de emails e, no futuro da Arentia, a coordenar processos e automatizar tarefas repetitivas para libertar as equipas. Obrigado por deixares a tua marca.\"",
    "Não termines só com 'Obrigado, ficou registado'."
  ].join("\n").trim();
}

function sendAssessmentRequest(goal, userText = "") {
  if (!dc || dc.readyState !== "open") return;

  setLocalAudioEnabled(false);
  awaitingAssessment = true;
  pendingAssessmentArgs = null;
  pendingAssessmentInput = { goal, userText };
  nextAssistantStep = "assess";
  assistantResponseInProgress = true;
  assistantAudioStarted = false;
  setMiaPresence("thinking");
  log(`[realtime] response.create assessment goal=${goal}`, "system");
  log(`[realtime] assessment prompt goal=${goal}; userText=${userText || "<vazio>"}`, "system");

  sendEvent({
    type: "response.create",
    response: {
      output_modalities: ["text"],
      tools: [buildAssessAnswerTool()],
      tool_choice: "required",
      instructions: buildAssessmentPrompt(goal, userText)
    }
  });
}

function sendAssistantResponse(step, userText = "", decision = null) {
  if (!dc || dc.readyState !== "open") return;

  setLocalAudioEnabled(false);
  awaitingAssessment = false;
  nextAssistantStep = step;
  assistantResponseInProgress = true;
  assistantAudioStarted = false;
  setMiaPresence("thinking");
  log(`[realtime] response.create step=${step}`, "system");
  log(`[realtime] prompt step=${step}; userText=${userText || "<vazio>"}`, "system");

  sendEvent({
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      tools: [],
      instructions: buildResponsePrompt(step, userText, decision)
    }
  });
}

function completeInterviewFromState(reason = "state_complete") {
  if (!interviewState || !canFinishInterview(interviewState)) return;
  markInternalDecision("auto_submit_after_close", { reason });
  completeInterview({
    ambiente: interviewState.ambiente || "não especificado",
    problemas: interviewState.problemas || "não especificado",
    visao_futuro: interviewState.visao_futuro || "não especificado"
  });
}

function completeInterview(args) {
  if (completed) return;

  if (!interviewState || !canFinishInterview(interviewState)) {
    const recoveryGoal = interviewState
      ? INTERVIEW_GOALS.find((goal) => !interviewState[goal]) || "problemas"
      : "problemas";
    if (interviewState) interviewState.current_goal = recoveryGoal;
    markInternalDecision("blocked_premature_submit", {
      args,
      recoveryGoal,
      state: interviewState
    });
    sendAssistantResponse(recoveryGoal, "", { reason: "premature_submit_blocked" });
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
      clarifications_per_goal: { ...interviewState.clarifications_per_goal },
      unspecified_fields: [...interviewState.unspecified_fields]
    }
  };

  cleanup();
  if (onCompleteCallback) onCompleteCallback(result);
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
      if (DEBUG_REALTIME) console.log("Realtime:", msg.type, msg);
    }

    if (msg.type === "output_audio_buffer.started") {
      assistantAudioStarted = true;
      setLocalAudioEnabled(false);
      setMiaPresence("speaking");
      return;
    }

    if (msg.type === "output_audio_buffer.stopped") {
      markAssistantOutputStopped();
      return;
    }

    if (msg.type === "output_audio_buffer.cleared") {
      markInternalDecision("assistant_output_cleared_ignored", {
        nextAssistantStep,
        assistantResponseInProgress,
        assistantAudioStarted
      });
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
        pendingUserTranscripts.push(text);
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
      }
      return;
    }

    if (msg.type === "response.function_call_arguments.done" && msg.name === "assess_interview_answer") {
      if (!awaitingAssessment) {
        markInternalDecision("ignored_unexpected_assessment_call", { nextAssistantStep });
        return;
      }
      try {
        const args = JSON.parse(msg.arguments || "{}");
        log(`Avaliação semântica: ${JSON.stringify(args)}`, "system");
        pendingAssessmentArgs = args;
      } catch (parseErr) {
        log(`Erro ao parsear avaliação: ${parseErr.message}`, "error");
        const goal = interviewState?.current_goal || "problemas";
        pendingAssessmentArgs = fallbackAssessAnswer(
          goal,
          pendingAssessmentInput?.userText || "",
          interviewState || createInterviewState()
        );
      }
      return;
    }

    if (msg.type === "response.done" && msg.response?.output) {
      const wasAwaitingAssessment = awaitingAssessment;

      if (!wasAwaitingAssessment && assistantResponseInProgress && !assistantAudioStarted) {
        markAssistantOutputStopped("response_done_without_audio_started");
      } else if (!wasAwaitingAssessment && assistantResponseInProgress) {
        scheduleResponseDoneFallback();
      }

      for (const item of msg.response.output) {
        if (wasAwaitingAssessment && item.type === "function_call" && item.name === "assess_interview_answer") {
          if (pendingAssessmentArgs) continue;
          try {
            const args = JSON.parse(item.arguments || "{}");
            log(`Avaliação semântica (via response.done): ${JSON.stringify(args)}`, "system");
            pendingAssessmentArgs = args;
          } catch (parseErr) {
            log(`Erro ao parsear avaliação: ${parseErr.message}`, "error");
          }
        }
      }

      if (wasAwaitingAssessment) {
        const goal = pendingAssessmentInput?.goal || interviewState?.current_goal || "problemas";
        const assessment = pendingAssessmentArgs || fallbackAssessAnswer(
          goal,
          pendingAssessmentInput?.userText || "",
          interviewState || createInterviewState()
        );
        if (!pendingAssessmentArgs) markInternalDecision("assessment_missing_tool_call", { goal });
        pendingAssessmentArgs = null;
        pendingAssessmentInput = null;
        applyAssessment(assessment);
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
    if (DEBUG_REALTIME) console.log("Realtime raw:", event.data);
  }
}

export function getTranscript() {
  return [...transcript];
}
