// Gestational-age lever tables, shared by the scenario generators and the calibrated
// patient builder so a table lives in exactly one place.
//
// Background: NOTHING in the engine reads `model.gestational_age` — it is metadata.
// (`Uterus`/`MaternalPlacenta` have a `preg_ga`, but that is the *maternal* pregnancy
// clock and is deliberately distinct from the patient's own gestational age.) And
// ModelScaler.scale_to_weight() scales VOLUMES ONLY — every elastance/resistance
// inverse-allometry line in it is commented out. So a gestational age is not something
// the engine can derive: each GA is a hand-fitted row of levers that compensates for
// what allometric volume scaling leaves behind.
//
// These tables are therefore STARTING POINTS refined by iterating the generator +
// reseed + probe, exactly as scripts/_make_preterm.mjs documents for the preterm series.

// --- FETAL (in utero) -------------------------------------------------------------
// Levers for scripts/_make_fetus.mjs, applied on top of the term_fetus.json baseline
// (which already carries the fetal topology: placental gas exchange, wide-open duct and
// foramen ovale, x21 PVR on the pulmonary compartments, inert fluid-filled lungs, HbF).
//
// The columns are deliberately NOT the preterm ones. A fetus has no alveolar gas
// exchange and no ventilatory drive, so there is no RDS bundle, no minute-volume or
// vt_rr column, and no `pda` column — the fetal duct is wide open (diameter_relative
// 1.0) at every gestational age by definition.
//
//   weight/height  body size; drives scale_to_weight and every per-kg model
//                  (Metabolism.vo2, Breathing.minute_volume_ref, Drugs, Glucose, ...).
//   svr            systemic resistance multiplier. scale_to_weight moves volumes but
//                  not resistances, so a smaller fetus runs hypotensive without this.
//   pvr            pulmonary resistance multiplier, applied ON TOP OF the baseline's baked PVR
//                  factor (now x9.5 — it was x21, which throttled pulmonary flow to 7-9% of
//                  combined output against a human MRI 11-25%). The two compose multiplicatively.
//                  Fetal PVR falls through the third trimester, so pulmonary flow RISES toward
//                  term: this column must keep the 30 wk share BELOW the term scenario's ~15%.
//                  NB it is sensitive to the baseline — when that changed from x21 to x9.5 the old
//                  1.35 left 30 wk at 19%, i.e. ABOVE term, inverting the gestational trend.
//                  Re-check the ordering against term_fetus after touching either.
//                  (The Doppler literature has pulmonary flow peaking near 30 wk rather than
//                  rising to term; this table follows the human MRI reading, consistent with the
//                  55:45 RV:LV target.)
//   hr_ref         Heart.heart_rate_ref. Fetal heart rate declines with gestation.
//   br_map         Ans BR_MAP.set_value — the MAP the baroreflex defends. Fetal arterial
//                  pressure rises with gestation; if this does not track the operating
//                  MAP the ANS drives permanent reflex tachycardia/vasoconstriction.
//   pl_vol         multiplier on vol/u_vol of the FETAL placental compartments (PL_UMB_ART,
//   mat_vol        PL_FETAL_ART/CAP/VEN, PL_UMB_VEN) and, separately, of the maternal pool PL_MAT.
//                  CRITICAL: no PL_* compartment appears anywhere in scaler_config, so
//                  scale_to_weight does NOT touch the placenta. Without these the fetus keeps a
//                  term-sized placenta: at 30 wk that is 164 mL/kg fetoplacental blood instead of
//                  ~112, with the placenta holding 52% of fetal blood instead of 29%. The factor is
//                  deliberately LARGER than the body's volume factor because the placenta:fetus
//                  mass ratio falls with gestation (~0.20 at 30 wk vs ~0.14 at term).
//   fo             Shunts.diameter_fo and .atrial_septal_width, in ABSOLUTE mm. The foramen scales
//   fo_septum      with atrial size, i.e. a linear body dimension ~ weight^(1/3) = 0.725 here.
//                  atrial_septal_width is the length term in the foramen's Poiseuille law — leaving
//                  it at term thickness makes the foramen artificially restrictive.
//   da_diam        Pda.diameter_ao_max / .diameter_pa_max and Pda.length, in ABSOLUTE mm. Nothing
//   da_len         scales these, so diameter_relative = 1.0 alone leaves a term-sized duct in a
//                  1.35 kg body.
//                  THE DUCT IS AN RV-ONLY AFTERLOAD, and it was the root cause of the fetal
//                  scenarios coming out LV-dominant. Duct resistance carries a Bernoulli orifice
//                  term scaling as 1/area^2 (Pda.js:200-210), so a narrow duct is expensive: the
//                  previously shipped 3.0 mm cost a 12.5 mmHg PA-over-Ao gradient, which only the
//                  RV pays. A fetus with a wide-open duct must have PA ~= Ao — probe_fetus.mjs
//                  prints exactly that expectation. Measured on term_fetus: 3.0 mm -> 12.5 mmHg
//                  and RV:LV 48:52; 6.0 mm -> 1.0 mmHg and 51:49.
//                  So da_diam at 40 wk is anchored to the PA~=Ao invariant (6.0 mm), NOT to the
//                  3.0 mm the scenario used to ship. Note 3.0 also contradicted the model's own
//                  cited source: the Szpinda regression in Pda.js:25 gives 3.95 mm at 40 wk. The
//                  duct-dependent lesions (hlhs, pa_vsd) had already overridden it to 4.0 for the
//                  same reason. That 6.0 exceeds the morphometric 3.95 points at the resistance
//                  formula / discharge_coeff being over-restrictive; 6.0 is chosen because it
//                  satisfies the physiological invariant.
//                  Other gestations scale by the Szpinda RATIO off that anchor:
//                  d(30) = 6.0 x (3.012/3.947) = 4.58 mm, L(30) = 14 x (10.07/14.45) = 9.76 mm.
//   umb_art_res    Placenta.umb_art_res / .umb_ven_res / .plf_res, in ABSOLUTE mmHg*s/L. These are
//   umb_ven_res    the coordinator props (Placenta.calc_model rewrites the owned resistors from
//   plf_res        them every step, so the resistors themselves are not the lever). Resistances do
//                  not auto-scale with weight, and the placenta is a large parallel low-resistance
//                  path: without raising these, systemic resistance is a weak MAP lever because
//                  raising it just diverts flow into the umbilical circuit (placental share climbs
//                  to >55%). Raising both together is what sets MAP and the placental share
//                  independently.
//   dif_o2/dif_co2 Placenta.dif_o2 / .dif_co2 — placental diffusion. The villous exchange
//                  surface is markedly smaller before term. NOTE these largely saturate
//                  (the exchanger nearly equilibrates fetal capillary blood to the
//                  maternal pool), so mat_to2/mat_tco2 are the real gas setpoints.
//   p50            Blood.P50_0. The HbF fraction is higher earlier in gestation, which
//                  left-shifts the dissociation curve further.
//   hb             fetal haemoglobin in mmol/L (the model's unit), via Blood.set_solute.
//                  Rises through gestation (10 mmol/L ~= 16.1 g/dL at term). NOTE the maternal
//                  pool PL_MAT must be excluded from this — see _make_fetus.mjs section E.
//   cont_left      immature myocardium: weaker systole (Heart.cont_factor_* < 1) and
//   cont_right     stiffer/slower diastolic relaxation (Heart.relax_factor_* > 1).
//   relax          cont_right is ALSO the lever that sets ventricular dominance, and it is the only
//                  one that works: the right-atrial blood divides between the tricuspid valve and an
//                  effectively unrestrictive foramen, so whichever ventricle ejects better draws the
//                  larger share. Measured on fetus_30wk, cont_right 1.25 -> RV:LV 53:47 and 1.5 ->
//                  57:43, monotone throughout, while foramen DIAMETER does nothing between 3 and
//                  6 mm (46:54 at every value) and only bites below 2 mm, where it swings violently
//                  (1 mm -> 73:27). Raising cont_right also pulls the foramen share down from 43%
//                  toward the human 27-34% and raises CVO/kg, so it fixes three things at once.
//                  This is COMPENSATION, not a model of fetal RV physiology — see rv_uvol.
//   rv_uvol_ratio  RV.u_vol expressed as a MULTIPLE OF LV.u_vol, not as a multiplier on the
//                  existing value — fetus_<ga>wk is generated from term_fetus, which already
//                  carries the trim, so a multiplier would be applied twice. The shipped chambers
//                  give the RV an unstressed volume
//                  5.46x the LV's (4.00 vs 0.73 mL) with a lower el_max (22200 vs 27200) — a
//                  NEONATAL parameterisation, correctly LV-dominant, inherited unchanged by the
//                  fetal transform. It leaves the fetal RV unable to empty near its unstressed
//                  volume: EF 33% at term and 25% at 30 wk against the LV's 57%/44%. Trimming it
//                  restores a physiological RV ejection fraction (term 33->51%, 30 wk 25->42%) but
//                  does NOT move the split on its own (46:54 at every value tested) — the two
//                  levers are independent. 5.46 is the shipped ratio; 1.64 is the trimmed one.
//                  The real repair is the chamber parameterisation itself,
//                  which is out of scope here because it ripples into ~30 neonatal scenarios; the
//                  PDA family already works around the same weakness with cont_factor_right 1.5-5.2.
//   ven_uvol       multiplier on the large systemic veins' (VLB/VUB) unstressed volume.
//                  Uniform volume scaling preserves the stressed fraction but leaves CVP
//                  near zero, so trim u_vol to restore venous filling/preload.
//
// Placenta.mat_to2 / mat_tco2 are intentionally NOT columns: the maternal pool is taken
// as gestation-independent, so the term baseline's values carry over unchanged.
//
// 40 is the term_fetus baseline itself — an identity row, useful as documentation and so
// `_make_fetus.mjs 40` is a no-op round-trip that must reproduce the source file.
export const FETAL = {
  30: { weight: 1.35, height: 0.385, pl_vol: 0.50, mat_vol: 0.50, svr: 1.75, pvr: 2.30, hr_ref: 152, br_map: 34, fo: 4.4, fo_septum: 2.2, da_diam: 4.58, da_len: 9.76, umb_art_res: 1260, umb_ven_res: 140, plf_res: 2800, dif_o2: 0.020, dif_co2: 0.027, p50: 18.2, hb: 9.0, cont_left: 0.93, cont_right: 1.16, relax: 1.06, rv_uvol_ratio: 1.64, ven_uvol: 0.85 },
  40: { weight: 3.545, height: 0.519, pl_vol: 1.0, mat_vol: 1.0, svr: 1.0, pvr: 1.0, hr_ref: 145, br_map: 55, fo: 6.0, fo_septum: 3.0, da_diam: 6.0, da_len: 14.0, umb_art_res: 680, umb_ven_res: 100, plf_res: 1500, dif_o2: 0.03, dif_co2: 0.04, p50: 18.8, hb: null, cont_left: 1.0, cont_right: 1.30, relax: 1.0, rv_uvol_ratio: 1.64, ven_uvol: 1.0 },
};

export const FETAL_GAS = Object.keys(FETAL).map(Number).sort((a, b) => a - b);

// snap to the nearest defined fetal row (mirrors nearestGa() in build_patient.mjs)
export const nearestFetalGa = (ga) =>
  FETAL_GAS.reduce((a, b) => (Math.abs(b - ga) < Math.abs(a - ga) ? b : a));
