# Fetal circulation scenarios

The scenario library ships fetuses *in utero* at two gestational ages:

| Scenario | GA | Weight | Built by |
|---|---|---|---|
| [`term_fetus`](../model_definitions/term_fetus.json) | 40 wk | 3.545 kg | `scripts/_make_term_fetus.mjs` (single-point transform of `term_neonate`) |
| [`fetus_30wk`](../model_definitions/fetus_30wk.json) | 30 wk | 1.35 kg | `scripts/_make_fetus.mjs 30` (per-GA transform of `term_fetus`) |

`term_fetus` is the anchor: it carries the fetal topology and its own fetal diagram. Every other
gestational age is derived from it by `_make_fetus.mjs`, so a retune of `term_fetus` propagates by
re-running the generator and the reseed.

## What makes a scenario "fetal"

Six properties. They are asserted by `_make_fetus.mjs` and re-asserted by `reseed_fetus.mjs` after
warm-up, because each one silently destroys the fetal circulation while the model still builds and
still prints a plausible-looking panel:

| Invariant | Why |
|---|---|
| `Placenta.placenta_running === true` | the placenta is the gas-exchange organ |
| `Placenta.umb_clamped === false` | the cord is patent |
| `Shunts.ips_res >= 1e7` | intrapulmonary shunts closed — fetal lung flow is all capillary; an open IPS adds a parallel low-resistance path that inflates pulmonary flow |
| `Pda.diameter_relative === 1.0` | the duct is fully relaxed in utero |
| `Breathing.is_enabled === false` | no ventilatory drive |
| `GASEX_LL/RL.dif_o2 === dif_co2 === 0` | the fluid-filled lung exchanges no gas. Zeroing the *constants* is what makes this stick — clearing a `BloodDiffusor`'s `is_enabled` does not survive the build |

`selectProfile`'s `isFetal()` predicate (`scripts/_probe.mjs`) sniffs the first two, which is
unambiguous across the shipped library: every neonatal and adult scenario has
`placenta_running = false, umb_clamped = true`.

## Why gestational age costs a calibration pass

**Nothing in the engine reads `model.gestational_age`.** It is metadata, consumed only by probe
range tables and the chat context string. (`Uterus`/`MaternalPlacenta` have a `preg_ga`, but that is
the *maternal* pregnancy clock and is deliberately distinct.)

**`ModelScaler.scale_to_weight()` scales volumes only** — every elastance and resistance
inverse-allometry line in it is commented out. Worse, it cannot see the placenta at all: no `PL_*`
compartment appears in any scenario's `scaler_config`.

So scaling a fetus to a new gestation is not one call. It is a hand-fitted row of levers that
compensates for what volume scaling leaves behind, which is what
[`scripts/_ga_tables.mjs`](../scripts/_ga_tables.mjs) holds. The table is the documentation for each
column; the values are **starting points refined by probe iteration**, the same status as
`_make_preterm.mjs`'s `PRETERM` table.

The three traps that cost the most time, in order:

1. **The un-scaled placenta.** Forget it and you get a 1.35 kg fetus carrying a term placenta's
   blood: 164 mL/kg fetoplacental volume instead of ~122, with the placenta holding 52% of fetal
   blood instead of 35%. The model builds and runs and looks plausible.
2. **The placenta is a large parallel low-resistance path**, so systemic resistance is a weak MAP
   lever on its own — raising SVR mostly diverts flow into the umbilical circuit (placental share
   climbs past 55%). The umbilical/fetoplacental resistances must rise with it.
3. **Absolute anatomic millimetres.** `Pda.diameter_ao_max`/`diameter_pa_max`/`length` and
   `Shunts.diameter_fo`/`atrial_septal_width` are millimetres no scaler touches.
   `Pda.diameter_relative` is a `[0..1]` *patency fraction*, not a size — conflating the two is the
   easy bug. The duct is anchored to the Szpinda regressions quoted in `Pda.js`.

## Operating points

Measured with `node scripts/probe_fetus.mjs <scenario>`, not copied from a script header.

| | `term_fetus` (40 wk) | `fetus_30wk` | human reference |
|---|---|---|---|
| HR | 146.5 bpm | 147.8 | — |
| ABP sys/dia/**map** | 67.2 / 44.0 / **55.7** | 44.6 / 32.0 / **38.3** | — |
| PAP mean | 56.9 | 39.1 | — |
| **PA − Ao** | **1.2 mmHg** | **0.8** | ≈ 0 (wide-open duct) |
| CVP | 3.8 | 2.5 | — |
| CVO | 1.341 L/min = **378 mL/kg/min** | 0.508 L/min = **376** | ~400–450 |
| **RV : LV** | **55 : 45** | **55 : 45** | ~55 : 45 (MRI) |
| RV / LV ejection fraction | 57% / 55% | ~45% / ~41% | — |
| placental share of CVO | 41% | 41% | ~30 (MRI) / ~45 (ovine) |
| **pulmonary share** | **15%** | **12%** | 11–25% |
| ductus arteriosus | 41% | 44% | 30–46% |
| foramen ovale | 30% | 33% | 27–34% |
| O₂ gradient UV / IVC / AA / AD / UA | 88 / 71 / 66 / 61 / 61 % | 89 / 70 / 65 / 59 / 59 % | — |
| umbilical-artery gas | pH 7.27, pCO₂ 50, BE −5 | pH 7.27, pCO₂ 50, BE −5 | pH ~7.35 |

Pulmonary share is deliberately **lower at 30 wk than at term**: this table follows the human MRI
reading in which pulmonary blood flow rises toward term. The Doppler literature instead has it
peaking near 30 wk, which would invert that ordering — see the `pvr` note in `_ga_tables.mjs`.

**PA ≈ Ao is a fetal invariant, and it is what the ventricular split hangs on.** With a wide-open
duct the pulmonary artery and aorta are one chamber hydraulically, so their mean pressures must
match. They previously did not (PA 62.6 vs Ao 50.1, a 12.5 mmHg gap) — see below.

The **oxygenation ordering UV > IVC > AA > AD** is the primary pass/fail: it is what streaming
through the foramen ovale and ductus venosus produces, and it collapses first when a fetal scenario
is wrong. `AD == UA` is expected — it is the same blood.

Note the shunt flows print **negative** in `probe_fetus.mjs`: `Pda.flow_pa` and `Shunts.flow_fo` are
positive for left→right, so the fetal direction (PA→Ao, R→L) is negative. A negative percentage
there is correct, not an error.

## Ventricular dominance — what actually sets it

The fetus must be RV-dominant. Both scenarios used to come out LV-dominant (48:52 and 46:54); they
now run 55:45. The diagnosis is worth recording because two of the three obvious levers do nothing.

**The split is an identity, not a free parameter:**

```
LV output = foramen flow + pulmonary venous return
```

This holds exactly at every operating point measured. So the whole question is how much crosses the
foramen — and the right atrium divides its blood between the tricuspid valve and the foramen
according to which ventricle ejects better, *not* according to the foramen's size.

**What does not work:**

- **Foramen diameter.** `res_fo` (4.24 mmHg·s/L at 6 mm) is ~13× *lower* than the tricuspid valve's
  55, so the foramen is a hole, not a resistance — the two ventricles effectively draw from a common
  atrial pressure. Measured: 6.0 → 4.4 → 3.0 mm gives 48:52 at every value. It only bites below
  2 mm and then swings violently (1 mm → 73:27). A steep unstable band is a bad calibration knob.
- **`fo_lr_factor`.** No effect on the split.
- **RV unstressed volume, on its own.** Cutting it to the LV's value raises RV ejection fraction
  25 → 34% but leaves the split at 46:54: it makes the RV both stronger *and* more compliant, so the
  right atrium still decompresses across the foramen. It is an EF knob, not a split knob.
- **The foramen's second path (`LA_RASVC`).** Carries ~1%; disabling it changes nothing. (It is still
  anatomically wrong — superior-vena-cava blood does not cross the foramen in life.)

**What does work — and why it was a bug, not a tuning gap:**

1. **The ductus arteriosus was too narrow, and it is an RV-only afterload.** Duct resistance carries
   a Bernoulli orifice term scaling as 1/area² (`Pda.js:200-210`), so a narrow duct is expensive.
   At the previously shipped 3.0 mm it cost a **12.5 mmHg PA-over-Ao gradient that only the right
   ventricle pays** — which is why the RV under-ejected and the atrial blood went left. Three things
   independently said 3.0 mm was wrong: it breaks the PA ≈ Ao invariant the probe itself checks for;
   it contradicts the Szpinda regression quoted in `Pda.js:25` (3.95 mm at 40 wk); and the
   duct-dependent lesions `hlhs` and `pa_vsd` had already overridden it to 4.0 because 3.0 cannot
   carry systemic output. Measured on `term_fetus`: 3.0 mm → 12.5 mmHg / 48:52; 3.95 → 5.0 / 50:50;
   6.0 → 1.0 / 51:49; 8.0 → −0.1 / 52:48.
2. **`Heart.cont_factor_right` supplies the remainder** (1.30 at term, 1.16 at 30 wk). Monotone and
   well-behaved, and it also pulls the foramen share down toward the human 27–34%.
   It is *mostly* independent of PVR but not entirely: at a fixed duct the split held 55:45 across
   PVR ×21 → ×9.5, yet raising the 30 wk `pvr` from 1.35 to 2.30 cost a point (55:45 → 54:46) and
   needed `cont_right` 1.11 → 1.16 to recover. Re-check the split after any PVR change.
3. **`RV.u_vol` restores a physiological ejection fraction** (33 → 57% at term). Independent of the
   split, so it is set once and left alone.

**The residual compensation.** Points 2 and 3 are still compensation for a chamber parameterisation
the fetal transform inherits from `term_neonate` unexamined: the RV ships with an unstressed volume
5.46× the LV's (4.00 vs 0.73 mL) and a *lower* `el_max` (22200 vs 27200) — correct for a neonate,
wrong for a fetus. The real repair is those chamber values, which is out of scope here because it
ripples into ~30 neonatal scenarios. The PDA family already works around the same weakness with
`cont_factor_right` between 1.52 and 5.2.

> Note the shipped `term_fetus` had drifted from its own generator header, which claimed RV:LV
> 51:49. The split appears to have crossed from RV- to LV-dominant across the new-PDA-model /
> bidirectional-shunts / HbF commits, and was never re-measured — commit `1689814` lists five
> quantities as unchanged and omits this one. **Re-measure with `probe_fetus.mjs`; do not trust a
> header.**

## Known limitations

These are inherited by every fetal scenario and are worth stating before the numbers are used for
teaching:

- **The umbilical arteriovenous CO₂ gradient is too wide.** UV pCO₂ 31 vs UA pCO₂ 50 is a 19 mmHg
  gradient where the literature is 8–10, and UA pH 7.27 is a post-labour value rather than an
  undisturbed in-utero one (cordocentesis: UA ≈ 7.35, UV ≈ 7.38). The lever is `Placenta.mat_tco2`.
- **Placental share runs sheep-like** (~41% against human MRI estimates of ~30%; the ovine figure is
  ~45%). Pulmonary, ductal and foramen shares are now all inside their human ranges, so the
  placental share is the remaining outlier. Judge a new gestation by its *delta from term* as well
  as by the absolute number.
- **CVO per kg is still nearly flat across gestation** (376 at 30 wk vs 378 at term) where human MRI
  data have it *falling* with GA, i.e. the 30 wk fetus should run clearly higher per kg. Both rose
  from ~314 once the duct and PVR were corrected, so the gap to the ~400–450 mL/kg/min literature
  figure is now small, but the gestational *trend* is still not reproduced.
- **The umbilical arteriovenous CO₂ gradient is unchanged by this work** and remains the largest
  outstanding discrepancy (see above).
- The **`Brain` compartment is now present** in both fetal scenarios. It had been missing: the
  committed `term_fetus` predated `Brain` being added to `term_neonate`, and regenerating picked it
  up. Cerebral autoregulation is enabled, but its setpoints are the neonatal ones and have not been
  re-fitted for fetal pressures — treat brain-sparing behaviour as unvalidated.

## Workflow

```bash
node scripts/_make_fetus.mjs 30                       # generate from term_fetus + the GA table
node scripts/probe_fetus.mjs fetus_30wk --seconds 150 # read the panel; iterate the table row
node scripts/reseed_fetus.mjs 30                      # dry run -> /tmp/fetus_30wk_reseed.json
node scripts/reseed_fetus.mjs 30 --write              # bake the equilibrium into the scenario
node scripts/probe_fetus.mjs fetus_30wk --seconds 20  # the reseed took if this matches the 150 s run
node scripts/probe_fetus.mjs                          # regression: term_fetus must be unchanged
```

Adding a gestation is one row in `FETAL` (`scripts/_ga_tables.mjs`) plus a make/probe/reseed loop.

`scripts/build_patient.mjs` also understands fetal baselines — it auto-detects one, seeds from the
same `FETAL` table, skips the neonatal RDS/PDA levers, and drives pO₂/pCO₂ from
`Placenta.mat_to2`/`mat_tco2` instead of the (inert) alveolar diffusors and ventilatory drive.

> **Probes exit 0 on bad physiology.** Only a build failure exits 1. The fetal-invariant assertions
> in `_make_fetus.mjs` and `reseed_fetus.mjs` are the only real gates; everything else is a table
> you read.
