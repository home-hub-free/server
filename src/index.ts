import * as dotenv from "dotenv";
dotenv.config();

import express, { Express } from "express";
import cors from "cors";
import {
  updateAstroEvents,
  getDailyEvents,
  updateDailyGoogleCalendarEvents,
} from "./handlers/dailyEventsHandler";

import { initSensorRoutes } from "./routes/sensor-routes";
import { initDeviceRoutes } from "./routes/device-routes";

import http from "http";
import { initWebSockets } from "./handlers/websocketHandler";
import { initEmmaRoutes } from "./routes/emma-routes";
import { initEffectsRoutes } from "./routes/effects-routes";
// import { fs } from "fs";
import fs from 'fs'

/**
 * This project requires to be setup with a designated local ip address so the network of
 * devices can communicate directly to it
 */

const app: Express = express();
const PORT = 8080;

updateAstroEvents();
updateDailyGoogleCalendarEvents();

app.use(express.json());
app.use(cors());
app.options("*", cors());
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log("App working at: ", PORT);
});

initWebSockets(server);
initSensorRoutes(app);
initDeviceRoutes(app);
initEmmaRoutes(app);
initEffectsRoutes(app);

// Change these to a proper DB eventually
const DBFiles = [
  'db/devices.db.json',
  'db/sensors.db.json',
  'db/effects.db.json',
];

DBFiles.forEach((file) => {
  try {
    fs.readFileSync(file);
  } catch(err) {
    // Doesn't exist
    if (err.code === 'ENOENT') {
      fs.writeFileSync(file, JSON.stringify({}));
    }
  }
})

app.get("/get-daily-events", (request, response) => {
  response.send(getDailyEvents());
});
