---
title: home-hub-free server (the hub)
summary: Overview of the central hub — Express on :8088 + Socket.IO, a local SQLite control plane, the ESP fleet contract, and the ingestion seam to the AI layer; contracts are authoritative in CLAUDE.md.
status: LIVE
owner: server
updated: 2026-07-14
tags: [server, hub, api]
---

# home-hub-free server

The **central hub** of home-hub-free: the control plane that connects the dashboard, the
voice/assistant layer, and the physical ESP device fleet. TypeScript + Express on **port 8088**
(+ Socket.IO), deployed on the Ubuntu 24.04 box (see the root [`../PROJECT_STATE.md`](../PROJECT_STATE.md)
§2 for the live service map and hardware).

> The authoritative dev contracts — HTTP API table, auth & identity, the ingestion-source
> semantics, the ESP device-name → category mapping — live in the root
> [`../CLAUDE.md`](../CLAUDE.md). This README is the overview; **CLAUDE.md is the letter of the
> law.** Agent-facing rules for this repo are in [`AGENTS.md`](./AGENTS.md).

## What it does

- **Owns device & sensor state.** Each connected ESP registers on boot (`/device-declare`,
  `/sensor-declare`); the hub tracks its value/config and pushes actuation over HTTP
  (`http://<device-ip>/set?value=…`).
- **Runs automations.** The `effects` table links a sensor state to a device action
  (motion → light, temp → cooler); the orchestrator fires them.
- **Serves the dashboard.** Config mutations, manual device control (`/device-update`), and
  live updates over Socket.IO (`device-update` / `sensor-update` / `*-declare`).
- **Feeds the AI layer.** A producer-only **ingestion seam** publishes every authoritative
  state change to MQTT for the memory/LLM services — the hub never reads their stores.
- **Fronts household login.** `users` / `sessions` with scrypt-hashed passwords and bearer
  tokens; a `HUB_SERVICE_TOKEN` for trusted internal callers (reflex, the scheduler).

## Architecture at a glance

- **Control-plane state is a local embedded SQLite DB** (`better-sqlite3`, synchronous, WAL) at
  `db/home-hub.db`, opened + migrated by `src/db/`. Tables: `devices`, `sensors`, `effects`,
  `kv_config`, `users`, `sessions`. The DB is **local to the hub by design** — the control plane
  keeps working even when the memory/LLM services are down.
- **`Device` / `Sensor` classes** (`src/classes/`) model the fleet: `autoTrigger` (respects the
  `manual` lock + operational ranges) vs `manualTrigger` (user override), `DeviceBlinds` for
  stepper blinds, boolean vs value sensors firing effect callbacks.
- **The ingestion seam** (`src/clients/ingestion.ts`) tags every emit with a `source`
  (`device` / `dashboard` / `voice` / `llm` / `system` / `automation`) so the AI layer can tell
  the actors apart. Fire-and-forget QoS-0, gated on a live broker, never throws into a device
  action; the transport is off unless `INGESTION_ENABLED=true`. Full semantics in CLAUDE.md.

## Commands

```bash
npm install
npm run build     # tsc → dist/
npm start         # node dist/index.js
npm run prod      # build + start
npx jest          # run all tests
npx jest --testPathPattern=device.class   # a single test file
```

## HTTP API

The full route table is in [`../CLAUDE.md`](../CLAUDE.md) (HTTP API). In brief: `/get-devices`,
`/get-sensors`, `/get-effects` (open reads); `/device-declare`, `/sensor-declare`,
`/sensor-update`, `/device-value-set` (the unauthenticated ESP fleet); `/device-update` (manual
control, actor-gated); the `/devices-data-set` / `/sensors-data-set` / `/set-effect(s)` config
mutations (auth-gated); and `/auth/*` for login + household management.

## OTA & the device fleet

The ESP firmware lives in its own repo (`devices/`, out of scope here). The hub serves
**pull-based OTA**: `./hub publish` stages `firmware.bin` + `manifest.json` into
`server/firmware/<category>/`, and devices poll `GET /firmware/<category>` (304 when current).
OTA is keyed by category. See the fleet contract in [`../CLAUDE.md`](../CLAUDE.md) (Device
Firmware).
