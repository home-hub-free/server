# @home-hub-free/server

This is the server/api for the home-hub-free project which runs locally and enables communication between the dashboard and the physical devices

Although this is built in NodeJS and should be able to run in any NodeJS friendly device, this codebase was developed using MacOS and tested in RaspberryPI 4

## Install dependencies

```npm install```

## Run locally

```npm run start```

# Environment variables

In order for this project to work there are a few optional environment variables that we need to set up, none of this is required but it enhances the server's capabilities

## Weather API

For these you need to create an account in: https://www.weatherapi.com

```WEATHER_API_KEY```\
```WEATHER_API_QUERY```


Used to gather forecast data about the current day, it retrieves current temperature, highest temperature of the day and Sunrise/Sunset data, which is useful to give devices a more dynamic range of programming/automation options

These data is processed into a sentence which is accessible trough the GET ```/request-weather``` endpoint.

(If the speech service is enabled it will also read it out loud for you)

## Google Calendar API

For these you need to create a project in: https://console.cloud.google.com/ enable the Google Calendar API and go trough the steps of creating the necessary permissions and keys to access the API.

```GOOGLE_PRIVATE_KEY```\
```GOOGLE_CLIENT_EMAIL```

You also need to provide a ```json``` file in the root of the project with data about the calendars that you want the server to read: 

```google-calendars.json```

```json
{
    "David": "david-test@gmail.com"
}
```

You also need to give the GOOGLE_CLIENT_EMAIL access to the calendars in the json list so it can read daily event data.

Go to you Google Calendar and then:

Settings > Settings for my calendars > Your_calendar_name > Share with specific people > + Add people

Here you add the email you created in the Google Cloud project

## AWS Polly API

This is to give a voice to all of the above, the Amazon Polly services provides a way to read out loud the forecast data and comming calendar events, for this service to work you need to create an AWS account, enable the Polly API and provide the keys for:

```AWS_ACCESS_KEY_ID```\
```AWS_SECRET_ACCESS_KEY```


# Thank you

The project is still very complex and not plug and play at all but we are working on improving every aspect of it that we can
