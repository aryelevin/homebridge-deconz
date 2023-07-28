// homebridge-deconz/lib/DeconzService/Thermostat.js
// Copyright© 2022-2023 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

'use strict'

const DeconzService = require('../DeconzService')

/**
  * @memberof DeconzService
  */
class HeaterCooler extends DeconzService.SensorsResource {
  constructor (accessory, resource, params = {}) {
    params.Service = accessory.Services.hap.HeaterCooler
    super(accessory, resource, params)

    this.addCharacteristicDelegate({
      key: 'currentTemperature',
      Characteristic: this.Characteristics.hap.CurrentTemperature,
      unit: '°C',
      props: { minValue: -40, maxValue: 100, minStep: 0.1 },
      value: 0
    }).on('didSet', async (value, fromHomeKit) => {
      this.updatePanels('currentTemperature')
    })

    this.addCharacteristicDelegate({
      key: 'coolingThresholdTemperature',
      Characteristic: this.Characteristics.hap.CoolingThresholdTemperature,
      unit: '°C',
      props: { minValue: 16, maxValue: 30, minStep: 1 },
      value: 0
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        await this.put('/config', { coolsetpoint: Math.round(value * 100) })
        this.updatePanels('coolingThresholdTemperature')
      }
    })

    this.addCharacteristicDelegate({
      key: 'heatingThresholdTemperature',
      Characteristic: this.Characteristics.hap.HeatingThresholdTemperature,
      unit: '°C',
      props: { minValue: 16, maxValue: 30, minStep: 1 },
      value: 0
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        await this.put('/config', { heatsetpoint: Math.round(value * 100) })
        this.updatePanels('heatingThresholdTemperature')
      }
    })

    this.addCharacteristicDelegate({
      key: 'targetHeaterCoolerState',
      Characteristic: this.Characteristics.hap.TargetHeaterCoolerState
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        let mode
        switch (value) {
          case this.Characteristics.hap.TargetHeaterCoolerState.COOL:
            mode = 'cool'
            break
          case this.Characteristics.hap.TargetHeaterCoolerState.HEAT:
            mode = 'heat'
            break
          case this.Characteristics.hap.TargetHeaterCoolerState.AUTO:
          default:
            mode = 'auto'
            break
        }
        await this.put('/config', { mode: mode })

        this.updatePanels('targetHeaterCoolerState')
      }
    })

    this.addCharacteristicDelegate({
      key: 'currentHeaterCoolerState',
      Characteristic: this.Characteristics.hap.CurrentHeaterCoolerState
    })

    this.addCharacteristicDelegate({
      key: 'active',
      Characteristic: this.Characteristics.hap.Active
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        let mode = 'off'
        if (value !== this.Characteristics.hap.Active.INACTIVE) {
          switch (this.values.targetHeaterCoolerState) {
            case this.Characteristics.hap.TargetHeaterCoolerState.COOL:
              mode = 'cool'
              break
            case this.Characteristics.hap.TargetHeaterCoolerState.HEAT:
              mode = 'heat'
              break
            case this.Characteristics.hap.TargetHeaterCoolerState.AUTO:
            default:
              mode = 'auto'
              break
          }
        }
        await this.put('/config', {
          mode: mode
        })
        
        this.updatePanels('active')
      }
    })

    this.addCharacteristicDelegate({
      key: 'fanmode',
      Characteristic: this.Characteristics.hap.RotationSpeed,
      unit: '%',
      props: { minValue: 25, maxValue: 100, minStep: 25 },
      value: 0
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        let speed = 'auto'
        switch (value) {
          case 25:
            speed = 'low'
            break
          case 50:
            speed = 'medium'
            break
          case 75:
            speed = 'high'
            break
          case 100:
          default:
            speed = 'auto'
            break
        }
        await this.put('/config', { fanmode: speed })
        this.updatePanels('fanmode')
      }
    })

    this.addCharacteristicDelegate({
      key: 'swingmode',
      Characteristic: this.Characteristics.hap.SwingMode
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        let mode = value > 0 ? 'half open' : 'fully open'
        await this.put('/config', { swingmode: mode })
        this.updatePanels('swingmode')
      }
    })

    this.addCharacteristicDelegate({
      key: 'offset',
      Characteristic: this.Characteristics.my.Offset,
      unit: '°C',
      props: { minValue: -5, maxValue: 5, minStep: 0.1 },
      value: 0
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        await this.put('/config', { offset: Math.round(value * 100) })
      }
    })

    this.addCharacteristicDelegate({
      key: 'displayUnits',
      Characteristic: this.Characteristics.hap.TemperatureDisplayUnits,
      value: this.Characteristics.hap.TemperatureDisplayUnits.CELSIUS
    })

    this.addCharacteristicDelegate({
      key: 'programData',
      Characteristic: this.Characteristics.eve.ProgramData,
      silent: true,
      value: Buffer.from('ff04f6', 'hex').toString('base64')
    })

    this.addCharacteristicDelegate({
      key: 'programCommand',
      Characteristic: this.Characteristics.eve.ProgramCommand,
      silent: true
    })

    if (resource.body.config.displayflipped !== undefined) {
      this.addCharacteristicDelegate({
        key: 'imageMirroring',
        Characteristic: this.Characteristics.hap.ImageMirroring
      }).on('didSet', async (value, fromHomeKit) => {
        if (fromHomeKit) {
          await this.put('/config', { displayflipped: value })
        }
      })
    }

    if (resource.body.config.locked !== undefined) {
      this.addCharacteristicDelegate({
        key: 'lockPhysicalControls',
        Characteristic: this.Characteristics.hap.LockPhysicalControls
      }).on('didSet', async (value, fromHomeKit) => {
        if (fromHomeKit) {
          await this.put('/config', {
            locked: value === this.Characteristics.hap.LockPhysicalControls
              .CONTROL_LOCK_ENABLED
          })
        }
      })
    }

    if (resource.body.config.pulseconfiguration !== undefined) {
      this.addCharacteristicDelegate({
        key: 'pulseConfiguration',
        Characteristic: this.Characteristics.hap.TunnelConnectionTimeout,
        // unit: '#',
        props: { minValue: 0, maxValue: 999, minStep: 1 },
        value: 0
      }).on('didSet', async (value, fromHomeKit) => {
        if (fromHomeKit) {
          await this.put('/config', { pulseconfiguration: value })
        }
      })

      this._characteristicDelegates.pulseConfiguration._characteristic.displayName = 'IR Codes Config'
    }

    super.addCharacteristicDelegates()

    this.update(resource.body, resource.rpath)
  }

  updateState (state) {
    // if (state.on != null) {
    //   this.values.currentState = state.on
    //     ? this.Characteristics.hap.CurrentHeatingCoolingState.HEAT
    //     : this.Characteristics.hap.CurrentHeatingCoolingState.OFF
    // }
    if (state.temperature != null) {
      this.values.currentTemperature = Math.round(state.temperature / 10) / 10
    }
    if (state.valve != null) {
      this.values.valvePosition = Math.round(state.valve / 2.55)
    }
    super.updateState(state)
  }

  updateConfig (config) {
    if (config.displayflipped != null) {
      this.values.imageMirroring = config.displayflipped
    }
    if (config.heatsetpoint != null) {
      this.values.heatingThresholdTemperature = Math.round(config.heatsetpoint / 50) / 2
    }
    if (config.coolsetpoint != null) {
      this.values.coolingThresholdTemperature = Math.round(config.coolsetpoint / 50) / 2
    }
    if (config.fanmode != null) {
      const fanState = {auto:100, low:25, medium:50, high:75}
      const hkRotationSpeed = fanState[config.fanmode]
      this.values.fanmode = hkRotationSpeed
    }
    if (config.swingmode != null) {
      const swingStates = {'fully open':0, 'half open':1, 'quarter open':1, 'three quarters open':1, 'fully closed':1};
      const hkSwingMode = swingStates[config.swingmode]
      this.values.swingmode = hkSwingMode
    }
    if (config.locked != null) {
      this.values.lockPhysicalControls = config.locked
        ? this.Characteristics.hap.LockPhysicalControls.CONTROL_LOCK_ENABLED
        : this.Characteristics.hap.LockPhysicalControls.CONTROL_LOCK_DISABLED
    }
    if (config.mode != null) {
      this.values.currentHeaterCoolerState = config.mode === 'off'
        ? this.Characteristics.hap.CurrentHeaterCoolerState.INACTIVE : config.mode === 'cool'
        ? this.Characteristics.hap.CurrentHeaterCoolerState.COOLING : config.mode === 'heat' 
        ? this.Characteristics.hap.CurrentHeaterCoolerState.HEATING : 
          this.Characteristics.hap.CurrentHeaterCoolerState.IDLE
      
      if (config.mode === 'off') {
        this.values.active = this.Characteristics.hap.Active.INACTIVE
      } else {
        this.values.active = this.Characteristics.hap.Active.ACTIVE
        this.values.targetHeaterCoolerState = config.mode === 'cool'
          ? this.Characteristics.hap.TargetHeaterCoolerState.COOL : config.mode === 'heat' 
          ? this.Characteristics.hap.TargetHeaterCoolerState.HEAT : 
            this.Characteristics.hap.TargetHeaterCoolerState.AUTO
      }
    }
    if (config.offset != null) {
      this.values.offset = Math.round(config.offset / 10) / 10
    }
    if (config.pulseconfiguration != null) {
      this.values.pulseConfiguration = config.pulseconfiguration
    }
    super.updateConfig(config)
  }

  updatePanels(hkValueToCheck) {
    let panelsToUpdate = this.gateway.platform.resourcesToPanels['/' + this.gateway.id + this.resource.rpath]
    
    if (panelsToUpdate && Array.isArray(panelsToUpdate) && panelsToUpdate.length) {
      for (var i = panelsToUpdate.length - 1; i >= 0; i--) {
        let panelResourceItem = panelsToUpdate[i]
        let pathComponents = panelResourceItem.split( '/' )
        if (pathComponents[4] === 'ac') {
          var shouldUpdatePanelState = true
          if (hkValueToCheck) {
            let acsControlledWithPanelDevice = this.gateway.platform.panelsToResources[panelResourceItem]
            for (var ii = acsControlledWithPanelDevice.length - 1; ii >= 0; ii--) {
              let acResourcePath = acsControlledWithPanelDevice[ii].split('/')
              let accessoryToCheck = this.gateway.platform.gatewayMap[acResourcePath[1]].accessoryByRpath['/' + acResourcePath[2] + '/' + acResourcePath[3]].service
              if (accessoryToCheck) {
                if (accessoryToCheck !== this && accessoryToCheck.values[hkValueToCheck] !== undefined && accessoryToCheck.values[hkValueToCheck] != this.values[hkValueToCheck]) {
                  shouldUpdatePanelState = false
                  break
                }
              }
            }
          }
          
          if (shouldUpdatePanelState) {
            this.updatePanel(pathComponents)
          }
        }
      }
    }
  }

  updatePanel(pathComponents) {
    const internalThermostat = this.gateway.platform._configJson.actionsConfigData[pathComponents[1]].aqara_S1_panels['/' + pathComponents[2] + '/' + pathComponents[3]].ac.internal_thermostat
    const temperature = this.values.targetHeaterCoolerState === this.Characteristics.hap.TargetHeaterCoolerState.HEAT ? this.values.heatingThresholdTemperature : this.values.targetHeaterCoolerState === this.Characteristics.hap.TargetHeaterCoolerState.COOL ? this.values.coolingThresholdTemperature : 255
    this.gateway.platform.gatewayMap[pathComponents[1]].sendStateToPanel(pathComponents, '6169725f636f6e64', internalThermostat ? '0e020055' : '0e200055', (this.values.active === this.Characteristics.hap.Active.ACTIVE ? '1' : '0') + (this.values.targetHeaterCoolerState === this.Characteristics.hap.TargetHeaterCoolerState.HEAT ? '0' : this.values.targetHeaterCoolerState === this.Characteristics.hap.TargetHeaterCoolerState.COOL ? '1' : '2') + (this.values.fanmode === 25 ? '0' : this.values.fanmode === 50 ? '1' : this.values.fanmode === 75 ? '2' : '3') + (internalThermostat ? '0' : 'f') + temperature.toString(16).padStart(2, '0') + (internalThermostat ? ((Math.round(this.values.currentTemperature) + 0) * 4).toString(16).padStart(2, '0') : '00'))
  }
}

module.exports = HeaterCooler
