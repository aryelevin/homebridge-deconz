// homebridge-deconz/lib/DeconzAccessory/DummySwitch.js
// Copyright© 2022-2024 Arye Levin. All rights reserved.
//
// Homebridge plugin for deCONZ.

import { AccessoryDelegate } from 'homebridge-lib/AccessoryDelegate'
import { DeconzAccessory } from '../DeconzAccessory/index.js'
import { DeconzService } from '../DeconzService/index.js'
import '../DeconzService/DummySwitch.js'

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

DeconzAccessory.DummySwitch = DummySwitch
