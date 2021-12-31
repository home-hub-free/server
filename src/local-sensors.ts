var sensorLib = require("node-dht-sensor");
const { updateSensor } = require("./handlers/sensorHandler");

let tempSensor = {
  id: 5,
  type: 11,
  pin: 17,
  name: 'Pi temp/humidity sensor',
};


export function initLocalSensors() {
  updateSensors();
  setInterval(() => {
    updateSensors();
  }, 60 * 1000);
}

function updateSensors() {
  let readOut = sensorLib.read(tempSensor.type, tempSensor.pin);
  let value = parseFloat(readOut.temperature) + ':' + parseFloat(readOut.humidity);
  updateSensor(tempSensor.id, value);
}