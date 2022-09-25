import * as dotenv from "dotenv";
dotenv.config();

import express, { Express } from "express";
import cors from "cors";
import { getRoomsStates } from "./handlers/roomHandler";
import { initLocalSensors } from "./local-sensors";
import {
  initDailyDevices,
} from "./handlers/deviceHandler";
import {
  updateAstroEvents,
  getDailyEvents,
  updateDailyGoogleCalendarEvents,
} from "./handlers/dailyEventsHandler";
import { emma } from "./emma/emma-assistent.class";
import { readCalendars } from "./handlers/googleCalendarHandler";
import { initSensorRoutes } from "./routes/sensor-routes";
import { initDeviceRoutes } from "./routes/device-routes";

/**
 * This project requires to be setup with a designated local ip address so the network of
 * devices can communicate directly to it
 */

const app: Express = express();
const PORT = 8080;

updateAstroEvents();
initDailyDevices();
initLocalSensors();
updateDailyGoogleCalendarEvents();


app.use(express.json());
app.use(cors());
app.options("*", cors());

initSensorRoutes(app);
initDeviceRoutes(app);

app.listen(PORT, () => {
  console.log("App working at: ", PORT);
});

app.get("/get-daily-events", (request, response) => {
  response.send(getDailyEvents());
});

app.get("/get-room-states", (request, response) => {
  response.send(getRoomsStates());
});

app.get("/request-weather", (request, response) => {
  emma.sayWeatherForecast().then((sentence) => {
    response.send(sentence);
  });
});

app.get("/get-google-calendar", (request, response) => {
  readCalendars().then((calendars) => {
    calendars.forEach((calendar) => {
      calendar.events.forEach((event) => {
        emma.sayCalendarEvent(calendar.calendarName, event);
      });
    });
    response.send(calendars);
  });
});

app.get("/emma", (request, response) => {
  let forecasted = emma.autoForecasted;
  let latest = emma.latestSpeeches;

  response.send({ forecasted, latest });
});
