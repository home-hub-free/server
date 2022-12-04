import { Express } from 'express';
import { emma } from '../emma/emma-assistent.class';
import { readCalendars } from '../handlers/googleCalendarHandler';

export function initEmmaRoutes(app: Express) {

  app.post('/emma-say', (request, response) => {
    emma.say(request.body.text).catch((err) => {
      response.send(err);
    }).finally(() => response.send(true));
  });

  app.get("/emma", (request, response) => {
    let forecasted = emma.autoForecasted;
    let latest = emma.latestSpeeches;
  
    response.send({ forecasted, latest });
  });

  app.get("/emma-weather", (request, response) => {
    emma.sayWeatherForecast().then((sentence) => {
      response.send(sentence);
    });
  });
  
  app.get("/emma-calendar", (request, response) => {
    readCalendars().then((calendars) => {
      calendars.forEach((calendar) => {
        if (!calendar.events.length) {
          emma.say(`There's nothing for today in ${calendar.calendarName}'s calendar`);
        } else {
          calendar.events.forEach((event) => {
            emma.sayCalendarEvent(calendar.calendarName, event);
          });
        }
      });
      response.send(calendars);
    });
  });
}