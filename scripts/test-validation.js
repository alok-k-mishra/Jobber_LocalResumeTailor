import assert from "node:assert/strict";
import {
  deterministicClaimValidation,
  stripUnsupportedClaims,
} from "../server/core/claims.js";

const evidence = [
  {
    evidence_id: "RESUME-EXP-001",
    original_text: "Cleaned and formatted monthly sales data in Excel for reporting.",
    normalized_claim: "Candidate cleaned and formatted monthly sales data in Excel for reporting.",
    technologies: ["Excel"],
    entity: "Acme Analytics",
  },
  {
    evidence_id: "RESUME-PROJ-001",
    original_text: "Built an admin panel using React for a browser game.",
    normalized_claim: "Candidate built an admin panel using React for a browser game.",
    technologies: ["React"],
    entity: "Vedic Wars",
  },
];

function validate(text, opts = {}) {
  return deterministicClaimValidation(text, evidence, opts);
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("deterministicClaimValidation");

check("supported content produces no hard failures", () => {
  const r = validate("I cleaned and formatted monthly sales data in Excel.");
  assert.equal(r.hardFailures.length, 0, JSON.stringify(r.hardFailures));
});

check("unsupported year is a hard failure", () => {
  const r = validate("I have been working in data since 2019.");
  assert.ok(r.hardFailures.some((w) => w.type === "UNSUPPORTED_DATE"));
});

check("unsupported metric is a hard failure", () => {
  const r = validate("I reduced reporting costs by 45%.");
  assert.ok(r.hardFailures.some((w) => w.type === "UNSUPPORTED_METRIC"));
});

check("invented company is a hard failure", () => {
  const r = validate("I worked at Globex Corporation on reporting.");
  assert.ok(r.hardFailures.some((w) => w.type === "NOVEL_TERM"));
});

check("injected technology from the JD is a hard failure", () => {
  const r = validate("I built dashboards with Kubernetes.", {
    sensitiveVocab: new Set(["Kubernetes"]),
  });
  assert.ok(r.hardFailures.some((w) => w.type === "NOVEL_TERM"));
});

check("target company/title named in the JD is allowed", () => {
  const r = validate("I am applying to Globex for the Data Analyst role.", {
    allowedTerms: ["Globex", "Data Analyst"],
  });
  assert.equal(r.hardFailures.length, 0, JSON.stringify(r.hardFailures));
});

check("unsupported seniority wording is a soft warning, not a hard failure", () => {
  const r = validate("I led the reporting team.");
  assert.equal(r.hardFailures.length, 0, JSON.stringify(r.hardFailures));
  assert.ok(r.softWarnings.some((w) => w.type === "POSSIBLE_EXAGGERATION"));
});

check("evidence facts are preserved as supported", () => {
  const r = validate("Candidate built an admin panel using React for a browser game.");
  assert.equal(r.hardFailures.length, 0, JSON.stringify(r.hardFailures));
  assert.equal(r.items.length, 0, JSON.stringify(r.items));
});

// stripUnsupportedClaims

const letterEvidence = [
  { evidence_id: "E1", original_text: "Cleaned monthly sales data in Excel.", normalized_claim: "Candidate cleaned monthly sales data in Excel.", technologies: ["Excel", "Tableau"] },
];

function strip(text, sensitiveVocab) {
  return stripUnsupportedClaims(text, letterEvidence, { sensitiveVocab });
}

check("injected JD term in a clause is removed from the letter", () => {
  const r = strip(
    "I am proficient with Excel, including PivotTables, and have used Tableau to visualize data.",
    new Set(["PivotTables"])
  );
  assert.ok(r.removed.length > 0, JSON.stringify(r.removed));
  assert.equal(r.removed[0].term, "PivotTables");
  assert.ok(!r.text.includes("PivotTables"), r.text);
  assert.ok(r.text.includes("Tableau"), "legitimate sentence content must survive");
  assert.equal(r.remainingHardFailures.length, 0, JSON.stringify(r.remainingHardFailures));
});

check("fully supported letter is left untouched", () => {
  const r = strip("I cleaned monthly sales data in Excel.", new Set(["PivotTables"]));
  assert.equal(r.removed.length, 0);
  assert.equal(r.text, "I cleaned monthly sales data in Excel.");
  assert.equal(r.remainingHardFailures.length, 0);
});

check("unsupported metric term is removed (sentence dropped, rest kept)", () => {
  const r = strip(
    "I cleaned monthly sales data in Excel. I increased reporting by 45%.",
    new Set([])
  );
  const bad = r.removed.find((x) => x.type === "UNSUPPORTED_METRIC");
  assert.ok(bad, JSON.stringify(r.removed));
  assert.ok(!r.text.includes("45%"), r.text);
  assert.ok(r.text.includes("monthly sales data"), r.text);
});

check("enforcement refuses to empty a single-sentence letter", () => {
  const r = strip("I increased reporting by 45%.", new Set([]));
  assert.equal(r.removed.length, 0);
  assert.ok(r.remainingHardFailures.some((w) => w.type === "UNSUPPORTED_METRIC"));
});

check("soft warnings never drive removal", () => {
  const r = strip("I led monthly reporting in Excel.", new Set(["PivotTables"]));
  assert.equal(r.removed.length, 0);
  assert.ok(r.softWarnings.some((w) => w.type === "POSSIBLE_EXAGGERATION"), JSON.stringify(r.softWarnings));
});

console.log(`\n${passed} checks passed.`);
