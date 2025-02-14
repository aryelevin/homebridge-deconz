// homebridge-deconz/lib/DeconzService/WindowCovering.js
// Copyright © 2022-2025 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

import { timeout } from 'homebridge-lib'

import { DeconzService } from '../DeconzService/index.js'
import '../DeconzService/LightsResource.js'

class WindowCovering extends DeconzService.LightsResource {
  constructor (accessory, resource, params = {}) {
    params.Service = accessory.Services.hap.WindowCovering
    super(accessory, resource, params)

    this.addCharacteristicDelegate({
      key: 'venetianBlind',
      value: false,
      silent: true
    })

    this.addCharacteristicDelegate({
      key: 'currentPosition',
      Characteristic: this.Characteristics.hap.CurrentPosition,
      unit: '%'
    })
    // Added by me: Arye Levin
      .on('didSet', async (value, fromHomeKit) => {
      // TODO: maybe i should set the this.values.positionState = this.Characteristics.hap.PositionState.STOPPED here, as this means the movement finished... (maybe compare target and current position before doing so... only if the're equal set it...)
        this.log('Current position set to %d', value)
        // const positionToAqaraHex = {0: '0000', 1: '3f80', 2: '4000', 3: '4040', 4: '4080', 5: '40a0', 6: '40c0', 7: '40e0', 8: '4100', 9: '4110', 10: '4120', 11: '4130', 12: '4140', 13: '4150', 14: '4160', 15: '4170', 16: '4180', 17: '4188', 18: '4190', 19: '4198', 20: '41a0', 21: '41a8', 22: '41b0', 23: '41b8', 24: '41c0', 25: '41c8', 26: '41d0', 27: '41d8', 28: '41e0', 29: '41e8', 30: '41f0', 31: '41f8', 32: '4200', 33: '4204', 34: '4208', 35: '420c', 36: '4210', 37: '4214', 38: '4218', 39: '421c', 40: '4220', 41: '4224', 42: '4228', 43: '422c', 44: '4230', 45: '4234', 46: '4238', 47: '423c', 48: '4240', 49: '4244', 50: '4248', 51: '424c', 52: '4250', 53: '4254', 54: '4258', 55: '425c', 56: '4260', 57: '4264', 58: '4268', 59: '426c', 60: '4270', 61: '4274', 62: '4278', 63: '427c', 64: '4280', 65: '4282', 66: '4284', 67: '4286', 68: '4288', 69: '428a', 70: '428c', 71: '428e', 72: '4290', 73: '4292', 74: '4294', 75: '4296', 76: '4298', 77: '429a', 78: '429c', 79: '429e', 80: '42a0', 81: '42a2', 82: '42a4', 83: '42a6', 84: '42a8', 85: '42aa', 86: '42ac', 87: '42ae', 88: '42b0', 89: '42b2', 90: '42b4', 91: '42b6', 92: '42b8', 93: '42ba', 94: '42bc', 95: '42be', 96: '42c0', 97: '42c2', 98: '42c4', 99: '42c6', 100: '42c8'}
        this.updatePanels('01010055', this.gateway.getAqaraHexFromInt(value).toString(16).padStart(4, '0')/* positionToAqaraHex[this.hk.currentPosition] */ + '0000', 'targetPosition')
        this.updatePanels('0e020055', '00000002', 'targetPosition')
      })
    // End of Added by me: Arye Levin

    this.addCharacteristicDelegate({
      key: 'targetPosition',
      Characteristic: this.Characteristics.hap.TargetPosition,
      unit: '%'
    }).on('didSet', async (value, fromHomeKit) => {
      if (!fromHomeKit) {
        return
      }
      this.values.targetPosition = Math.round(this.values.targetPosition / 5) * 5
      return this.setPosition()
    })

    this.addCharacteristicDelegate({
      key: 'positionState',
      Characteristic: this.Characteristics.hap.PositionState,
      value: this.Characteristics.hap.PositionState.STOPPED
    })

    this.addCharacteristicDelegate({
      key: 'holdPosition',
      Characteristic: this.Characteristics.hap.HoldPosition
    }).on('didSet', async () => {
      await this.put(this.statePath, { stop: true })
      this.values.positionState = this.Characteristics.hap.PositionState.STOPPED
    })

    if (this.values.venetianBlind) {
      this.addCharacteristicDelegate({
        key: 'closeUpwards',
        Characteristic: this.Characteristics.my.CloseUpwards
      }).on('didSet', async (value, fromHomeKit) => {
        if (!fromHomeKit) {
          return
        }
        if (this.values.currentPosition !== 100) {
          return this.setPosition()
        }
      })
    }

    if (resource.capabilities.maxSpeed != null) {
      this.addCharacteristicDelegate({
        key: 'motorSpeed',
        Characteristic: this.Characteristics.my.MotorSpeed,
        unit: '',
        props: {
          unit: '',
          minValue: 0,
          maxValue: resource.capabilities.maxSpeed,
          minStep: 1
        }
      }).on('didSet', async (value, fromHomeKit) => {
        if (!fromHomeKit) {
          return
        }
        await this.put('/config', { speed: value })
      })
    }

    if (resource.capabilities.positionChange) {
      this.addCharacteristicDelegate({
        key: 'positionChange',
        Characteristic: this.Characteristics.my.PositionChange
      }).on('didSet', async (value) => {
        if (value !== 0) {
          await this.put(this.statePath, { lift_inc: -value })
          await timeout(this.platform.config.waitTimeReset)
          this.values.positionChange = 0
        }
      })
      this.values.positionChange = 0
    }

    this.addCharacteristicDelegates()

    this.update(resource.body, resource.rpath)
    this.values.targetPosition = this.values.currentPosition
  }

  async setPosition () {
    let lift = 100 - this.values.targetPosition // % closed --> % open
    if (this.values.venetianBlind) {
      if (this.values.closeUpwards) {
        lift *= -1
      }
      lift += 100
      lift /= 2
      lift = Math.round(lift)
      this.targetCloseUpwards = this.values.closeUpwards
    }
    this.values.positionState =
      this.values.targetPosition > this.values.currentPosition
        ? this.Characteristics.hap.PositionState.INCREASING
        : this.Characteristics.hap.PositionState.DECREASING
    this.moving = new Date()
    // Added by me: Arye Levin
    this.updatePanels('0e020055', '000000' + (this.values.positionState === this.Characteristics.hap.PositionState.INCREASING ? 1 : 0).toString(16).padStart(2, '0'), 'targetPosition')
    // End of Added by me: Arye Levin
    if (
      this.resource.capabilities.useOpen &&
      (this.lift === 0 || lift === 100)
    ) {
      return this.put(this.statePath, { open: lift === 0 })
    }
    return this.put(this.statePath, { lift })
  }

  updateState (state) {
    if (state.lift != null) {
      let position = Math.round(state.lift / 5) * 5
      let closeUpwards
      if (this.values.venetianBlind) {
        position *= 2
        position -= 100
        if (position < 0) {
          position *= -1
          closeUpwards = true
        } else if (position > 0) {
          closeUpwards = false
        }
      }
      position = 100 - position // % open -> % closed
      this.values.currentPosition = position
      if (closeUpwards != null) {
        this.values.closeUpwards = closeUpwards
      }
      if (
        this.moving == null || new Date() - this.moving >= 30000 || (
          position === this.values.targetPosition &&
          (closeUpwards == null || closeUpwards === this.targetCloseUpwards)
        )
      ) {
        this.moving = null
        this.values.targetPosition = position
        this.values.positionState = this.Characteristics.hap.PositionState.STOPPED
      }
    }
    if (state.speed != null) {
      this.values.motorSpeed = state.speed
    }
    super.updateState(state)
  }

  // Added by me: Arye Levin
  updatePanels (parameter, content, hkValueToCheck) {
    const panelsToUpdate = this.gateway.platform.resourcesToPanels['/' + this.gateway.id + this.resource.rpath]

    if (panelsToUpdate && Array.isArray(panelsToUpdate) && panelsToUpdate.length) {
      for (let i = panelsToUpdate.length - 1; i >= 0; i--) {
        const panelResourceItem = panelsToUpdate[i]
        const pathComponents = panelResourceItem.split('/')
        if (pathComponents[4].startsWith('curtain')) {
          const lightsControlledWithPanelDevice = this.gateway.platform.panelsToResources[panelResourceItem]
          let shouldUpdatePanelState = true
          for (let ii = lightsControlledWithPanelDevice.length - 1; ii >= 0; ii--) {
            const lightResourcePath = lightsControlledWithPanelDevice[ii].split('/')
            const accessoryToCheck = this.gateway.platform.gatewayMap[lightResourcePath[1]].accessoryByRpath['/' + lightResourcePath[2] + '/' + lightResourcePath[3]].service
            if (accessoryToCheck) {
              if (accessoryToCheck !== this && accessoryToCheck.values[hkValueToCheck] !== undefined && accessoryToCheck.values[hkValueToCheck] !== this.values[hkValueToCheck]) { // this.obj.state.on
                shouldUpdatePanelState = false
                break
              }
            }
          }

          if (shouldUpdatePanelState) {
            this.updatePanel(pathComponents, parameter, content)
          }
        }
      }
    }
  }

  updatePanel (pathComponents, parameter, content) {
    this.gateway.platform.gatewayMap[pathComponents[1]].sendStateToPanel(pathComponents, '6375727461696e' + parseInt(pathComponents[4].charAt(pathComponents[4].length - 1)).toString(16).padStart(2, '3'), parameter, content)
  }

  updatePanelPositionState (pathComponents) {
    const aqaraPosition = this.gateway.getAqaraHexFromInt(this.values.targetPosition).toString(16).padStart(4, '0')
    this.log('HK Position: ' + this.values.targetPosition + ', Aqara Position: ' + aqaraPosition)
    this.updatePanel(pathComponents, '01010055', aqaraPosition + '0000')
  }

  updatePanelMovementState (pathComponents) {
    let movementState = '00000002' // Stopped...
    if (this.values.positionState !== this.Characteristics.hap.PositionState.STOPPED/* this.values.targetPosition !== this.values.currentPosition */) {
      movementState = '000000' + (this.values.positionState === this.Characteristics.hap.PositionState.INCREASING ? 1 : 0).toString(16).padStart(2, '0')
    }
    this.log('HK PositionState: ' + (this.values.positionState === this.Characteristics.hap.PositionState.INCREASING ? 'INCREASING' : this.values.positionState === this.Characteristics.hap.PositionState.DECREASING ? 'DECREASING' : 'STOPPED'))
    this.updatePanel(pathComponents, '0e020055', movementState)
  }
  // End of Added by me: Arye Levin
}

DeconzService.WindowCovering = WindowCovering
