const { updateRoomState, ROOMS } = require('./roomHandler');

const sensors = [
  {
    id: 1,
    type: 'boolean',
    description: 'Motion sensor',
    value: false,
    rooms: [ROOMS.LIVING_ROOM]
  },
  {
    id: 2,
    type: 'boolean',
    description: 'Motion sensor',
    value: false,
    rooms: [ROOMS.DINNING_ROOM]
  },
  {
    id: 3,
    type: 'boolean',
    description: 'Motion sensor',
    value: false,
    rooms: [ROOMS.KITCHEN]
  },
  {
    id: 4,
    type: 'value',
    description: 'Temp, humidity sensor',
    value: '',
    rooms: [ROOMS.KITCHEN, ROOMS.DINNING_ROOM]
  }
];

function updateSensor(sensorId, value) {
  let sensor = sensors.find(sensor => sensor.id === sensorId);
  if (!sensor) return;

  switch (sensor.type) {
    case 'boolean':
      updateBooleanSensor(sensor, value);
      break;
  }
}

function updateBooleanSensor(sensor, value) {
  sensor.value = value === 1;
  // This sensor is related to rooms
  if(sensor.rooms.length > 0) {
    sensor.rooms.forEach(room => {
      updateRoomState(room, sensor.value);
    });
  }
}

function updateValueSensor(sensor, value) {
  
}

exports.updateSensor = updateSensor;