import * as dotenv from "dotenv";
dotenv.config();

import express, { Express } from "express";
import cors from "cors";
import {
  updateAstroEvents,
  getDailyEvents,
  updateDailyGoogleCalendarEvents,
} from "./handlers/dailyEventsHandler";
// import { emma } from "./emma/emma-assistent.class";
// import { readCalendars } from "./handlers/googleCalendarHandler";
import { initSensorRoutes } from "./routes/sensor-routes";
import { initDeviceRoutes } from "./routes/device-routes";

import http from 'http';
import { initWebSockets } from "./handlers/websocketHandler";
import { initEmmaRoutes } from "./routes/emma-routes";

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

app.get("/get-daily-events", (request, response) => {
  response.send(getDailyEvents());
});