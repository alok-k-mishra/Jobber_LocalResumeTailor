import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function sessionPath(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid session id.");
  return path.join(config.dataDir, `${id}.json`);
}

export function newSessionId() {
  return crypto.randomUUID();
}

export function createSession(name = "") {
  const now = new Date().toISOString();
  return {
    id: newSessionId(),
    name: String(name || ""),
    created_at: now,
    updated_at: now,
    resume: { filename: "", raw_text: "", extraction: null },
    truth_db: [],
    job_description: "",
    job_url: "",
    jd: null,
    matches: [],
    questions: [],
    answers: [],
    recommendations: [],
    cover_letter: null,
    audit: null,
    stage: "created",
  };
}

export function saveSession(session) {
  ensureDir();
  session.updated_at = new Date().toISOString();
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
  return session;
}

export function getSession(id) {
  try {
    const raw = fs.readFileSync(sessionPath(id), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function deleteSession(id) {
  try {
    fs.unlinkSync(sessionPath(id));
    return true;
  } catch {
    return false;
  }
}

export function listSessions() {
  ensureDir();
  return fs
    .readdirSync(config.dataDir)
    .filter(
      (f) =>
        f.endsWith(".json") &&
        f !== "resume-memory.json" &&
        f !== "questions-bank.json" &&
        f !== "learning-store.json"
    )
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(config.dataDir, f), "utf8"));
        return {
          id: s.id,
          name: s.name || "",
          created_at: s.created_at,
          updated_at: s.updated_at,
          stage: s.stage,
          process: s.process || null,
          resume: s.resume?.filename || "",
          job_title: s.jd?.job_title || "",
          company: s.jd?.company || "",
          job_url: s.job_url || "",
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}
