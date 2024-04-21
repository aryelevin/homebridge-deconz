// homebridge-deconz/lib/DeconzService/Switch.js
// Copyright © 2022-2024 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

'use strict'

// const DeconzService = require('../DeconzService')
const { ServiceDelegate } = require('homebridge-lib')

class DummySwitch extends ServiceDelegate {
  constructor (accessory, config, params = {}) {
    params.Service = config.dimmer ? accessory.Services.hap.Lightbulb : accessory.Services.hap.Switch
    super(accessory, params)

    this.name = config.name;
    this.stateful = config.stateful;
    this.dimmer = config.dimmer;
    this.reverse = config.reverse;
    this.time = config.time ? config.time : 1000;		
    this.resettable = config.resettable;
    this.timer = null;
    this.random = config.random;

    function randomize(time) {
      return Math.floor(Math.random() * (time + 1));
    }

    this.addCharacteristicDelegate({
      key: 'on',
      Characteristic: this.Characteristics.hap.On,
      // value: this.capabilities.on
      //   ? this.resource.body.state.on
      //   : this.resource.body.state.all_on
    }).on('didSet', (value, fromHomeKit) => {
      if (fromHomeKit) {
        var delay = this.random ? randomize(this.time) : this.time;
          var msg = "Setting switch to " + value
          if (this.random && !this.stateful) {
              if (value && !this.reverse || !value && this.reverse) {
                msg = msg + " (random delay " + delay + "ms)"
              }
          }
          // if( ! this.disableLogging ) {
          //     this.log(msg);
          // }

          if (value && !this.reverse && !this.stateful) {
            if (this.resettable) {
              clearTimeout(this.timer);
            }
            this.timer = setTimeout(function() {
              // this._service.setCharacteristic(Characteristic.On, false);
              this.values.on = false
            }.bind(this), delay);
          } else if (!value && this.reverse && !this.stateful) {
            if (this.resettable) {
              clearTimeout(this.timer);
            }
            this.timer = setTimeout(function() {
              // this._service.setCharacteristic(Characteristic.On, true);
              this.values.on = true
            }.bind(this), delay);
          }
      }
    })

    if (this.dimmer) {
      this.addCharacteristicDelegate({
        key: 'brightness',
        Characteristic: this.Characteristics.hap.Brightness,
        // value: this.capabilities.on
        //   ? this.resource.body.state.on
        //   : this.resource.body.state.all_on
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          
        }
      })
    }
  }
}

module.exports = DummySwitch
