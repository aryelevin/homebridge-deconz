// homebridge-deconz/lib/DeconzService/Switch.js
// Copyright © 2022-2025 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

import { DeconzService } from '../DeconzService/index.js'
import '../DeconzService/LightsResource.js'

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
        if (this.gateway.platform._configJson.useHTTPRequestsForPUTWithPort) { 
          this.platform.platformAccessory.sendPUTRequestToServer(this.gateway.id, this.accessory.id, this.resource.subtype, 'on', value)
        } else {
          this.putState({ on: value })
        }
      }
    })

    if (this.resource.body.state.on === undefined) {
      this.addCharacteristicDelegate({
        key: 'anyOn',
        Characteristic: this.Characteristics.my.AnyOn,
        value: this.resource.body.state.any_on
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          this.putState({ on: value })
        }
      })
    }

    if (this.resource.rtype === 'lights') {
      this.addCharacteristicDelegate({
        key: 'wallSwitch',
        value: false
      })
    }

    this.addCharacteristicDelegates()
  }

  updateState (state) {
    // Added by me: Arye Levin
    if ((this.platform._configJson.resourcesToIgnoreDeviceStateUpdates !== undefined && this.platform._configJson.resourcesToIgnoreDeviceStateUpdates?.includes('/' + this.gateway.id + this.resource.rpath)) || (this.platform._configJson.shabbatModeCLIPSensor !== undefined && !this.platform.platformAccessory.service.values.switchesOn)) {
      state = { ...state } // Copy the state before the changes we're doing...
      const paramsToSet = {}
      if (state.on !== undefined && state.on !== this.values.on) {
        paramsToSet.on = this.values.on
        state.on = this.values.on
      }
      if (state.all_on !== undefined && state.all_on !== this.values.on) {
        paramsToSet.on = this.values.on
        state.all_on = this.values.on
      }
      if (Object.keys(paramsToSet).length) {
        this.put(this.statePath, paramsToSet)
      }
    }
    // End of Added by me: Arye Levin
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
          if (this.values.wallSwitch && !state.reachable) {
            if (this.values.on) {
              this.log('not reachable: force On to false')
            }
            this.values.on = false
            break
          }
          this.values.on = value
          break
        default:
          break
      }
    }
    super.updateState(state)
  }
  // Added by me: Arye Levin
  updateScenes (scenes) {

  }

  putCurrentBasicState () {
    this.log('putCurrentBasicState: /%s%s counter: %i', this.gateway.id, this.resource.rpath, this.putStateCounter)
    this.put(this.statePath, { on: !!this.values.on }).then(() => {
      // this.log('putCurrentBasicStateCompleted for: ' + this.resource.rpath);
    }).catch((err) => {
      this.error(err)
    })
  }
  // End of Added by me: Arye Levin
}

DeconzService.Switch = Switch
