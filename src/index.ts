import * as dotenv from "dotenv";
dotenv.config();

// Run the legacy-JSON -> SQLite migration before any module that reads the DB at
// import time (assistant singleton, bootstrap sensor). Must stay first.
import "./db/bootstrap";

import express, { Express } from "express";
import cors from "cors";
import {
  getDailyEvents,
  initDailyEvents,
} from "./handlers/daily-events.handler";

import { initAuthRoutes } from "./routes/auth-routes";
import { initSensorRoutes } from "./routes/sensor-routes";
import { initDeviceRoutes } from "./routes/device-routes";
import { initStateRoutes } from "./routes/state-routes";
import { initIngestion } from "./clients/ingestion";

import http from "http";
import { initWebSockets } from "./handlers/websockets.handler";
import { initVAssistantRoutes } from "./routes/v-assistant-routes";
import { initWeatherRoutes } from "./routes/weather-routes";
import { initEffectsRoutes, setOnEffectsChanged } from "./routes/effects-routes";
import { initZonesRoutes } from "./routes/zones-routes";
import { wireAutomations } from "./automation/wire";
import { initTimeEffects, rearmTimeEffects } from "./automation/time-scheduler-driver";
import { initFirmwareRoutes, ensureFirmwareStore } from "./routes/firmware-routes";
import { initDeviceLogRoutes } from "./routes/device-log-routes";
import { initTimerRoutes } from "./routes/timer-routes";
import { initAssistantChatRoutes } from "./routes/assistant-chat-routes";
import { initTimers } from "./timers/scheduler";
import { Bonjour } from "bonjour-service";
import fs from "fs";

/**
 * This project requires to be setup with a designated local ip address so the network of
 * devices can communicate directly to it
 */
const app: Express = express();
// Default 8088 (matches the deployed fleet). Overridable via HUB_PORT so a SECOND, isolated instance
// can run in parallel with prod — e.g. the bench sim stack (HUB_SIM=1 HUB_PORT=8089 HUB_DB_PATH=…),
// which gives the scenario gate its own hub + DB instead of seeding mocks into the live control plane.
const PORT = Number(process.env.HUB_PORT ?? 8088);
// HUB_SIM marks a throwaway sim instance: skip the side effects that assume there's exactly ONE hub on
// the LAN (mDNS advertisement, the fixed-port camera WS) so a parallel instance can't hijack discovery
// or collide on a port. The DB is already isolated via HUB_DB_PATH.
const SIM = !!process.env.HUB_SIM;

app.use(express.json());
app.use(cors());
app.options("*", cors());
app.use(express.static("public"));
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log("App working at: ", PORT);

  // Advertise the hub over mDNS as _homehub._tcp so devices discover it by
  // service instead of a hardcoded IP. Moving the hub then needs no reflash —
  // devices re-resolve via HomeHubDevice::resolveHub(). See devices/_shared.
  // Skipped for a sim instance so it never competes with the real hub for discovery.
  if (!SIM) {
    try {
      new Bonjour().publish({ name: "home-hub", type: "homehub", port: PORT });
      console.log("mDNS: advertising _homehub._tcp on", PORT);
    } catch (err) {
      console.error("mDNS advertise failed:", err);
    }
  }
});

initWebSockets(server);

// Producer-only ingestion seam → MQTT (no-op unless INGESTION_ENABLED=true).
initIngestion();

initAuthRoutes(app);
initSensorRoutes(app);
initDeviceRoutes(app);
initEffectsRoutes(app);
// Wire the Node automation hook now that the registry + effects store exist.
wireAutomations();
// Arm the time-trigger one-shot scheduler, and re-arm it whenever the rule set changes.
setOnEffectsChanged(() => rearmTimeEffects());
initTimeEffects();
initStateRoutes(app);
initVAssistantRoutes(app);
// Auth boundary for the gateway's persisted assistant chats (owner = the signed-in member).
initAssistantChatRoutes(app);
initWeatherRoutes(app);
initZonesRoutes(app);
ensureFirmwareStore();
initFirmwareRoutes(app);
initDeviceLogRoutes(app);
initTimerRoutes(app);
// Always-on driver for user timers/reminders — fires due ones through the house speaker.
initTimers();

/**
 * Control-plane state now lives in SQLite (db/home-hub.db), opened + migrated by
 * the "./db/bootstrap" import above. Only non-DB support files are ensured here.
 */
const CalendarFile = ["google-calendars.json"];

CalendarFile.forEach((file) => {
  try {
    fs.readFileSync(file);
  } catch (err) {
    // Doesn't exist
    if (err.code === "ENOENT") {
      fs.writeFileSync(file, JSON.stringify({}));
    }
  }
});

// These are optional
initDailyEvents();

app.get("/get-daily-events", (request, response) => {
  response.send(getDailyEvents());
});
