# Placenta

The `Placenta` model is a **coordinator** for the **fetal** placental circulation and gas exchange.
Like [Pda](./Pda.md) and [Shunts](./Shunts.md), it owns no physics of its own — it drives a set of
pre-built sub-models (umbilical and fetal-placental resistors, the maternal blood pool, and a
blood-blood gas diffusor) from a single set of parameters, and switches the whole unit on or off.

> **This is the FETAL placenta.** It exchanges gases against a **fixed-composition maternal pool**
> (`PL_MAT`) whose O₂/CO₂ contents are held at constant scalars (`mat_to2`/`mat_tco2`) — i.e. an
> idealized, infinite maternal reservoir. The *maternal* intervillous bed and uterine supply are
> modelled separately by [MaternalPlacenta](./MaternalPlacenta.md) and [Uterus](./Uterus.md); when
> those are active they take over the maternal pool (see `skip_mat_gas_write` below).

## Inheritance

```
BaseModelClass
  └── Placenta   (group coordinator — no compartment of its own)
```

Extends `BaseModelClass` directly. `calc_model()` writes onto referenced sub-models; it has no
`el_base`/`vol`/`r_for` of its own.

## What it models

Fetal blood leaves the descending aorta, runs through the umbilical arteries to the fetal side of the
placenta, exchanges O₂/CO₂ with maternal blood across the placental membrane, and returns via the
umbilical vein to the inferior vena cava.

```
DA ──[PL_UMB_ART]──► PL_FETAL_ART ─► PL_FETAL_CAP ─► PL_FETAL_VEN ──[PL_UMB_VEN]──► (PL_UMB_VEN_IVCI) ──► IVCI
                                          │
                                    [PL_GASEX: BloodDiffusor]
                                          │
                                       PL_MAT  (maternal pool, fixed composition)
```

| Reference | Model | Role |
|---|---|---|
| `_umb_art` / `_umb_ven` | `PL_UMB_ART` / `PL_UMB_VEN` | umbilical artery / vein resistors |
| `_plf_art` / `_plf_cap` / `_plf_ven` | `PL_FETAL_ART/CAP/VEN` | fetal-placental resistors |
| `_plm` | `PL_MAT` | maternal blood pool — a `fixed_composition` reservoir held at `mat_to2`/`mat_tco2` |
| `_gas_exchanger` | `PL_GASEX` | `BloodDiffusor` exchanging O₂/CO₂ between fetal capillary and maternal pool |
| `_umb_ven_ret` | `PL_UMB_VEN_IVCI` | standalone umbilical-vein → IVC return resistor (Placenta-owned) |

## Properties

### Configuration (set in the model definition)

| Property | Default | Unit | Description |
|---|---|---|---|
| `placenta_running` | `false` | — | master on/off (drives `is_enabled` of all sub-models) |
| `umb_clamped` | `true` | — | clamp the umbilical/fetal vessels (`no_flow`) while running |
| `skip_mat_gas_write` | `false` | — | when true, do **not** write `PL_MAT` gases here (the Uterus coupling is authoritative) |
| `umb_art_res` | `800` | mmHg·s/L | umbilical-artery resistance |
| `umb_art_res_factor` | `1.0` | — | multiplier on `umb_art_res` |
| `umb_ven_res` | `100` | mmHg·s/L | umbilical-vein resistance |
| `umb_ven_res_factor` | `1.0` | — | multiplier on `umb_ven_res` |
| `plf_res` | `2000` | mmHg·s/L | fetal-placental resistance (applied to art/cap/ven) |
| `plf_res_factor` | `1.0` | — | multiplier on `plf_res` |
| `mat_to2` | `6.85` | mmol/L | maternal total O₂ content held on `PL_MAT` |
| `mat_tco2` | `23` | mmol/L | maternal total CO₂ content held on `PL_MAT` |
| `dif_o2` | `0.0005` | mmol/mmHg·s | O₂ diffusion constant pushed to `PL_GASEX` |
| `dif_co2` | `0.001` | mmol/mmHg·s | CO₂ diffusion constant pushed to `PL_GASEX` |

### Declared outputs

`umb_art_flow`, `umb_art_velocity`, `umb_ven_flow`, `umb_ven_velocity` are declared as dependent
parameters but are **not** updated by the current `calc_model` (reserved read-outs). Read umbilical
flow from the resistors (`PL_UMB_ART.flow` / `PL_UMB_VEN.flow`) instead.

### Local (internal)

`_update_interval` (0.015 s) / `_update_counter` throttle the loop; `_umb_art`/`_umb_ven`/`_plf_*`/
`_plm`/`_gas_exchanger`/`_umb_ven_ret` cache the sub-model references resolved in `init_model`.

## Calculation cycle (`calc_model`)

Every `_update_interval` (0.015 s):

1. **Guard** — return if any required sub-model reference is missing.
2. **Sync enabled state** — every sub-model's `is_enabled` (including the `_umb_ven_ret` return
   resistor) is set to `placenta_running`. This runs on **every** tick (not only while running) so
   that *stopping* the placenta actually disables flow and gas exchange.
3. **Only while running:**
   - **Clamp** — set `no_flow = umb_clamped` on the umbilical/fetal resistors and on the return
     resistor (so a clamp stops flow on both sides).
   - **Resistances** — `umb_art_res · factor`, `umb_ven_res · factor`, `plf_res · factor` onto the
     respective resistors (`plf_res` is applied to the fetal art/cap/ven trio).
   - **Maternal gases** — unless `skip_mat_gas_write`, hold `PL_MAT.to2 = mat_to2`,
     `PL_MAT.tco2 = mat_tco2` (the maternal pool is `fixed_composition`, so the diffusor draws from it
     without depleting it).
   - **Diffusion constants** — push `dif_o2`, `dif_co2` to the gas exchanger.

## Example definition (JSON)

From `term_fetus.json` (placenta running, cord unclamped):

```json
{
  "name": "Placenta",
  "description": "Placenta model",
  "model_type": "Placenta",
  "is_enabled": true,
  "placenta_running": true,
  "umb_clamped": false,
  "skip_mat_gas_write": false,
  "umb_art_res": 680,
  "umb_art_res_factor": 1,
  "umb_ven_res": 100,
  "umb_ven_res_factor": 1,
  "plf_res": 1500,
  "plf_res_factor": 1,
  "mat_to2": 7.4,
  "mat_tco2": 21,
  "dif_o2": 0.03,
  "dif_co2": 0.04
}
```

## Usage in the model

- In **fetal** scenarios (e.g. `term_fetus.json`) the placenta is the gas exchanger and the lungs are
  inert; the open FO ([Shunts](./Shunts.md)) and ductus arteriosus ([Pda](./Pda.md)) complete fetal
  circulation.
- **Birth transition** is modelled by clamping (`umb_clamped = true`, flow stops) and then stopping
  (`placenta_running = false`, the whole unit is disabled).
- When the **maternal–fetal coupling** is active, [Uterus](./Uterus.md) / [MaternalPlacenta](./MaternalPlacenta.md)
  drive `PL_MAT` instead; set `skip_mat_gas_write = true` so the maternal pool has exactly **one**
  authoritative writer per step.

## Notes & caveats

- **Gestational age is not a parameter of this model.** Every constant here is anchored at term
  (the literature comments cite 37–39 week measurements: cord 55 cm, umbilical-artery CSA
  0.147 cm²). Nothing in the engine reads `model.gestational_age`. Gestation-specific fetal
  scenarios therefore set these props explicitly from a per-GA table in
  [`scripts/_ga_tables.mjs`](../scripts/_ga_tables.mjs), applied by
  [`scripts/_make_fetus.mjs`](../scripts/_make_fetus.mjs) — see
  [fetal_circulation.md](./fetal_circulation.md).
- **The coordinator props are the levers — not the sub-models.** `calc_model` rewrites
  `PL_GASEX.dif_o2`/`dif_co2` from `this.dif_o2`/`dif_co2`, and `PL_MAT.to2`/`tco2` from
  `mat_to2`/`mat_tco2`, on **every** step. Writing to `PL_GASEX.dif_o2` or `PL_MAT.to2` directly is
  silently clobbered. Likewise the umbilical/fetal-placental resistors are rewritten from
  `umb_art_res`/`umb_ven_res`/`plf_res` (times their `*_factor` multipliers, which are plain
  persistent props — set once, never reset per step).
- **Gas exchange sits on a full-equilibration plateau.** At the shipped fetal settings the exchanger
  equilibrates fetal capillary blood essentially completely to the maternal pool (umbilical-vein
  pCO₂ equals `PL_MAT` pCO₂ exactly). So `mat_to2`/`mat_tco2` are the *effective* gas setpoints and
  `dif_o2`/`dif_co2` have little authority — raising them changes almost nothing. Calibrate fetal
  oxygenation and pCO₂ through the maternal contents.
- **`PL_*` compartments are outside every scaler group.** No placental compartment appears anywhere
  in a scenario's `scaler_config`, so `ModelScaler.scale_to_weight` does **not** shrink the placenta.
  A fetus scaled to a smaller weight keeps a term-sized placental blood volume unless it is trimmed
  explicitly (at 30 wk that is the difference between 164 and 122 mL/kg of fetoplacental blood).
- **`PL_MAT` holds the *mother's* blood, and `Blood` writes to it.** `Blood.set_solute()` and
  `Blood.set_P50()` propagate to every registered blood component, `PL_MAT` included. Setting a
  fetal haemoglobin or unmeasured-anion value therefore changes the maternal pool too — and because
  `mat_to2` pins its O₂ *content*, lowering its haemoglobin below the implied carrying capacity
  drives the pool to 100% saturation with a wildly unphysiological dissolved pO₂, which then
  propagates down the umbilical vein. Snapshot and restore `PL_MAT.P50_0` and `PL_MAT.solutes`
  after any such write (`_make_fetus.mjs` §E and `build_patient.mjs`'s `restoreMaternalPool()` do).
- **Two independent off-switches.** `placenta_running = false` disables every sub-model (flow *and*
  gas exchange stop). `umb_clamped = true` stops flow only (via `no_flow`) while the placenta keeps
  running — useful to model cord occlusion with the unit otherwise intact.
- **Maternal pool is an infinite reservoir.** `PL_MAT` is `fixed_composition`, so the diffusor
  exchanges gases with it without changing its composition; the Placenta also re-asserts
  `mat_to2`/`mat_tco2` each tick (unless `skip_mat_gas_write`).
- **`mat_to2`/`mat_tco2` are total contents (mmol/L), not partial pressures** — the gas exchange
  itself is partial-pressure driven inside `PL_GASEX`, which derives pCO₂/pO₂ from these contents.
- **Sub-model references are required.** `calc_model` skips the tick if any is missing rather than
  dereferencing null.
- **The umbilical-vein → body return is an autonomous resistor under Placenta control.** The return
  segment `PL_UMB_VEN → IVCI` is the resistor `PL_UMB_VEN_IVCI`, declared as a standalone `Resistor`
  in the model definition — deliberately **not** an entry in `IVCI.inputs`. If it were an IVCI input,
  `IVCI` (a `BloodVessel`) would auto-create and co-manage it, re-asserting its `is_enabled`/`no_flow`
  every step and leaving it outside the placenta's two off-switches (a one-way leak of placental blood
  into the fetal IVC whenever the unit was stopped or clamped). As a free resistor, nothing else owns
  it: the `Placenta` resolves it by name in `init_model` (`_umb_ven_ret`) and drives its `is_enabled`
  (= `placenta_running`) and `no_flow` (= `umb_clamped`) alongside the rest of the unit. Its
  resistance is left at the scenario value, so running-unclamped hemodynamics are unchanged.
  **When wiring a new placenta scenario, connect the umbilical vein to the IVC with a standalone
  `PL_UMB_VEN_IVCI` resistor — do not add `PL_UMB_VEN` to `IVCI.inputs`,** or the off-switches break.
