import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.static("public"));
app.use(express.json({ limit: "10mb" }));

// ── Multer (upload de fotos) ───────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "data/faces";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const name = req.body.name || "unknown";
    const safe = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const ts = Date.now();
    cb(null, `${ts}_${safe}.jpg`);
  }
});
const upload = multer({ storage });

// ── Helpers para JSON local ────────────────────────────────────────────────
const DATA_DIR = "data";
const USERS_FILE = path.join(DATA_DIR, "users.json");
const DESCRIPTORS_FILE = path.join(DATA_DIR, "descriptors.json");
const INTERVIEWS_DIR = path.join(DATA_DIR, "interviews");

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync("data/faces")) fs.mkdirSync("data/faces", { recursive: true });
  if (!fs.existsSync(INTERVIEWS_DIR)) fs.mkdirSync(INTERVIEWS_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
  if (!fs.existsSync(DESCRIPTORS_FILE)) fs.writeFileSync(DESCRIPTORS_FILE, JSON.stringify({ version: 1, descriptors: [] }, null, 2));
}
ensureDataFiles();

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

function normalizeDescriptor(raw) {
  let value = raw;

  if (typeof value === "string") {
    value = JSON.parse(value);
  }

  // Caso venha como { descriptor: [...] }
  if (value && value.descriptor) {
    value = value.descriptor;
  }

  // Caso venha como [[...]]
  if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0])) {
    value = value[0];
  }

  // Caso venha como objeto tipo {0: 0.123, 1: 0.456, ...}
  if (!Array.isArray(value) && typeof value === "object" && value !== null) {
    value = Object.values(value);
  }

  if (!Array.isArray(value)) {
    throw new Error("Descritor facial inválido: não é array");
  }

  const numbers = value.map(Number);

  if (numbers.length !== 128) {
    throw new Error(`Descritor facial inválido: tamanho ${numbers.length}, esperado 128`);
  }

  if (!numbers.every(Number.isFinite)) {
    throw new Error("Descritor facial inválido: contém valores não numéricos");
  }

  return numbers;
}

// ── Endpoints ───────────────────────────────────────────────────────────────

// 0. ICE servers para WebRTC (STUN sempre, TURN quando configurado)
app.get("/ice-config", (req, res) => {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" }
  ];

  const turnUrl = process.env.TURN_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;
  const hasTurn = Boolean(turnUrl && turnUsername && turnCredential);

  if (hasTurn) {
    iceServers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential
    });
  }

  res.json({
    iceServers,
    iceTransportPolicy: "all",
    turnConfigured: hasTurn
  });
});

// 1. Token efémero para WebRTC
app.get("/token", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Falta OPENAI_API_KEY no .env" });
    }

    console.log("[token] a criar sessão realtime");

    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: "gpt-realtime",
          instructions: `És a Mia: simpática, leve e natural. Fala sempre em português europeu de Portugal. Sê curta, humana e conversacional. Nunca digas que és ChatGPT. És a entrevistadora; o tema da conversa é o uso de IA no dia a dia da empresa, não a Mia. Segue as instruções de cada resposta e usa a função submit_interview quando a conversa terminar.`.trim(),
          tools: [
            {
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
            }
          ],
          audio: {
            output: {
              voice: "marin"
            },
            input: {
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "pt"
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                silence_duration_ms: 700,
                create_response: false,
                interrupt_response: false
              },
              noise_reduction: {
                type: "near_field"
              }
            }
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json({ error: "Erro ao criar token realtime", details: data });
    }

    const clientSecret =
      data?.value ||
      data?.client_secret?.value ||
      data?.session?.client_secret?.value;

    if (!clientSecret) {
      return res.status(500).json({ error: "Resposta sem client secret", data });
    }

    res.json({ client_secret: clientSecret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno no servidor" });
  }
});

// 2. Registar novo utilizador (face + dados)
app.post("/register-face", upload.single("photo"), (req, res) => {
  try {
    const { name, descriptor } = req.body;
    if (!name || !descriptor || !req.file) {
      return res.status(400).json({ error: "Faltam dados (nome, descritor ou foto)" });
    }

    const parsedDescriptor = normalizeDescriptor(descriptor);
    const userId = `usr_${Date.now()}`;

    // Guardar utilizador
    const users = loadJson(USERS_FILE) || [];
    const user = {
      id: userId,
      name: name.trim(),
      photoPath: req.file.filename,
      registeredAt: new Date().toISOString()
    };
    users.push(user);
    saveJson(USERS_FILE, users);

    // Guardar descritor
    const descriptorsData = loadJson(DESCRIPTORS_FILE) || { version: 1, descriptors: [] };
    descriptorsData.descriptors.push({
      userId,
      label: name.trim(),
      descriptor: parsedDescriptor
    });
    saveJson(DESCRIPTORS_FILE, descriptorsData);

    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(400).json({
      error: "Erro ao registar utilizador",
      details: err.message
    });
  }
});

// 3. Guardar resultado da conversa
app.post("/interview", (req, res) => {
  try {
    const payload = req.body;

    if (!payload.responses) {
      return res.status(400).json({ error: "Faltam respostas da conversa" });
    }

    const userId = payload.userId || "guest";
    console.log(`[interview] a guardar conversa para ${userId}`);

    const today = new Date().toISOString().split("T")[0];
    const dir = path.join(INTERVIEWS_DIR, today);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const ts = Date.now();
    const filename = `${ts}_${userId}.json`;
    const filepath = path.join(dir, filename);

    const finalPayload = {
      ...payload,
      userId,
      savedAt: new Date().toISOString()
    };

    fs.writeFileSync(filepath, JSON.stringify(finalPayload, null, 2));

    console.log(`[interview] guardada em ${filepath}`);

    res.json({ success: true, file: filename });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao guardar conversa" });
  }
});

// 4. Obter descritores e utilizadores
app.get("/faces/descriptors", (req, res) => {
  const descriptorsData = loadJson(DESCRIPTORS_FILE) || { version: 1, descriptors: [] };
  const users = loadJson(USERS_FILE) || [];
  res.json({
    descriptors: descriptorsData.descriptors,
    users: users.map(u => ({ id: u.id, name: u.name, photoPath: u.photoPath }))
  });
});

// 5. Obter lista de utilizadores
app.get("/users", (req, res) => {
  const users = loadJson(USERS_FILE) || [];
  res.json(users);
});

// Favicon (evita erro 404 no browser)
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

// ── Iniciar ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor a correr em http://localhost:${PORT}`);
});
