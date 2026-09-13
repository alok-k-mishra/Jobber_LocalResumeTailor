# Jobber 🔥 — Local Resume Tailor

A privacy-first, evidence-based **resume tailoring assistant**. Everything runs
fully locally through [Ollama](https://ollama.com) — no resume, job description,
or generated text ever leaves your machine.

Upload your master resume and a job description, and the app derives the JD's
requirements, matches your real, verifiable experience against them, and rewrites
your resume summary, bullets, and a custom cover letter — while enforcing
anti-hallucination checks so every claim is backed by your actual resume.

## What it does

1. **Resume Memory** — upload your master resume (PDF/DOCX/TXT) once. Qwen parses
   it into structured, editable data (summary, experience, projects, education,
   skills, metrics...). Re-uploading a newer version shows a diff and lets you
   refresh only the changed facts. You can edit this data directly in the UI.
2. **Job description analysis** — drop in a JD; Qwen breaks it into atomic
   requirements with importance and category.
3. **Evidence matching** — Phi-4-mini judges each requirement against a
   deterministic shortlist of your Resume Memory evidence, producing strength
   ratings and gaps.
4. **Personal & behavioural questions** — the JD's own questions become
   Yes/No confirmations. Answers are stored in Resume Memory and reused across
   applications, so you only confirm genuinely new conditions.
5. **Tailoring** — Phi-4-mini rewrites your summary and resume bullets
   (Markdown, one-page friendly) and generates a custom cover letter. Every
   generated claim is validated against your real evidence (see Truthfulness).

## Pipeline

| Stage | Model | Purpose |
|-------|-------|---------|
| Resume extraction | Qwen 3.5 (`extraction`) | Lines -> structured facts -> Resume Memory |
| JD analysis | Qwen 3.5 (`extraction`) | JD -> atomic requirements |
| Matching | Phi-4-mini (`reasoning`) | Requirement -> evidence strength/gaps |
| Questions | Qwen 3.5 (`extraction`) | JD-specific Yes/No confirmations |
| Tailoring + cover letter | Phi-4-mini (`reasoning`) | Rewritten bullets + cover letter |
| Final claim validation | Qwen 3.5 (`validation`) | Semantic scope check (only when deterministic checks pass) |

## Truthfulness

Anti-hallucination is enforced in layers and never relies on a single model:

- **Evidence binding** — every generated claim must cite existing
  `VERIFIED`/`USER_CONFIRMED` evidence IDs; unknown IDs are dropped.
- **Deterministic factual validation** (`server/core/claims.js`) — code-based
  checks for dates/years, metrics/numbers, technologies, companies, job titles,
  project names, and unsupported seniority wording. These run on every audit; if
  code proves a violation, the content fails closed **without** a model call.
- **Final claim validation** (Qwen) — only runs when the deterministic checks find
  no hard violation; judges semantic scope/context.
- **Retry** — a failing audit feeds violations back into the Phi-4 generation
  pass exactly once.

## Requirements

- **Node.js >= 20**
- **Ollama** installed and running with at least one LLM model

## Models

The app is model-agnostic — you can use **any Ollama models** you want. The env
vars `OLLAMA_EXTRACTION_MODEL`, `OLLAMA_REASONING_MODEL`, and
`OLLAMA_VALIDATION_MODEL` are completely configurable; if the exact tag is not
installed, the app auto-resolves to a close installed tag and reports the change
in the UI with a `*`.

**Recommended combo** (what I personally use and test with):

| Variable                  | Model              | Notes |
|---------------------------|--------------------|-------|
| `OLLAMA_EXTRACTION_MODEL` | `qwen3.5:4b`       | Strong extraction, structured facts, and final validation. |
| `OLLAMA_REASONING_MODEL`  | `phi4-mini:3.8b`   | Reasoning, matching, tailoring, cover letters. |
| `OLLAMA_VALIDATION_MODEL` | `qwen3.5:4b`       | Reuses the extraction model. |

If those exact tags aren't available, any recent Qwen or Phi variant works —
e.g. `qwen3:4b` or `phi4-mini:3.8b`. Heavier tags (larger parameter count)
generally give sharper results on slower hardware.

## Setup

### 1. Install and start Ollama

Install Ollama from <https://ollama.com>, then pull the recommended models:

```sh
ollama pull qwen3.5:4b
ollama pull phi4-mini:3.8b
```

Want to use something different instead? Just `ollama pull <your-model>` and set
the matching env vars — no code changes needed.

### 2. Configure the environment

Copy the example env file and adjust:

```sh
cp .env.example .env
```

### 3. Install & run

```sh
npm install
npm start        # http://localhost:5173
npm run dev      # watch mode (restarts on changes)
```

## Environment variables

All variables are optional (built-in defaults shown). Copy `.env.example` to
`.env` and adjust only what you need.

| Variable                    | Default                | Description |
|-----------------------------|------------------------|-------------|
| `OLLAMA_BASE_URL`           | `http://localhost:11434` | Base URL of your local Ollama server. In WSL this is usually the default gateway IP (see `ip route \| grep default`). The app also auto-detects localhost, `127.0.0.1`, the WSL gateway, and `host.docker.internal`. |
| `OLLAMA_EXTRACTION_MODEL`   | `qwen3.5:4b`           | Model for resume/JD/answer extraction and structured facts. |
| `OLLAMA_REASONING_MODEL`    | `phi4-mini:3.8b`       | Model for requirement analysis, matching, tailoring, and cover letter generation. |
| `OLLAMA_VALIDATION_MODEL`   | `qwen3.5:4b`           | Model for the final claim-validation pass. |
| `PORT`                      | `5173`                 | HTTP port for the web UI/API. |
| `DATA_DIR`                  | `./data/sessions`      | Where session JSON is persisted (local only). |
| `MAX_UPLOAD_MB`             | `15`                   | Max resume/JD upload size in megabytes. |
| `OLLAMA_TIMEOUT_MS`         | `300000`               | LLM request timeout in milliseconds. |
| `ALLOW_CLOUD`               | `false`                | Never enables cloud fallback; kept for safety. Leave false. |
| `LEARNING_ENABLED`          | `true`                 | In-context learning: completed analyses are re-injected into future prompts so results sharpen per application. No model weights are touched. |

## Tests

```sh
npm test         # deterministic factual validation (no LLM, fast)
npm run smoke    # full end-to-end pipeline against scripts/fixtures
```

`npm run smoke` prints per-stage timing and the resolved models.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/status` | Ollama status and model routing |
| POST   | `/api/sessions` | Create an application (session) |
| PATCH  | `/api/sessions/:id` | Rename an application / set its JD text |
| DELETE | `/api/sessions/:id` | Delete an application |
| GET    | `/api/resume-memory` | Read Resume Memory (structured + facts) |
| POST   | `/api/resume-memory/upload` | Parse a resume; compare with stored version (diff) |
| POST   | `/api/resume-memory/save` | Create Resume Memory from parsed facts |
| POST   | `/api/resume-memory/apply` | Apply selected section diffs to Resume Memory |
| POST   | `/api/resume-memory/edit` | Save structured edits back to Resume Memory |
| DELETE | `/api/resume-memory` | Delete Resume Memory |
| POST   | `/api/sessions/:id/jd` | Analyze a job description |
| POST   | `/api/sessions/:id/match` | Match evidence to requirements |
| POST   | `/api/sessions/:id/questions` | Extract personal/behavioural questions from the JD |
| POST   | `/api/sessions/:id/answers` | Record an answer (stored in Resume Memory too) |
| POST   | `/api/sessions/:id/tailor` | Recommendations + cover letter + internal validation |
| GET    | `/api/sessions/:id/evidence` | Inspect the Truth Database |

## Project structure

```
server/            Express API, pipeline stages, LLM client
  prompts/         Prompt templates used by the local models
  pipeline/        Stage orchestrators (resume, jd, matching, questions, tailor, audit, ...)
  core/            Deterministic logic: claims validation, truth DB, retrieval, learning
public/            Browser UI (vanilla JS, single page)
scripts/           Smoke tests, unit tests, fixture generator
data/sessions/     Local JSON persistence (gitignored)
```