# Testing

How to exercise and verify the Explain engine **headlessly** — build a scenario, drive the step loop, and read model state directly from Node, without a browser, a Web Worker, or the Vue layer. This is the workflow used for physiological calibration and model-development verification. The tools here are the `scripts/*.mjs` files; this doc explains the shared harness they sit on, the canonical probe pattern, and the full inventory. See [ARCHITECTURE](./ARCHITECTURE.md) for the two-thread picture and the `{type, message, payload}` wire protocol these scripts reuse.

> **Everything you need is in this repo, with no install step.** The tools are the `scripts/*.mjs`
> files at this repo's root, beside the engine source they drive. They `import` the engine
> **read-only** — they never modify engine source — and run with **`node` directly**:
>
> ```bash
> git clone git@github.com:explain-labs/explain-engine.git && cd explain-engine
> node scripts/probe_vitals.mjs term_neonate   # no npm install needed
> ```
>
> This repo has **zero dependencies and zero devDependencies**, so a bare clone runs a full
> calibrated simulation immediately. There is **no `npm test`** and no CI suite — `package.json`
> wires one convenience script (`probe`). These are interactive verification tools you run by hand.

## The headless harness

`scripts/_harness.mjs` exports a single function, `createEngine({ verbose })`, that boots the engine in plain Node and returns a small driver object:

```js
import { createEngine } from "./_harness.mjs";
const eng = await createEngine();           // pass { verbose: true } to see engine logs
const model = eng.build(def);               // build a model_definition, get the live model by reference
eng.calc(60);                               // run 60 sim-seconds synchronously
console.log(model.models.Heart.heart_rate); // state is final and readable immediately
```

| Member | What it does |
|---|---|
| `send(type, message, payload)` | Raw envelope dispatch — `self.onmessage({ data: { type, message, payload } })`. The same `{type, message, payload}` envelope [`Model.js`](../Model.js) posts over the wire (see [ARCHITECTURE](./ARCHITECTURE.md)). |
| `build(def)` | `send("POST", "build", def)` then `send("GET", "state", [])`; returns the live `model` handle (by reference). `def` is a `model_definition` object. |
| `calc(seconds)` | `send("POST", "calc", seconds)` — runs `seconds / modeling_stepsize` steps **synchronously**. |
| `scale(group, factor)` | `send("POST", "scale", { group, factor })` — routes to `ModelEngine.scale_model`. |
| `get model` | The captured live `model` object (same reference `build` returned, or `null` before build). |
| `log` | The original `console.log` (the harness silences `console.log` unless `verbose`), for callers that want to restore output. |

### The zero-engine-edit shim trick

[`ModelEngine.js`](../ModelEngine.js) is a **Web-Worker module**: its only entry point is `self.onmessage`, and it replies via `postMessage`. Neither global exists in plain Node. The harness fabricates them **before** importing the engine, so the engine loads unmodified:

1. **ESM resolve hook.** The engine uses Vite-style **extensionless** relative imports (e.g. `import ... from "./ModelIndex"`), which Node's ESM resolver rejects. `scripts/resolve-extensionless.mjs` is a resolve hook that catches a failed relative-specifier import and retries it with a `.js` suffix. The harness registers it first: `register("./resolve-extensionless.mjs", import.meta.url)`.
2. **Global shims, installed BEFORE the engine import.** `globalThis.self = globalThis`, and `globalThis.postMessage = (msg) => {…}` — the fake `postMessage` captures the engine's replies: a `state` message stashes the live `model` (`liveModel = msg.payload`, **by reference, not a clone**), and `error` / `status ERROR` messages are forwarded to `console.error`.
3. **Import the engine.** `await import("../ModelEngine.js")` runs the module body, which registers `self.onmessage` on the shimmed global.
4. **Drive it** through the same envelope the real worker uses: `send("POST", "build", def)`, `send("GET", "state", [])` to grab the live `model`, `send("POST", "calc", seconds)` to step.

Because `calc` runs the step loop **fully synchronously** (no `setInterval`, no realtime batching), model state is final and directly readable the instant `calc` returns — that is what makes deterministic, assertion-style probing possible.

### `headless.mjs` — the standalone calibration panel

`scripts/headless.mjs` is the original standalone harness (the harness shim was later extracted from it into `_harness.mjs`). It boots the engine the same way but is specialized as a **renal + hormonal calibration panel**: it builds a scenario, freezes the ANS by default (calibration protocol), and cycle-averages a Kidneys / Hormones read-out.

```
node scripts/headless.mjs <scenario> [--seconds N] [--window W] [--no-ans] [--no-autoreg] [--verbose]
```

`<scenario>` is a filename in `model_definitions/` without `.json`. It supports live-tuning overrides on the Kidneys/Hormones models (`--kf`, `--water`, `--frac na=…,k=…`, `--hset key=val,…`) and a perturbation phase (`--bleed FRAC`, `--naload DELTA`, `--phase2 S`), printing a JSON report to stdout (diagnostics to stderr).

## Writing/running a probe

A probe is a self-contained `.mjs` that boots the engine, runs a scripted physiological scenario, and prints a human-readable verdict. The shared shape (canonically in `scripts/probe_vitals.mjs`):

1. **Boot** — register the resolve hook, install the `self`/`postMessage` shims, `await import("../ModelEngine.js")`, define `send`. (Probes predating `_harness.mjs` inline this; newer ones import `createEngine`.)
2. **Build** — read `model_definitions/<scenario>.json`, unwrap `json.model_definition || json`, `send("POST","build",def)`, `send("GET","state",[])`, capture `model`. A build failure exits `1`.
3. **Isolate (optional)** — disable the system that would mask the one under test, typically the baroreflex: `if (model.models.Ans) model.models.Ans.is_enabled = false`. (`probe_vitals.mjs` keeps the ANS **on** — its target is the *regulated* operating point — and exposes `--no-ans` to turn it off.)
4. **Warm to steady state** — one big synchronous `send("POST","calc",SECONDS)` (default 60–120 s) to clear startup transients.
5. **Measure** — a slice-loop that advances the sim in small steps and cycle-averages the pulsatile signals so beat-to-beat ripple cancels:

   ```js
   const SLICE = 0.02;                  // 20 ms, sub-cardiac-cycle
   const N = Math.round(WINDOW / SLICE);
   for (let i = 0; i < N; i++) {
     send("POST", "calc", SLICE);
     add("map", M.minmax?.abp_pre_pres_mean);  // read off the live Monitor / component models
     // …
   }
   for (const k in acc) acc[k] /= N;
   ```

   Reads come off the live [Monitor](./Monitor.md) (hemodynamics: `heart_rate`, `minmax.*`, `flows.*`, `sao2_*`, `etco2`, `temp`) and component models (e.g. `AA` for the arterial blood gas, `IVCI` for a mixed-venous proxy, `Pda.flow_pa` for the ductal shunt).
6. **Perturb (optional)** — apply an insult between phases (e.g. remove a volume fraction from every blood compartment for a haemorrhage, then `calc` again and re-measure) to compare baseline vs perturbed.
7. **Report** — print a labelled table with normal-range flags (`ok` / `LOW` / `HIGH`).

`probe_vitals.mjs` is the canonical example: it reports HR, ABP (sys/dia/mean), CVP, PAP, CO/RV-output, cardiac index, SpO2 (pre/post-ductal), PDA shunt, SvO2, RR, etCO2, temperature, and a full arterial blood gas, each flagged against a `RANGES` table selected by `--profile adult|neonate|preterm_24|…|preterm_36` (auto-picked from body weight when omitted). The measurement loop, the `RANGES` tables, and `selectProfile()`/`flagOf()` are shared via `scripts/_probe.mjs` so the generic builder (`build_patient.mjs`) measures identically.

### Run examples

```bash
node scripts/probe_vitals.mjs term_neonate
node scripts/probe_vitals.mjs preterm_28wk --profile preterm_28
node scripts/probe_vitals.mjs adult_female --no-ans --seconds 90
node scripts/probe_brain.mjs --scenario term_neonate --bleed 0.3
node scripts/probe_pda.mjs preterm_28wk --beats 6
```

Common flags seen across the vitals/brain/pda probes: `--seconds N` (warm-up), `--window W` (averaging window), `--verbose` (un-silence engine logs), `--no-ans` (freeze the baroreflex). Scenario-specific probes add their own (e.g. `probe_brain.mjs` `--bleed`/`--edema`/`--scenario`, `probe_pda.mjs` `--beats`/`--trace`). Confirm a probe's flags by reading its header comment — each script documents its own `Usage:` line.

## Important: probes are not CI gates

Probes are **interactive verification tools, not pass/fail test cases.** They print verdicts (labelled lines flagged `ok`/`LOW`/`HIGH`, or a `console.table`) and you read the result. A failed physiological assertion does **not** make the process exit non-zero — the only thing that exits `1` is a **build failure** (no `model`, missing required model). Do not wire them into a CI green/red check expecting a non-zero exit on a bad number; they will exit `0` while printing `HIGH`. There is no `npm test` and no aggregate runner — run the relevant probe by hand and inspect its output.

## Probe inventory

35 `probe_*.mjs` scripts. Group by what they verify:

| Group | Scripts | Verifies |
|---|---|---|
| **Core vitals / calibration** | `probe_vitals.mjs`, `probe_tune.mjs`, `probe_ea.mjs` | Regulated vitals + ABG vs normal ranges; the live closed-loop tuner; mitral E/A ratio. |
| **Physiology systems** | `probe_brain.mjs`, `probe_respiratory.mjs`, `probe_surfactant.mjs`, `probe_derecruitment.mjs`, `probe_thermo.mjs`, `probe_glucose.mjs`, `probe_lactate.mjs`, `probe_renal.mjs`, `probe_heartfunction.mjs`, `probe_cpap.mjs`, `probe_apnea.mjs`, `probe_arrhythmia.mjs`, `probe_drugs.mjs`, `probe_pge1.mjs` | Cerebral autoregulation/ICP; respiratory/acid-base dose-response sweeps (FiO2, O2 diffusion, minute volume, UMA); RDS recruitment/derecruitment + surfactant; thermoregulation; glucose/insulin; hypoxic lactate; GFR + RAAS/ADH response to haemorrhage and volume load; load-induced contractility; CPAP/PS ventilation of spontaneous breathing; apnea of prematurity (episode count, SpO2/HR nadirs, desat→brady lag; `--no-chemoreflex` attribution); conduction arrhythmias; adrenaline/noradrenaline PK/PD; PGE1 ductal patency. |
| **Devices** | `probe_ventilator.mjs`, `probe_ecls.mjs`, `probe_resuscitation.mjs` | Pressure-control ventilation of a preterm RDS lung with spontaneous drive off, sweeping FiO2 / rate / PEEP; veno-arterial ECMO rescue under near-abolished alveolar diffusion, sweeping pump speed / sweep-gas flow (both report the **emergent** blood gas from the gas-exchange physics, not the device); CPR — under a simulated arrest, verifies the compression waveform, that compressions drive forward aortic flow via `pres_ext`, the `vent_no`-breaths-per-pause timing, and a clean `switch_cpr` re-toggle. |
| **Fetal / maternal** | `probe_fetus.mjs [scenario]`, `probe_uterus.mjs`, `probe_placenta.mjs` | Fetal circulation (takes a scenario stem, default `term_fetus`; see [fetal_circulation.md](./fetal_circulation.md)); uterine bed / pregnancy adaptation / contractions; maternal placenta. |
| **PDA / CDH** | `probe_pda.mjs`, `probe_cdh.mjs` | PDA Doppler envelope classification; congenital diaphragmatic hernia phenotypes. |
| **CHD family** | `probe_as.mjs`, `probe_coarc.mjs`, `probe_dtga.mjs`, `probe_hlhs.mjs`, `probe_paivs.mjs`, `probe_pavsd.mjs`, `probe_ps.mjs`, `probe_ta.mjs`, `probe_tapvc.mjs` | Duct/FO-dependent congenital heart disease scenarios (aortic stenosis, coarctation, d-TGA, HLHS, PA-IVS, PA-VSD, pulmonary stenosis, tricuspid atresia, TAPVC). |

> Most probes default to `term_neonate`; the ones whose physiology only makes sense on a sick lung default elsewhere (e.g. `probe_ventilator.mjs` → `preterm_28wk`). Check the script's `Usage:` header.

## Other engine-dev tooling

The remaining `scripts/*.mjs` support calibration, scenario authoring, and steady-state baking. They reuse the same harness/shim and the same envelope.

| Group | Scripts | Role |
|---|---|---|
| **Calibration** | `build_patient.mjs`, `probe_tune.mjs` | Closed-loop calibration via [`helpers/Calibrator.js`](../helpers/Calibrator.js) (see [Calibrator](./Calibrator.md)) — `build_patient.mjs` builds a new calibrated patient from target vitals; `probe_tune.mjs` exercises the same live tuner headlessly. |
| **Reseeding** | `reseed_*.mjs` (e.g. `reseed_term_neonate`, `reseed_preterm`, `reseed_adult_female`, the CHD set) | Warm a scenario to steady state and serialize it back into `model_definition` (baking equilibrium seeds, clearing startup transients). Each shares `_serialize_state.mjs` (replicates `Model._processModelState`). **Default is a dry run to `/tmp`**; pass `--write` to overwrite the scenario file in place. |
| **Scenario generation** | `_make_*.mjs` (e.g. `_make_preterm`, `_make_cdh_phenotypes`, `_make_dtga`, `_make_pda_patterns`, …) | Generate/derive a scenario JSON (usually from `term_neonate`) by applying phenotype-specific lever edits. |
| **Gestational-age families** | `_make_preterm.mjs <ga>`, `_make_fetus.mjs <ga>`, `reseed_preterm.mjs <ga>`, `reseed_fetus.mjs <ga>` | Per-GA scenario families. The preterm levers live in `_make_preterm.mjs`; the fetal levers in `scripts/_ga_tables.mjs` (shared with `build_patient.mjs`). Generate → probe → iterate the table → reseed `--write`. |
| **Feature patchers** | `_add_neonatal_core.mjs`, `_add_brain.mjs`, `_add_surfactant.mjs` | Patch a model/feature into many existing scenario JSONs at once (without reseeding, to preserve calibration). |
| **Shared internals** | `_harness.mjs`, `_probe.mjs`, `_serialize_state.mjs`, `resolve-extensionless.mjs` | `createEngine`; `measureVitals`/`RANGES`/`selectProfile`/`flagOf`; the `serializeState` baker; the ESM `.js`-retry resolve hook. |

For the calibration math these tools drive, see [Calibrator](./Calibrator.md); for the signals the probes read, see [Monitor](./Monitor.md); for the message envelope they all speak, see [ARCHITECTURE](./ARCHITECTURE.md).
