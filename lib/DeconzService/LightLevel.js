// homebridge-deconz/lib/DeconzService/LightLevel.js
// Copyright © 2022-2025 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

import { ApiClient } from 'hb-deconz-tools/ApiClient'

import { DeconzService } from '../DeconzService/index.js'
import '../DeconzService/SensorsResource.js'

const { lightLevelToLux } = ApiClient

/**
  * @memberof DeconzService
  */
class LightLevel extends DeconzService.SensorsResource {
  constructor (accessory, resource, params = {}) {
    params.Service = accessory.Services.hap.LightSensor
    super(accessory, resource, params)

    this.addCharacteristicDelegate({
      key: 'lightLevel',
      Characteristic: this.Characteristics.hap.CurrentAmbientLightLevel,
      unit: ' lux'
    })

    this.addCharacteristicDelegate({
      key: 'dark',
      Characteristic: this.Characteristics.my.Dark
    })

    this.addCharacteristicDelegate({
      key: 'daylight',
      Characteristic: this.Characteristics.my.Daylight
    })

    this.addCharacteristicDelegates()

    this.update(resource.body, resource.rpath)
  }

  updateState (state) {
    if (state.lightlevel != null) {
      this.values.lightLevel = lightLevelToLux(state.lightlevel)
    }
    if (state.dark != null) {
      this.values.dark = state.dark
    }
    if (state.daylight != null) {
      this.values.daylight = state.daylight
    }
    super.updateState(state)
  }
}

DeconzService.LightLevel = LightLevel
