import { devices } from '../handlers/device.handler';
import { SensorsDB } from '../handlers/sensor.handler';
import { io } from '../handlers/websockets.handler';
import { EffectsDB } from '../routes/effects-routes';
import { assistant } from '../v-assistant/v-assistant.class';
import { Device } from './device.class';
import { emitSensorEvent } from '../clients/ingestion';

const TIME_TO_INACTIVE = 1000 * 10;

export const SensorTypesToDataTypes = {
  'motion': 'boolean',
  'presence': 'boolean',
  'temp/humidity': 'value'
}

export class Sensor {
  id: string;
  type: 'boolean' | 'value';
  name: string;
  value: any;
  timeout: NodeJS.Timeout;
  ip: string = '';
  effects = {
    value: [],
    on: [],
    off: []
  };
  consecutiveActivations = 0;
  consecutiveActivationsTimer = null;
  lastPing: Date = new Date();
  sensorType: 'motion' | 'temp/humidity' | 'presence';

  constructor(
    id: string,
    name?: string,
    type?: 'boolean' | 'value',
    ) {
    this.id = id;
    this.type = type;
    this.name = name;
    this.sensorType = name as 'motion' | 'temp/humidity' | 'presence';
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
    switch (this.sensorType) {
      case 'motion':
      case 'presence':
        this.setBooleanSensorEffect(effect);
        break;
      case 'temp/humidity':
        this.setTempHumidityEffect(effect)
    }
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

  clearEffects() {
    this.effects = {
      on: [],
      off: [],
      value: [],
    }
  }

  /**
   * Boolean sensors are basically motion sensors (for now)
   * so we keep an activity timmer for 1 minute
   */
  private updateMotionSensor(value: any) {
    let state = value === 1;
    if (state) {
      // Cancel any pending deactivation from the grace period. Null the handle so
      // a stale reference can't linger after the timer is cleared.
      if (this.timeout) {
        clearTimeout(this.timeout);
        this.timeout = null;
      }
      // Edge-trigger: only run on-effects on a real false -> true transition.
      if (this.value !== true) {
        this.value = true;
        this.effects.on.forEach((fn) => fn());
        io.emit('sensor-update', {
          id: this.id,
          value: true,
        });
        emitSensorEvent(this, 'device');
      }
    } else {
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = setTimeout(() => {
        this.timeout = null;
        this.value = false;
        this.effects.off.forEach((fn) => fn());
        io.emit('sensor-update', {
          id: this.id,
          value: false,
        });
        emitSensorEvent(this, 'device');
      }, TIME_TO_INACTIVE);
    }
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
    emitSensorEvent(this, 'device');

    // TODO: handle value effects
    this.effects.value.forEach(effect => effect());
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
    if (this.consecutiveActivations >= 5 && twoHoursHavePassed) {
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

  private setBooleanSensorEffect(effect: any) {
    let prop = !effect.when.is || effect.when.is === 'false' ? 'off' : 'on';
    this.effects[prop].push(() => {
      let device = devices.find(device => device.id === effect.set.id);
      if (device && device.value !== effect.set.value) {
        const { hasChanges, newValue } = this.getNewValueFromEffect(effect, device);
        if (hasChanges) {
          device.autoTrigger(newValue);
        }
      }
    });
  }

  private setTempHumidityEffect(effect: any) {  
    this.effects.value.push(async () => {
      const [valueToCheck, comparassion, targetValue] = effect.when.is.split(':');

      let device = devices.find(device => device.id === effect.set.id);
      let [temperature, humidity] = this.value.split(':');
      let sensorValue = null;
      switch (valueToCheck) {
        case 'temp':
          sensorValue = temperature;
          break;
        case 'humidity':
          sensorValue = humidity;
      }

      let triggerEffect = false;
      switch (comparassion) {
        case 'higher-than':
          triggerEffect = sensorValue > targetValue;
          break;
        case 'lower-than':
          triggerEffect = sensorValue < targetValue;
      }

      // This will always be true for multi value devices, but thats okay
      if (device && triggerEffect) {
        const { hasChanges, newValue } = this.getNewValueFromEffect(effect, device);
        if (hasChanges) {
          device.autoTrigger(newValue);
        }
      }
    });
  }

  private getNewValueFromEffect(effect: any, device: Device) {
    let newValue = null;
    let hasChanges = false;
    const valueToSet = effect.set.valueToSet;
    if (valueToSet) {
      newValue = {
        ...device.value,
        [valueToSet]: effect.set.value,
      }
      hasChanges = device.value[valueToSet] != effect.set.value;
    } else {
      newValue = effect.set.value;
      hasChanges = device.value !== effect.set.value
    }

    return { hasChanges, newValue};
  }
}