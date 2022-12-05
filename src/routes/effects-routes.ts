import { Express } from "express";
import JSONdb from "simple-json-db";
import { sensors } from "../handlers/sensodr.handler";

type EffectTypes = 'sensor' | 'time';

interface IEffect {
  set: {
    id: string,
    value: any
  }
  when: {
    id: string,
    type: EffectTypes,
    is: any
  }
}

export const EffectsDB = new JSONdb<IEffect[]>("db/effects.db.json");

export function initEffectsRoutes(app: Express) {
  app.get("/get-effects", (request, response) => {
    let effects = EffectsDB.get('effects') || [];
    response.send(effects);
  });

  app.post("/set-effect", (request, response) => {
    let { effect } = request.body;
    let effects: IEffect[] = EffectsDB.get('effects') || [];
    effect.set.value = JSON.parse(effect.set.value);
    effect.when.is = JSON.parse(effect.when.is);
    effects.push(effect);
    EffectsDB.set('effects', effects);

    switch (effect.when.type) {
      case 'sensor':
        let sensorAffected = sensors.find(sensor => sensor.id === effect.when.id);
        sensorAffected.setEffect(effect);
        break;
      case 'time':
        break;
    }

    response.send(true);
  }); 
}