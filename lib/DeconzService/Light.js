// homebridge-deconz/lib/DeconzService/Light.js
// Copyright © 2022-2025 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

import { timeout } from 'homebridge-lib'
import { AdaptiveLighting } from 'homebridge-lib/AdaptiveLighting'
import { Colour } from 'homebridge-lib/Colour'
import { ServiceDelegate } from 'homebridge-lib/ServiceDelegate'

import { DeconzService } from '../DeconzService/index.js'
import '../DeconzService/LightsResource.js'

const { defaultGamut, xyToHsv, hsvToXy, ctToXy } = Colour

class Light extends DeconzService.LightsResource {
  constructor (accessory, resource, params = {}) {
    params.Service = accessory.Services.hap.Lightbulb
    super(accessory, resource, params)

    this.capabilities = {
      on: this.resource.body.state.on !== undefined,
      bri: this.resource.body[this.stateKey].bri !== undefined,
      ct: this.resource.body[this.stateKey].ct !== undefined,
      hs: this.resource.body[this.stateKey].xy === undefined &&
        this.resource.body[this.stateKey].hue !== undefined,
      xy: this.resource.body[this.stateKey].xy !== undefined
    }
    if (this.resource.body.action?.effect !== undefined) {
      this.capabilities.colorLoop = true
    } else if (this.resource.body?.capabilities?.color?.effects != null) {
      const effects = this.resource.body.capabilities.color.effects
      if (effects.length > 1 && effects[1] === 'colorloop') {
        this.capabilities.colorLoop = true
        this.capabilities.effects = effects.length > 2
      } else if (effects.length > 1) {
        this.capabilities.effects = effects.length > 1
      }
    }

    this.addCharacteristicDelegate({
      key: 'on',
      Characteristic: this.Characteristics.hap.On,
      value: this.capabilities.on
        ? this.resource.body.state.on
        : this.resource.body.state.all_on
    }).on('didSet', (value, fromHomeKit) => {
      if (fromHomeKit) {
        this.putState({ on: value })
        this.updateAdaptiveLighting()
      }
      // Added by me: Arye Levin
      this.updatePanelsOnState(value)
      // End of Added by me: Arye Levin
    })

    if (!this.capabilities.on) {
      this.addCharacteristicDelegate({
        key: 'anyOn',
        Characteristic: this.Characteristics.my.AnyOn,
        value: this.resource.body.state.any_on
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          this.putState({ on: value })
          this.updateAdaptiveLighting()
        }
      })
    }

    if (this.capabilities.bri) {
      this.brightnessDelegate = this.addCharacteristicDelegate({
        key: 'brightness',
        Characteristic: this.Characteristics.hap.Brightness,
        unit: '%',
        value: Math.round(this.resource.body[this.stateKey].bri / 2.54)
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          const bri = Math.round(value * 2.54)
          this.putState({ bri })
          this.updateAdaptiveLighting()
        }
        // Added by me: Arye Levin
        this.updatePanels('0e010055', '000000' + value.toString(16).padStart(2, '0'), 'bri')
        // End of Added by me: Arye Levin
      })

      this.addCharacteristicDelegate({
        key: 'brightnessChange',
        Characteristic: this.Characteristics.my.BrightnessChange,
        value: 0
      }).on('didSet', async (value) => {
        this.putState({ bri_inc: Math.round(value * 254.0 / 100.0) })
        await timeout(this.platform.config.waitTimeReset)
        this.values.brightnessChange = 0
      })
      this.values.brightnessChange = 0
    }

    if (this.capabilities.ct || this.capabilities.xy || this.capabilities.hs) {
      this.addCharacteristicDelegate({
        key: 'colormode',
        value: this.resource.body[this.stateKey].colormode,
        silent: true
      }).on('didSet', (value) => {
        this.resource.body.colormode = value
        if (value !== 'ct') {
          this.checkAdaptiveLighting()
        }
      })
    }

    if (this.resource.body?.config?.color?.execute_if_off != null) {
      this.addCharacteristicDelegate({
        key: 'colorExecuteIfOff',
        value: this.resource.body.config.color.execute_if_off
      }).on('didSet', async (value) => {
        try {
          await this.put('/config', { color: { execute_if_off: value } })
        } catch (error) { this.warn(error) }
      })
    }

    if (this.capabilities.ct) {
      if (
        this.resource.body?.capabilities?.color?.ct?.min == null ||
        this.resource.body?.capabilities?.color?.ct?.max == null
      ) {
        if (this.capabilities.on) {
          this.warn('using default ct range')
        }
      }
      const ctMin = this.resource.body?.capabilities?.color?.ct?.min ?? 153
      const ctMax = this.resource.body?.capabilities?.color?.ct?.max ?? 500
      this.colorTemperatureDelegate = this.addCharacteristicDelegate({
        key: 'colorTemperature',
        Characteristic: this.Characteristics.hap.ColorTemperature,
        unit: ' mired',
        props: {
          minValue: ctMin,
          maxValue: ctMax
        },
        value: this.resource.body[this.stateKey].ct
      }).on('didSet', (value, fromHomeKit) => {
        const ct = Math.max(ctMin, Math.min(value, ctMax))
        if (fromHomeKit) {
          this.checkAdaptiveLighting()
          // Added by me: Arye Levin
          // this.putState({ ct })
          const calculatedCt = this.calculateCT(ct)
          this.putState({ ct: calculatedCt })
          // End of Added by me: Arye Levin
          this.values.colormode = 'ct'
        }
        if (this.capabilities.xy && this.values.colormode === 'ct') {
          const { h, s } = xyToHsv(ctToXy(ct), this.capabilities.gamut)
          this.values.hue = h
          this.values.saturation = s
        }
        // Added by me: Arye Levin
        this.updatePanels('0e020055', '0000' + ct.toString(16).padStart(4, '0'), 'colorTemperature')
        // End of Added by me: Arye Levin
      })
    }

    if (this.capabilities.xy) {
      if (
        this.resource.body?.capabilities?.color?.xy?.blue == null ||
        this.resource.body?.capabilities?.color?.xy?.green == null ||
        this.resource.body?.capabilities?.color?.xy?.red == null ||
        this.resource.body?.capabilities?.color?.xy?.green?.[1] === 0 ||
        this.resource.body?.capabilities?.color?.xy?.red?.[0] === 0
      ) {
        if (this.capabilities.on) {
          this.warn('using default xy gamut')
        }
        this.capabilities.gamut = defaultGamut
      } else {
        this.capabilities.gamut = {
          r: this.resource.body.capabilities.color.xy.red,
          g: this.resource.body.capabilities.color.xy.green,
          b: this.resource.body.capabilities.color.xy.blue
        }
      }

      this.addCharacteristicDelegate({
        key: 'hue',
        Characteristic: this.Characteristics.hap.Hue,
        unit: '°'
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          const xy = hsvToXy(
            value, this.values.saturation, this.capabilities.gamut
          )
          this.putState({ xy })
          this.values.colormode = 'xy'
        }
        // Added by me: Arye Levin
        const newXy = hsvToXy(value, this.values.saturation, this.capabilities.gamut)
        this.updatePanels('0e080055', Math.round(newXy[0] * 65535).toString(16).padStart(4, '0') + Math.round(newXy[1] * 65535).toString(16).padStart(4, '0'), 'hue')
        // End of Added by me: Arye Levin
      })
      this.addCharacteristicDelegate({
        key: 'saturation',
        Characteristic: this.Characteristics.hap.Saturation,
        unit: '%'
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          const xy = hsvToXy(this.values.hue, value, this.capabilities.gamut)
          this.putState({ xy })
          this.values.colormode = 'xy'
        }
        // Added by me: Arye Levin
        const newXy = hsvToXy(this.values.hue, value, this.capabilities.gamut)
        this.updatePanels('0e080055', Math.round(newXy[0] * 65535).toString(16).padStart(4, '0') + Math.round(newXy[1] * 65535).toString(16).padStart(4, '0'), 'saturation')
        // End of Added by me: Arye Levin
      })
    } else if (this.capabilities.hs) {
      this.addCharacteristicDelegate({
        key: 'hue',
        Characteristic: this.Characteristics.hap.Hue,
        unit: '°'
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          const hue = Math.round(this.values.hue * 65535.0 / 360.0)
          this.putState({ hue })
          this.values.colormode = 'hs'
        }
        // Added by me: Arye Levin
        const newXy = hsvToXy(value, this.values.saturation, this.capabilities.gamut)
        this.updatePanels('0e080055', Math.round(newXy[0] * 65535).toString(16).padStart(4, '0') + Math.round(newXy[1] * 65535).toString(16).padStart(4, '0'), 'hue')
        // End of Added by me: Arye Levin
      })
      this.addCharacteristicDelegate({
        key: 'saturation',
        Characteristic: this.Characteristics.hap.Saturation,
        unit: '%'
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          const sat = Math.round(this.values.saturation * 254.0 / 100.0)
          this.putState({ sat })
          this.values.colormode = 'hs'
        }
        // Added by me: Arye Levin
        const newXy = hsvToXy(this.values.hue, value, this.capabilities.gamut)
        this.updatePanels('0e080055', Math.round(newXy[0] * 65535).toString(16).padStart(4, '0') + Math.round(newXy[1] * 65535).toString(16).padStart(4, '0'), 'saturation')
        // End of Added by me: Arye Levin
      })
    }

    if (this.capabilities.colorLoop) {
      this.addCharacteristicDelegate({
        key: 'colorLoop',
        Characteristic: this.Characteristics.my.ColorLoop
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          const effect = value ? 'colorloop' : 'none'
          const state = { effect }
          if (value) {
            state.colorloopspeed = this.values.colorLoopSpeed
          }
          this.putState(state)
          this.values.colormode = 'hs'
        }
      })
      this.addCharacteristicDelegate({
        key: 'colorLoopSpeed',
        Characteristic: this.Characteristics.my.ColorLoopSpeed,
        unit: 's',
        value: 25
      }).on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          const effect = 'colorloop'
          this.putState({ effect, colorloopspeed: value })
          this.values.colormode = 'hs'
        }
      })
    }

    this.addCharacteristicDelegates()

    if (this.capabilities.bri && this.capabilities.ct && !this.capabilities.hs) {
      this.adaptiveLightingNotInitialised = true
      this.addCharacteristicDelegate({
        key: 'supportedTransitionConfiguration',
        Characteristic: this.Characteristics.hap
          .SupportedCharacteristicValueTransitionConfiguration,
        silent: true,
        getter: async () => {
          this.initAdaptiveLighting()
          return this.adaptiveLighting.generateConfiguration()
        }
      })
      this.addCharacteristicDelegate({
        key: 'transitionControl',
        Characteristic: this.Characteristics.hap
          .CharacteristicValueTransitionControl,
        silent: true,
        getter: async () => {
          this.initAdaptiveLighting()
          return this.adaptiveLighting.generateControl()
        },
        setter: async (value) => {
          this.initAdaptiveLighting()
          const control = this.adaptiveLighting.parseControl(value)
          this.context.transitionControl = value
          const response = this.adaptiveLighting.generateControlResponse()
          const parsedResponse = this.adaptiveLighting.parseControl(response)
          this.vdebug(
            'adaptive lighting: control update: %j => %j',
            control, parsedResponse
          )
          this.values.activeTransitionCount = parsedResponse === '' ? 0 : 1
          return response
        }
      })
      this.addCharacteristicDelegate({
        key: 'activeTransitionCount',
        Characteristic: this.Characteristics.hap
          .CharacteristicValueActiveTransitionCount,
        silent: true,
        value: 0
      }).on('didSet', (value) => {
        this.log('adaptive lighting: %sabled', value > 0 ? 'en' : 'dis')
        if (value) {
          this.updateAdaptiveLighting()
        }
      })
    }

    if (this.resource.rtype === 'groups') {
      this.addCharacteristicDelegate({
        key: 'exposeScenes',
        value: true
      })
      if (this.values.exposeScenes) {
        this.sceneServices = {}
        this.updateScenes(this.resource.body.scenes)
      }
    }

    if (this.capabilities.effects != null) {
      this.exposeEffects()
    }

    if (this.resource.rtype === 'lights') {
      this.addCharacteristicDelegate({
        key: 'wallSwitch',
        value: false
      })
    }
  }

  exposeEffects () {
    const effectString = this.addCharacteristicDelegate({
      key: 'effectString',
      value: 'none',
      silent: true
    })
    effectString.setMaxListeners(20)
    for (const id in this.resource.body.capabilities.color.effects) {
      const effect = this.resource.body.capabilities.color.effects[id]
      const characteristicName = effect[0].toUpperCase() + effect.slice(1) + 'Effect'
      if (this.Characteristics.my[characteristicName] != null) {
        this.addCharacteristicDelegate({
          key: effect,
          Characteristic: this.Characteristics.my[characteristicName]
        }).on('didSet', (value, fromHomeKit) => {
          if (fromHomeKit) {
            this.checkAdaptiveLighting()
            this.putState({ effect: value ? effect : 'none' })
            this.values.effectString = value ? effect : 'none'
          }
        })
        effectString.on('didSet', (value) => {
          this.values[effect] = value === effect
        })
      }
    }
    // if (this.capabilities.effectSpeed) {
    //   this.addCharacteristicDelegate({
    //     key: 'effectSpeed',
    //     Characteristic: this.Characteristics.my.EffectSpeed,
    //     value: 50
    //   }).on('didSet', (value) => {
    //     this.setEffectSpeed(value)
    //   })
    //   this.hk.effectColours = []
    //   for (let i = 0; i <= 5; i++) {
    //     const service = new this.Service.Lightbulb(
    //       this.name + ' Effect Color ' + (i + 1), this.subtype + '-C' + i
    //     )
    //     service.addCharacteristicDelegate({
    //       key: 'on',
    //       Characteristic: this.Characteristics.hap.On,
    //       value: true
    //     }).on('didSet', (value) => {
    //       this.setEffectOn(i, value)
    //     })
    //     service.addCharacteristicDelegate({
    //       key: 'hue',
    //       Characteristic: this.Characteristics.hap.Hue,
    //       value: i * 60
    //     }).on('didSet', (value) => {
    //       this.setEffectHue(i, value)
    //     })
    //     service.addCharacteristicDelegate({
    //       key: 'saturation',
    //       Characteristic: this.Characteristics.hap.Saturation,
    //       value: 100
    //     }).on('didSet', (value) => {
    //       this.setEffectSat(i, value)
    //     })
    //     this.effectServices.push(service)
    //   }
    // }
    // this.checkEffect(this.obj.state.effect)
  }

  updateState (state, rpath, stateKey = 'state') {
    if (/* Fingerbot -> */!(this.resource.manufacturer === '_TZ3210_dse8ogfy' && this.resource.model === 'TS0001') && this.resource.manufacturer !== 'ubisys' && this.resource.manufacturer !== 'EcoDim B.V' && this.resource.manufacturer !== 'ROBB smarrt' && this.resource.manufacturer !== 'SmartDimmer' && this.resource.manufacturer !== 'Idinio' && (this.resource.model !== 'lumi.switch.n4acn4' || !this.platform.platformAccessory.service.values.switchesOn) && (this.resource.model !== 'lumi.switch.n1acn1' || !this.platform.platformAccessory.service.values.switchesOn) && !this.platform._configJson.excludeForceState?.includes('/' + this.gateway.id + this.resource.rpath)) {
      state = { ...state } // Copy the state before the changes we're doing...
      this.debug('Override state update for light: ' + rpath + ', state: ' + JSON.stringify(state))
      const paramsToSet = {}
      if (state.on !== undefined && state.on !== this.values.on) {
        // this.log('On state is not equal, overriding...')
        paramsToSet.on = this.values.on
        state.on = this.values.on
      }
      if (state.all_on !== undefined && state.all_on !== this.values.on) {
        paramsToSet.on = this.values.on
        state.all_on = this.values.on
      }
      if (state.bri !== undefined) {
        const brightness = Math.round(this.values.brightness * 2.54)
        if (state.bri !== brightness) {
          paramsToSet.bri = brightness
          state.bri = brightness
        }
      }
      if (rpath.startsWith('/groups/') && stateKey === 'action') {
        if (this.values.activeTransitionCount > 0 && this.values.colormode === 'ct') {
          if (state.colormode !== 'ct') {
            paramsToSet.colormode = 'ct'
          }
          delete state.colormode
          // state.ct = 0 // Set it to something, so it will be set to the relevant value on the next if statement...
          delete state.ct // This is better than above, it will adjust the CT once the next update of the CT value happens...
          delete state.hue
          delete state.sat
          delete state.xy
        }
      }
      if (state.ct !== undefined && this.values.colormode === 'ct') {
        const calculatedCT = this.calculateCT(this.values.colorTemperature)
        if (state.ct !== calculatedCT) {
          if (this.values.on === true) { // Send only if device is on, otherwise it will fail...
            paramsToSet.ct = calculatedCT
          }
          state.ct = calculatedCT
        }
      }
      if (Object.keys(paramsToSet).length) {
        this.put(this.statePath, paramsToSet)
      }
    }
    this.initAdaptiveLighting()
    let updateAdaptiveLighting = false
    for (const key in state) {
      const value = state[key]
      // const oldValue = this.resource.body[stateKey][key]
      this.resource.body[stateKey][key] = value
      switch (key) {
        case 'all_on':
          this.values.on = value
          updateAdaptiveLighting = true
          break
        case 'any_on':
          this.values.anyOn = value
          updateAdaptiveLighting = true
          break
        case 'bri':
          if (!this.recentlyUpdated) {
            this.values.brightness = Math.max(1, Math.round(value / 2.54)) // iOS 16.4 Home bug
            // this.values.brightness = Math.round(value / 2.54)
            updateAdaptiveLighting = true
          }
          break
        case 'colormode':
          this.values.colormode = value
          break
        case 'ct':
          if (!this.recentlyUpdated && this.values.colormode === 'ct') {
            this.values.colorTemperature = value
          }
          break
        case 'effect':
          this.values.colorLoop = value === 'colorloop'
          if (this.capabilities.effects) {
            this.values.effectString = value
          }
          break
        case 'hue':
          if (!this.capabilities.xy) {
            this.values.hue = value
          }
          break
        case 'on':
          if (stateKey === 'action') {
            break
          }
          if (this.values.wallSwitch && !state.reachable) {
            if (this.values.on) {
              this.log('not reachable: force On to false')
            }
            this.values.on = false
            break
          }
          this.values.on = value
          break
        case 'sat':
          if (!this.capabilities.xy) {
            this.values.hue = value
          }
          break
        case 'xy':
          if (
            !this.recentlyUpdated && (
              this.values.colormode !== 'ct' ||
              this.resource.body?.capabilities?.color?.ct?.computesXy
            )
          ) {
            const { h, s } = xyToHsv(value, this.capabilities.gamut)
            this.values.hue = h
            this.values.saturation = s
          }
          break
        default:
          break
      }
    }
    if (updateAdaptiveLighting) {
      this.updateAdaptiveLighting()
    }
    super.updateState(state)
  }

  updateConfig (config) {
    for (const key in config) {
      const value = config[key]
      switch (key) {
        case 'color':
          if (value.execute_if_off != null) {
            this.values.colorExecuteIfOff = value.execute_if_off
          }
          break
        default:
          break
      }
    }
  }

  updateScenes (scenes) {
    if (!this.values.exposeScenes) {
      for (const id in this.scenesServices) {
        this.sceneServices[id].destroy()
        delete this.sceneServices[id]
      }
      return
    }
    const sceneById = {}
    for (const scene of scenes) {
      sceneById[scene.id] = scene
      if (this.sceneServices[scene.id] == null) {
        const service = new ServiceDelegate(this.accessoryDelegate, {
          name: this.resource.body.name + ' ' + scene.name,
          Service: this.Services.hap.Lightbulb,
          subtype: this.resource.subtype + '-S' + scene.id
        })
        service.addCharacteristicDelegate({
          key: 'on',
          Characteristic: this.Characteristics.hap.On,
          value: false
        }).on('didSet', async (value, fromHomeKit) => {
          this.checkAdaptiveLighting()
          if (fromHomeKit && value) {
            try {
              await this.put('/scenes/' + scene.id + '/recall')
            } catch (error) { this.warn(error) }
            await timeout(this.platform.config.waitTimeReset)
            service.values.on = false
          }
        })
        service.addCharacteristicDelegate({
          key: 'index',
          Characteristic: this.Characteristics.hap.ServiceLabelIndex,
          value: Number(scene.id) + 1
        })
        this.sceneServices[scene.id] = service
      }
    }
    for (const id in this.scenesServices) {
      if (sceneById[id] == null) {
        this.sceneServices[id].destroy()
        delete this.sceneServices[id]
      }
    }
  }

  initAdaptiveLighting () {
    if (this.adaptiveLightingNotInitialised) {
      delete this.adaptiveLightingNotInitialised
      this.adaptiveLighting = new AdaptiveLighting(
        this.brightnessDelegate, this.colorTemperatureDelegate
      )
      if (this.values.activeTransitionCount > 0) {
        const control = this.adaptiveLighting.parseControl(
          this.context.transitionControl
        )
        this.vdebug('adaptive lighting: restore control: %j', control)
        this.adaptiveLighting.parseControl(this.context.transitionControl)
      }
      this.log(
        'adaptive lighting: %sabled',
        this.values.activeTransitionCount > 0 ? 'en' : 'dis'
      )
    }
  }

  async updateAdaptiveLighting () {
    if (
      this.adaptiveLighting == null || // not supported
      this.values.activeTransitionCount === 0 // disabled
    ) {
      return
    }
    if (!this.values.on && !this.values.colorExecuteIfOff) {
      if (this.values.colorExecuteIfOff != null && !this.values.colorExecuteIfOff) {
        this.values.colorExecuteIfOff = true
      }
      return
    }
    const ct = this.adaptiveLighting.getCt(
      this.values.brightness * this.gateway.values.brightnessAdjustment
    )
    if (ct == null) {
      this.warn('adaptive lighting: cannot compute Color Temperature')
      return
    }
    if (this.values.colormode === 'ct' && ct === this.values.colorTemperature) {
      return
    }
    this.debug('adaptive lighting: set Color Temperature to %d mired', ct)
    // Added by me: Arye Levin
    // this.putState({ ct })
    const calculatedCt = this.calculateCT(ct)
    this.putState({ ct: calculatedCt })
    // End of Added by me: Arye Levin
    this.fromAdaptiveLighting = true
    this.values.colormode = 'ct'
    if (ct !== this.values.colorTemperature) {
      this.values.colorTemperature = ct // should only do this when PUT succeeds
    } else if (this.capabilities.xy) { // colormode changed
      const { h, s } = xyToHsv(ctToXy(ct), this.capabilities.gamut)
      this.values.hue = h
      this.values.saturation = s
    }
    this.fromAdaptiveLighting = false

    // Added by me: Arye Levin
    // this.updatePanels('0e020055', '0000' + ct.toString(16).padStart(4, '0'), 'colorTemperature')
    // const newXy = ctToXy(ct)
    // this.updatePanels('0e080055', Math.round(newXy[0] * 65535).toString(16).padStart(4, '0') + Math.round(newXy[1] * 65535).toString(16).padStart(4, '0'), 'hue', 'saturation')
    // End of Added by me: Arye Levin
  }

  checkAdaptiveLighting (key, value) {
    if (this.adaptiveLighting == null || this.fromAdaptiveLighting) {
      return
    }
    this.adaptiveLighting.deactivate()
    this.values.activeTransitionCount = 0
  }

  calculateCT (ct) {
    let calculatedCt = ct
    if (this.resource.body?.capabilities?.color?.ct?.originalMax && this.resource.body?.capabilities?.color?.ct?.actualMax && this.resource.body?.capabilities?.color?.ct?.originalMin && this.resource.body?.capabilities?.color?.ct?.actualMin) {
      calculatedCt = Math.max(this.resource.body.capabilities.color.ct.actualMin, Math.min(this.resource.body.capabilities.color.ct.actualMax, ct))
      const calculatedCTForLight = Math.round((((ct - this.resource.body.capabilities.color.ct.actualMin) * (this.resource.body.capabilities.color.ct.originalMax - this.resource.body.capabilities.color.ct.originalMin)) / (this.resource.body.capabilities.color.ct.actualMax - this.resource.body.capabilities.color.ct.actualMin)) + this.resource.body.capabilities.color.ct.originalMin)
      calculatedCt = calculatedCTForLight
      this.log('ct calculation is from %d to %d', ct, calculatedCt)
    }
    return calculatedCt
  }

  putCurrentBasicState () {
    if (/* Fingerbot -> */this.resource.manufacturer === '_TZ3210_dse8ogfy' && this.resource.model === 'TS0001'/* (this.config.doorLock && this.service.getCharacteristic(Characteristic.LockCurrentState).value == this.service.getCharacteristic(Characteristic.LockTargetState).value) */) {
      // this.log('putCurrentBasicState: %s is most probably a warning device such as a smoke sensor, skipping...', this.resource.rpath)
      return
    }

    this.debug('putCurrentBasicState: /%s%s', this.gateway.id, this.resource.rpath)
    const newOn = /* this.config.doorLock ? this.hk.lockTargetState === Characteristic.LockTargetState.SECURED : */this.values.on
    const params = { on: !!newOn }
    if (newOn && this.capabilities.bri && this.values.brightness) {
      const newBri = Math.round(this.values.brightness * 254.0 / 100.0)
      params.bri = newBri
    }
    if (this.capabilities.ct && this.values.colormode === 'ct' && newOn && this.values.colorTemperature) {
      const ctMin = this.resource.body?.capabilities?.color?.ct?.min ?? 153
      const ctMax = this.resource.body?.capabilities?.color?.ct?.max ?? 500

      const newCt = this.values.colorTemperature
      const ct = Math.max(ctMin, Math.min(newCt, ctMax))
      const calculatedCt = this.calculateCT(ct)
      params.ct = calculatedCt
    }
    // if (this.config.noTransitionTime && !newOn) {
    //   params.transitiontime = 0
    // }
    this.put(this.statePath, params).then(() => {
      // this.log('putCurrentBasicStateCompleted for: ' + this.resource.rpath);
    }).catch((err) => {
      this.error(err)
    })
  }

  updatePanelOnOffState (pathComponents) {
    this.log('On/Off: ' + this.values.on)
    this.updatePanel(pathComponents, '04010055', '000000' + (this.values.on ? 1 : 0).toString(16).padStart(2, '0'))
  }

  updatePanelBrightnessState (pathComponents) {
    this.log('Brightness: ' + this.values.brightness)
    this.updatePanel(pathComponents, '0e010055', '000000' + this.values.brightness.toString(16).padStart(2, '0'))
  }

  updatePanelColorTemperatureState (pathComponents) {
    this.log('Color Temperature: ' + this.values.colorTemperature)
    this.updatePanel(pathComponents, '0e020055', '0000' + this.values.colorTemperature.toString(16).padStart(4, '0'))
  }

  updatePanelColorState (pathComponents) {
    this.log('Color Hue: ' + this.values.hue + ', Color Saturation: ' + this.values.saturation)

    const xy = hsvToXy(this.values.hue, this.values.saturation, this.capabilities.gamut)
    this.log('Color X: ' + xy[0] + ', Color Y: ' + xy[1])
    this.updatePanel(pathComponents, '0e080055', Math.round(xy[0] * 65535).toString(16).padStart(4, '0') + Math.round(xy[1] * 65535).toString(16).padStart(4, '0'))
  }

  updatePanels (parameter, content, hkValueToCheck, secondHkValueToCheck = undefined) {
    const panelsToUpdate = this.gateway.platform.resourcesToPanels['/' + this.gateway.id + this.resource.rpath]

    if (panelsToUpdate && Array.isArray(panelsToUpdate) && panelsToUpdate.length) {
      for (let i = panelsToUpdate.length - 1; i >= 0; i--) {
        const panelResourceItem = panelsToUpdate[i]
        const pathComponents = panelResourceItem.split('/')
        if (pathComponents[4].startsWith('light')) {
          const lightsControlledWithPanelDevice = this.gateway.platform.panelsToResources[panelResourceItem]
          let shouldUpdatePanelState = true
          for (let ii = lightsControlledWithPanelDevice.length - 1; ii >= 0; ii--) {
            const lightResourcePath = lightsControlledWithPanelDevice[ii].split('/')
            const accessoryToCheck = this.gateway.platform.gatewayMap[lightResourcePath[1]].accessoryByRpath['/' + lightResourcePath[2] + '/' + lightResourcePath[3]].service
            if (accessoryToCheck) {
              if (accessoryToCheck !== this && accessoryToCheck.values[hkValueToCheck] !== undefined && ((accessoryToCheck.values[hkValueToCheck] !== this.values[hkValueToCheck]) || (secondHkValueToCheck !== undefined && accessoryToCheck.values[secondHkValueToCheck] !== undefined && accessoryToCheck.values[secondHkValueToCheck] !== this.values[secondHkValueToCheck]))) { // this.obj.state.on
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
    this.gateway.platform.gatewayMap[pathComponents[1]].sendStateToPanel(pathComponents, '6c69676874732f' + parseInt(pathComponents[4].charAt(pathComponents[4].length - 1)).toString(16).padStart(2, '3'), parameter, content)
  }

  updatePanelsOnState (newOn) {
    this.updatePanels('04010055', '000000' + (newOn ? 1 : 0).toString(16).padStart(2, '0'), 'on')
    // Queue it for a later processing to allow any other lights to complete its on/off operation to allow anyOn be correct...
    const that = this
    setTimeout(function () {
      const panelsToUpdate = that.gateway.platform.resourcesToPanels['/' + that.gateway.id + that.resource.rpath]

      if (panelsToUpdate && Array.isArray(panelsToUpdate) && panelsToUpdate.length) {
        for (let i = panelsToUpdate.length - 1; i >= 0; i--) {
          const panelResourceItem = panelsToUpdate[i]
          const pathComponents = panelResourceItem.split('/')

          if (pathComponents[4] === 'switch'/* && that.bridge.platform.bridgeMap[pathComponents[1]].fullState.lights[pathComponents[3]].state.on != that.hk.on */) {
            const lightsControlledWithPanelDevice = that.gateway.platform.panelsToResources[panelResourceItem]
            let anyOn = false
            if (newOn) {
              anyOn = true
            } else {
              for (let ii = lightsControlledWithPanelDevice.length - 1; ii >= 0; ii--) {
                const lightResourcePath = lightsControlledWithPanelDevice[ii].split('/')
                const accessoryToCheck = that.gateway.platform.gatewayMap[lightResourcePath[1]].accessoryByRpath['/' + lightResourcePath[2] + '/' + lightResourcePath[3]].service
                if (accessoryToCheck) {
                  if (accessoryToCheck !== that && accessoryToCheck.values.on) {
                    anyOn = true
                    break
                  }
                }
              }
            }

            if (anyOn !== that.gateway.platform.gatewayMap[pathComponents[1]].context.fullState.lights[pathComponents[3]].state.on) {
              const panelResourcePath = '/' + pathComponents[2] + '/' + pathComponents[3] + '/state'
              that.log('Going to set on: ' + anyOn + ' at panel: ' + panelResourcePath)
              that.gateway.platform.gatewayMap[pathComponents[1]].client.put(panelResourcePath, { on: anyOn }).then((obj) => {
                // To make sure to avoid its socket message with the attribute report...
                // We need to set it here at the callback of the PUT command, since we need to make sure that if more than 3 calls happens concurrently, it will be delayed and could get into on/off racing condition infinite loop. (To do this, i just need to verify that the attribute report of it happens only after the callback is triggered...)
                that.gateway.platform.gatewayMap[pathComponents[1]].context.fullState.lights[pathComponents[3]].state.on = anyOn
                that.log('Successfully set on: ' + anyOn + ' at panel: ' + panelResourcePath)
              }).catch((error) => {
                that.error('Error setting panel switch state %s: %s', panelResourcePath, error)
              })
            }
          }
        }
      }
    }, 0)
  }
}

DeconzService.Light = Light
