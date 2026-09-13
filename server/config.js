import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

function parseBool(v, fallback = false) {
  if (v === undefined || v === null || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function candidateBaseUrls() {
  const candidates = [];
  const add = (u) => {
    if (!u) return;
    const clean = String(u).replace(/\/+$/, "");
    if (!candidates.includes(clean)) candidates.push(clean);
  };

  add(process.env.OLLAMA_BASE_URL);
  add("http://localhost:11434");
  add("http://127.0.0.1:11434");

  // WSL: Windows host is commonly the default gateway.
  try {
    const resolv = fs.readFileSync("/etc/resolv.conf", "utf8");
    const ns = resolv
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("nameserver"))
      .map((l) => l.split(/\s+/)[1])
      .filter(Boolean);
    for (const ip of ns) add(`http://${ip}:11434`);
  } catch {
    /* not on a system with resolv.conf */
  }

  // WSL: the default gateway (Windows host) is the usual home of Ollama.
  try {
    const route = fs.readFileSync("/proc/net/route", "utf8");
    for (const line of route.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 3) continue;
      const dest = cols[1];
      const gatewayHex = cols[2];
      if (dest !== "00000000") continue;
      // Gateway is little-endian hex.
      const bytes = gatewayHex.match(/../g);
      if (!bytes || bytes.length !== 4) continue;
      const ip = bytes
        .reverse()
        .map((b) => parseInt(b, 16))
        .join(".");
      add(`http://${ip}:11434`);
    }
  } catch {
    /* /proc/net/route unavailable */
  }

  add("http://host.docker.internal:11434");
  return candidates;
}

export const config = {
  port: Number(process.env.PORT || 5173),
  dataDir: path.isAbsolute(process.env.DATA_DIR || "")
    ? process.env.DATA_DIR
    : path.resolve(ROOT, process.env.DATA_DIR || "./data/sessions"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 15) * 1024 * 1024,
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 300000),
  allowCloud: parseBool(process.env.ALLOW_CLOUD, false),
  // In-context learning: every completed analysis is stored and the best past
  // examples are re-injected into future prompts so the local models get
  // sharper with each application. No model weights are ever touched.
  learning: parseBool(process.env.LEARNING_ENABLED, true),
  // Two local models only:
  //   Qwen 3.5   -> extraction (resume/JD/answers), structured facts, final claim validation
  //   Phi-4-mini -> reasoning (requirement analysis, matching, tailoring, cover letter)
  desiredModels: {
    extraction: process.env.OLLAMA_EXTRACTION_MODEL || "qwen3.5:4b",
    reasoning: process.env.OLLAMA_REASONING_MODEL || "phi4-mini:3.8b",
    validation: process.env.OLLAMA_VALIDATION_MODEL || "qwen3.5:4b",
  },
  promptsDir: path.resolve(ROOT, "server/prompts"),
};

// Runtime resolution cache.
const runtime = {
  baseUrl: null,
  resolvedAt: 0,
  models: [], // full model objects from /api/tags
  routing: {}, // task family -> { desired, resolved, changed }
  lastError: null,
};

const TAGS_TIMEOUT_MS = 4000;

async function fetchTags(baseUrl) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TAGS_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json.models) ? json.models : [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Detect a reachable Ollama instance. Tries the configured URL first, then
 * common local addresses. Never falls back to a cloud endpoint.
 */
export async function detectOllama({ force = false } = {}) {
  const now = Date.now();
  if (!force && runtime.baseUrl && now - runtime.resolvedAt < 15000) {
    return runtime;
  }

  const errors = [];
  for (const baseUrl of candidateBaseUrls()) {
    try {
      const models = await fetchTags(baseUrl);
      runtime.baseUrl = baseUrl;
      runtime.models = models;
      runtime.routing = resolveRouting(models);
      runtime.resolvedAt = now;
      runtime.lastError = null;
      return runtime;
    } catch (err) {
      errors.push(`${baseUrl}: ${err.message}`);
    }
  }

  runtime.baseUrl = null;
  runtime.models = [];
  runtime.routing = {};
  runtime.lastError = errors.join(" | ");
  runtime.resolvedAt = now;
  return runtime;
}

function normalizeName(s) {
  return String(s || "").toLowerCase().trim();
}

function baseName(s) {
  return normalizeName(s).split(":")[0];
}

/**
 * Pick the installed model that best matches a desired tag. Exact match wins.
 * Otherwise match on family/base name, then on closest parameter size.
 */
function pickModel(models, desired) {
  const names = models.map((m) => m.name);
  const dNorm = normalizeName(desired);
  const exact = names.find((n) => normalizeName(n) === dNorm);
  if (exact) return { name: exact, changed: false };

  const dBase = baseName(desired);
  const sameFamily = names.filter((n) => baseName(n) === dBase);
  if (sameFamily.length === 1) {
    return { name: sameFamily[0], changed: true };
  }
  if (sameFamily.length > 1) {
    // choose the largest variant of the family as the safer general default
    const bySize = sameFamily
      .map((n) => ({ n, size: models.find((m) => m.name === n)?.size || 0 }))
      .sort((a, b) => b.size - a.size);
    return { name: bySize[0].n, changed: true };
  }

  // Family differs entirely (e.g. spec says qwen3.5, installed qwen3).
  const fuzzy = names.find((n) => {
    const nb = baseName(n);
    return nb.startsWith(dBase.slice(0, 4)) || dBase.startsWith(nb.slice(0, 4));
  });
  if (fuzzy) return { name: fuzzy, changed: true };

  return { name: null, changed: true };
}

function resolveRouting(models) {
  const routing = {};
  for (const [task, desired] of Object.entries(config.desiredModels)) {
    const { name, changed } = pickModel(models, desired);
    routing[task] = { desired, resolved: name, changed };
  }
  return routing;
}

export function getRuntime() {
  return runtime;
}

export function ollamaUnavailableError() {
  return new Error(
    "Ollama is unavailable. Start Ollama and try again. " +
      (runtime.lastError ? `(tried: ${runtime.lastError})` : "")
  );
}

export function resolveModelForTask(task) {
  const routing = runtime.routing || {};
  const entry = routing[task];
  if (!entry) {
    throw new Error(`No model routing configured for task "${task}".`);
  }
  if (!entry.resolved) {
    throw new Error(
      `No installed Ollama model matches "${entry.desired}" for task "${task}". ` +
        `Install it or set the model env var. Installed: ${runtime.models
          .map((m) => m.name)
          .join(", ")}`
    );
  }
  return entry.resolved;
}

export function statusSnapshot() {
  return {
    baseUrl: runtime.baseUrl,
    available: Boolean(runtime.baseUrl),
    models: runtime.models.map((m) => m.name),
    routing: runtime.routing,
    error: runtime.lastError,
  };
}
