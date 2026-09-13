import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const BANK_PATH = path.join(config.dataDir, "questions-bank.json");

/**
 * Persistent bank of personal questions derived from job descriptions.
 *
 * Each item is one reusable question:
 *   { id, question, answer_type, answer, notes_evidence, source,
 *     requirement_id, created_at, updated_at }
 *
 * The pool only grows; answered requirements are reused across applications so
 * the model is asked only about genuinely new confirmations.
 */

function ensureDir() {
  fs.mkdirSync(path.dirname(BANK_PATH), { recursive: true });
}

function pad(n) {
  return String(n).padStart(3, "0");
}

function normKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function listQuestions() {
  try {
    const raw = fs.readFileSync(BANK_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQuestions(items) {
  ensureDir();
  fs.writeFileSync(BANK_PATH, JSON.stringify(items, null, 2), "utf8");
}

function nextQuestionId(items) {
  let hi = 0;
  for (const it of items) {
    const m = /^Q-?(\d{1,4})$/i.exec(String(it.id || ""));
    if (m) hi = Math.max(hi, Number(m[1]));
  }
  return `Q-${pad(hi + 1)}`;
}

export function getQuestion(id) {
  return listQuestions().find((q) => q.id === id) || null;
}

export function addQuestion({ question, answer_type, answer, notes_evidence, source, requirement_id, key }) {
  if (!question || !String(question).trim()) {
    throw new Error("Question text is required.");
  }
  const items = listQuestions();
  const qk = normKey(question);
  const existing = items.find((q) => normKey(q.question) === qk);
  if (existing) return existing;
  const now = new Date().toISOString();
  const item = {
    id: nextQuestionId(items),
    question: String(question).trim(),
    answer_type: answer_type || "free_text",
    answer: answer || "",
    notes_evidence: notes_evidence || "",
    source: source || "",
    requirement_id: requirement_id || "",
    key: key || "",
    created_at: now,
    updated_at: now,
  };
  items.push(item);
  saveQuestions(items);
  return item;
}

export function updateQuestion(id, patch) {
  const items = listQuestions();
  const item = items.find((q) => q.id === id);
  if (!item) return null;
  if (patch.question !== undefined) item.question = String(patch.question || "").trim();
  if (patch.answer_type !== undefined) item.answer_type = patch.answer_type || "free_text";
  if (patch.answer !== undefined) item.answer = String(patch.answer || "");
  if (patch.notes_evidence !== undefined) item.notes_evidence = String(patch.notes_evidence || "");
  if (patch.source !== undefined) item.source = String(patch.source || "");
  if (patch.requirement_id !== undefined) item.requirement_id = String(patch.requirement_id || "");
  if (patch.key !== undefined) item.key = String(patch.key || "");
  item.updated_at = new Date().toISOString();
  saveQuestions(items);
  return item;
}

export function deleteQuestion(id) {
  const items = listQuestions().filter((q) => q.id !== id);
  saveQuestions(items);
  return true;
}

/**
 * Reuse a banked question: matches by requirement_id first, then by normalized
 * question text. Returns the first banked item that already carries an answer.
 */
export function findBanked(reqId, questionText, anyState = false) {
  const key = normKey(questionText);
  return (
    listQuestions().find((q) => {
      const matched =
        (reqId && q.requirement_id === reqId) ||
        normKey(q.question) === key ||
        (q.key && normKey(q.key) === key);
      return matched && (anyState || Boolean(q.answer));
    }) || null
  );
}

function answerTypeFor(options, answer) {
  if (options && options.length === 2) return "yes_no";
  if (/^\s*\d/.test(String(answer || ""))) return "number";
  return "free_text";
}

/**
 * Persist a recorded answer into the bank (upsert). Requirement-scoped items are
 * matched by requirement_id so a JD requirement reuses its stored answer on
 * every future application.
 */
export function upsertAnswerFromEvidence({ question, answer, requirement_id, normalized_claim, options, key }) {
  const items = listQuestions();
  const found =
    items.find(
      (q) =>
        (requirement_id && q.requirement_id === requirement_id) ||
        normKey(q.question) === normKey(question) ||
        (key && q.key === key)
    ) || null;
  const answerText = String(answer || "");
  if (found) {
    found.answer = answerText;
    if (normalized_claim) found.notes_evidence = String(normalized_claim);
    found.source = "user_answer";
    found.answer_type = answerTypeFor(options, answerText);
    if (key) found.key = String(key);
    found.updated_at = new Date().toISOString();
  } else {
    items.push({
      id: nextQuestionId(items),
      question: String(question || "").trim(),
      answer_type: answerTypeFor(options, answerText),
      answer: answerText,
      notes_evidence: normalized_claim || "",
      source: "user_answer",
      requirement_id: requirement_id || "",
      key: key || "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  saveQuestions(items);
}