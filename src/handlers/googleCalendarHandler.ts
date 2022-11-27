import { calendar_v3 } from 'googleapis';
import { AuthPlus } from 'googleapis/build/src/googleapis';

const calendars = require('../../google-calendars.json');
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;

const auth = new AuthPlus()
const jwtClient = new auth.JWT(
  GOOGLE_CLIENT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY,
  SCOPES
);

const calendar = new calendar_v3.Calendar({
  auth: jwtClient
})

export interface IEventData {
  type: string,
  id: string,
  startTime: Date,
  endTime: Date,
  name: string,
  status: string
}

export interface ICalendarData {
  calendarName: string,
  events: IEventData[]
}

export function readCalendars(): Promise<ICalendarData[]> {
  let calendarNames = Object.keys(calendars);
  let resolved = 0;
  let result: ICalendarData[] = [];

  return new Promise((resolve, reject) => {
    calendarNames.forEach((name, i) => {
      getCalendarEvents(calendars[name])
        .then((items: any) => {
          result[i] = {
            calendarName: name,
            events: items.map((item) => buildEventDataData(item))
          };
          resolved++;
          if (resolved >= calendarNames.length) {
            resolve(result);
          }
        })
        .catch((err) => {
          reject(err);
        })
    });
  });
}

function buildEventDataData(serverEventData): IEventData {
  let data: IEventData = {
    id: serverEventData.id,
    name: serverEventData.summary,
    type: serverEventData.kind.split('#')[1],
    status: serverEventData.status,
    startTime: new Date(serverEventData.start.dateTime),
    endTime: new Date(serverEventData.end.dateTime),
  };
  return data;
}

function getCalendarEvents(id: string) {
  let now = new Date();
  let endOfDay = new Date();
  endOfDay.setHours(23);
  endOfDay.setMinutes(59);
  endOfDay.setSeconds(59);

  return new Promise((resolve, reject) => {
    calendar.events.list({
      calendarId: id,
      timeMin: now.toISOString(),
      timeMax: endOfDay.toISOString(),
      maxResults: 20,
      singleEvents: true,
      orderBy: 'startTime',
    }, (error, result) => {
      if (error) {
        reject(error);
        console.log(error);
      } else {
        if (result.data.items.length) {
          resolve(result.data.items);
        } else {
          resolve([]);
        }
      }
    });
  });
}