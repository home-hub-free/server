import { Sensor } from '../classes/sensor.class';
// import { rooms } from "./roomHandler";

// These get populated as sensors join the local network
export const sensors: Sensor[] = [];

export function updateSensor(sensorId: number, value: any) {
  let sensor: Sensor = sensors.find(sensor => sensor.id === sensorId);
  if (sensor) sensor.update(value);
}

export function getSensorsData() {
  let sensorsData = sensors.map((sensor: Sensor) => {
    return {
      id: sensor.id,
      type: sensor.type,
      name: sensor.name,
      value: sensor.value
    }
  });

  return sensorsData;
}
