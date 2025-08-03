// homebridge-deconz/lib/DeconzPlatform.js
// Copyright © 2022-2025 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

import { once } from 'node:events'

import { timeout } from 'homebridge-lib'
import { HttpClient } from 'homebridge-lib/HttpClient'
import { OptionParser } from 'homebridge-lib/OptionParser'
import { Platform } from 'homebridge-lib/Platform'

import { Discovery } from 'hb-deconz-tools/Discovery'

import { DeconzAccessory } from './DeconzAccessory/index.js'
import './DeconzAccessory/Gateway.js'

// Added by me: Arye Levin
import * as https from 'node:https'
// import { readFileSync } from 'node:fs'
import * as fs from 'node:fs'
import './DeconzAccessory/Platform.js'
import './DeconzAccessory/JewishCalendarSensor.js'
import './DeconzAccessory/DummySwitch.js'
// End of Added by me: Arye Levin
class DeconzPlatform extends Platform {
  constructor (log, configJson, homebridge, bridge) {
    super(log, configJson, homebridge)
    this.parseConfigJson(configJson)
    this.debug('config: %j', this.config)

    this
      .on('accessoryRestored', this.accessoryRestored)
      .once('heartbeat', this.init)
      .on('heartbeat', this.heartbeat)
  }

  parseConfigJson (configJson) {
    this.config = {
      forceHttp: false,
      hosts: [],
      noResponse: false,
      parallelRequests: 10,
      stealth: false,
      timeout: 5,
      waitTimePut: 50,
      waitTimePutGroup: 1000,
      waitTimeResend: 300,
      waitTimeReset: 500,
      waitTimeUpdate: 100
    }
    const optionParser = new OptionParser(this.config, true)
    optionParser
      .on('userInputError', (message) => {
        this.warn('config.json: %s', message)
      })
      .stringKey('name')
      .stringKey('platform')
      .boolKey('forceHttp')
      .stringKey('host')
      .arrayKey('hosts')
      .boolKey('noResponse')
      .intKey('parallelRequests', 1, 30)
      .boolKey('stealth')
      .intKey('timeout', 5, 30)
      .intKey('waitTimePut', 0, 50)
      .intKey('waitTimePutGroup', 0, 1000)
      .intKey('waitTimeResend', 100, 1000)
      .intKey('waitTimeReset', 10, 2000)
      .intKey('waitTimeUpdate', 0, 500)

    this.gatewayMap = {}
    // Added by me: Arye Levin
    this.panelsToResources = {}
    this.resourcesToPanels = {}
    this.allPanels = []
    this.lastWeatherData = { temperature: -1, humidity: -1, weathercode: -1, uvindex: -1 }
    // End of Added by me: Arye Levin

    try {
      optionParser.parse(configJson)
      if (this.config.host != null) {
        this.config.hosts.push(this.config.host)
      }
      this.discovery = new Discovery({
        forceHttp: this.config.forceHttp,
        timeout: this.config.timeout
      })
      this.discovery
        .on('error', (error) => {
          if (error instanceof HttpClient.HttpError) {
            this.log(
              '%s: request %d: %s %s', error.request.name,
              error.request.id, error.request.method, error.request.resource
            )
            this.warn(
              '%s: request %d: %s', error.request.name, error.request.id, error
            )
            return
          }
          this.warn(error)
        })
        .on('request', (request) => {
          this.debug(
            '%s: request %d: %s %s', request.name,
            request.id, request.method, request.resource
          )
        })
        .on('response', (response) => {
          this.debug(
            '%s: request %d: %d %s', response.request.name,
            response.request.id, response.statusCode, response.statusMessage
          )
        })
        .on('found', (name, id, address) => {
          this.debug('%s: found %s at %s', name, id, address)
        })
        .on('searching', (host) => {
          this.debug('upnp: listening on %s', host)
        })
        .on('searchDone', () => { this.debug('upnp: search done') })
    } catch (error) {
      this.error(error)
    }
  }

  async foundGateway (host, config) {
    const id = config.bridgeid
    if (this.gatewayMap[id] == null) {
      this.gatewayMap[id] = new DeconzAccessory.Gateway(this, { config, host })
    }
    await this.gatewayMap[id].found(host, config)
    await once(this.gatewayMap[id], 'initialised')
    this.emit('found')
  }

  async findHost (host) {
    try {
      const config = await this.discovery.config(host)
      await this.foundGateway(host, config)
    } catch (error) {
      this.warn('%s: %s - retrying in 15s', host, error)
      await timeout(15000) // Changed by me to 15s: Arye Levin
      return this.findHost(host)
    }
  }

  async init () {
    // Added by me: Arye Levin
    this.platformAccessory = new DeconzAccessory.Platform(this)

    let jewishCalendarConfig = this._configJson.jewishCalendarConfig
    if (jewishCalendarConfig) {
      this.hebrewCalendar = new DeconzAccessory.JewishCalendarSensor(this, jewishCalendarConfig)
    }

    let dummySwitches = this._configJson.dummySwitches
    this.dummySwitchesAccessories = []

    for (const index in dummySwitches) {
      let switchConfig = dummySwitches[index]
      let accessory = new DeconzAccessory.DummySwitch(this, switchConfig)
      this.dummySwitchesAccessories.push(accessory)
    }

    if (this._configJson.addShabbatModeDummy === true) {
      this.shabbatModeSwitch = new DeconzAccessory.DummySwitch(this, { "name": "System Shabbat Mode", "stateful": true })
      this.shabbatModeSwitch.service.characteristicDelegate('on').on('didSet', (value, fromHomeKit) => {
        if (fromHomeKit) {
          this.platformAccessory.service.characteristicDelegate('switchesOn').value = !value
        }
      }).value = !this.platformAccessory.service.characteristicDelegate('switchesOn').value
    }
    // End of Added by me: Arye Levin
    try {
      const jobs = []
      if (this.config.hosts.length > 0) {
        for (const host of this.config.hosts) {
          this.debug('job %d: find gateway at %s', jobs.length, host)
          jobs.push(this.findHost(host))
        }
      } else {
        this.debug('job %d: find at least one gateway', jobs.length)
        jobs.push(once(this, 'found'))
        for (const id in this.gatewayMap) {
          const gateway = this.gatewayMap[id]
          const host = gateway.values.host
          this.debug('job %d: find gateway %s', jobs.length, id)
          jobs.push(once(gateway, 'initialised'))
          try {
            const config = await this.discovery.config(host)
            await this.foundGateway(host, config)
          } catch (error) {
            this.warn('%s: %s', id, error)
          }
        }
      }

      this.debug('waiting for %d jobs', jobs.length)
      for (const id in jobs) {
        try {
          await jobs[id]
          this.debug('job %d/%d: done', Number(id) + 1, jobs.length)
        } catch (error) {
          this.warn(error)
        }
      }

      this.log('%d gateways', Object.keys(this.gatewayMap).length)
      this.emit('initialised')
      const dumpInfo = {
        config: this.config,
        gatewayMap: {}
      }
      for (const id in this.gatewayMap) {
        const gateway = this.gatewayMap[id]
        dumpInfo.gatewayMap[id] = Object.assign({}, gateway.context)
        dumpInfo.gatewayMap[id].deviceById = gateway.deviceById
      }
      await this.createDumpFile(dumpInfo)
    } catch (error) { this.error(error) }
  }

  async onUiRequest (method, url, body) {
    const path = url.split('/').slice(1)
    if (path.length < 1) {
      return { status: 403 } // Forbidden
    }
    if (path[0] === 'gateways') {
      if (path.length === 1) {
        if (method === 'GET') {
          // const gatewayByHost = await this.discovery.discover()
          const body = {}
          for (const id of Object.keys(this.gatewayMap).sort()) {
            const gateway = this.gatewayMap[id]
            body[gateway.values.host] = {
              config: gateway.context.config,
              host: gateway.values.host,
              id
            }
          }
          return { status: 200, body }
        }
        return { status: 405 } // Method Not Allowed
      }
      const gateway = this.gatewayMap[path[1]]
      if (gateway == null) {
        return { status: 404 } // Not Found
      }
      if (method === 'GET') {
        return gateway.onUiGet(path.slice(2))
      }
      if (method === 'PUT') {
        return gateway.onUiPut(path.slice(2), body)
      }
      return { status: 405 } // Method Not Allowed
    }
    return { status: 403 } // Forbidden
  }

  async heartbeat (beat) {
    try {
      if (beat % 300 === 5 && this.config.hosts.length === 0) {
        const configs = await this.discovery.discover()
        const jobs = []
        for (const host in configs) {
          jobs.push(this.foundGateway(host, configs[host]))
        }
        for (const job of jobs) {
          try {
            await job
          } catch (error) {
            this.error(error)
          }
        }
      }
      // Added by me: Arye Levin
      const updateWeatherEvery = 300 // Seconds!!! // 900 is 15 minutes
      // FIXME: If there is no panels configured with any controlled devices (AC, Lights or Curtains) but switch is configured, then this.allPanels.length will always be 0 and Object.keys(this.panelsToResources).length will always be true since the switches is linked (No sensor resource only light), which will lead to contant loading of weather.
      if ((!this.allPanels.length && Object.keys(this.panelsToResources).length) || (beat % updateWeatherEvery === 0 && this.allPanels.length)) {
        if (!this.allPanels.length) {
          const panelsResourcePaths = Object.keys(this.panelsToResources)
          for (let index = 0; index < panelsResourcePaths.length; index++) {
            const panelsResourcePath = panelsResourcePaths[index].split('/')
            const resourcePath = '/' + panelsResourcePath[1] + '/' + panelsResourcePath[2] + '/' + panelsResourcePath[3]
            if (panelsResourcePath[2] === 'sensors' && this.allPanels.indexOf(resourcePath) < 0) {
              this.allPanels.push(resourcePath)
            }
          }
        }

        const that = this

        let casigningcert = this._configJson.caFile ? fs.readFileSync(this._configJson.caFile) : undefined
        // https.get('https://api.open-meteo.com/v1/forecast?latitude=32.08934&longitude=34.83760&hourly=relativehumidity_2m,uv_index&current_weather=true&forecast_days=1', casigningcert ? {ca: casigningcert} : {}, res => {
        https.get('https://api.open-meteo.com/v1/forecast?latitude=' + this._configJson.homeLocationCoords.latitude + '&longitude=' + this._configJson.homeLocationCoords.longitude + '&hourly=relativehumidity_2m,uv_index&current_weather=true&forecast_days=1', casigningcert ? {ca: casigningcert} : {}, res => {
          const data = []
          const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'
          that.debug('Status Code:', res.statusCode)
          that.debug('Date in Response header:', headerDate)

          res.on('data', chunk => {
            data.push(chunk)
          })

          res.on('end', () => {
            that.log('Response ended')
            const parsedData = JSON.parse(Buffer.concat(data).toString())

            if (parsedData) {
              // The panel wordings is: {0: 'Sunny', 1: 'Clear', 2: 'Fair', 3: 'Fair', 4: 'Cloudy', 5: 'Partly Cloudy', 6: 'Partly Cloudy', 7: 'Mostly Cloudy', 8: 'Mostly Cloudy', 9: 'Overcast', 10: 'Shower', 11: 'Thundershower', 12: 'Hail', 13: 'Light Rain', 14: 'Moderate Rain', 15: 'Heavy Rain', 16: 'Storm', 17: 'Heavy Storm', 18: 'Severe Storm', 19: 'Ice Rain', 20: 'Sleet', 21: 'Snow Flurry', 22: 'Light Snow', 23: 'Moderate Snow', 24: 'Heavy Snow', 25: 'Snowstorm', 26: 'Dust', 27: 'Sand', 28: 'Duststorm', 29: 'Sandstorm', 30: 'Foggy', 31: 'Haze', 32: 'Windy', 33: 'Blustery', 34: 'Hurricane', 35: 'Tropical Storm', 36: 'Tornado', 37: 'Cold', 38: 'Hot', 39: '--'}
              const wmoWeatherInterpretationCodesToPanelCodes = { 0: 1, 1: 2, 2: 5, 3: 9, 45: 30, 48: 30, 51: 10, 53: 10, 55: 11, 56: 12, 57: 12, 61: 13, 63: 14, 65: 15, 66: 19, 67: 20, 71: 22, 73: 23, 75: 24, 77: 25, 80: 16, 81: 17, 82: 18, 85: 24, 86: 25, 95: 37, 96: 37, 99: 37 }
              const temperature = Math.round(parsedData.current_weather.temperature) // floor/ceil/round
              const humidity = parsedData.hourly.relativehumidity_2m[parsedData.hourly.time.indexOf(parsedData.current_weather.time.slice(0, -2) + '00')] || 0
              const weathercode = wmoWeatherInterpretationCodesToPanelCodes[parsedData.current_weather.weathercode] || 39
              const uvindex = 4096 // 4096 Will show "!" sign and "--" instead any number
              that.log('temperature: ' + temperature + ', humidity: ' + humidity + ', weathercode: ' + weathercode + '.')

              for (let index = 0; index < that.allPanels.length; index++) {
                const panelsResourcePath = that.allPanels[index].split('/')
                const gateway = that.gatewayMap[panelsResourcePath[1]]
                if (gateway.initialised) {
                  if (weathercode !== that.lastWeatherData.weathercode) {
                    gateway.sendFeelPageDataToPanel(panelsResourcePath, gateway.id.toLowerCase(), '0d020055', weathercode.toString(16).padStart(8, '0'))
                  }
                  // TODO: Send temperature and humidity only if no temperature sensor is configured on the panel configuration...
                  if (temperature !== that.lastWeatherData.temperature) {
                    gateway.sendFeelPageDataToPanel(panelsResourcePath, gateway.id.toLowerCase(), '00040055', gateway.getAqaraHexFromInt(temperature).toString(16).padStart(4, '0') + '0000')
                  }
                  if (humidity !== that.lastWeatherData.humidity) {
                    gateway.sendFeelPageDataToPanel(panelsResourcePath, gateway.id.toLowerCase(), '00050055', gateway.getAqaraHexFromInt(humidity).toString(16).padStart(4, '0') + '0000')
                  }
                  if (uvindex !== that.lastWeatherData.uvindex) {
                    gateway.sendFeelPageDataToPanel(panelsResourcePath, gateway.id.toLowerCase(), '00060055', gateway.getAqaraHexFromInt(uvindex).toString(16).padStart(4, '0') + '0000')
                  }
                }
              }
              that.lastWeatherData.weathercode = weathercode
              that.lastWeatherData.temperature = temperature
              that.lastWeatherData.humidity = humidity
              that.lastWeatherData.uvindex = uvindex
            }
          })
        }).on('error', err => {
          that.log('Error: ', err.message)
          that.error(err)
        })
      }
      // End of Added by me: Arye Levin
    } catch (error) { this.error(error) }
  }

  /** Called when an accessory has been restored.
    *
    * Re-create {@link DeconzAccessory.Gateway Gateway} delegates for restored
    * gateway accessories.
    * Accessories for devices exposed by the gateway will be restored from
    * the gateway context, once Homebridge has started it's HAP server.
    */
  accessoryRestored (className, version, id, name, context) {
    try {
      if (className === 'Gateway') {
        if (
          this.config.hosts.length === 0 ||
          this.config.hosts.includes(context.host)
        ) {
          this.gatewayMap[id] = new DeconzAccessory.Gateway(this, context)
        }
      }
    } catch (error) { this.error(error) }
  }
}

export { DeconzPlatform }
