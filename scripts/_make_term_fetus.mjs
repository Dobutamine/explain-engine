// One-off transform: term_neonate.json -> term_fetus.json (fetal-circulation scenario).
// Re-runnable. Applies the topology + calibration; steady-state re-seeding is done afterwards by
// reseed_term_fetus.mjs (which warms the model and bakes the equilibrium gas/volume seeds).
//
//   node scripts/_make_term_fetus.mjs
//
// Calibration was found with scripts/probe_fetus.mjs (see that file's flags). Operating point,
// re-measured (the previous header had drifted on every number — it claimed CVO 341, RV:LV 51:49,
// FO 36%, UV SaO2 80%):
//   HR 138, MAP 55, PA 57 (PA-Ao 1.4 mmHg), CVO ~350 mL/kg/min, RV:LV 55:45,
//   placental flow 44% / pulmonary 8% / DA 48% (PA->Ao) / FO 37% (R->L),
//   O2 gradient UV 88% > IVC 71% > AA 67% > AD 62%, umbilical-artery gas pH 7.27 / PCO2 50 / BE -5.
// Re-measure with `node scripts/probe_fetus.mjs term_fetus` after any change here rather than
// trusting this block.
import fs from "node:fs";

const src = new URL("../model_definitions/term_neonate.json", import.meta.url);
const dst = new URL("../model_definitions/term_fetus.json", import.meta.url);
const j = JSON.parse(fs.readFileSync(src, "utf8"));

// --- top-level metadata ---
j.name = "term_fetus";
j.user = "timothy";
j.description =
  "term fetus in utero (3.545 kg, 40 wk) — fetal circulation: placental gas exchange, wide-open ductus arteriosus and foramen ovale, high pulmonary vascular resistance, inert (fluid-filled) lungs";

const md = j.model_definition;
const M = md.models;
const log = [];

// A. Placenta is the gas-exchange organ --------------------------------------
// Resistances tuned for ~42% of combined output through the umbilical circuit; the gas-exchanger
// fully equilibrates fetal capillary blood to the (fixed) maternal pool, so mat_to2/mat_tco2 set the
// achievable umbilical-vein gas (maternal PCO2 ~30 → pregnancy-like; mat_to2 6.85 → UV SaO2 ~80%).
const PL = M.Placenta;
PL.placenta_running = true;
PL.umb_clamped = false;
PL.umb_art_res = 680;   // umbilical artery resistance (mmHg*s/L)
PL.umb_ven_res = 100;   // umbilical vein resistance (unchanged)
PL.plf_res = 1500;      // fetal-placenta resistance
PL.dif_o2 = 0.03;       // placental O2 diffusion
PL.dif_co2 = 0.04;      // placental CO2 diffusion
PL.mat_to2 = 7.4;       // maternal pool O2 content (with fetal HbF → UV SaO2 ~88%, brain SaO2 ~65%)
PL.mat_tco2 = 21;       // maternal pool CO2 content (→ maternal/UV PCO2 ~30)
log.push(`Placenta: running, plf_res=${PL.plf_res} umb_art_res=${PL.umb_art_res} dif_o2=${PL.dif_o2} dif_co2=${PL.dif_co2} mat_to2=${PL.mat_to2} mat_tco2=${PL.mat_tco2}`);

// B. Ductus arteriosus wide open ---------------------------------------------
// diameter_relative is the [0..1] patency fraction; the SIZE is diameter_*_max, and it matters far
// more than it looks. Duct resistance carries a Bernoulli orifice term scaling as 1/area^2
// (Pda.js:200-210), so the inherited 3.0 mm cost a 12.5 mmHg PA-over-Ao gradient — an afterload the
// RV pays and the LV does not, and the reason this scenario used to come out LV-dominant (48:52).
// A fetus with a wide-open duct must have PA ~= Ao. Measured: 3.0 mm -> 12.5 mmHg / 48:52;
// 6.0 mm -> 1.0 mmHg / 51:49. 3.0 also contradicted the Szpinda regression cited in Pda.js:25
// (3.95 mm at 40 wk), and hlhs/pa_vsd had already overridden it to 4.0 for the same reason.
M.Pda.diameter_relative = 1.0;
M.Pda.diameter_ao_max = 6.0;
M.Pda.diameter_pa_max = 6.0;
log.push(`Pda: diameter_relative=${M.Pda.diameter_relative}, diameter_ao/pa_max=${M.Pda.diameter_ao_max} mm (PA~=Ao)`);

// C. Foramen ovale open; intrapulmonary shunts closed ------------------------
M.Shunts.diameter_fo = 6.0;     // mm; VSD stays 0
M.Shunts.ips_res = 1e8;         // close the intrapulmonary shunts (IPSL/IPSR) — fetal lung flow is all
                                // capillary; otherwise IPS adds a parallel low-R path inflating pulm flow
log.push(`Shunts: diameter_fo=${M.Shunts.diameter_fo} fo_lr_factor=${M.Shunts.fo_lr_factor} ips_res=${M.Shunts.ips_res} (IPS closed)`);

// D. High pulmonary vascular resistance (fluid-filled fetal lungs) ------------
// PVR_FACTOR was x21, which throttled pulmonary flow to 7-9% of combined output against a human
// MRI range of 11-25%. x9.5 puts it at ~15% and simultaneously brings the foramen (30%) and duct
// (40%) shares inside their human ranges (27-34% and 30-46%). The ventricular split is insensitive
// to this over the whole range tested (55:45 at x21 through x9.5 at cont_factor_right 1.3), so PVR
// and dominance are independent levers — but they are not obviously so, because lowering PVR raises
// pulmonary venous return and hence LV filling. Re-check the split after changing this.
// The pulmonary BloodVessel compartments OWN their inlet resistor (BloodVessel adopts the same-named
// top-level Resistor and overwrites its r_for from r_for_eff each step), so the PVR lever is the
// compartment r_for/r_back — NOT the top-level resistor. x21 (with IPS closed) → pulmonary flow ~8% of CVO.
const PVR_FACTOR = 9.5;
const pulmComps = ["PAAL", "PAAR", "LL_ART", "RL_ART", "LL_CAP", "RL_CAP"];
const circ = M.Circulation.components;
for (const n of pulmComps) {
  const m = circ[n] || M[n];
  m.r_for *= PVR_FACTOR;
  m.r_back *= PVR_FACTOR;
}
log.push(`PVR: x${PVR_FACTOR} on ${pulmComps.join(",")} (BloodVessel r_for/r_back)`);

// E. Inert lungs: no spontaneous breathing, no alveolar gas exchange ---------
// The fetal lung is fluid-filled and does not exchange gas. Disabling the GASEX BloodDiffusor's
// is_enabled does NOT stick (the build re-enables BloodDiffusors), so make the lung inert robustly by
// zeroing the diffusion constants — effective diffusion = dif * factor = 0 regardless of is_enabled.
M.Breathing.is_enabled = false;
M.Breathing.breathing_enabled = false;
const resp = M.Respiration.components;
for (const n of ["GASEX_LL", "GASEX_RL"]) {
  const m = resp[n] || M[n];
  if (m) { m.dif_o2 = 0; m.dif_co2 = 0; }
}
log.push(`Lungs inert: Breathing off, GASEX_LL/RL dif_o2=dif_co2=0 (fluid-filled lung)`);

// F. Fetal haemoglobin (HbF) — left-shifted O2 dissociation curve -------------
// The blood-gas solver reads a per-compartment P50_0 (O2-Hb affinity baseline). Set the fetal body to
// HbF (P50 18.8) so SaO2 is high at the correct LOW fetal pO2; keep the maternal placental pool (PL_MAT)
// at the unchanged affinity so the placental gas-exchange target is not perturbed.
M.Blood.P50_0 = 18.8;
M.Placenta.components.PL_MAT.P50_0 = 20.0;
log.push(`HbF: Blood.P50_0=${M.Blood.P50_0} (fetal); PL_MAT.P50_0=${M.Placenta.components.PL_MAT.P50_0} (maternal pool)`);

// G. ventricular dominance. The fetus must be RV-dominant; without this it comes out LV-dominant
// (48:52) because the fetal transform inherits the NEONATAL chamber parameterisation unchanged —
// the RV carries an unstressed volume 5.46x the LV's (4.00 vs 0.73 mL) with a lower el_max, so it
// cannot empty near u_vol and ejects at EF 33% against the LV's 57%. Right-atrial blood then
// decompresses across an effectively unrestrictive foramen into the LA.
//   - cont_factor_right sets the split: it is monotone and well-behaved, and it also pulls the
//     foramen share from 43% toward the human 27-34% and raises CVO/kg. The foramen DIAMETER does
//     not work as a lever — 3 to 6 mm gives 48:52 throughout, and it only bites below 2 mm where it
//     swings violently.
//   - RV u_vol restores a physiological RV ejection fraction (33% -> 51%) and is INDEPENDENT of the
//     split (it does not move it at all).
// Both are compensation for the chamber parameterisation, not a model of fetal RV physiology; the
// PDA scenarios already work around the same weakness with cont_factor_right 1.5-5.2.
// NB this script edits the definition JSON directly (no engine build), so the chambers are still
// nested under Heart.components — they are only flattened onto model.models at build time.
const RV = M.Heart.components.RV, LV = M.Heart.components.LV;
M.Heart.cont_factor_right = 1.30;
RV.u_vol = LV.u_vol * 1.64;
log.push(`Ventricles: cont_factor_right=${M.Heart.cont_factor_right} (RV-dominant), RV u_vol=${RV.u_vol} (1.64x LV, was 5.46x)`);

// H. baroreflex operating point. BR_MAP.set_value is the MAP the ANS defends; if it does not match
// the scenario's actual operating pressure the reflex fights the model forever (here it was 50
// against a measured MAP of ~55, holding HR down at 138). NB in this script BR_MAP is still nested
// under Ans.components — the build flattens it onto model.models, but the definition JSON does not.
M.Ans.components.BR_MAP.set_value = 55;
log.push(`Ans: BR_MAP set_value=${M.Ans.components.BR_MAP.set_value} (matches the operating MAP)`);

// I. heart_rate_ref left at 145 (gives HR ~145); ANS active.
// J. AD_PL_UMB_ART stays disabled — umbilical inflow is PL_UMB_ART's own input resistor from AD.
log.push(`AD_PL_UMB_ART is_enabled=${M.AD_PL_UMB_ART.is_enabled} (kept disabled; inflow via PL_UMB_ART.inputs)`);

fs.writeFileSync(dst, JSON.stringify(j, null, 1) + "\n");
console.log("wrote", dst.pathname);
console.log(log.join("\n"));
