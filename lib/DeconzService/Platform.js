// homebridge-deconz/lib/DeconzService/Platform.js
// Copyright© 2022-2023 Arye Levin. All rights reserved.
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
        const commandsToExecute = value ? this.platformAccessory.platform._configJson.remotesEnabledStateCommands : this.platformAccessory.platform._configJson.remotesDisabledStateCommands
        if (commandsToExecute) {
          for (const cmdEnum in commandsToExecute) {
            const cmd = commandsToExecute[cmdEnum]
            const cmdPath = cmd.resourcePath
            const cmdObject = cmd.objectData
            if (cmdPath && cmdObject) {
              const pathComponents = cmdPath.split('/')
              if (pathComponents.length === 5) {
                const aqaraS1Bridge = this.platformAccessory.platform.gatewayMap[pathComponents[1]]
                if (aqaraS1Bridge) {
                  aqaraS1Bridge.client.put('/' + pathComponents[2] + '/' + pathComponents[3] + '/' + pathComponents[4], cmdObject).then((obj) => {
                    // aqaraS1Bridge.log('Success')
                  }).catch((error) => {
                    // aqaraS1Bridge.log('Error')
                    this.error(error)
                  })
                } else {
                  this.debug('Bridge not found')
                }
              } else {
                this.debug('Command path is not correct length: ' + pathComponents.length)
              }
            } else {
              this.debug('Missing command data: ' + JSON.stringify(cmd))
            }
          }
        } else {
          this.debug('No commands to execute')
        }
      }
    })
    this._characteristicDelegates.switchesOn._characteristic.displayName = 'Enable Switches'

    this.addCharacteristicDelegate({
      key: 'resetAqaraConfiguration',
      Characteristic: this.Characteristics.my.SubEnabled
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        this.log('Changed switch to: ' + value)
        for (const id in this._platform.gatewayMap) {
          const gateway = this._platform.gatewayMap[id]
          delete gateway.context.aqaraS1PanelsConfiguration
          gateway.setAqaraS1PanelsConfiguration()
        }
        this.values.resetAqaraConfiguration = false
      }
    })
    this._characteristicDelegates.resetAqaraConfiguration._characteristic.displayName = 'Reset Aqara Configuration Context'
  }

  // update (config) {
  //   this.values.expose = true
  //   this.values.lastUpdated = new Date().toString().slice(0, 24)
  // }
}

module.exports = Platform
