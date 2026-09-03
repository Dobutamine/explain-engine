# Explain Engine

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21389097.svg)](https://doi.org/10.5281/zenodo.21389097)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A framework-agnostic, dependency-free physiological simulation engine (whole-body neonatal
and adult cardiorespiratory model). It runs in a dedicated Web Worker (`ModelEngine.js`) and
is controlled from the main thread through the `Model` wrapper (`Model.js`).

This repository is self-contained: it has no runtime or build dependencies, and the tooling
under `scripts/` (headless harness, probes, sensitivity-analysis campaign) runs on plain Node
with no install step. Consumers mount it as a git submodule — see
[`explain-ui`](https://github.com/explain-labs/explain-ui) for the web app built on it.

Both repositories are part of the [**Explain Labs**](https://github.com/explain-labs)
organization — [`explain-labs/explain-engine`](https://github.com/explain-labs/explain-engine)
(this repo) and [`explain-labs/explain-ui`](https://github.com/explain-labs/explain-ui). The org
page carries the shared overview of how the two fit together. To work on the engine alone:

```sh
git clone https://github.com/explain-labs/explain-engine.git
```

> **Where to read next**
> - [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the full engine architecture (two-thread design, build/step loop, wire protocol, scaling/tuning, realtime data plane). Start there for deep detail.
> - [`./docs/`](./docs/) — per-class physiological reference (one Markdown file per model, e.g. `Heart.md`, `BloodCapacitance.md`, `Pda.md`), plus helper docs (`DataCollector.md`, `TaskScheduler.md`, `ModelScaler.md`, …).
> - [`./docs/README.md`](./docs/README.md) — index of the per-class docs.
>
> This README is the **start-here / onboarding** guide. It keeps the lifecycle, a minimal usage example, and the student manual; the deep architecture lives in `ARCHITECTURE.md`.

## High-level architecture

Two threads, one wire protocol. `Model.js` runs on the main thread: it spawns the worker, exposes the public API, and re-emits worker responses as events you subscribe to with `explain.on(event, handler)`. `ModelEngine.js` is the Web Worker: it owns the live `model` object, the build/step loop, and the GET/PUT/POST/DELETE message router. See [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the complete picture.


## Runtime lifecycle

1. UI constructs `new Model()` (see `src/composables/useExplain.ts`).
2. `Model` creates a worker from `ModelEngine.js`.
3. UI calls `build()` or `load(<definition_name>)`.
4. Worker `build()`:
   - copies top-level model settings,
   - instantiates each model component by `model_type` via `ModelIndex`,
   - calls `init_model(args)` on each component,
   - creates `DataCollector` and `TaskScheduler`.
5. UI can run:
   - **batch simulation** via `calculate(seconds)`, or
   - **real-time simulation** via `start()` / `stop()`.
6. Worker sends state/data/status events back to main thread.

## Worker message protocol

`Model` and `ModelEngine` communicate with message objects:

```js
{
  type: "GET" | "PUT" | "POST" | "DELETE",
  message: string,
  payload: any
}
```

### Inbound commands to worker (`ModelEngine`)

Commands are routed by the worker's `self.onmessage` switch on `type` then `message` — e.g. `POST build`/`start`/`stop`/`calc`/`call`/`scale`/`calibrate`/`watch`, `PUT property_value`/`diagram_definition`/`sample_interval`, `GET state`/`data`/`model_props`/`model_types`, `DELETE watchlist`. See the full command table in [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

### Outbound events from worker

The worker posts back messages whose `type` is mapped to emitter events in `Model.receive()` — including `state`, `status`, `model_ready`, `rt_start`/`rt_stop`, `data`/`data_slow`, `rtf`/`rts` (realtime fast/slow), `prop_value`, `model_props`, `model_types`, `state_saved`, `tuned`, and `error`. Subscribe with `explain.on(event, handler)` (the `Model` is a `ModelEmitter`; these are **not** DOM `CustomEvent`s). The realtime data-plane messages (`RT_MSG.*`) bypass this and are consumed by `RealtimeBus`. See [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full event reference.

## Public API (`Model.js`)

The main-thread methods UI code calls — `load`/`build`/`restart`, `calculate(seconds)`, `start`/`stop`/`dispose`, `watchModelProps`/`watchModelPropsSlow` and their `clear*` counterparts, `getModelData`/`getModelDataSlow`/`getModelState`/`saveModelState`/`getModelTypes`/`getPropValue`, `setPropValue`/`callModelFunction`, `scaleModel(group, factor)`, `tune(targets, opts)`, and `updateDiagram`. Each is documented inline in `Model.js`; see [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the annotated public-API reference.

## Data collection and scheduling

### `DataCollector`

Keeps two watchlists — `watch_list` (fast stream, ~0.005 s) and `watch_list_slow` (slow stream, 1.0 s) — of dot-path props resolved against `model.models`, drained each collect cycle. Full behavior in [`./docs/DataCollector.md`](./docs/DataCollector.md).

### `TaskScheduler`

Runs deferred mutations on a fixed interval: `setPropValue(prop, value, it, at)` tweens numeric targets over `it` seconds after an `at`-second delay (booleans/strings swap instantly), and `callModelFunction` schedules a method call. See [`./docs/TaskScheduler.md`](./docs/TaskScheduler.md).

## Model class contract

Most classes extend `BaseModelClass` and follow this pattern:

  - `model_type` (string identifier used at build time)
  - constructor defines independent/dependent/local fields
  - `init_model(args)` applies config and sets `_is_initialized`
  - `step_model()` checks `is_enabled && _is_initialized`
  - `calc_model()` performs actual calculations

The engine is pure physics: model classes carry **no UI metadata**. The
parameter-editing schema (formerly a `static model_interface` array on each
class) now lives in the UI layer at `src/model-interface/`, keyed by
`model_type`. The engine neither stores nor transports it.

## Composite model behavior

Some component models create additional internal models in `init_model`.

Example: `MicroVascularUnit` creates and configures internal `BloodVessel` components (arteriole/capillary/venule), then registers them in the engine model map. This allows a higher-level model to encapsulate a local network while still participating in global stepping.

## Adding a new model type

> Writing a model for a course project or an experiment? Use the extension point instead —
> `custom_models/README.md` and `STUDENT_WORKFLOW.md` in the explain-ui repo. It is the same
> class contract, but your model registers from `CustomModelIndex.js` rather than the shared
> `ModelIndex.js`, so your branch never conflicts with anyone else's. The steps below are for
> models that become part of the core engine.

1. Create a class in `base_models/`, `component_models/`, or `device_models/`.
2. Extend `BaseModelClass` (or match required engine contract).
3. Define static `model_type`.
4. Implement `init_model` and/or `calc_model` as needed.
5. Export it from `ModelIndex.js`.
6. Reference the new `model_type` in model definition JSON.
7. If the parameters should be editable in the app, add a `model_type` entry to
   the UI schema at `src/model-interface/registry.ts`.

## Minimal usage example

```js
// In Vue components, get the engine wrapper from the composable:
import { useExplain } from "src/composables/useExplain";
const explain = useExplain().model; // the singleton Model instance

// Build from object (or call explain.load("definition_name"))
explain.build(modelDefinition);

// Observe selected variables
explain.watchModelProps([
  "Heart.heart_rate",
  "Heart.lv_sv",
  "Ventilator.vent_rate"
]);

// Run realtime
explain.start();

// Later...
explain.stop();
```

## Notes and caveats

A few things that bite newcomers: payloads crossing the worker boundary are JSON-stringified for `build`/`property_value`/`call`; UI metadata is **not** on the model classes (it lives in `src/model-interface/registry.ts`); cardiac/breathing timing counters live on the engine `model` object (`ncc_*`), not on the components; and the factor / `*_factor_ps` / `*_factor_scaling_ps` effective-value pattern means core physics params are never used raw. These and other gotchas are covered in [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Student onboarding manual

> Set up first: `STUDENT_WORKFLOW.md` in the explain-ui repo covers cloning both
> repositories, working on your own branch, and handing work in. This section is the
> engine-side reference for what to do once you are set up.

### 1. Running the model

1. Start the Vite dev server with `npm run dev` from the **`explain-ui` repository root** — the directory this engine is mounted inside as a submodule. (The engine itself has no dependencies, no build step and no `dev` script; production build via `npm run build`, also from the app root.)
2. The explain engine bootstraps via `src/composables/useExplain.ts`, a singleton that instantiates `Model` (imported as `@explain/Model`) and loads the default definition.
3. Use UI buttons or call the engine wrapper returned by `useExplain()` (`model`) to `build`, `load`, `start`, `stop`, or `calculate(seconds)`.
4. Place custom definitions under `model_definitions` and run `explain.load("definition_name")` (omit `.json`).

### 2. Observing & tweaking data

- Fast telemetry: `explain.watchModelProps(["Heart.heart_rate", "Ventilator.peep"])`.
- Change parameters with easing: `explain.setPropValue("Ventilator.peep", 10, 5 /* seconds */, 0 /* delay */)`.
- Trigger functions: `explain.callModelFunction("Heart.resetBaro", [], 0.25)`.

### 3. Adding models

**Your own models** (`custom_models`) — the student path
- Copy `custom_models/_ExampleModel.js`, rename the class and its `static model_type`, and export it from `CustomModelIndex.js`. Add UI fields in `src/model-interface/custom-registry.ts` in the explain-ui repo.
- Both of those files are empty on `main` and yours to fill in, so your work never collides with the shared registries. Conventions and the full class contract: `custom_models/README.md`.

**Base models** (`base_models`) — core engine only
- Extend `BaseModelClass` and define a static `model_type`. (UI/parameter metadata is **not** on the class — add a `model_type` entry to the UI schema at `src/model-interface/registry.ts` to make parameters editable.)
- Implement `init_model(config)` and `calc_model()`/`step_model()`.
- Import/export the class in `ModelIndex.js`.

**Component models** (`component_models`)
- Compose multiple base models or encapsulate subsystems.
- Register internally created models on the engine `models` map so schedulers and collectors can target them.

**Device models** (`device_models`)
- Represent external hardware; validate dependencies (e.g., lungs) in `init_model` and emit clear errors if missing.

**Helpers** (`helpers`)
- Instantiate new helpers inside `ModelEngine` and keep their state serializable (strip private fields in `_processModelState`).

### 4. Editing definitions

1. Definitions live in `model_definitions/*.json`.
2. Each entry contains `{ name, model_type, settings, inputs }`.
3. Example block:

```json
{
  "name": "MyDevice",
  "model_type": "MyDevice",
  "settings": { "pressure": 18 },
  "inputs": { "Lung": "Lung" }
}
```

4. Reload via `explain.load("my_definition")` or rebuild in place with `explain.restart()`.

### 5. Debugging checklist

- Watch worker traffic in DevTools (console logs prefixed with `Model:`).
- Hook events: `document.addEventListener("status", (evt) => console.log(evt.detail))`.
- Snapshot: `explain.getModelState()`; inspect the payload emitted by the worker.
- Missing models usually mean `model_type` typos or missing exports in `ModelIndex` (or, for your own models, in `CustomModelIndex`).

### 6. Cleanup

- When done (component unmount, hot reload), call `explain.dispose()` to terminate the worker and drop listeners.

## Citation

If you use this software, please cite it via its archived release. The DOI below is the
**concept (all-versions) DOI** and always resolves to the latest release:

> Antonius, T. *Explain: a whole-body physiological simulation engine* (v0.1.0). Zenodo. https://doi.org/10.5281/zenodo.21389097

Machine-readable metadata lives in [`CITATION.cff`](./CITATION.cff); GitHub's "Cite this repository" button reads it directly. To cite a specific version, use that release's version-specific DOI from the [Zenodo record](https://doi.org/10.5281/zenodo.21389097) instead of the concept DOI.

