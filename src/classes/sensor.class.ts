import { devices } from '../handlers/device.handler';
import { SensorsDB } from '../handlers/sensodr.handler';
import { io } from '../handlers/websockets.handler';
import { EffectsDB } from '../routes/effects-routes';
import { assistant } from '../v-assistant/v-assistant.class';

const TIME_TO_INACTIVE = 60 * 1000 * 2;

export const SensorTypesToDataTypes = {
  'motion': 'boolean',
  'temp/humidity': 'value'
}

export class Sensor {
  id: string;
  type: 'boolean' | 'value';
  name: string;
  value: any;
  timeout: NodeJS.Timeout;
  effects = {
    on: [],
    off: []
  };
  consecutiveActivations = 0;
  consecutiveActivationsTimer = null;
  lastPing: Date = new Date();
  sensorType: 'motion' | 'temp/humidity';

  constructor(
    id: string,
    name?: string,
    type?: 'boolean' | 'value',
    ) {
    this.id = id;
    this.type = type;
    this.name = name;
    this.sensorType = name as 'motion' | 'temp/humidity';
    this.mergeDBData();
    this.setSensorDBEffects();

    switch (type) {
      case 'boolean':
        this.value = false;
        break;
      case 'value':
        this.value = '';
    }
  }

  update(value) {
    switch (this.type) {
      case 'boolean':
        this.updateMotionSensor(value);
        break;
      case 'value':
        this.updateValueSensor(value);
        break;
    }
  }

  setEffect(effect: any) {
    let prop = !effect.when.is || effect.when.is === 'false' ? 'off' : 'on';
    this.effects[prop].push(() => {
      let device = devices.find(device => device.id === effect.set.id);
      if (device && device.value !== effect.set.value) {
        device.autoTrigger(effect.set.value);
      }
    });
  }

  mergeDBData() {
    const dbStoredData = SensorsDB.get(this.id);
    if (dbStoredData) {
      Object.keys(dbStoredData).forEach((key: string) => {
        if (this[key]) this[key] = dbStoredData[key];
      });
    }
  }

  setSensorDBEffects() {
    const effects = EffectsDB.get('effects');
    if (effects && effects.length) {
      let sensorEffects = effects.filter((effect) => {
        return effect.when.type === 'sensor' && effect.when.id === this.id 
      });
      sensorEffects.forEach((e) => {
        this.setEffect(e);
      });
    }
  }

  /**
   * Boolean sensors are basically motion sensors (for now)
   * so we keep an activity timmer for 1 minute
   */
  private updateMotionSensor(value: any) {
    let state = value === 1;
    this.effects.on.forEach((fn) => fn());
    if (this.timeout) clearTimeout(this.timeout)
    if (state) {
      this.handleConsecutiveActivations();
      this.value = true;
      io.emit('sensor-update', {
        id: this.id,
        value: true,
      });
    }
    this.timeout = setTimeout(() => {
      this.value = false;
      this.timeout = null;
      this.effects.off.forEach((fn) => fn());

      io.emit('sensor-update', {
        id: this.id,
        value: false,
      });
    }, TIME_TO_INACTIVE);
  }

  /**
   * Value sensors will be used to store data, like temp
   * humidity, light levels, basically any sensor that
   * requires a more complex way of reading its data gets
   * updated here
   * @param {*} value Value gathered from sensor
   */
  private updateValueSensor(value: any) {
    this.value = value;
    io.emit('sensor-update', {
      id: this.id,
      value: this.value,
    });

    // TODO: handle value effects
  }

  /**
   * Motion sensors will trigger voiced forecast if
   * any motion sensor activates 5 consecutive times
   * and its a reasonable time of day
   */
  private handleConsecutiveActivations() {
    this.consecutiveActivations++;
    if (this.consecutiveActivationsTimer) clearTimeout(this.consecutiveActivationsTimer);

    this.consecutiveActivationsTimer = setTimeout(() => {
      this.consecutiveActivations = 0;
      this.consecutiveActivationsTimer = null;
    }, 15 * 1000);

    let now = new Date();
    let hour = now.getHours();
    let twoHoursHavePassed = now.getTime() - assistant.lastAutoForecast > 1000 * 60 * 60 * 2;
    if (this.consecutiveActivations >= 5 && hour >= 5 && twoHoursHavePassed) {
      let timeOfDay = hour >= 6 && hour < 12 ?
        'morning' : hour >= 12 && hour < 18 ?
        'afternoon' : 'evening';
      if (!assistant.autoForecasted[timeOfDay]) {
        assistant.sayWeatherForecast();
        assistant.autoForecasted[timeOfDay] = true;
        assistant.lastAutoForecast = now.getTime();
      }
      this.consecutiveActivations = 0;
    }
  }
}

// sensors.push(
//   new Sensor('12301', 'Fake sensor', 'boolean')
// )