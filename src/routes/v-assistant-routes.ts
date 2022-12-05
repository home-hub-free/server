import { Express } from 'express';
import { assistant } from '../v-assistant/v-assistant.class';
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
  
    response.send({ forecasted, latest });
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
}