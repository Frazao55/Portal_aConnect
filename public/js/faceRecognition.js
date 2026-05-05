// faceRecognition.js — Deteção e reconhecimento facial (silencioso)

import { log, getVideoElement } from "./ui.js";
import { buildCameraConstraints } from "./cameraConfig.js";

const MODEL_URL = "/models";

let video = null;
let cameraStream = null;
let detectionInterval = null;
let isDetecting = false;
let registeredDescriptors = [];
let registeredUsers = [];
let currentDescriptor = null;
let currentPhoto = null;
let faceCount = 0;

export async function loadModels() {
  log("A carregar modelos faciais...", "system");
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
  log("Modelos faciais carregados.", "system");
}

export async function loadRegisteredFaces() {
  try {
    const res = await fetch("/faces/descriptors");
    if (!res.ok) throw new Error("Falha ao carregar descritores");
    const data = await res.json();
    registeredDescriptors = data.descriptors || [];
    registeredUsers = data.users || [];
    log(`${registeredDescriptors.length} rostos carregados.`, "system");
  } catch (err) {
    log("Erro ao carregar rostos: " + err.message, "error");
    registeredDescriptors = [];
    registeredUsers = [];
  }
}

export async function startCamera() {
  video = getVideoElement();
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: buildCameraConstraints(),
    audio: false
  });
  video.srcObject = cameraStream;

  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      video.play();
      resolve(cameraStream);
    };
  });
}

export function getCameraStream() {
  return cameraStream;
}

export function stopCamera() {
  if (detectionInterval) {
    clearInterval(detectionInterval);
    detectionInterval = null;
  }
  isDetecting = false;
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  if (video) {
    video.srcObject = null;
  }
  faceCount = 0;
  currentDescriptor = null;
  currentPhoto = null;
}

export function startDetection(onFaceFound, onNoFace) {
  isDetecting = true;
  let stableFrames = 0;
  const REQUIRED_STABLE = 6; // ~1.2s a 200ms

  detectionInterval = setInterval(async () => {
    if (!video || video.paused || video.ended || !isDetecting) return;

    const detections = await faceapi
      .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    faceCount = detections.length;

    if (faceCount === 0) {
      currentDescriptor = null;
      currentPhoto = null;
      stableFrames = 0;
      if (onNoFace) onNoFace();
      return;
    }

    if (faceCount > 1) {
      stableFrames = 0;
      currentDescriptor = null;
      currentPhoto = null;
      return;
    }

    const detection = detections[0];
    currentDescriptor = detection.descriptor;
    currentPhoto = capturePhoto();
    stableFrames++;

    if (stableFrames >= REQUIRED_STABLE) {
      if (onFaceFound) {
        const match = findBestMatch(currentDescriptor);
        onFaceFound(match);
      }
    }
  }, 200);
}

export function stopDetection() {
  isDetecting = false;
  if (detectionInterval) {
    clearInterval(detectionInterval);
    detectionInterval = null;
  }
}

// ── Normalização robusta de descritores ─────────────────────────

function normalizeClientDescriptor(raw) {
  let value = raw;

  if (value instanceof Float32Array) {
    return value.length === 128 ? value : null;
  }

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (value && value.descriptor) value = value.descriptor;
  if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0])) value = value[0];
  if (!Array.isArray(value) && typeof value === "object" && value !== null) value = Object.values(value);
  if (!Array.isArray(value)) return null;

  const numbers = value.map(Number);
  if (numbers.length !== 128) return null;
  if (!numbers.every(Number.isFinite)) return null;

  return new Float32Array(numbers);
}

function findBestMatch(inputDescriptor) {
  const queryDescriptor = normalizeClientDescriptor(inputDescriptor);
  if (!queryDescriptor) return null;
  if (!registeredDescriptors.length) return null;

  let bestMatch = null;
  let bestDistance = Infinity;
  const THRESHOLD = 0.48;

  for (const item of registeredDescriptors) {
    const savedDescriptor = normalizeClientDescriptor(item.descriptor);
    if (!savedDescriptor) continue;
    const distance = faceapi.euclideanDistance(queryDescriptor, savedDescriptor);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = item;
    }
  }

  if (!bestMatch || bestDistance > THRESHOLD) return null;

  return {
    userId: bestMatch.userId,
    label: bestMatch.label,
    distance: bestDistance
  };
}

export function getCurrentDescriptor() {
  return currentDescriptor;
}

export function getCurrentPhoto() {
  return currentPhoto;
}

export function getFaceCount() {
  return faceCount;
}

export function capturePhoto() {
  if (!video) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

export async function registerFace(name, descriptor, photoDataUrl) {
  const res = await fetch(photoDataUrl);
  const blob = await res.blob();
  const file = new File([blob], "face.jpg", { type: "image/jpeg" });

  const formData = new FormData();
  formData.append("name", name);
  formData.append("descriptor", JSON.stringify(Array.from(descriptor)));
  formData.append("photo", file);

  const response = await fetch("/register-face", {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || err.details || "Erro ao registar");
  }

  const data = await response.json();
  await loadRegisteredFaces();
  return data.user;
}
