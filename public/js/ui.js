// ui.js — Gestão da interface e log

const screens = {
  idle: document.getElementById("screen-idle"),
  identifying: document.getElementById("screen-identifying"),
  recognized: document.getElementById("screen-recognized"),
  register: document.getElementById("screen-register"),
  interview: document.getElementById("screen-interview"),
  done: document.getElementById("screen-done")
};

const els = {
  videoContainer: document.getElementById("video-container"),
  video: document.getElementById("camera"),
  facePill: document.getElementById("face-pill"),
  statePill: document.getElementById("state-pill"),
  statusText: document.getElementById("status-text"),
  recognizedName: document.getElementById("recognized-name"),
  interviewStatus: document.getElementById("interview-status"),
  interviewTimer: document.getElementById("interview-timer"),
  miaStage: document.getElementById("mia-stage"),
  miaPresenceText: document.getElementById("mia-presence-text"),
  log: document.getElementById("log"),
  registerPhoto: document.getElementById("register-photo"),
  registerName: document.getElementById("register-name")
};

const debugEnabled = new URLSearchParams(window.location.search).get("debug") === "1";
document.body.dataset.debug = debugEnabled ? "true" : "false";

export function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add("hidden"));
  if (screens[name]) screens[name].classList.remove("hidden");
}

export function showVideo() {
  els.videoContainer.classList.remove("hidden");
}

export function hideVideo() {
  els.videoContainer.classList.add("hidden");
}

export function setFacePill(text, type = "") {
  els.facePill.textContent = text;
  els.facePill.className = "pill " + type;
}

export function setStatePill(text, type = "info") {
  els.statePill.textContent = text;
  els.statePill.className = "pill " + type;
}

export function setStatus(text) {
  els.statusText.textContent = text;
}

export function setRecognizedName(name) {
  els.recognizedName.textContent = name;
}

export function setInterviewStatus(text) {
  els.interviewStatus.textContent = text;
}

export function setMiaPresence(state, text = "") {
  if (els.miaStage) {
    els.miaStage.dataset.presence = state;
  }

  if (els.miaPresenceText && text) {
    els.miaPresenceText.textContent = text;
  }
}

export function setInterviewTimer(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  els.interviewTimer.textContent = `${m}:${s}`;
}

export function setRegisterPhoto(dataUrl) {
  els.registerPhoto.src = dataUrl;
}

export function getRegisterName() {
  return els.registerName.value.trim();
}

export function clearRegisterName() {
  els.registerName.value = "";
}

export function log(message, role = "system") {
  if (!debugEnabled) return;

  const time = new Date().toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const entry = document.createElement("div");
  entry.className = "entry";
  entry.innerHTML = `<span class="time">[${time}]</span><span class="role-${role}">${escapeHtml(message)}</span>`;
  els.log.appendChild(entry);
  els.log.scrollTop = els.log.scrollHeight;
}

export function clearLog() {
  els.log.innerHTML = "";
}

export function getVideoElement() {
  return els.video;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Botões exportados para app.js ligar eventos
export const buttons = {
  startId: document.getElementById("btn-start-id"),
  startInterview: document.getElementById("btn-start-interview"),
  newUser: document.getElementById("btn-new-user"),
  register: document.getElementById("btn-register"),
  cancelRegister: document.getElementById("btn-cancel-register"),
  stopInterview: document.getElementById("btn-stop-interview"),
  restart: document.getElementById("btn-restart")
};
