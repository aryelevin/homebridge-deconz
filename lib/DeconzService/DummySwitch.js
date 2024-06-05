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
    this.notification = config.notification;
    this.notificationMuted = false;

    function randomize(time) {
      return Math.floor(Math.random() * (time + 1));
    }

    this.addCharacteristicDelegate({
      key: 'on',
      Characteristic: this.Characteristics.hap.On,
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
              this.values.on = false
            }.bind(this), delay);

            if (this.notification) {
              if (this.notificationMuted === false) {
                this.log('Send notification: ' + JSON.stringify(this.notification));
                var msg = {
                  // These values correspond to the parameters detailed on https://pushover.net/api
                  // 'message' is required. All other values are optional.
                  message: 'Home',	// required
                  // title: "Well - this is fantastic",
                  sound: this.notification.sound,
                  // device: 'Aryes-iPhone-15-Pro-Max',
                  priority: 1
                }

                let casigningcert = this._platform._configJson.caFile ? fs.readFileSync(this._platform._configJson.caFile) : undefined
                
                p.send( msg, casigningcert, function( err, result ) {
                  if ( err ) {
                    throw err
                  }
                
                  this.log( result )
                }.bind(this))

                // Mute further notifications for specified time
                this.serviceMuted = true;
                setTimeout(function() {
                  this.notificationMuted = false;
                  this.log("notification un-muted");
                }.bind(this), this.notification.muteNotificationIntervalInSec * 1000);
              }
              else {
                this.log("notification is muted");
              }
            }
          } else if (!value && this.reverse && !this.stateful) {
            if (this.resettable) {
              clearTimeout(this.timer);
            }
            this.timer = setTimeout(function() {
              this.values.on = true
            }.bind(this), delay);
          }
      }
    })

    if (this.dimmer) {
      this.addCharacteristicDelegate({
        key: 'brightness',
        Characteristic: this.Characteristics.hap.Brightness,
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          
        }
      })
    }
  }
}

module.exports = DummySwitch
