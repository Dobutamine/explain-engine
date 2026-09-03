# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Scope note

The parent directory `/Users/timantonius/Projects/CLAUDE.md` documents an unrelated NICU
patient-data repository (`data/`, `data_secure/`, Dutch CSV exports). **None of it applies here.**
This repo is a simulation engine with no patient data and no CSV inputs. Ignore that file's
instructions when working in `explain-engine/`.

## What this is

A framework-agnostic, **dependency-free** physiological simulation engine (whole-body neonatal &
adult cardiorespiratory model). It runs in a Web Worker (`ModelEngine.js`) and is driven from the
main thread via `Model.js`. Consumers mount it as a git submodule — the web app that hosts it is
[`explain-ui`](https://github.com/explain-labs/explain-ui), a separate repo.

This repo is [`explain-labs/explain-engine`](https://github.com/explain-labs/explain-engine)
(`git@github.com:explain-labs/explain-engine.git`). It and `explain-ui` moved into the
`explain-labs` organization from the personal `Dobutamine` account; GitHub still redirects the old
URLs, so a pre-move clone keeps working, but anything you write should use the org URLs. Shared
cross-repo usage instructions live on the [org profile](https://github.com/explain-labs), sourced
from `explain-labs/.github`.

`package.json` has **zero `dependencies` and zero `devDependencies`**. There is no build step, no
bundler, and no `npm install`. A bare clone runs immediately on plain `node`.

## Documentation map — read these before making changes

The docs here are current and detailed; prefer them over re-deriving from source.

| Doc | Covers |
|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | **Start here.** Two-thread design, wire protocol, build/step loop, factor system, helpers, realtime data plane. |
| [`docs/TESTING.md`](./docs/TESTING.md) | The headless Node harness, the probe pattern, full script inventory. |
| [`docs/MODEL_DEFINITIONS.md`](./docs/MODEL_DEFINITIONS.md) | The scenario JSON format that `load()` consumes. |
| [`docs/README.md`](./docs/README.md) | Index of the ~50 per-class physiological docs (one per model, e.g. `Heart.md`, `Pda.md`). |

When you add or change a model class, update its per-class doc — the house template is in
`ARCHITECTURE.md` §9, and `docs/BloodCapacitance.md` is the canonical exemplar.

## Commands

No install step. Everything runs with `node` directly from the repo root.

```bash
node scripts/probe_vitals.mjs term_neonate            # canonical probe: vitals + ABG vs normal ranges
node scripts/probe_vitals.mjs preterm_28wk --profile preterm_28
node scripts/probe_vitals.mjs adult_female --no-ans --seconds 90
node scripts/probe_pda.mjs preterm_28wk --beats 6
npm run probe                                          # the one wired script — just probe_fetus.mjs
node scripts/probe_fetus.mjs fetus_30wk                 # probe_fetus takes an optional scenario stem
```

Scenario arguments are filename stems from `model_definitions/` **without `.json`**
(`term_neonate`, `pphn`, `cdh_severe`, …; the full list is `model_definitions/index.json`).

Common flags across probes: `--seconds N` (warm-up), `--window W` (averaging window),
`--no-ans` (freeze the baroreflex), `--verbose` (un-silence engine logs). Scenario-specific probes
add their own — **read the script's header comment**; each documents its own `Usage:` line.

### There is no test suite

**No `npm test`, no CI, no aggregate runner.** Probes are *interactive verification tools, not
pass/fail gates*: they print labelled verdicts flagged `ok` / `LOW` / `HIGH` and you read the
output. A bad physiological number still **exits `0`** — only a *build* failure exits `1`. Never
wire a probe into a green/red check expecting a non-zero exit, and never report "the probe passed"
based on exit status alone. Read the printed table.

### Other tooling

```bash
node scripts/headless.mjs <scenario> [--seconds N] [--no-ans]   # renal+hormonal calibration panel; JSON to stdout
node scripts/build_patient.mjs                                  # build a calibrated patient from target vitals
node scripts/reseed_term_neonate.mjs                            # DRY RUN to /tmp by default
node scripts/reseed_term_neonate.mjs --write                    # overwrites the scenario JSON in place
```

`reseed_*.mjs` warms a scenario to steady state and bakes the equilibrium back into the scenario
file. **Default is a dry run to `/tmp`; `--write` is what mutates `model_definitions/`.**

`_make_*.mjs` (scenario generation) and `_add_*.mjs` (feature patchers, edit many scenarios at
once) are leading-underscore = internal/shared, not entry points you run casually.

### Sensitivity analysis (`scripts/sa/`)

```bash
node scripts/sa/validate_estimators.mjs                 # check estimators vs closed-form (Ishigami) FIRST
node scripts/sa/smoke.mjs term_neonate                  # determinism + lever-sign check
node scripts/sa/run_sa.mjs --scenario term_neonate --tier oat --set reduced
node scripts/sa/run_sa.mjs --scenario pphn --tier sobol --set reduced --N 512
node scripts/sa/campaign.mjs --quick                    # tiny sizes, plumbing only
node scripts/sa/campaign.mjs                            # FULL campaign — hours; run in background
node scripts/sa/summarize.mjs                           # consolidate results/ into tables + _summary.json
node scripts/sa/plot_sa.mjs [--out DIR]                 # dependency-free SVG figures
```

Tiers are `oat | morris | sobol | prcc`. Results are tracked in `scripts/sa/results/`;
`results/figures/` is gitignored (derived, regenerate with `plot_sa.mjs`).

`run_sa.mjs` shards rows across `os.cpus()-2` **forked processes** — because the engine is a
module-scope singleton per process, parallelism can only be process-level, never threads or
concurrent `createEngine()` calls in one process.

## Architecture essentials

The full picture is in `ARCHITECTURE.md`; these are the cross-file facts that bite.

**Two threads, one envelope.** `Model.js` (main thread, public API, extends `ModelEmitter`) talks to
`ModelEngine.js` (worker, owns the live model) via `{ type: "GET"|"PUT"|"POST"|"DELETE", message, payload }`.
The live `model` object exists **only in the worker**; the main thread holds read-only echoes.
Subscribe with `explain.on(event, handler)` — these are emitter events, **not** DOM `CustomEvent`s.

**Build is two-pass.** `build()` constructs *every* instance before initializing *any*. That ordering
is what lets `init_model` resolve cross-model refs (`this._lv = this._model_engine.models["LV"]`).
Preserve it.

**`ModelIndex.js` is the registry.** The engine derives `available_model_map` from whatever
`ModelIndex.js` exports. **Forgetting to export a new class there is the usual cause of "model type
not found" at build.** `CustomModelIndex.js` is a second barrel merged on top of it — empty on
`main`, it is where student/experimental models in `custom_models/` register without touching the
shared file, and a custom `model_type` deliberately overrides a built-in one (with a `console.warn`).
Keep it empty on `main`; that is what keeps student branches conflict-free on rebase.

**Composite lookup goes through `helpers/ModelRegistry.js`.** `BaseModelClass` instantiates
`this.components` sub-models by `model_type` and cannot import the barrels directly to do it —
every model extends it, so `CustomModelIndex → custom model → BaseModelClass` is an evaluation-time
cycle ("Cannot access 'BaseModelClass' before initialization"). `ModelEngine` publishes the merged
map into that registry at startup instead. Don't "simplify" it back into a top-level import or
spread; both fail at module-evaluation time, not at build time.

**The factor / effective-value pattern.** Core physics params are never used raw. Each tunable
combines three multiplier layers additively against the base:
`p_eff = p + (factor-1)*p + (factor_ps-1)*p + (factor_scaling-1)*p`, where `_factor` is
non-persistent (reset to 1.0 each step), `_factor_ps` is the persistent user/scenario layer, and the
scaling layer belongs to `ModelScaler` alone. Follow this for any new tunable.

> ⚠️ **The scaling suffix is not uniform.** The capacitance/resistor/time-varying-elastance family
> uses `*_factor_scaling_ps`; the diffusor/exchanger family uses `*_factor_scaling` (**no `_ps`**).
> Scaling a diffusor through the `_ps` name silently does nothing. Verify before copying.

**`ncc_*` cycle counters live on the engine `model` object**, not on components — `Heart`,
`Breathing`, and `Ventilator` reach them through `this._model_engine`.

**Composition rides the flow.** There is no global solver. `Resistor.calc_flow` moves volume, and
`volume_in` dilution-mixes gases, solutes, drugs, temp, and viscosity into the receiving
compartment. That is how everything propagates.

**The engine ships no UI metadata.** Model classes carry no parameter-edit schema — it lives in the
consumer (`src/model-interface/registry.ts` in explain-ui). Don't add `model_interface` back to a class.

**Extensionless imports.** Source uses Vite-style `import ... from "./ModelIndex"` (no `.js`), which
Node's ESM resolver rejects. `scripts/resolve-extensionless.mjs` is a resolve hook that retries with
`.js`, and `_harness.mjs` must `register()` it **before** the first engine import. Keep the
extensionless style consistent with the surrounding code rather than "fixing" it.

## The headless harness

`scripts/_harness.mjs` boots the worker engine in plain Node with zero engine edits: it shims
`globalThis.self` / `postMessage` **before** dynamic-importing `ModelEngine.js`, then drives it
through the same envelope the real worker uses.

```js
import { createEngine } from "./_harness.mjs";
const eng = await createEngine();            // { verbose: true } to see engine logs
const model = eng.build(def);                // live model, BY REFERENCE
eng.calc(60);                                // 60 sim-seconds, fully synchronous
console.log(model.models.Heart.heart_rate);  // state is final the instant calc() returns
```

`calc()` runs the step loop synchronously — no `setInterval`, no realtime batching — which is what
makes deterministic assertion-style probing possible. The harness silences `console.log` unless
`verbose` (the engine is chatty), so scripts emit **JSON on stdout, diagnostics on stderr**.

## Adding a new model

1. Create the class in `base_models/`, `component_models/`, or `device_models/`, extending
   `BaseModelClass` (or an intermediate like `Capacitance` / `Resistor` / `TimeVaryingElastance`).
2. Give it a `static model_type` string.
3. Implement `init_model(args)` (resolve cross-model refs; set `_is_initialized`) and `calc_model()`
   (the physics). Don't override `step_model()` — the base gates on `is_enabled && _is_initialized`.
4. Follow the factor convention, with the **correct scaling suffix** for the family.
5. **Export it from `ModelIndex.js`** — or, for a student/experimental model living in
   `custom_models/`, from `CustomModelIndex.js` (see `custom_models/README.md`).
6. Reference the `model_type` in the relevant `model_definitions/*.json`.
7. Write the per-class doc in `docs/` using the §9 template.

## Doc drift to watch for

This repo was extracted from a UI repo where the engine lived in an `explain/` subdirectory. Stale
docs and header comments may still write engine paths as `../explain/ModelEngine.js` — **the repo
root is the engine**, so the correct path is `../ModelEngine.js`. Some `scripts/*.mjs` header
comments also describe sweeps/flags that have since changed. Trust the source (and a real run) over
a header comment; fix drift when you touch the file.
