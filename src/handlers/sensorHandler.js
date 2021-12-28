const { updateRoomState, ROOMS, updateRoomData } = require('./roomHandler');

const sensors = [
  {
    id: 1,
    type: 'boolean',
    description: 'Motion sensor',
    value: false,
    rooms: [ROOMS.LIVING_ROOM],
  },
  {
    id: 2,
    type: 'boolean',
    description: 'Motion sensor',
    value: false,
    rooms: [ROOMS.DINNING_ROOM],
  },
  {
    id: 3,
    type: 'boolean',
    description: 'Motion sensor',
    value: false,
    rooms: [ROOMS.KITCHEN],
  },
  {
    id: 4,
    type: 'value',
    description: 'Temp, humidity sensor',
    value: '',
    rooms: [ROOMS.MAIN_ROOM],
  }
];

function updateSensor(sensorId, value) {
  let sensor = sensors.find(sensor => sensor.id === sensorId);
  if (!sensor) return;

  switch (sensor.type) {
    case 'boolean':
      updateBooleanSensor(sensor, value);
      break;
    case 'value':
      updateValueSensor(sensor, value);
  }
}

/**
 * Boolean sensors are only used to update active state in rooms
 * @param {*} sensor 
 * @param {boolean} value Sensor state true/false
 */
function updateBooleanSensor(sensor, value) {
  sensor.value = value === 1;
  // This sensor is related to rooms
  if(sensor.rooms.length > 0) {
    sensor.rooms.forEach(room => {
      updateRoomState(room, sensor.value);
    });
  }
}

/**
 * Value sensors will be used to store data, like temp
 * humidity, light levels, 
 * @param {*} sensor 
 * @param {*} value Value gathered from sensor
 */
function updateValueSensor(sensor, value) {
  sensor.value = value;
  if (sensor.rooms.length <= 0) {
    return;
  }

  sensor.rooms.forEach(room => {
    updateRoomData(room, (data) => {
      data[`sensor-${sensor.id}`] = {
        id: sensor.id,
        value: value,
        description: sensor.description
      };
    });
  });
}

exports.updateSensor = updateSensor;