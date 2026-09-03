// One-off transform: term_fetus.json -> fetus_<ga>wk.json (fetus in utero at a given gestation).
// Re-runnable. Applies allometric size scaling + the gestation-graded fetal levers; steady-state
// re-seeding is done afterwards by reseed_fetus.mjs (which warms the model and bakes the
// equilibrium gas/volume seeds).
//
//   node scripts/_make_fetus.mjs 30
//
// The SOURCE is term_fetus.json, not term_neonate.json: it already carries the whole fetal
// transform (placental gas exchange, wide-open ductus arteriosus and foramen ovale, x21 pulmonary
// vascular resistance, inert fluid-filled lungs, HbF affinity) AND its own fetal diagram_definition.
// Starting from the neonate would mean re-applying all of that and hand-copying the diagram.
//
// Prematurity-of-gestation here is SIZE + the circulatory operating point. There is no RDS lung
// phenotype (the fetal lung is fluid-filled and inert at every gestation — GASEX dif_o2/dif_co2 are
// already 0) and no ventilatory drive (Breathing is disabled), so the preterm-neonate levers for
// those do not apply. The ductus stays wide open (diameter_relative 1.0) at every fetal gestation.
//
// The per-GA lever table lives in scripts/_ga_tables.mjs (shared with build_patient.mjs so it is
// not duplicated the way PRETERM_SEED currently is). Its values are starting points: final numbers
// come from iterating this script + reseed_fetus.mjs + probe_fetus.mjs against the fetal targets.
//
// Targets (probe_fetus.mjs): the oxygenation ordering UV > IVC > AA > AD > UA must hold; placental
// share of combined ventricular output is higher and pulmonary share lower than at term; MAP tracks
// gestation (much lower than the term fetus's ~51 mmHg).
import fs from "node:fs";
import { createEngine } from "./_harness.mjs";
import { serializeState } from "./_serialize_state.mjs";
import { FETAL, FETAL_GAS } from "./_ga_tables.mjs";

const ga = Number(process.argv[2]);
const cfg = FETAL[ga];
if (!cfg) {
  console.error(`unknown gestational age "${process.argv[2]}"; use one of ${FETAL_GAS.join(", ")}`);
  process.exit(1);
}

const src = new URL("../model_definitions/term_fetus.json", import.meta.url);
const dst = new URL(`../model_definitions/fetus_${ga}wk.json`, import.meta.url);
const j = JSON.parse(fs.readFileSync(src, "utf8"));

const eng = await createEngine();
// build the term-fetus baseline. build() freezes model._baseline_weight = model.weight = 3.545,
// which is the allometric denominator scale_to_weight needs.
const model = eng.build(j.model_definition);
if (!model || !model.models) {
  console.error("build failed for the term_fetus baseline.");
  process.exit(1);
}
const M = model.models;
const TERM_W = 3.545; // term_fetus baseline weight (== model._baseline_weight before serialization)
const log = [];

// A. allometric volume scaling to the fetal weight. MUST COME FIRST: ModelScaler._apply() sets the
// *_factor_scaling_ps layer ABSOLUTELY and weight_scale re-runs the five volume groups, so any
// SVR/PVR scaling applied before this would be clobbered. scale_to_weight takes absolute kg and
// sets model.weight; it moves VOLUMES ONLY (its el/res inverse-allometry is commented out), which
// is exactly why the svr/pvr levers below exist.
eng.scale("weight_scale", cfg.weight);
const volFactor = cfg.weight / TERM_W;
log.push(`size: weight ${TERM_W} -> ${cfg.weight} kg (vol x${volFactor.toFixed(3)}); per-kg models (VO2, drugs) auto-scale`);

// A2. the placenta is INVISIBLE to scale_to_weight — no PL_* compartment appears anywhere in
// scaler_config, so the step above shrank the body and left the placenta at term size. Unfixed, a
// 30 wk fetus carries 164 mL/kg of fetoplacental blood (term: 112) with the placenta holding 52% of
// fetal blood instead of 29%. Scale it explicitly, by a LARGER factor than the body: the
// placenta:fetus mass ratio falls with gestation (~0.20 at 30 wk vs ~0.14 at term).
// Applied after weight_scale so it reads as a deliberate, differently-sized second pass.
const FETAL_PL = ["PL_UMB_ART", "PL_FETAL_ART", "PL_FETAL_CAP", "PL_FETAL_VEN", "PL_UMB_VEN"];
if (cfg.pl_vol !== 1.0) {
  for (const n of FETAL_PL) {
    const c = M[n];
    if (!c) continue;
    if (typeof c.vol === "number") c.vol *= cfg.pl_vol;
    if (typeof c.u_vol === "number") c.u_vol *= cfg.pl_vol;
  }
}
if (cfg.mat_vol !== 1.0 && M.PL_MAT) {
  M.PL_MAT.vol *= cfg.mat_vol;
  M.PL_MAT.u_vol *= cfg.mat_vol;
}
log.push(`Placental volume: fetal PL_* x${cfg.pl_vol}, maternal PL_MAT x${cfg.mat_vol} (outside every scaler group)`);

// B. resistance compensation. Volumes scaled but resistances did not, so the smaller fetus runs
// hypotensive; raise SVR to restore the operating pressure. PVR is raised on top of the baseline's
// baked x21 (that x21 lives in the compartments' raw r_for/r_back; this writes the separate
// r_factor_scaling_ps layer, and the two compose multiplicatively) because fetal pulmonary vascular
// resistance falls steeply through the third trimester. Applied BEFORE anything that equilibrates
// against pulmonary pressure, i.e. before the duct and foramen settle.
// No incorporate() — it throws on the shipped scenarios (scaler_config.lung has only a volume list)
// and is unnecessary: r_factor_scaling_ps serializes into the JSON and is re-applied every step.
if (cfg.svr !== 1.0) {
  eng.scale("systemic_resistances", cfg.svr);
  log.push(`SVR: systemic resistances x${cfg.svr} (restore operating MAP after volume-only scaling)`);
}
if (cfg.pvr !== 1.0) {
  eng.scale("pulmonary_resistances", cfg.pvr);
  log.push(`PVR: pulmonary resistances x${cfg.pvr} on top of the baseline's baked PVR factor (higher PVR earlier in gestation)`);
}

// C. placental circulation. The bed is smaller earlier AND takes a larger share of combined output;
// resistances do not auto-scale with weight, so umbilical/fetal-placental resistance and the
// diffusion constants are set explicitly. mat_to2/mat_tco2 are left at the baseline values — the
// maternal pool is taken as gestation-independent.
const PL = M.Placenta;
PL.umb_art_res = cfg.umb_art_res;
PL.umb_ven_res = cfg.umb_ven_res;
PL.plf_res = cfg.plf_res;
PL.dif_o2 = cfg.dif_o2;
PL.dif_co2 = cfg.dif_co2;
log.push(`Placenta: umb_art_res=${PL.umb_art_res} umb_ven_res=${PL.umb_ven_res} plf_res=${PL.plf_res} dif_o2=${PL.dif_o2} dif_co2=${PL.dif_co2} (mat_to2=${PL.mat_to2} mat_tco2=${PL.mat_tco2} unchanged)`);

// D. shunt anatomy. These are ABSOLUTE millimetres that no scaler group touches, so without this
// the fetus keeps a term-sized duct and foramen in a 1.35 kg body.
//   - the foramen scales with atrial size (a linear dimension ~ weight^(1/3)); atrial_septal_width
//     is the LENGTH term in its Poiseuille law, so leaving it at term thickness would make the
//     foramen artificially restrictive.
//   - the duct is anchored to the Szpinda regressions quoted in Pda.js:25-26.
//   - diameter_relative is a [0..1] PATENCY fraction, not a size: it stays 1.0 at every fetal
//     gestation (the duct is fully relaxed in utero). The size lever is diameter_*_max. Asserted
//     rather than multiplied, because conflating the two is the easy bug here.
M.Shunts.diameter_fo = cfg.fo;
M.Shunts.atrial_septal_width = cfg.fo_septum;
M.Pda.diameter_ao_max = cfg.da_diam;
M.Pda.diameter_pa_max = cfg.da_diam;
M.Pda.length = cfg.da_len;
M.Pda.diameter_relative = 1.0;
log.push(`Shunts: diameter_fo ${cfg.fo} mm, atrial_septal_width ${cfg.fo_septum} mm (ips_res ${M.Shunts.ips_res} kept — intrapulmonary shunts stay closed)`);
log.push(`Pda: diameter_ao/pa_max ${cfg.da_diam} mm, length ${cfg.da_len} mm, diameter_relative 1.0 (wide open)`);

// E. fetal haemoglobin: the HbF fraction is higher earlier in gestation, left-shifting the
// dissociation curve further, and total Hb rises through gestation.
//
// PL_MAT holds MATERNAL blood and must be excluded from both changes. Blood.set_P50 and
// Blood.set_solute propagate to every registered blood component INCLUDING PL_MAT, but the
// maternal pool's O2 content is pinned by Placenta.mat_to2 (rewritten every step) — so lowering
// its haemoglobin below the capacity that content implies drives the pool to 100% saturation with
// a wildly unphysiological dissolved PO2, which then propagates into the umbilical vein. The
// baseline already restores PL_MAT.P50_0 for the same reason; haemoglobin needs the same care.
const matHb = M.PL_MAT?.solutes?.hemoglobin;
M.Blood.P50_0 = cfg.p50;
if (M.Blood.set_P50) M.Blood.set_P50(cfg.p50);
if (cfg.hb != null) M.Blood.set_solute("hemoglobin", cfg.hb);
if (M.PL_MAT) {
  M.PL_MAT.P50_0 = 20.0;                                  // maternal pool keeps adult affinity
  if (matHb != null) M.PL_MAT.solutes.hemoglobin = matHb;  // ... and maternal haemoglobin
}
log.push(`Blood: P50_0 ${cfg.p50} (HbF)${cfg.hb != null ? `, hemoglobin ${cfg.hb} mmol/L` : ""}; PL_MAT kept maternal (P50_0 20.0, hb ${matHb})`);

// F. heart rate + the MAP the baroreflex defends. If br_map does not track the fetus's actual
// operating pressure the ANS drives permanent reflex tachycardia and vasoconstriction.
M.Heart.heart_rate_ref = cfg.hr_ref;
if (M.BR_MAP) M.BR_MAP.set_value = cfg.br_map; // flattened onto model.models at build (nesting is JSON-only)
log.push(`Heart: heart_rate_ref -> ${cfg.hr_ref}; Ans BR_MAP set_value -> ${cfg.br_map}`);

// G. immature myocardium (weaker systole, stiffer/slower diastolic relaxation) and venous preload.
// Uniform volume scaling preserves the stressed fraction but leaves CVP near zero, so trim the
// large systemic veins' unstressed volume to restore filling.
// cont_right > cont_left is what makes the fetus RV-dominant. The right atrium divides its blood
// between the tricuspid valve and an effectively unrestrictive foramen, so the split follows
// whichever ventricle ejects better — not the foramen's size (which is inert between 3 and 6 mm).
// rv_uvol separately restores a physiological RV ejection fraction; it does not move the split.
// Both compensate for a NEONATAL chamber parameterisation the fetal transform inherits unchanged
// (RV u_vol 5.46x the LV's, lower el_max) — see the column notes in _ga_tables.mjs.
const H = M.Heart;
H.cont_factor_left = cfg.cont_left; H.cont_factor_right = cfg.cont_right;
H.relax_factor_left = cfg.relax; H.relax_factor_right = cfg.relax;
// RV.u_vol is set as a RATIO of LV.u_vol, not as a multiplier: this scenario is generated from
// term_fetus, which already carries the trim, so a multiplier would apply it twice.
if (cfg.rv_uvol_ratio != null && M.RV && M.LV) M.RV.u_vol = M.LV.u_vol * cfg.rv_uvol_ratio;
for (const n of ["VLB", "VUB"]) { const c = M[n]; if (c) c.u_vol *= cfg.ven_uvol; }
log.push(`Cardiac: cont_factor L/R ${cfg.cont_left}/${cfg.cont_right} (R>L => RV-dominant), relax_factor ${cfg.relax}`);
log.push(`Preload: RV u_vol = ${cfg.rv_uvol_ratio}x LV u_vol = ${(M.RV.u_vol*1000).toFixed(3)} mL (restore RV ejection fraction); VLB/VUB u_vol x${cfg.ven_uvol}`);

// H. fetal invariants. These are the properties that silently destroy the fetal circulation while
// still building and still printing a plausible-looking panel, so fail loudly instead. (Probes exit
// 0 on bad physiology, so this assertion block is the only real gate in the pipeline.)
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
if (bad.length) {
  console.log = eng.log;
  console.error("fetal invariants violated:\n  " + bad.join("\n  "));
  process.exit(1);
}

// I. engine-level metadata. build() re-derives _baseline_weight = weight on reload, so the
// allometric baseline re-anchors to this fetus's size for any in-app scaling.
model.weight = cfg.weight;
model.height = cfg.height;
model.gestational_age = ga;
model.age = 0;

const name = `fetus_${ga}wk`;
const description =
  `fetus in utero at ${ga} weeks gestation (${cfg.weight} kg) — fetal circulation: placental gas ` +
  `exchange, wide-open ductus arteriosus and foramen ovale, high pulmonary vascular resistance, ` +
  `inert (fluid-filled) lungs; allometric size scaling from the term fetus`;
j.name = name;
j.description = description;
j.user = "timothy";
j.provenance = "calibrator-fitted";
// honest about the actual pipeline: the inherited note credits build_patient.mjs, which is not what
// produced this file.
j.provenance_note =
  "anatomy inherited from term_fetus (scripts/_make_term_fetus.mjs); gestational-age levers in " +
  "scripts/_ga_tables.mjs applied by scripts/_make_fetus.mjs, fitted to fetal targets with " +
  "scripts/probe_fetus.mjs and baked to steady state by scripts/reseed_fetus.mjs";
model.name = name;
model.description = description;

serializeState(model);
j.model_definition = model;
const out = JSON.stringify(j, null, 1) + "\n";
JSON.parse(out); // fail loudly before writing if anything is non-serializable
fs.writeFileSync(dst, out);

console.log = eng.log;
console.log("wrote", dst.pathname);
console.log(log.join("\n"));
