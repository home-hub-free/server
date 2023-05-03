import { Express } from 'express';
import { assistant, VAssistantDB } from '../v-assistant/v-assistant.class';
import { readCalendars } from '../handlers/google-calendar.handler';

export function initVAssistantRoutes(app: Express) {

  app.post('/emma-say', (request, response) => {
    assistant.say(request.body.text).catch((err) => {
      response.send(err);
    }).finally(() => response.send(true));
  });

  app.get("/emma", (request, response) => {
    let forecasted = assistant.autoForecasted;
    let latest = assistant.latestSpeeches;
    let houseData = VAssistantDB.get('houseData') || {};
  
    response.send({ forecasted, latest, houseData });
  });

  app.get("/emma-weather", (request, response) => {
    assistant.sayWeatherForecast().then((sentence) => {
      response.send(sentence);
    });
  });
  
  app.get("/emma-calendar", (request, response) => {
    readCalendars().then((calendars) => {
      calendars.forEach((calendar) => {
        if (!calendar.events.length) {
          assistant.say(`There's nothing for today in ${calendar.calendarName}'s calendar`);
        } else {
          calendar.events.forEach((event) => {
            assistant.sayCalendarEvent(calendar.calendarName, event);
          });
        }
      });
      response.send(calendars);
    });
  });

  app.post("/update-house-data", (request, response) => {
    const { property, value } = request.body;
    const houseData = VAssistantDB.get('houseData') || {};
    if (value === 'null') {
      houseData[property] = null;
    } else {
      houseData[property] = value;
    }

    VAssistantDB.set('houseData', houseData);
    response.send(true);
  });
}