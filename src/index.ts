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

import { initSensorRoutes } from "./routes/sensor-routes";
import { initDeviceRoutes } from "./routes/device-routes";

import http from "http";
import { initWebSockets } from "./handlers/websockets.handler";
import { initVAssistantRoutes } from "./routes/v-assistant-routes";
import { initEffectsRoutes } from "./routes/effects-routes";
import fs from "fs";

/**
 * This project requires to be setup with a designated local ip address so the network of
 * devices can communicate directly to it
 */
const app: Express = express();
const PORT = 8088;

app.use(express.json());
app.use(cors());
app.options("*", cors());
app.use(express.static("public"));
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log("App working at: ", PORT);
});

initWebSockets(server);

initSensorRoutes(app);
initDeviceRoutes(app);
initEffectsRoutes(app);
initVAssistantRoutes(app);

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
