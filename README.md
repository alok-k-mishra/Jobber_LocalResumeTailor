# Jobber 🔥 — Local Resume Tailor

A privacy-first, evidence-based **resume tailoring assistant**. Everything runs
fully locally through [Ollama](https://ollama.com) — no resume, job description,
or generated text ever leaves your machine.

Upload your master resume and a job description, and the app derives the JD's
requirements, matches your real, verifiable experience against them, and rewrites
your resume summary, bullets, and a custom cover letter — while enforcing
anti-hallucination checks so every claim is backed by your actual resume.

## Screenshots

![Resume upload and JD input](https://alok-k-mishra.github.io/assets/1-COPq422c.png)
![Requirement matching](https://alok-k-mishra.github.io/assets/2-B-1MaQzh.png)
![Tailored output](https://alok-k-mishra.github.io/assets/3-LF4bBf0M.png)

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
6. **Learns with every analysis** — completed analyses are stored and
   re-injected into future prompts (in-context learning), so the app's output
   sharpens the more you use it. No model weights are touched.

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

I personally use the following models since I have a GPU with **6 GB VRAM**:

| Variable                  | Model              | Notes |
|---------------------------|--------------------|-------|
| `OLLAMA_EXTRACTION_MODEL` | `qwen3.5:4b`       | Strong extraction, structured facts, and final validation. |
| `OLLAMA_REASONING_MODEL`  | `phi4-mini:3.8b`   | Reasoning, matching, tailoring, cover letters. |
| `OLLAMA_VALIDATION_MODEL` | `qwen3.5:4b`       | Reuses the extraction model. |

If you have a more powerful GPU (larger VRAM), you can pick models with higher
parameter counts for sharper results — but do your research first. In general:

- **Extraction** (`OLLAMA_EXTRACTION_MODEL`) — an instruction-tuned model that
  is good at turning raw text into structured output, e.g. recent **Qwen**
  variants.
- **Reasoning** (`OLLAMA_REASONING_MODEL`) — a model with strong reasoning and
  instruction following for matching and tailoring, e.g. recent **Phi** or
  **Qwen** variants.
- **Validation** (`OLLAMA_VALIDATION_MODEL`) — a capable model for judging
  semantic scope; reusing your extraction model usually works fine.

Check each model's context window, quality benchmarks, and VRAM requirements
(e.g. on [Ollama's library](https://ollama.com/library)) before pulling something
heavier than your hardware can handle comfortably.

## Setup

### 1. Install and start Ollama

Install Ollama from <https://ollama.com>, then pull the models I use:

```sh
ollama pull qwen3.5:4b
ollama pull phi4-mini:3.8b
```

Want to use something different instead? Just `ollama pull <your-model>` — the
app never pulls models for you; you decide what's installed. The setup wizard
(see below) then lists exactly the models you have.

### 2. Start the app

**Option A — one-click launcher (recommended).** Run the launcher for your OS:

| Platform             | Command                          |
|----------------------|----------------------------------|
| Linux / WSL          | `./start.sh`                     |
| macOS                | `./start-macos.sh`               |
| Windows (PowerShell) | `.\start.ps1`                    |

It prints the banner and a menu:

- `R` — restart the server
- `O` — open the app in your browser
- `L` — show recent server logs
- `I` — (re)install dependencies
- `Q` — stop the server and quit

**Option B — plain install & run:**

```sh
npm install
npm start        # http://localhost:5173
npm run dev      # watch mode (restarts on changes)
```

### First-run setup wizard

If the app finds no `.env`, it boots into **first-run setup mode** and serves a
wizard instead of the UI (the launcher opens it in your browser automatically):

1. **Ollama URL** — enter your Ollama address (default
   `http://localhost:11434`; the wizard tests the connection and shows Ollama's
   version). In WSL, Ollama usually runs on the Windows host at the default
   gateway IP — find it with `ip route | grep default` (Linux/WSL) or `ipconfig`
   (Windows).
2. **Models** — pick one installed model per role (extraction, reasoning,
   validation). The list comes live from your Ollama; nothing is auto-selected.
3. **Finish** — choose the port and save. The `.env` is written and the app
   **restarts automatically** after a 3-second countdown with the new settings.

To reconfigure later, delete `.env` and restart the app — the wizard runs again.

### Manual configuration (optional)

Instead of the wizard you can write `.env` yourself — copy the example and
adjust:

```sh
cp .env.example .env
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
| GET    | `/api/setup/status` | First-run wizard state (setup mode, port, recommended models) |
| POST   | `/api/setup/probe` | Test an Ollama URL and report its version / model count |
| POST   | `/api/setup/models` | List models installed on an Ollama URL |
| POST   | `/api/setup/save` | Write `.env` and auto-restart with the new settings |
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
public/            Browser UI (vanilla JS, single page) + first-run setup wizard
scripts/           Smoke tests, unit tests, fixture generator
data/sessions/     Local JSON persistence (gitignored)
start.sh           One-click launcher (Linux / WSL)
start-macos.sh     One-click launcher (macOS)
start.ps1          One-click launcher (Windows / PowerShell)
```