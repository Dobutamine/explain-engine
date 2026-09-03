// Re-seed a fetal scenario to its calibrated steady state (same approach as reseed_term_fetus.mjs,
// generalised over gestational age).
//
// All fetal calibration already lives in the scenario JSON (written by scripts/_make_fetus.mjs), so
// this script just warms the model to steady state and serializes it back into model_definition the
// way the app's save-state does — baking the equilibrium gas/volume seeds and clearing startup
// transients so the file loads at its operating point.
//
//   node scripts/reseed_fetus.mjs 30 [--seconds 250] [--write]
//   node scripts/reseed_fetus.mjs term            # the 40 wk term_fetus scenario
//
// Default is a DRY RUN to /tmp/<stem>_reseed.json; --write is what mutates model_definitions/.
// The 250 s default warm-up is longer than the preterm reseeds use on purpose: the placental
// circuit is a large, slow compartment.
import fs from "node:fs";
import { createEngine } from "./_harness.mjs";
import { serializeState } from "./_serialize_state.mjs";
import { FETAL, FETAL_GAS } from "./_ga_tables.mjs";

const argv = process.argv.slice(2);
const ga = argv[0] && !argv[0].startsWith("-") ? argv[0] : "";
const SECONDS = (() => { const i = argv.indexOf("--seconds"); return i >= 0 ? Number(argv[i + 1]) : 250; })();
const WRITE = argv.includes("--write");

// `term` resolves to the legacy term_fetus stem so there is one reseed entry point for the whole
// fetal family and a future retune of term_fetus uses this same code path.
const stem = ga === "term" || ga === "40" ? "term_fetus" : `fetus_${ga}wk`;
if (!ga || (stem !== "term_fetus" && !FETAL[Number(ga)])) {
  console.error(`usage: node scripts/reseed_fetus.mjs <ga> [--seconds N] [--write]`);
  console.error(`  <ga> is one of ${FETAL_GAS.join(", ")}, or "term" for term_fetus`);
  process.exit(1);
}

const file = new URL(`../model_definitions/${stem}.json`, import.meta.url);
let json;
try {
  json = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  console.error(`cannot read ${stem}.json —`, String(e));
  process.exit(1);
}

const eng = await createEngine();
const model = eng.build(json.model_definition);
if (!model || !model.models) {
  console.error(`build failed for "${stem}".`);
  process.exit(1);
}
const M = model.models;

// warm to steady state — no deltas, the calibration is already baked into the JSON
eng.calc(SECONDS);

// Re-check the fetal invariants AFTER the warm-up, before writing. Probes exit 0 on bad physiology,
// so a reseed that silently bakes a collapsed circulation would otherwise ship unnoticed.
const bad = [];
if (M.Placenta.placenta_running !== true) bad.push("Placenta.placenta_running is not true");
if (M.Placenta.umb_clamped !== false) bad.push("Placenta.umb_clamped is not false");
if (!(M.Shunts.ips_res >= 1e7)) bad.push(`Shunts.ips_res ${M.Shunts.ips_res} — intrapulmonary shunts reopened`);
if (M.Pda.diameter_relative !== 1.0) bad.push(`Pda.diameter_relative ${M.Pda.diameter_relative} — fetal duct must be wide open`);
if (M.Breathing.is_enabled !== false || M.Breathing.breathing_enabled !== false) bad.push("Breathing is enabled");
for (const n of ["GASEX_LL", "GASEX_RL"]) {
  const g = M[n];
  if (g && (g.dif_o2 !== 0 || g.dif_co2 !== 0)) bad.push(`${n} is exchanging gas — the fetal lung must be inert`);
}

// A self-diagnosing summary so a dry run is readable on its own. Snapshot the numbers BEFORE
// serializeState — it re-nests the PL_*/pulmonary compartments under their owner model and removes
// them from model.models, so reading them afterwards silently yields 0.
const Mon = M.Monitor;
const cvo = (Mon.flows?.lvo ?? 0) + (Mon.flows?.rvo ?? 0);
const share = (q) => (cvo ? Math.abs((q ?? 0) * 60 / cvo) * 100 : 0);
const r = (x, n = 1) => Number((x ?? 0).toFixed(n));
const summary = {
  map: Mon.minmax?.abp_pre_pres_mean, pap: Mon.minmax?.pap_pres_mean, hr: Mon.heart_rate,
  cvoKg: cvo * 1000 / model.weight,
  plac: share(M.PL_UMB_ART?.flow),
  pulm: share((M.PAAL_LL_ART?.flow ?? 0) + (M.PAAR_RL_ART?.flow ?? 0)),
};

serializeState(model);
json.model_definition = model;
const out = JSON.stringify(json, null, 1) + "\n";
JSON.parse(out);

console.log = eng.log;
console.log(`reseed ${stem}: ${Object.keys(model.models).length} top-level models, warmup ${SECONDS}s, output ${out.length} bytes`);
console.log(`  MAP ${r(summary.map)} mmHg, PAP ${r(summary.pap)} mmHg, HR ${r(summary.hr)} bpm`);
console.log(`  CVO ${r(summary.cvoKg, 0)} mL/kg/min; placental ${r(summary.plac, 0)}%, pulmonary ${r(summary.pulm, 0)}%`);

if (bad.length) {
  console.error("\nfetal invariants violated after warm-up — NOT writing:\n  " + bad.join("\n  "));
  process.exit(1);
}
if (WRITE) { fs.writeFileSync(file, out); console.log("WROTE", file.pathname); }
else {
  const tmp = `/tmp/${stem}_reseed.json`;
  fs.writeFileSync(tmp, out);
  console.log(`dry run -> ${tmp} (pass --write to commit)`);
}
