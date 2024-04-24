// homebridge-deconz/lib/DeconzAccessory/Platform.js
// Copyright© 2022-2023 Arye Levin. All rights reserved.
//
// Homebridge plugin for deCONZ.

'use strict'

const { AccessoryDelegate } = require('homebridge-lib')
const DeconzService = require('../DeconzService')

/** Delegate class for a HomeKit accessory, corresponding to a light device
  * or groups resource.
  * @extends AccessoryDelegate
  * @memberof AccessoryDelegate
  */
class DummySwitch extends AccessoryDelegate {
  /** Instantiate a delegate for an accessory corresponding to a device.
    * @param {DeconzPlatform} platform - The platform.
    */
  constructor (platform, dummySwitchConfig) {
    super(platform, { name: dummySwitchConfig.name, id: dummySwitchConfig.name })

    this.service = new DeconzService.DummySwitch(this, dummySwitchConfig, {
      name: this.name + ' Service',
      primaryService: true
    })

    // let service = new DeconzService.DummySwitch(this, dummySwitchConfig, {name: switchName, id: switchName, subtype: switchName + '_type'})

    // this.identify()

    setImmediate(() => {
      this.debug('initialised')
      this.emit('initialised')
    })
  }
}

module.exports = DummySwitch
