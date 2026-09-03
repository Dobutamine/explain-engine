// Generic calibrated-patient builder for the Explain engine.
//
// Given a SPEC (a baseline scenario + a set of TARGET physiological values), this
// builds the baseline headless, applies a structural pass (size / pathophysiology /
// fixed solutes), then runs a closed-loop calibration: warm to steady state ->
// measure the monitor vitals + ABG -> nudge one lever per off-target vital ->
// repeat until every target is within tolerance or max_iters is reached. It then
// bakes the equilibrium state and prints the full, runnable scenario JSON to
// STDOUT (the convergence trace + final probe go to STDERR).
//
// This is the engine the Explain bot drives to turn "build me a 1.2 kg 28-week
// preterm, MAP 33, SpO2 90, pCO2 52" into a definition the app loads immediately.
//
// Usage:
//   node scripts/build_patient.mjs --spec spec.json          (spec from a file)
//   echo '{...}' | node scripts/build_patient.mjs            (spec from stdin)
//   node scripts/build_patient.mjs --spec spec.json --pretty > patient.json
//
// SPEC schema (all fields optional except `baseline`):
//   {
//     "baseline": "term_neonate",          // a name in model_definitions/
//     "fetal": true,                       // force fetal mode (default: auto-detected from the
//                                          //   baseline — see "FETAL MODE" below)
//     "name": "custom_patient",            // output scenario name (metadata)
//     "description": "...",                // output description (auto-generated if absent)
//     "targets": {                          // only listed vitals are calibrated
//       "weight": 1.2, "gestational_age": 28, "height": 0.355, "age": 0,  // structural
//       "hb": 9.5,            // hemoglobin in mmol/L (the model's unit)
//       "hb_gdl": 15.3,       // OR hemoglobin in g/dL — builder converts to mmol/L
//       "temp": 36.8, "pda": 0.4,                                         // structural
//       "hr": 160, "map": 33, "cvp": 4, "pap_m": 28,                      // iterated
//       "spo2": 90, "po2": 55, "pco2": 52, "ph": 7.28, "be": -5, "co": 0.3 // iterated
//     },
//     "pathophysiology": { "rds": "moderate", "pvr_scale": 1.7 },         // named modifiers
//     "tolerance": { "map": 3, "pco2": 4 },                               // per-vital override
//     "profile": "preterm_28",             // normal-range table (else auto from weight/GA)
//     "max_iters": 12, "warm_seconds": 45, "settle_seconds": 90, "final_seconds": 200
//   }
//
// FETAL MODE. A fetal baseline (term_fetus, fetus_<ga>wk) is auto-detected and changes three
// things, because the neonatal levers are actively wrong on a fetus:
//   - the gestational-age seed comes from FETAL, not PRETERM_SEED. The preterm seed would set
//     Shunts.ips_res = 2200 (reopening the intrapulmonary shunts the fetus needs closed at 1e8)
//     and Pda.diameter_relative = 0.36 (constricting a duct that must be wide open). Both
//     silently destroy the fetal circulation while still building and still printing a
//     plausible-looking panel.
//   - the RDS lung phenotype is skipped entirely (the fetal lung is fluid-filled and inert).
//   - PO2/SpO2 and pCO2 are driven from Placenta.mat_to2 / mat_tco2 instead of the alveolar
//     diffusors and the ventilatory drive, both of which are no-ops in a fetus (GASEX dif_* are 0,
//     Breathing is disabled).
// Blood.set_solute / set_P50 reach the MATERNAL pool PL_MAT as well, so fetal mode snapshots and
// restores it after every such write — otherwise the BE/pH controller acidifies the mother and
// shifts the placental gradient under the O2 controller's feet.
//
// Units mirror the monitor/ABG the app shows: pressures mmHg, SpO2/SvO2 %, temp °C,
// pH unitless, pCO2/pO2 mmHg, BE mmol/L, weight kg, height m, CO L/min. Hb is
// mmol/L (the model's unit) — pass `hb` in mmol/L, or `hb_gdl` in g/dL to convert.

import fs from "node:fs";
import { createEngine } from "./_harness.mjs";
import { serializeState } from "./_serialize_state.mjs";
import { measureVitals, selectProfile, RANGES, flagOf, isFetal } from "./_probe.mjs";
import { FETAL, nearestFetalGa } from "./_ga_tables.mjs";
import { makeController, runCalibration } from "../helpers/Calibrator.js";

// ---------------------------------------------------------------------------
// 0. read the SPEC (from --spec <file> or stdin)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const PRETTY = argv.includes("--pretty");
const specIdx = argv.indexOf("--spec");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
const specRaw = specIdx >= 0 ? fs.readFileSync(argv[specIdx + 1], "utf8") : readStdin();
let spec;
try {
  spec = JSON.parse(specRaw || "{}");
} catch (e) {
  console.error("build_patient: SPEC is not valid JSON —", String(e));
  process.exit(1);
}

const baseline = spec.baseline || "term_neonate";
const targets = spec.targets || {};
const patho = spec.pathophysiology || {};
const MAX_ITERS = Number.isFinite(spec.max_iters) ? spec.max_iters : 12;
const WARM = Number.isFinite(spec.warm_seconds) ? spec.warm_seconds : 45;
const SETTLE = Number.isFinite(spec.settle_seconds) ? spec.settle_seconds : 90;
const FINAL = Number.isFinite(spec.final_seconds) ? spec.final_seconds : 200;
const WINDOW = Number.isFinite(spec.window_seconds) ? spec.window_seconds : 12;

// default tolerances per vital (clinician-meaningful bands); overridable via spec.tolerance
const DEFAULT_TOL = { hr: 6, map: 3, cvp: 1.5, pap_m: 3, spo2: 2, po2: 6, pco2: 4, ph: 0.03, be: 1.5, co: 0.05 };
const tolOf = (k) => (spec.tolerance && spec.tolerance[k] != null ? spec.tolerance[k] : DEFAULT_TOL[k]);

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, n = 2) => (typeof x === "number" && isFinite(x) ? Number(x.toFixed(n)) : x);

// the preterm seed table — when a GA is given we start from the matching lever
// bundle so calibration begins near-converged (mirrors scripts/_make_preterm.mjs:43-51).
const PRETERM_SEED = {
  24: { weight: 0.64, height: 0.310, rds_el: 4.0, rds_uvol: 0.36, gasex: 0.32, hr_ref: 151, vt_rr: 0.72, br_map: 24, ips_res: 1900, ven_uvol: 0.78, cont: 0.90, relax: 1.15, pda: 0.40, svr: 1.85, pvr: 3.0 },
  26: { weight: 0.85, height: 0.330, rds_el: 3.5, rds_uvol: 0.42, gasex: 0.38, hr_ref: 153, vt_rr: 0.76, br_map: 26, ips_res: 1600, ven_uvol: 0.80, cont: 0.90, relax: 1.12, pda: 0.42, svr: 1.35, pvr: 1.9 },
  28: { weight: 1.0, height: 0.355, rds_el: 3.0, rds_uvol: 0.50, gasex: 0.45, hr_ref: 152, vt_rr: 0.80, br_map: 28, ips_res: 1900, ven_uvol: 0.82, cont: 0.90, relax: 1.10, pda: 0.45, svr: 1.0, pvr: 1.75 },
  30: { weight: 1.35, height: 0.385, rds_el: 2.5, rds_uvol: 0.58, gasex: 0.55, hr_ref: 151, vt_rr: 0.85, br_map: 31, ips_res: 2200, ven_uvol: 0.84, cont: 0.91, relax: 1.08, pda: 0.36, svr: 1.0, pvr: 1.65 },
  32: { weight: 1.7, height: 0.420, rds_el: 2.0, rds_uvol: 0.65, gasex: 0.65, hr_ref: 150, vt_rr: 0.90, br_map: 35, ips_res: 2500, ven_uvol: 0.85, cont: 0.92, relax: 1.07, pda: 0.28, svr: 1.0, pvr: 1.6 },
  34: { weight: 2.2, height: 0.450, rds_el: 1.4, rds_uvol: 0.80, gasex: 0.80, hr_ref: 148, vt_rr: 0.95, br_map: 41, ips_res: 3400, ven_uvol: 0.88, cont: 0.96, relax: 1.03, pda: 0.22, svr: 1.0, pvr: 1.4 },
  36: { weight: 2.7, height: 0.480, rds_el: 1.2, rds_uvol: 0.88, gasex: 0.90, hr_ref: 145, vt_rr: 0.97, br_map: 45, ips_res: 4200, ven_uvol: 0.93, cont: 0.98, relax: 1.02, pda: 0.15, svr: 1.0, pvr: 1.3 },
};
const nearestGa = (ga) => [24, 26, 28, 30, 32, 34, 36].reduce((a, b) => (Math.abs(b - ga) < Math.abs(a - ga) ? b : a));

// RDS severity -> lung-stiffness / FRC / diffusion bundle (named modifier)
const RDS_BUNDLE = {
  mild: { rds_el: 1.4, rds_uvol: 0.85, gasex: 0.85, ips_res: 3800 },
  moderate: { rds_el: 2.5, rds_uvol: 0.6, gasex: 0.55, ips_res: 2400 },
  severe: { rds_el: 3.5, rds_uvol: 0.45, gasex: 0.4, ips_res: 1700 },
};

// ---------------------------------------------------------------------------
// 1. build the baseline headless
// ---------------------------------------------------------------------------
const eng = await createEngine();
const baseUrl = new URL(`../model_definitions/${baseline}.json`, import.meta.url);
let baseJson;
try {
  baseJson = JSON.parse(fs.readFileSync(baseUrl, "utf8"));
} catch (e) {
  console.error(`build_patient: cannot read baseline "${baseline}" —`, String(e));
  process.exit(1);
}
const model = eng.build(baseJson.model_definition || baseJson);
if (!model || !model.models) {
  console.error(`build_patient: build failed for baseline "${baseline}".`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. structural pass (applied ONCE, not iterated)
// ---------------------------------------------------------------------------
const trace = (...a) => console.error(...a);
const has = (k) => targets[k] != null;

// fetal vs neonatal baseline. Sniff the baseline JSON (before any structural pass) so the branch
// is decided up front; an explicit spec.fetal overrides.
const FETAL_MODE = spec.fetal != null ? !!spec.fetal : isFetal(baseJson.model_definition || baseJson);
trace(`fetal mode: ${FETAL_MODE ? "ON" : "off"} (${spec.fetal != null ? "spec" : "detected from baseline"})`);

// the maternal placental pool is not the patient. Blood.set_solute()/set_P50() propagate to every
// registered blood component INCLUDING PL_MAT, so snapshot it and restore after any such write.
const matSnap = FETAL_MODE && model.models.PL_MAT
  ? { P50_0: model.models.PL_MAT.P50_0, solutes: { ...model.models.PL_MAT.solutes } }
  : null;
const restoreMaternalPool = () => {
  if (!matSnap) return;
  const plm = model.models.PL_MAT;
  plm.P50_0 = matSnap.P50_0;
  Object.assign(plm.solutes, matSnap.solutes);
};

// gestational-age seed bundle (used to seed both structure and starting lever values)
let seed = null;
if (FETAL_MODE) {
  seed = FETAL[nearestFetalGa(has("gestational_age") ? targets.gestational_age : 40)];
} else if (has("gestational_age") && targets.gestational_age < 37) {
  seed = PRETERM_SEED[nearestGa(targets.gestational_age)];
}

// weight: allometric volume scaling (scale_to_weight sets model.weight too). Apply FIRST —
// _scale_vol multiplies vol AND u_vol on every listed compartment, so any absolute per-compartment
// volume edit (the venous preload trim, the fetal placental trim) must come after it to be a trim
// on the already-scaled value. NOTE scale_to_weight does NOT reset resistance scaling — every
// elastance/resistance line in it is commented out, so it moves volumes only.
const weightKg = has("weight") ? targets.weight : seed ? seed.weight : null;
if (weightKg != null) {
  eng.scale("weight_scale", weightKg);
  model.weight = weightKg;
  trace(`structural: weight -> ${weightKg} kg (allometric volume scaling)`);
}
if (has("height")) model.height = targets.height >= 3 ? targets.height / 100 : targets.height;
else if (seed) model.height = seed.height;
if (has("gestational_age")) model.gestational_age = targets.gestational_age;
if (has("age")) model.age = targets.age;

// pathophysiology + GA-seed RDS lung phenotype (stiff, low-FRC, reduced diffusion)
// The placenta is invisible to scale_to_weight (no PL_* compartment appears in scaler_config), so
// a scaled fetus keeps a term-sized placenta unless it is trimmed explicitly.
if (FETAL_MODE && seed?.pl_vol != null && weightKg != null) {
  for (const n of ["PL_UMB_ART", "PL_FETAL_ART", "PL_FETAL_CAP", "PL_FETAL_VEN", "PL_UMB_VEN"]) {
    const c = model.models[n];
    if (!c) continue;
    if (typeof c.vol === "number") c.vol *= seed.pl_vol;
    if (typeof c.u_vol === "number") c.u_vol *= seed.pl_vol;
  }
  const plm = model.models.PL_MAT;
  if (plm && seed.mat_vol != null) { plm.vol *= seed.mat_vol; plm.u_vol *= seed.mat_vol; }
  trace(`structural: placental volume x${seed.pl_vol} (fetal), PL_MAT x${seed.mat_vol}`);
}

// RDS is a neonatal lung phenotype and must never touch a fetus: the fetal lung is fluid-filled and
// inert, and the bundle's ips_res write would reopen the intrapulmonary shunts.
if (FETAL_MODE && patho.rds) {
  console.error(`build_patient: pathophysiology.rds is meaningless on a fetal baseline ("${baseline}") — the fetal lung is inert.`);
  process.exit(1);
}
const rds = FETAL_MODE ? null : patho.rds ? RDS_BUNDLE[patho.rds] : seed ? { rds_el: seed.rds_el, rds_uvol: seed.rds_uvol, gasex: seed.gasex, ips_res: seed.ips_res } : null;
if (rds) {
  for (const n of ["ALL", "ALR"]) {
    const c = model.models[n];
    if (c) { c.el_base *= rds.rds_el; c.u_vol *= rds.rds_uvol; }
  }
  for (const n of ["GASEX_LL", "GASEX_RL"]) {
    const c = model.models[n];
    if (c) { c.dif_o2 *= rds.gasex; c.dif_co2 *= rds.gasex; }
  }
  if (model.models.Shunts && rds.ips_res) model.models.Shunts.ips_res = rds.ips_res;
  trace(`structural: RDS lungs (el x${rds.rds_el}, u_vol x${rds.rds_uvol}, dif x${rds.gasex}, ips_res ${rds.ips_res})`);
}

// venous preload trim for the smallest babies (uniform scaling leaves CVP near zero)
if (seed && seed.ven_uvol !== 1.0) {
  for (const n of ["VLB", "VUB"]) { const c = model.models[n]; if (c) c.u_vol *= seed.ven_uvol; }
}

// cardiac immaturity (weaker systole, stiffer diastole) from the GA seed
if (seed) {
  const H = model.models.Heart;
  if (H) {
    H.cont_factor_left = seed.cont; H.cont_factor_right = seed.cont;
    H.relax_factor_left = seed.relax; H.relax_factor_right = seed.relax;
  }
}

// patent ductus
if (FETAL_MODE) {
  // The fetal duct is fully relaxed in utero: diameter_relative is a [0..1] PATENCY fraction and
  // stays 1.0 at every gestation. The SIZE levers are the anatomic millimetres, which no scaler
  // touches — without them a scaled fetus keeps a term-sized duct and foramen.
  if (has("pda")) {
    console.error(`build_patient: targets.pda is not a fetal knob — the fetal duct is wide open. Use a named ductal-constriction pathophysiology instead.`);
    process.exit(1);
  }
  const P = model.models.Pda, S = model.models.Shunts;
  if (P && seed?.da_diam != null) { P.diameter_ao_max = seed.da_diam; P.diameter_pa_max = seed.da_diam; P.length = seed.da_len; P.diameter_relative = 1.0; }
  if (S && seed?.fo != null) { S.diameter_fo = seed.fo; S.atrial_septal_width = seed.fo_septum; }
  trace(`structural: fetal shunt anatomy — duct ${seed?.da_diam} mm x ${seed?.da_len} mm (relative 1.0), FO ${seed?.fo} mm`);
  // placental bed
  const PL = model.models.Placenta;
  if (PL && seed?.umb_art_res != null) { PL.umb_art_res = seed.umb_art_res; PL.plf_res = seed.plf_res; PL.dif_o2 = seed.dif_o2; PL.dif_co2 = seed.dif_co2; }
} else {
  const pda = has("pda") ? targets.pda : seed ? seed.pda : null;
  if (pda != null && model.models.Pda) { model.models.Pda.diameter_relative = pda; trace(`structural: PDA diameter_relative ${pda}`); }
}

// hemoglobin — the model's unit is mmol/L. Accept `hb` (mmol/L) directly, or
// `hb_gdl` (g/dL) which is converted (1 g/dL = 0.6206 mmol/L). The model NEVER
// sees g/dL — always feed set_solute("hemoglobin", …) a mmol/L value.
if (model.models.Blood && (has("hb") || has("hb_gdl"))) {
  const hbMmol = has("hb") ? targets.hb : targets.hb_gdl * 0.6206;
  model.models.Blood.set_solute("hemoglobin", hbMmol);
  restoreMaternalPool(); // PL_MAT is the mother's blood — her Hb does not follow the fetus's
  trace(`structural: Hb ${round(hbMmol, 2)} mmol/L${!has("hb") && has("hb_gdl") ? ` (converted from ${targets.hb_gdl} g/dL)` : ""}`);
}

// thermoregulation set-point -> target core/blood temperature
if (has("temp") && model.models.Thermoregulation) { model.models.Thermoregulation.setpoint_temp = targets.temp; trace(`structural: temp setpoint ${targets.temp}`); }

// baroreflex MAP set-point: defend the requested MAP so the ANS doesn't fight it
if (has("map") && model.models.BR_MAP) { model.models.BR_MAP.set_value = targets.map; trace(`structural: baroreflex MAP set-point ${targets.map}`); }

// heart-rate reference seed (also an iterated lever below if hr is targeted)
if (seed && model.models.Heart && !has("hr")) model.models.Heart.heart_rate_ref = seed.hr_ref;
// the baroreflex must defend the gestation's own MAP when the spec does not name one, or it drives
// permanent reflex tachycardia (the fetal setpoint is 50 at term, far above a 30 wk target)
if (seed?.br_map != null && !has("map") && model.models.BR_MAP) model.models.BR_MAP.set_value = seed.br_map;
// fetal haemoglobin affinity (HbF), maternal pool excluded
if (FETAL_MODE && seed?.p50 != null && model.models.Blood) {
  if (model.models.Blood.set_P50) model.models.Blood.set_P50(seed.p50); else model.models.Blood.P50_0 = seed.p50;
  restoreMaternalPool();
  trace(`structural: fetal P50 ${seed.p50} (PL_MAT kept maternal)`);
}

// ---------------------------------------------------------------------------
// 3. controllers (one lever per off-target vital) — applied iteratively
// ---------------------------------------------------------------------------
// Each controller drives one measured vital toward its target via one lever (the
// secant loop lives in explain/helpers/Calibrator.js, shared with the live tuner).
// `mkc` injects this build's target + tolerance + the measure-dict key (co reads
// "lvo", spo2 reads "spo2_pre" from measureVitals).
const READKEY = { co: "lvo", spo2: "spo2_pre" };
const mkc = (spec) => makeController({ ...spec, readKey: READKEY[spec.key] ?? spec.key, target: targets[spec.key], tol: tolOf(spec.key) });

const controllers = [];

// MAP  <- systemic vascular resistance scaling (↑SVR ↑MAP)
if (has("map")) {
  let f = seed && seed.svr ? seed.svr : 1.0;
  eng.scale("systemic_resistances", f);
  controllers.push(mkc({ key: "map", lo: 0.3, hi: 8, sign: +1, gain: 0.04, value: f, set: (v) => eng.scale("systemic_resistances", v) }));
}
// PAP mean <- pulmonary vascular resistance scaling (↑PVR ↑PAP)
if (has("pap_m")) {
  let f = patho.pvr_scale || (seed && seed.pvr) || 1.0;
  eng.scale("pulmonary_resistances", f);
  controllers.push(mkc({ key: "pap_m", lo: 0.3, hi: 12, sign: +1, gain: 0.05, value: f, set: (v) => eng.scale("pulmonary_resistances", v) }));
} else if (patho.pvr_scale || (seed && seed.pvr)) {
  eng.scale("pulmonary_resistances", patho.pvr_scale || seed.pvr); // structural-only PVR
}
// CVP <- venous unstressed-volume multiplier on VLB/VUB (↓u_vol ↑CVP -> sign -1)
if (has("cvp")) {
  const base = {};
  for (const n of ["VLB", "VUB"]) { const c = model.models[n]; if (c) base[n] = c.u_vol; }
  const apply = (mult) => { for (const n in base) model.models[n].u_vol = base[n] * mult; };
  controllers.push(mkc({ key: "cvp", lo: 0.5, hi: 1.3, sign: -1, gain: 0.05, value: 1.0, set: apply }));
}
// HR <- heart-rate reference setpoint (direct)
if (has("hr")) {
  const start = model.models.Heart?.heart_rate_ref ?? targets.hr;
  controllers.push(mkc({ key: "hr", lo: 60, hi: 240, sign: +1, gain: 0.8, value: start, set: (v) => { if (model.models.Heart) model.models.Heart.heart_rate_ref = v; } }));
}
// CO (LV output) <- ventricular contractility (el_max persistent factor)
if (has("co")) {
  const apply = (f) => { for (const n of ["LV", "RV"]) { const m = model.models[n]; if (m) m.el_max_factor_ps = f; } };
  controllers.push(mkc({ key: "co", lo: 0.3, hi: 3, sign: +1, gain: 0.8, value: 1.0, set: apply }));
}
// PO2 / SpO2 <- alveolar O2 diffusion persistent factor (↑dif ↑PO2); in a FETUS the alveolar
// diffusors are inert (dif_o2 = 0, so the factor multiplies into zero — a complete no-op that would
// burn every iteration on a lever that cannot move the measurement). The fetal setpoint is the
// maternal pool's O2 content: Placenta.calc_model() writes mat_to2 onto PL_MAT every step and the
// exchanger nearly fully equilibrates fetal capillary blood to it, so mat_to2 IS the achievable
// umbilical-vein oxygen content. It reaches arterial (AA) saturation only indirectly via the
// UV -> ductus venosus -> foramen ovale -> LA path, hence the small gain.
if (has("po2") || has("spo2")) {
  const key = has("po2") ? "po2" : "spo2";
  if (FETAL_MODE) {
    const P = model.models.Placenta;
    controllers.push(mkc({ key, lo: 4.0, hi: 10.0, sign: +1, gain: key === "po2" ? 0.05 : 0.03,
      value: P.mat_to2, set: (v) => { P.mat_to2 = v; } }));
  } else {
    const apply = (f) => { for (const n of ["GASEX_LL", "GASEX_RL"]) { const m = model.models[n]; if (m) m.dif_o2_factor_ps = f; } };
    controllers.push(mkc({ key, lo: 0.1, hi: 8, sign: +1, gain: key === "po2" ? 0.03 : 0.06, value: 1.0, set: apply }));
  }
}
// pCO2 <- spontaneous ventilatory drive (Breathing.minute_volume_ref multiplier).
// ↓drive ↑pCO2 -> sign -1. This is the lever that actually shifts the *regulated*
// CO2 operating point: the chemoreflex (mv_ans_factor, Breathing.js:60) defends a
// pCO2 setpoint, so gas-exchange dif_co2 alone is fought back to baseline — only
// changing the drive moves steady-state pCO2. (Assumes spontaneous breathing; for
// a ventilated baseline the bot sets ventilator rate/Vt instead.)
// In a FETUS this lever is inert (Breathing.is_enabled = false). The fetal equivalent is the
// maternal pool's CO2 content: a higher maternal CO2 content means a smaller placental gradient and
// therefore LESS clearance, so fetal pCO2 rises with mat_tco2 (sign +1 — verified empirically with
// `probe_fetus.mjs <scenario> --mattco2`, not asserted from reading).
if (has("pco2") && FETAL_MODE) {
  const P = model.models.Placenta;
  controllers.push(mkc({ key: "pco2", lo: 14, hi: 30, sign: +1, gain: 0.15, value: P.mat_tco2, set: (v) => { P.mat_tco2 = v; } }));
} else if (has("pco2") && model.models.Breathing) {
  const B = model.models.Breathing;
  const baseMv = B.minute_volume_ref;
  const apply = (mult) => { B.minute_volume_ref = baseMv * mult; };
  controllers.push(mkc({ key: "pco2", lo: 0.2, hi: 2.5, sign: -1, gain: 0.03, value: 1.0, set: apply }));
}
// BE / pH (metabolic) <- Stewart unmeasured anions uma (↑uma ↓BE/pH -> sign -1)
if (has("be") || has("ph")) {
  const key = has("be") ? "be" : "ph";
  const startUma = model.models.AA?.solutes?.uma ?? 0;
  const apply = (v) => {
    if (model.models.Blood) model.models.Blood.set_solute("uma", Math.max(0, v));
    restoreMaternalPool(); // set_solute reaches PL_MAT; the mother is not the patient
  };
  controllers.push(mkc({ key, lo: 0, hi: 40, sign: -1, gain: key === "be" ? 0.8 : 18, value: startUma, set: apply }));
}

// ---------------------------------------------------------------------------
// 4. calibration loop
// ---------------------------------------------------------------------------
const profile = selectProfile({ weight: model.weight, gestational_age: model.gestational_age, profile: spec.profile, fetal: FETAL_MODE });
const ranges = RANGES[profile] || RANGES.adult;
trace(`\ncalibrating "${spec.name || baseline}" (baseline ${baseline}, profile ${profile}) — ${controllers.length} target(s)`);

// run the shared secant calibration (settle → measure → nudge → warm → repeat),
// then an equilibrium bake (final) — eng.calc is the model stepper, measureVitals
// the windowed reader. Returns the final measured vitals + per-target residuals.
const result = runCalibration(controllers, {
  measureAll: () => measureVitals(model, eng.send, { window: WINDOW }),
  step: (s) => eng.calc(s),
  settle: SETTLE,
  warm: WARM,
  maxIters: MAX_ITERS,
  final: FINAL,
  log: (line) => trace(`  ${line}`),
});
const vf = result.measured;
const it = result.iters;

// ---------------------------------------------------------------------------
// 5. residual report (stderr)
// ---------------------------------------------------------------------------
trace(`\n=== ${spec.name || baseline} — final vitals (profile ${profile}) ===`);
const REPORT = ["hr", "map", "cvp", "pap_m", "spo2_pre", "po2", "pco2", "ph", "be", "hco3"];
for (const k of REPORT) {
  const tk = k === "spo2_pre" ? "spo2" : k;
  const tgt = targets[tk];
  const flag = flagOf(ranges, k, vf[k]);
  trace(`  ${k.padEnd(10)} ${String(round(vf[k])).padStart(8)}${tgt != null ? `  (target ${tgt}, Δ ${round(vf[k] - tgt)})` : ""}  [${flag}]`);
}
const allWithin = result.converged;
trace(`  calibration ${allWithin ? "CONVERGED" : "INCOMPLETE"} after ${it} iter — ${result.residuals.filter((r) => !r.within).map((r) => r.key).join(", ") || "all targets met"}`);

// ---------------------------------------------------------------------------
// 6. serialize and emit the runnable scenario JSON (stdout)
// ---------------------------------------------------------------------------
const name = spec.name || `${baseline}_custom`;
const description =
  spec.description ||
  `AI-built patient from ${baseline}: ` +
    REPORT.filter((k) => targets[k === "spo2_pre" ? "spo2" : k] != null)
      .map((k) => `${k === "spo2_pre" ? "SpO2" : k}≈${round(vf[k])}`)
      .join(", ");

model.name = name;
model.description = description;
model.age = model.age ?? 0;
serializeState(model);

const out = { ...baseJson, name, description, user: spec.user || "explain-bot", model_definition: model };
const json = JSON.stringify(out, null, PRETTY ? 1 : 0);
JSON.parse(json); // fail loudly before emitting if anything is non-serializable
process.stdout.write(json + "\n");
