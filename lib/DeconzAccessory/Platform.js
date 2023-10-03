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
class Platform extends AccessoryDelegate {
  /** Instantiate a delegate for an accessory corresponding to a device.
    * @param {DeconzPlatform} platform - The platform.
    */
  constructor (platform) {
    super(platform, { name: 'Main Platform', id: 'MainPlatform' })

    this.service = new DeconzService.Platform(this, {
      name: this.name + ' Service',
      primaryService: true
    })

    // this.identify()

    setImmediate(() => {
      this.debug('initialised')
      this.emit('initialised')
    })
  }
}

module.exports = Platform
