---
title: AGENTS — server (the hub)
summary: Read-first pointers for the hub — the authoritative contracts live in the root CLAUDE.md; the DB is local by design; every state change goes through the source-tagged ingestion seam.
status: LIVE
owner: server
updated: 2026-07-14
tags: [server, agents, meta]
---

# AGENTS.md — server (the hub)

> Context for any AI coding session working in this project. Read this first.
> The [`README.md`](./README.md) is the overview; **the root [`../CLAUDE.md`](../CLAUDE.md) is
> the authoritative contract** for everything below.

## Read before you touch anything

The hub's dev contracts are defined once, in the root [`../CLAUDE.md`](../CLAUDE.md):

- **HTTP API** — the full route table (what's open, what's auth-gated, what's actor-gated).
- **Auth & identity** — `users`/`sessions`, scrypt passwords, bearer tokens, `requireAuth` vs
  `requireActor`, and the `HUB_SERVICE_TOKEN` service-token path for internal callers.
- **The ingestion-source contract** — the `IngestionSource` values and exactly which sites emit
  `automation` / `llm` / `system` etc. This is subtle; read it in full before changing an emit.
- **The ESP device-name → category mapping** and `PRECISION_DEVICES`.

Don't restate those contracts here or in code comments — point at CLAUDE.md and keep the single
home.

## Hard rules (invariants that must not break)

- **The DB is local to the hub by design.** The control plane must keep working when the
  memory/LLM services are down — never make an actuation path depend on MQTT, memory-service, or
  reflex being up. SQLite (`better-sqlite3`) is synchronous and local; keep it that way.
- **Every authoritative state change goes through the ingestion seam** (`src/clients/ingestion.ts`)
  with the correct `source`. A device write that skips `emitDeviceState` / `emitSensorEvent` is
  invisible to the AI layer — that's a bug. Emits are fire-and-forget and must never throw into
  a device action.
- **`PRECISION_DEVICES` own their value** — on first ping the hub does NOT push its stored value
  to `blinds` / `camera`; the device is the source of truth.
- **`manualTrigger` latches the `manual` lock only for `source === "dashboard"`** — agent/system
  writes actuate without disabling automations. Preserve this asymmetry.
- **The ESP fleet is never authenticated** — firmware/reporting routes and all GET reads stay
  open. Only dashboard config mutations and `/auth/*` are gated.

## Adding a device category

Hub-side changes (per CLAUDE.md): add it to `DeviceCategory`, `DeviceTypesToDataTypes`, and (if
it needs a custom URL) `getDeviceUpdateRequestURL()` in `src/classes/device.class.ts`; mirror it
in the dashboard `devices-tab.model.ts` union; add to `PRECISION_DEVICES` if the device owns its
value.

## Build / test

```bash
npm install
npm run build                              # tsc → dist/
npm start                                  # node dist/index.js
npx jest                                   # all tests
npx jest --testPathPattern=device.class    # one test file
```

Deploy is through **ops-dashboard** (the sole build/deploy/restart surface) — don't hand-restart
the hub service.
