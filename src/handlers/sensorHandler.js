const { updateRoomState, ROOMS } = require('./roomHandler');

const sensors = [
  {
    id: 1,
    type: 'boolean',
    value: false,
    rooms: [ROOMS.KITCHEN]
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

exports.updateSensor = updateSensor;