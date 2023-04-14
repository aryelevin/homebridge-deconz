// homebridge-deconz/lib/DeconzService/Gateway.js
// Copyright© 2022-2023 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

'use strict'

const { ServiceDelegate } = require('homebridge-lib')

/** Delegate class for a DeconzGateway service.
  * @extends ServiceDelegate
  * @memberof DeconzService
  */
class Platform extends ServiceDelegate {
  constructor (platformAccessory, params = {}) {
    params.Service = platformAccessory.Services.my.DeconzGateway
    params.exposeConfiguredName = true
    super(platformAccessory, params)
    this.platformAccessory = platformAccessory

    this.addCharacteristicDelegate({
      key: 'switchesOn',
      Characteristic: this.Characteristics.my.Enabled
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        this.log('Changed switch to: ' + value)
        let commandsToExecute = value ? this.platformAccessory.platform._configJson.remotesEnabledStateCommands : this.platformAccessory.platform._configJson.remotesDisabledStateCommands
        if (commandsToExecute) {
          for (const cmdEnum in commandsToExecute) {
            let cmd = commandsToExecute[cmdEnum]
            let cmdPath = cmd.resourcePath
            let cmdObject = cmd.objectData
            if (cmdPath && cmdObject) {
              let pathComponents = cmdPath.split('/')
              if (pathComponents.length === 5) {
                let aqaraS1Bridge = this.platformAccessory.platform.gatewayMap[pathComponents[1]]
                if (aqaraS1Bridge) {
                  aqaraS1Bridge.client.put('/' + pathComponents[2] + '/' + pathComponents[3] + '/' + pathComponents[4], cmdObject).then((obj) => {
                    // aqaraS1Bridge.log('Success')
                  }).catch((error) => {
                    // aqaraS1Bridge.log('Error')
                  })
                } else {
                  this.log.info("Bridge not found")
                }
              } else {
                this.log.info("Command path is not correct length: " + pathComponents.length)
              }
            } else {
              this.log.info("Missing command data: " + JSON.stringify(cmd))
            }
          }
        } else {
          this.log.info("No commands to execute")
        }
      }
    })
    this._characteristicDelegates.switchesOn._characteristic.displayName = 'Enable Switches'
  }

  // update (config) {
  //   this.values.expose = true
  //   this.values.lastUpdated = new Date().toString().slice(0, 24)
  // }
}

module.exports = Platform
