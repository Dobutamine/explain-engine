# Shunts

The `Shunts` model is a thin coordinator (like [Pda](./Pda.md)) that drives the resistances of the
**non-ductal shunts** from a small set of geometric inputs. It does not hold volume or pressure
itself — it owns no sub-models of its own but writes each step onto five pre-existing `Resistor`s.

It covers three shunt families:

| Shunt | Resistors driven | Path |
|---|---|---|
| **Foramen ovale (FO)** | `LA_RAIVCI`, `LA_RASVC` | LA ↔ the two right-atrial streams (RAIVCI, RASVC) |
| **Ventricular septal defect (VSD)** | `VSD` | LV ↔ RV |
| **Intrapulmonary shunts (IPS)** | `IPSL`, `IPSR` | arterial → venous within each lung (LL_ART→LL_VEN, RL_ART→RL_VEN) |

(The ductus arteriosus is handled separately by the [Pda](./Pda.md) model.)

## Inheritance

```
BaseModelClass
  └── Shunts   (group coordinator — no compartment of its own)
```

Extends `BaseModelClass` directly. `calc_model()` computes Hagen-Poiseuille resistances and writes
them onto the referenced `Resistor`s; it has no `el_base`/`vol`/`r_for` of its own.

## What it models

The FO and VSD are openings whose resistance follows the **Hagen-Poiseuille** law from their diameter,
the septal thickness (length), and blood viscosity. Closure is expressed directly via `diameter_fo` /
`diameter_vsd` (0 mm = closed → `no_flow`). The intrapulmonary shunts are a small *fixed* resistance
representing anatomic right-to-left lung shunting; they are **not** diameter-driven.

## Properties

### Configuration (set in the model definition)

| Property | Default | Unit | Description |
|---|---|---|---|
| `diameter_fo` | `2.0` | mm | foramen ovale diameter (0 = closed) |
| `diameter_fo_max` | `10.0` | mm | FO diameter ceiling (clamp) |
| `diameter_vsd` | `2.0` | mm | ventricular septal defect diameter (0 = closed) |
| `diameter_vsd_max` | `10.0` | mm | VSD diameter ceiling (clamp) |
| `atrial_septal_width` | `3.0` | mm | FO channel length |
| `ventricular_septal_width` | `5.0` | mm | VSD channel length |
| `fo_lr_factor` | `10.0` | — | left-to-right resistance multiplier on the FO (flap valve) |
| `ips_res` | `5000` | mmHg·s/L | fixed intrapulmonary shunt resistance |
| `viscosity` | `6.0` | cP | blood viscosity used in the resistance formula |

### Computed / reported (outputs)

| Property | Unit | Description |
|---|---|---|
| `res_fo` | mmHg·s/L | computed FO resistance (per orifice, before `fo_lr_factor`) |
| `res_vsd` | mmHg·s/L | computed VSD resistance |
| `flow_fo` | L/s | combined FO flow (`LA_RAIVCI.flow + LA_RASVC.flow`) |
| `flow_vsd` | L/s | VSD flow |
| `velocity_fo` | m/s | FO orifice velocity from combined flow |
| `velocity_vsd` | m/s | VSD orifice velocity |

### Local (internal)

`_fo_ivci`, `_fo_svc`, `_vsd`, `_ipsl`, `_ipsr` cache the five resistor references;
`_refs_resolved`/`_refs_warned` gate the one-time resolution and the single missing-wiring warning.

## Calculation cycle (`calc_model`)

1. **Resolve references once.** `_resolve_refs()` caches `LA_RAIVCI`, `LA_RASVC`, `VSD`, `IPSL`,
   `IPSR`. If any is missing it logs a single warning and `calc_model` returns early every step (so a
   partial wiring degrades gracefully instead of throwing).
2. **Clamp diameters** to their `*_max`.
3. **Flow gating** — set `no_flow = (diameter === 0)` on the FO (`LA_RAIVCI`, `LA_RASVC`) and VSD
   resistors.
4. **Resistances** — `res_fo`, `res_vsd` from `calc_resistance(diameter, septal_width, viscosity)`.
5. **Push resistances** to the resistors (see FO asymmetry below); IPS resistors get the constant
   `ips_res`.
6. **Read back flows** and compute orifice velocities (`Q/A`).

## Foramen ovale: flap-valve asymmetry and the split path

The FO is driven through **two** resistors (`LA_RAIVCI`, `LA_RASVC`) because the model splits the
right atrium into an IVC-stream and an SVC-stream. Each resistor receives:

```
r_for  = res_fo · fo_lr_factor      (LA → RA, restricted)
r_back = res_fo                     (RA → LA, easy)
```

`fo_lr_factor` (default 10, often higher in scenarios — e.g. 25) makes left-to-right flow much harder
than right-to-left, reproducing the **flap-valve** behaviour: in fetal/transitional physiology the FO
shunts right-to-left, and reverses only under raised left-atrial pressure.

> **Modelling note.** Because the FO is represented as two *parallel* resistors that each carry the
> full `res_fo`, the orifice's effective resistance is `res_fo / 2`. `velocity_fo` is therefore
> computed from the **combined** flow (`LA_RAIVCI.flow + LA_RASVC.flow`) over the single-orifice area
> from `diameter_fo`.

## Velocity outputs

```
area     = π · (diameter_mm · 1e-3 / 2)²          [m²]
velocity = (flow_L/s · 1e-3) / area               [m/s]   (0 when area = 0)
```

`velocity_fo` uses the summed FO flow; `velocity_vsd` uses the VSD flow.

## Resistance formula — `calc_resistance(diameter, length, viscosity)`

Standard Hagen-Poiseuille for a uniform cylinder:

```
R = (8 · μ · L) / (π · r⁴)        in Pa·s/m³   →  × 0.00000750062  →  mmHg·s/L
```

with diameter/length in mm and viscosity in cP. Returns the sentinel `1e8` (no flow) when
`diameter ≤ 0` or `length ≤ 0`. (This is a private copy of the same formula [Pda](./Pda.md) uses.)

## Example definition (JSON)

From `term_neonate.json` (a healthy term neonate — both septal openings closed):

```json
{
  "name": "Shunts",
  "description": "shunts (FO, ASD, VSD) model",
  "model_type": "Shunts",
  "is_enabled": true,
  "diameter_fo": 0,
  "diameter_fo_max": 10,
  "diameter_vsd": 0,
  "diameter_vsd_max": 10,
  "atrial_septal_width": 3,
  "ventricular_septal_width": 5,
  "fo_lr_factor": 25,
  "viscosity": 6,
  "ips_res": 25000
}
```

## Usage in the model

- A healthy term neonate runs with `diameter_fo = 0` and `diameter_vsd = 0` (closed); transitional and
  congenital scenarios open them (e.g. patent foramen ovale, muscular/perimembranous VSD).
- The fetal scenario keeps the FO open with a high `fo_lr_factor` so it shunts right-to-left, matching
  fetal circulation (see [Placenta](./Placenta.md) and the term-fetus scenario).
- `IPSL`/`IPSR` provide a small constant anatomic right-to-left lung shunt independent of the septal
  defects; raising/lowering `ips_res` tunes baseline shunt fraction.

## Notes & caveats

- **`diameter_fo` is NOT the lever for the atrial split.** At fetal sizes `res_fo` is ~13x lower
  than the tricuspid valve's resistance, so the foramen is a hole rather than a restriction and the
  two ventricles draw from a common atrial pressure. Measured on the fetal scenarios, 6.0 -> 3.0 mm
  moves RV:LV by 0 points; it only bites below 2 mm, where it swings violently (1 mm -> 73:27).
  `fo_lr_factor` likewise has no effect on the split. What sets it is which ventricle ejects better
  — see [fetal_circulation.md](./fetal_circulation.md).
- **`diameter_fo` and `atrial_septal_width` are absolute millimetres that no scaler touches.**
  `atrial_septal_width` is the length term in the foramen's resistance law, so leaving it at term
  thickness in a scaled-down body makes the foramen artificially restrictive; see
  [fetal_circulation.md](./fetal_circulation.md).
- **References resolve only once.** After the five resistors are cached, they are never re-resolved; a
  model added/removed at runtime would not be picked up. Missing wiring at first call is reported with
  a single console warning.
- **`viscosity` is a static input here** — unlike [Pda](./Pda.md) (which pulls it from its capacitance
  each step), `Shunts.viscosity` is whatever the definition sets and does not track hematocrit.
- **IPS resistance is fixed.** `IPSL`/`IPSR` always receive `ips_res`; there is no diameter or
  flow-gating on them.
