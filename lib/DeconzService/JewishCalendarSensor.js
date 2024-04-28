// homebridge-deconz/lib/DeconzService/DummySwitch.js
// Copyright © 2022-2024 Arye Levin. All rights reserved.
//
// Homebridge plugin for deCONZ.

'use strict'

const { ServiceDelegate } = require('homebridge-lib')

var Push = require( '../pushover' )

var p = new Push( {
  user: 'u5purs1ef7xrxn7rnd3rrp5vzfzb71',
  token: 'a4wt2oipy5cvm1nkjvgsnq1drh9mv2',
  // httpOptions: {
  //   proxy: process.env['http_proxy'],
  //},
  // onerror: function(error) {},
  // update_sounds: true // update the list of sounds every day - will
  // prevent app from exiting.
})

class JewishCalendarSensor extends ServiceDelegate {
  constructor (accessory, params = {}) {
    params.Service = accessory.Services.hap.ContactSensor
    super(accessory, params)

    this.addCharacteristicDelegate({
      key: 'contact',
      Characteristic: this.Characteristics.hap.ContactSensorState
    })

    
  }
}

module.exports = JewishCalendarSensor
