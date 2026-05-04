// ui.js — Gestão da interface e log

const screens = {
  preview: document.getElementById("screen-preview"),
  loading: document.getElementById("screen-loading"),
  welcome: document.getElementById("screen-welcome"),
  register: document.getElementById("screen-register"),
  interview: document.getElementById("screen-interview"),
  done: document.getElementById("screen-done")
};

const els = {
  video: document.getElementById("camera"),
  welcomeName: document.getElementById("welcome-name"),
  doneName: document.getElementById("done-name"),
  interviewTimer: document.getElementById("interview-timer"),
  miaStage: document.getElementById("mia-stage"),
  log: document.getElementById("log"),
  registerPhoto: document.getElementById("register-photo"),
  registerName: document.getElementById("register-name"),
  particles: document.getElementById("particles"),
  miaPreview: document.getElementById("mia-preview"),
  cameraPreview: document.getElementById("camera-preview")
};

const miaVideo = document.getElementById("mia-video");
const statusEl = document.getElementById("interview-status");

const debugEnabled = new URLSearchParams(window.location.search).get("debug") === "1";
document.body.dataset.debug = debugEnabled ? "true" : "false";

export function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add("hidden"));
  if (screens[name]) screens[name].classList.remove("hidden");

  if (name !== "interview") {
    miaVideo?.pause();
    delete document.body.dataset.miaPresence;
  }

  if (name === "preview" && els.miaPreview) {
    els.miaPreview.currentTime = 0;
    els.miaPreview.pause();
  }
}

export function setWelcomeName(name) {
  els.welcomeName.textContent = name;
}

export function setDoneName(name) {
  els.doneName.textContent = name;
}

const STATUS_TEXT = {
  connecting: "A ligar...",
  thinking: "A pensar...",
  listening: "Podes falar...",
  speaking: "Mia est\u00e1 a falar",
  idle: ""
};

export function setMiaPresence(state) {
  if (els.miaStage) {
    els.miaStage.dataset.presence = state;
  }

  document.body.dataset.miaPresence = state;

  if (statusEl) {
    statusEl.textContent = STATUS_TEXT[state] || "";
  }

  if (!miaVideo) return;

  if (state === "speaking") {
    miaVideo.currentTime = 0;
    miaVideo.play().catch(() => {});
  } else {
    miaVideo.pause();
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

// ── Partículas ─────────────────────────────────────────────────

let particlesActive = false;
let particlesAnimId = null;

export function startParticles() {
  if (particlesActive) return;
  particlesActive = true;

  const canvas = els.particles;
  const ctx = canvas.getContext("2d");
  const dots = [];
  const count = 50;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener("resize", resize);

  for (let i = 0; i < count; i++) {
    dots.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.6 + 0.4,
      vx: (Math.random() - 0.5) * 0.25,
      vy: -Math.random() * 0.5 - 0.15,
      alpha: Math.random() * 0.5 + 0.25,
      pulse: Math.random() * Math.PI * 2,
      color: Math.random() < 0.35 ? "239, 68, 68" : "100, 100, 100"
    });
  }

  function draw() {
    if (!particlesActive) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const d of dots) {
      d.x += d.vx;
      d.y += d.vy;
      d.pulse += 0.015;

      if (d.y < -10) { d.y = canvas.height + 10; d.x = Math.random() * canvas.width; }
      if (d.x < -10) d.x = canvas.width + 10;
      if (d.x > canvas.width + 10) d.x = -10;

      const a = d.alpha * (0.6 + 0.4 * Math.sin(d.pulse));
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${d.color}, ${a})`;
      ctx.fill();
    }

    particlesAnimId = requestAnimationFrame(draw);
  }

  draw();
}

export function stopParticles() {
  particlesActive = false;
  if (particlesAnimId) {
    cancelAnimationFrame(particlesAnimId);
    particlesAnimId = null;
  }
}

// ── Botões ─────────────────────────────────────────────────────

export const buttons = {
  startConversation: document.getElementById("btn-start-conversation"),
  register: document.getElementById("btn-register"),
  cancelRegister: document.getElementById("btn-cancel-register"),
  stopInterview: document.getElementById("btn-stop-interview"),
  restart: document.getElementById("btn-restart")
};

export function setCameraPreviewStream(stream) {
  if (els.cameraPreview) {
    els.cameraPreview.srcObject = stream;
  }
}

// ── Preview overlay state ──────────────────────────────────────

export function setPreviewAnalyzing(analyzing) {
  const previewScreen = document.getElementById("screen-preview");
  const btn = document.getElementById("btn-start-conversation");
  const status = document.getElementById("preview-status");
  const loading = document.getElementById("preview-loading");

  if (!previewScreen || !btn || !status || !loading) return;

  if (analyzing) {
    previewScreen.classList.add("analyzing");
    btn.classList.add("hidden");
    status.classList.add("hidden");
    loading.classList.remove("hidden");
  } else {
    previewScreen.classList.remove("analyzing");
    btn.classList.remove("hidden");
    status.classList.remove("hidden");
    loading.classList.add("hidden");
  }
}

export function hidePreviewOverlay() {
  const previewScreen = document.getElementById("screen-preview");
  if (previewScreen) {
    previewScreen.classList.add("interviewing");
  }
}

export function showPreviewOverlay() {
  const previewScreen = document.getElementById("screen-preview");
  if (previewScreen) {
    previewScreen.classList.remove("interviewing");
    previewScreen.classList.remove("analyzing");
  }
}
