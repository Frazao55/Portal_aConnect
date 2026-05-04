// scripts/pre-register.js
// Pré-regista utilizadores a partir de fotos numa pasta
// Uso: node scripts/pre-register.js <pasta_com_fotos>

import * as faceapi from "@vladmandic/face-api";
import { createCanvas, loadImage } from "canvas";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const FACES_DIR = path.join(DATA_DIR, "faces");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const DESCRIPTORS_FILE = path.join(DATA_DIR, "descriptors.json");

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FACES_DIR)) fs.mkdirSync(FACES_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
  if (!fs.existsSync(DESCRIPTORS_FILE)) fs.writeFileSync(DESCRIPTORS_FILE, JSON.stringify({ version: 1, descriptors: [] }, null, 2));
}

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function filenameToName(filename) {
  // Remove extensão
  const base = path.basename(filename, path.extname(filename));
  // Substitui underscores por espaços
  const withSpaces = base.replace(/_/g, " ");
  // Capitaliza cada palavra
  return withSpaces
    .split(" ")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const inputDir = process.argv[2];

  if (!inputDir) {
    console.error("❌ Uso: node scripts/pre-register.js <pasta_com_fotos>");
    console.error("   Exemplo: node scripts/pre-register.js data/fotos_funcionarios/");
    process.exit(1);
  }

  const resolvedInput = path.resolve(inputDir);
  if (!fs.existsSync(resolvedInput)) {
    console.error(`❌ Pasta não existe: ${resolvedInput}`);
    process.exit(1);
  }

  ensureDirs();

  // Carregar modelos
  console.log("📦 A carregar modelos de reconhecimento facial...");
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
  console.log("✅ Modelos carregados.\n");

  // Ler ficheiros de imagem
  const files = fs.readdirSync(resolvedInput).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return [".jpg", ".jpeg", ".png"].includes(ext);
  });

  if (files.length === 0) {
    console.error("❌ Nenhuma imagem encontrada (.jpg, .jpeg, .png)");
    process.exit(1);
  }

  console.log(`🖼️  ${files.length} imagem(ns) encontrada(s). A processar...\n`);

  const users = loadJson(USERS_FILE) || [];
  const descriptorsData = loadJson(DESCRIPTORS_FILE) || { version: 1, descriptors: [] };

  let successCount = 0;
  let skipCount = 0;

  for (const file of files) {
    const filepath = path.join(resolvedInput, file);
    const name = filenameToName(file);

    console.log(`⏳ ${name} (${file})`);

    try {
      // Carregar imagem
      const img = await loadImage(filepath);
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, img.width, img.height);

      // Detetar face + landmarks + descritor
      const detection = await faceapi
        .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        console.log(`   ⚠️  Face não detetada. Ignorado.\n`);
        skipCount++;
        continue;
      }

      // Gerar ID e copiar foto
      const userId = `usr_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
      const photoFilename = `${Date.now()}_${safeName}.jpg`;
      const destPath = path.join(FACES_DIR, photoFilename);

      // Converter para JPEG e guardar
      const outCanvas = createCanvas(detection.detection.box.width, detection.detection.box.height);
      const outCtx = outCanvas.getContext("2d");
      outCtx.drawImage(
        canvas,
        detection.detection.box.x,
        detection.detection.box.y,
        detection.detection.box.width,
        detection.detection.box.height,
        0, 0,
        detection.detection.box.width,
        detection.detection.box.height
      );
      const jpegBuffer = outCanvas.toBuffer("image/jpeg", { quality: 0.9 });
      fs.writeFileSync(destPath, jpegBuffer);

      // Guardar utilizador
      const user = {
        id: userId,
        name: name,
        photoPath: photoFilename,
        registeredAt: new Date().toISOString()
      };
      users.push(user);

      // Guardar descritor
      descriptorsData.descriptors.push({
        userId,
        label: name,
        descriptor: Array.from(detection.descriptor)
      });

      console.log(`   ✅ Registado com sucesso (ID: ${userId})\n`);
      successCount++;

      // Pequeno delay para evitar IDs duplicados
      await new Promise(r => setTimeout(r, 10));

    } catch (err) {
      console.log(`   ❌ Erro: ${err.message}\n`);
      skipCount++;
    }
  }

  // Guardar ficheiros JSON
  saveJson(USERS_FILE, users);
  saveJson(DESCRIPTORS_FILE, descriptorsData);

  console.log("─────────────────────────────────────");
  console.log(`✅ Concluído: ${successCount} registado(s), ${skipCount} ignorado(s).`);
  console.log(`📁 Dados guardados em:`);
  console.log(`   - ${USERS_FILE}`);
  console.log(`   - ${DESCRIPTORS_FILE}`);
  console.log(`   - ${FACES_DIR}/`);
}

main().catch(err => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
