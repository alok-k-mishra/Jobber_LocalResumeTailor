import fs from "node:fs";
import path from "node:path";
import {
  config,
  detectOllama,
  resolveModelForTask,
  ollamaUnavailableError,
  getRuntime,
} from "../config.js";

const promptCache = new Map();

export function loadPrompt(name) {
  if (promptCache.has(name)) return promptCache.get(name);
  const file = path.join(config.promptsDir, `${name}.txt`);
  const text = fs.readFileSync(file, "utf8");
  promptCache.set(name, text);
  return text;
}

/**
 * Very small mustache-like renderer. Only replaces {{key}} tokens with the
 * provided values. Values are inserted verbatim (they may be large documents).
 */
export function render(template, vars = {}) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const v = vars[key];
      return v === undefined || v === null ? "" : String(v);
    }
    return m;
  });
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(id) };
}

async function ensureOllama() {
  const rt = await detectOllama();
  if (!rt.baseUrl) throw ollamaUnavailableError();
  return rt;
}

/**
 * Low-level chat call against the local Ollama server only.
 */
export async function chat({
  model,
  messages,
  format,
  options = {},
  think,
  timeoutMs = config.ollamaTimeoutMs,
}) {
  const rt = await ensureOllama();
  const body = {
    model,
    messages,
    stream: false,
    options: { temperature: 0.1, ...options },
  };
  if (format) body.format = format;
  if (typeof think === "boolean") body.think = think;

  const { signal, clear } = timeoutSignal(timeoutMs);
  let res;
  try {
    res = await fetch(`${rt.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    clear();
    if (err.name === "AbortError") {
      throw new Error(`Ollama request timed out after ${timeoutMs}ms.`);
    }
    throw ollamaUnavailableError();
  }
  clear();

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama returned HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = await res.json();
  const content = json?.message?.content ?? json?.response ?? "";
  return { content: String(content), raw: json, model };
}

function tryExtractJson(text) {
  const cleaned = String(text)
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Call the model for a given task and validate the JSON result against a zod
 * schema. Attempts controlled repair before failing closed.
 */
export async function generateJson({
  task,
  promptName,
  vars = {},
  schema,
  model: modelOverride,
  maxAttempts = 3,
  temperature = 0.1,
  think = false,
  label = promptName || task,
  maxTokens,
}) {
  await ensureOllama();
  const model = modelOverride || resolveModelForTask(task);
  const template = loadPrompt(promptName);
  const basePrompt = render(template, vars);
  const schemaHint = `\n\nReturn ONLY valid JSON that conforms to this JSON Schema:\n${JSON.stringify(
    zodToJsonSchema(schema)
  )}`;

  const messages = [
    {
      role: "system",
      content:
        "You are a strict, evidence-first JSON extraction and reasoning engine. " +
        "You never invent facts. You output only valid JSON. No prose, no markdown.",
    },
    { role: "user", content: basePrompt + schemaHint },
  ];

  let lastError = null;
  let lastContent = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { content } = await chat({
      model,
      messages,
      format: zodToJsonSchema(schema),
      options: { temperature, ...(maxTokens ? { num_predict: maxTokens } : {}) },
      think,
    });
    lastContent = content;

    const parsed = tryExtractJson(content);
    if (parsed === null) {
      lastError = new Error("Output was not parseable JSON.");
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content:
          "Your previous response was not valid JSON. Reply with a single valid JSON object only, no markdown fences, no commentary.",
      });
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) {
      return { data: result.data, model, attempts: attempt, raw: parsed };
    }

    lastError = new Error(
      `JSON failed schema validation: ${result.error.issues
        .slice(0, 12)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`
    );
    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content:
        `Your previous JSON did not match the required schema. Fix ONLY these problems and return the full corrected JSON:\n` +
        result.error.issues
          .slice(0, 12)
          .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    });
  }

  const err = new Error(
    `Model "${model}" failed to produce valid JSON for "${label}" after ${maxAttempts} attempts: ${lastError?.message}`
  );
  err.lastContent = lastContent;
  throw err;
}

/**
 * Minimal zod -> JSON schema converter for the subset we use (objects, arrays,
 * strings, numbers, booleans, enums, optionals, defaults, nullable, literals).
 * Keeps the app dependency-free of a separate converter package.
 */
export function zodToJsonSchema(schema) {
  const def = schema?._def;
  if (!def) return {};

  const typeName = def.typeName;
  switch (typeName) {
    case "ZodObject": {
      const shape = def.shape();
      const properties = {};
      const required = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      };
    }
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema(def.type) };
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: def.values };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return zodToJsonSchema(def.innerType);
    case "ZodEffects":
      return zodToJsonSchema(def.schema);
    case "ZodUnion": {
      const options = def.options.map(zodToJsonSchema);
      return { anyOf: options };
    }
    case "ZodRecord":
      return { type: "object", additionalProperties: true };
    default:
      return {};
  }
}

function isOptional(schema) {
  const t = schema?._def?.typeName;
  return t === "ZodOptional" || t === "ZodDefault" || t === "ZodNullable";
}

export function modelRoutingInfo() {
  const rt = getRuntime();
  return rt.routing;
}
