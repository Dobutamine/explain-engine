// Fetal-circulation probe for the fetal scenarios (term_fetus, fetus_<ga>wk).
//
// Warms up the scenario, then reports the panel needed to calibrate fetal circulation:
//   - vitals (HR, ABP, PAP, CVP) and combined ventricular output (RV:LV split)
//   - shunt / placental flows as mL/min and as % of combined ventricular output (CVO)
//   - the fetal oxygenation gradient: umbilical vein > ascending aorta > descending aorta > umbilical artery
//
// Usage:
//   node scripts/probe_fetus.mjs [scenario] [--seconds N] [--window W] [--no-ans] [--verbose]
//
// `scenario` is a filename stem from model_definitions/ without .json, defaulting to term_fetus
// (e.g. `node scripts/probe_fetus.mjs fetus_30wk`).
//
// Live calibration overrides (applied before warm-up, mutate the live model):
//   --fo MM           foramen ovale diameter (Shunts.diameter_fo)
//   --da REL          ductus arteriosus diameter_relative (Pda)
//   --pvr X           multiply pulmonary arteriolar resistance (PAAL_LL_ART,PAAR_RL_ART,LL_ART_LL_CAP,RL_ART_RL_CAP)
//   --plfres R        fetal-placenta resistance (Placenta.plf_res)
//   --umbart R        umbilical-artery resistance (Placenta.umb_art_res)
//   --difo2 X         placental O2 diffusion (Placenta.dif_o2)
//   --difco2 X        placental CO2 diffusion (Placenta.dif_co2)
//   --matto2 X        maternal pool O2 content (Placenta.mat_to2)
//   --hb X            fetal hemoglobin (mmol/L, via Blood.set_solute)
//   --uma X           unmeasured anions (acid-base, via Blood.set_solute)
//   --hrref BPM       Heart.heart_rate_ref
//   --contract X      SYMMETRIC contractility: el_max_factor_ps on BOTH LV and RV
//   --contract-right X  Heart.cont_factor_right — the ventricular-dominance lever. The atrial split
//                     follows whichever ventricle ejects better, because the foramen is effectively
//                     unrestrictive; --fo does NOT move the split between 3 and 6 mm.
//   --contract-left X   Heart.cont_factor_left
//   --rvuvol X        multiplier on RV.u_vol — sets RV ejection fraction, NOT the split
//   --venuvol X       multiplier on VLB/VUB u_vol (venous preload)
//   --bloodvol X      multiplier on every blood compartment's volume

import fs from "node:fs";
import { register } from "node:module";
register("./resolve-extensionless.mjs", import.meta.url);
import { calc_blood_composition } from "../component_models/BloodComposition.js";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : d; };
// only argv[0] may be the scenario stem: argv.find(a => !a.startsWith("-")) would pick up a
// flag VALUE (e.g. "4.3" from `--fo 4.3`) and try to load it as a scenario.
const SCENARIO = argv[0] && !argv[0].startsWith("-") ? argv[0] : "term_fetus";
const SECONDS = opt("--seconds", 120);
const WINDOW = opt("--window", 20);
const VERBOSE = flag("--verbose");

let liveModel = null;
globalThis.self = globalThis;
globalThis.postMessage = (msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === "state") liveModel = msg.payload;
  if (msg.type === "error") console.error("ENGINE ERROR:", msg.message, msg.payload ?? "");
  if (msg.type === "status" && /ERROR/i.test(msg.message || "")) console.error("ENGINE:", msg.message);
};
const _log = console.log;
if (!VERBOSE) console.log = () => {};
await import("../ModelEngine.js");
const send = (type, message, payload) => self.onmessage({ data: { type, message, payload } });

const path = new URL(`../model_definitions/${SCENARIO}.json`, import.meta.url);
const json = JSON.parse(fs.readFileSync(path, "utf8"));
send("POST", "build", json.model_definition || json);
send("GET", "state", []);
const model = liveModel;
if (!model || !model.models) { console.log = _log; console.error(`Build failed for "${SCENARIO}".`); process.exit(1); }
const M = model.models;
const weight = model.weight;

if (flag("--no-ans") && M.Ans) M.Ans.is_enabled = false;

// --- live calibration overrides ---
const Blood = M.Blood;
const setS = (s, v) => { if (Blood && v != null) Blood.set_solute(s, v); };
setS("hemoglobin", opt("--hb", null));
setS("uma", opt("--uma", null));
if (opt("--fo", null) != null) M.Shunts.diameter_fo = opt("--fo", null);
if (opt("--da", null) != null) M.Pda.diameter_relative = opt("--da", null);
// PVR lever: scale the pulmonary BloodVessel compartments' own r_for/r_back (their adopted inlet
// resistor is overwritten each step from BloodVessel.r_for_eff, so the top-level resistor is NOT the lever)
const pvr = opt("--pvr", null);
if (pvr != null) for (const n of ["PAAL", "PAAR", "LL_ART", "RL_ART", "LL_CAP", "RL_CAP"]) { const m = M[n]; if (m) { m.r_for *= pvr; m.r_back *= pvr; } }
if (opt("--plfres", null) != null) M.Placenta.plf_res = opt("--plfres", null);
if (opt("--umbart", null) != null) M.Placenta.umb_art_res = opt("--umbart", null);
if (opt("--difo2", null) != null) M.Placenta.dif_o2 = opt("--difo2", null);
if (opt("--difco2", null) != null) M.Placenta.dif_co2 = opt("--difco2", null);
if (opt("--matto2", null) != null) M.Placenta.mat_to2 = opt("--matto2", null);
if (opt("--mattco2", null) != null) M.Placenta.mat_tco2 = opt("--mattco2", null);
if (opt("--ipsres", null) != null && M.Shunts) M.Shunts.ips_res = opt("--ipsres", null); // raise to close intrapulmonary shunts
if (opt("--p50", null) != null && M.Blood?.set_P50) { M.Blood.set_P50(opt("--p50", null)); if (M.PL_MAT) M.PL_MAT.P50_0 = 20.0; } // fetal HbF affinity; keep maternal pool unchanged
if (opt("--hrref", null) != null) M.Heart.heart_rate_ref = opt("--hrref", null);
const contract = opt("--contract", null);
if (contract != null) for (const n of ["LV", "RV"]) { const m = M[n]; if (m) m.el_max_factor_ps = contract; }
// asymmetric inotropy — the lever that actually sets RV:LV dominance
if (opt("--contract-right", null) != null && M.Heart) M.Heart.cont_factor_right = opt("--contract-right", null);
if (opt("--contract-left", null) != null && M.Heart) M.Heart.cont_factor_left = opt("--contract-left", null);
if (opt("--rvuvol", null) != null && M.RV) M.RV.u_vol *= opt("--rvuvol", null);
const venuvol = opt("--venuvol", null);
if (venuvol != null) for (const n of ["VLB", "VUB"]) { const m = M[n]; if (m) m.u_vol *= venuvol; }
const bloodvol = opt("--bloodvol", null);
if (bloodvol != null) for (const [n, m] of Object.entries(M)) {
  if (m && typeof m.vol === "number" && m.solutes && Object.keys(m.solutes).length && !n.startsWith("ECLS") && n !== "URINE") m.vol *= bloodvol;
}

// --- warm up ---
send("POST", "calc", SECONDS);

// --- cycle-average over WINDOW ---
const Mon = M.Monitor;
const SLICE = 0.02;
const N = Math.round(WINDOW / SLICE);
const acc = {};
const add = (k, v) => { acc[k] = (acc[k] || 0) + (v ?? 0); };
const gasComps = { UV: M.PL_UMB_VEN, AA: M.AA, AD: M.AD, UA: M.PL_UMB_ART, IVCI: M.IVCI, PLMAT: M.PL_MAT, PLCAP: M.PL_FETAL_CAP };
for (let i = 0; i < N; i++) {
  send("POST", "calc", SLICE);
  add("hr", Mon.heart_rate);
  add("sys", Mon.minmax?.abp_pre_pres_max); add("dia", Mon.minmax?.abp_pre_pres_min); add("map", Mon.minmax?.abp_pre_pres_mean);
  add("pap_s", Mon.minmax?.pap_pres_max); add("pap_d", Mon.minmax?.pap_pres_min); add("pap_m", Mon.minmax?.pap_pres_mean);
  add("cvp", Mon.minmax?.cvp_pres_mean);
  add("lvo", Mon.flows?.lvo); add("rvo", Mon.flows?.rvo);
  // flows (L/s) — average instantaneous resistor flow
  add("q_umb_art", M.PL_UMB_ART?.flow); add("q_umb_ven", M.PL_UMB_VEN_IVCI?.flow);
  add("q_pulm", (M.PAAL_LL_ART?.flow ?? 0) + (M.PAAR_RL_ART?.flow ?? 0));
  add("q_pcap", (M.LL_ART_LL_CAP?.flow ?? 0) + (M.RL_ART_RL_CAP?.flow ?? 0)); // true capillary flow
  add("q_ips", (M.IPSL?.flow ?? 0) + (M.IPSR?.flow ?? 0));                     // intrapulmonary shunt
  add("q_da", M.Pda?.flow_pa); add("q_fo", M.Shunts?.flow_fo);
  // gas — solve composition each slice and average
  for (const [k, c] of Object.entries(gasComps)) {
    if (!c) continue;
    calc_blood_composition(c);
    add(`so2_${k}`, c.so2); add(`po2_${k}`, c.po2); add(`pco2_${k}`, c.pco2);
    add(`ph_${k}`, c.ph); add(`hco3_${k}`, c.hco3); add(`be_${k}`, c.be);
  }
}
for (const k in acc) acc[k] /= N;

console.log = _log;
const r = (x, n = 1) => (typeof x === "number" && isFinite(x) ? Number(x.toFixed(n)) : x);
const cvo_Lmin = (acc.lvo || 0) + (acc.rvo || 0);                 // L/min
const cvo_mlkgmin = cvo_Lmin * 1000 / weight;
const Lmin = (q) => (q || 0) * 60;                               // L/s -> L/min
const ml = (q) => (q || 0) * 60 * 1000;                          // L/s -> mL/min
const pct = (q) => cvo_Lmin ? (Lmin(q) / cvo_Lmin) * 100 : 0;

console.log(`\n=== ${SCENARIO} (weight ${weight} kg, GA ${model.gestational_age} wk, ANS ${M.Ans?.is_enabled ? "ON" : "OFF"}, warmup ${SECONDS}s) ===\n`);
console.log("-- Hemodynamics --");
console.log(`Heart rate            ${String(r(acc.hr)).padStart(7)} bpm`);
console.log(`ABP (AA) sys/dia/map  ${String(r(acc.sys)).padStart(7)} / ${r(acc.dia)} / ${r(acc.map)} mmHg`);
console.log(`PAP     sys/dia/map   ${String(r(acc.pap_s)).padStart(7)} / ${r(acc.pap_d)} / ${r(acc.pap_m)} mmHg   (PA≈Ao if mean matches)`);
console.log(`CVP (mean)            ${String(r(acc.cvp)).padStart(7)} mmHg`);
console.log(`LV / RV output        ${String(r(acc.lvo,3)).padStart(7)} / ${r(acc.rvo,3)} L/min`);
console.log(`Combined output (CVO) ${String(r(cvo_Lmin,3)).padStart(7)} L/min  = ${r(cvo_mlkgmin,0)} mL/kg/min`);
console.log(`RV : LV split         ${cvo_Lmin ? r(acc.rvo/cvo_Lmin*100,0) : 0} : ${cvo_Lmin ? r(acc.lvo/cvo_Lmin*100,0) : 0}`);

console.log("\n-- Flows (mL/min and % of CVO) --");
const fline = (label, q) => console.log(`${label.padEnd(28)} ${String(r(ml(q),0)).padStart(7)} mL/min   ${r(pct(q),0)} %`);
fline("Umbilical artery (->placenta)", acc.q_umb_art);
fline("Umbilical vein (DV->IVC)", acc.q_umb_ven);
fline("Pulmonary (PA->lungs)", acc.q_pulm);
fline("  via capillary", acc.q_pcap);
fline("  via intrapulm shunt", acc.q_ips);
fline("Ductus arteriosus (PA->Ao)", acc.q_da);
fline("Foramen ovale (R->L)", acc.q_fo);

console.log("\n-- Oxygenation gradient (expect UV > AA > AD > UA) --");
const gline = (k, label) => console.log(`${label.padEnd(22)} SaO2 ${String(r(acc[`so2_${k}`],0)).padStart(4)}%   PO2 ${String(r(acc[`po2_${k}`],0)).padStart(4)}   PCO2 ${String(r(acc[`pco2_${k}`],0)).padStart(4)}   pH ${r(acc[`ph_${k}`],2)}   HCO3 ${r(acc[`hco3_${k}`],0)}   BE ${r(acc[`be_${k}`],0)}`);
gline("UV", "Umbilical vein");
gline("AA", "Ascending aorta");
gline("AD", "Descending aorta");
gline("UA", "Umbilical artery");
gline("IVCI", "IVC (mixed)");
gline("PLCAP", "Placenta fetal cap");
gline("PLMAT", "Placenta maternal");
console.log("");
