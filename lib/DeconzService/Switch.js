// homebridge-deconz/lib/DeconzService/Switch.js
// Copyright© 2022-2023 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

'use strict'

const DeconzService = require('.')

class Switch extends DeconzService.LightsResource {
  constructor (accessory, resource, params = {}) {
    params.Service = accessory.Services.hap.Switch
    super(accessory, resource, params)

    this.addCharacteristicDelegate({
      key: 'on',
      Characteristic: this.Characteristics.hap.On,
      value: this.capabilities.on
        ? this.resource.body.state.on
        : this.resource.body.state.all_on
    }).on('didSet', (value, fromHomeKit) => {
      if (fromHomeKit) {
        this.put({ on: value })
      }
    })

    if (this.resource.body.state.on === undefined) {
      this.addCharacteristicDelegate({
        key: 'anyOn',
        Characteristic: this.Characteristics.my.AnyOn,
        value: this.resource.body.state.any_on
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          this.put({ on: value })
        }
      })
    }

    this.addCharacteristicDelegates()

    this.settings = {
      resetTimeout: this.platform.config.resetTimeout,
      waitTimeUpdate: this.platform.config.waitTimeUpdate,
      wallSwitch: false
    }
  }

  updateState (state) {
    if (this.resource.manufacturer !== 'ubisys' && this.resource.manufacturer !== 'EcoDim B.V' && this.resource.manufacturer !== 'ROBB smarrt' && this.resource.manufacturer !== 'AduroSmart Eria' && this.resource.manufacturer !== 'SmartDimmer' && this.resource.manufacturer !== 'Idinio' && this.resource.model !== 'lumi.switch.n4acn4') {
      state = {...state} // Copy the state before the changes we're doing...
      let paramsToSet = {}
      if (state.on !== undefined && state.on != this.values.on) {
        paramsToSet.on = this.values.on
        state.on = this.values.on
      }
      if (state.all_on !== undefined && state.all_on != this.values.on) {
        paramsToSet.on = this.values.on
        state.all_on = this.values.on
      }
      if (Object.keys(paramsToSet).length) {
        this.put(paramsToSet)
      }
    }
    for (const key in state) {
      const value = state[key]
      this.resource.body.state[key] = value
      switch (key) {
        case 'all_on':
          this.values.on = value
          break
        case 'any_on':
          this.values.anyOn = value
          break
        case 'on':
          this.values.on = value
          break
        default:
          break
      }
    }
    super.updateState(state)
  }
  
  updateScenes (scenes) {
    
  }

  putState () {
    this.debug('putState: /%s%s', this.gateway.id, this.resource.rpath)
    this.put({ on: this.values.on ? true : false }).then(() => {
      // this.log('putStateCompleted for: ' + this.resource.rpath);
    }).catch((err) => {
      
    })
  }
}

module.exports = Switch
