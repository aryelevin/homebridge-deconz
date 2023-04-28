// homebridge-deconz/lib/DeconzPlatform.js
// Copyright© 2022-2023 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

'use strict'

const events = require('events')
const { HttpClient, OptionParser, Platform, timeout } = require('homebridge-lib')
const Deconz = require('./Deconz')
const DeconzAccessory = require('./DeconzAccessory')

const https = require('https')

class DeconzPlatform extends Platform {
  constructor (log, configJson, homebridge, bridge) {
    super(log, configJson, homebridge)
    this.parseConfigJson(configJson)
    this.debug('config: %j', this.config)

    this.initJobs = []
    this
      .on('accessoryRestored', this.accessoryRestored)
      .once('heartbeat', this.init)
      .on('heartbeat', this.heartbeat)
  }

  parseConfigJson (configJson) {
    this.config = {
      brightnessAdjustment: 100,
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
      .boolKey('waitTimeReset', 10, 2000)
      .intKey('waitTimeUpdate', 0, 500)

    this.gatewayMap = {}
    this.panelsToResources = {}
    this.resourcesToPanels = {}
    this.allPanels = []

    try {
      optionParser.parse(configJson)
      if (this.config.host != null) {
        this.config.hosts.push(this.config.host)
      }
      this.discovery = new Deconz.Discovery({
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
    await events.once(this.gatewayMap[id], 'initialised')
    this.emit('found')
  }

  async findHost (host) {
    try {
      const config = await this.discovery.config(host)
      await this.foundGateway(host, config)
    } catch (error) {
      this.warn('%s: %s - retrying in 60s', host, error)
      await timeout(60000)
      return this.findHost(host)
    }
  }

  async init () {
    this.platformAccessory = new DeconzAccessory.Platform(this)
    try {
      const jobs = []
      if (this.config.hosts.length > 0) {
        for (const host of this.config.hosts) {
          this.debug('job %d: find gateway at %s', jobs.length, host)
          jobs.push(this.findHost(host))
        }
      } else {
        this.debug('job %d: find at least one gateway', jobs.length)
        jobs.push(events.once(this, 'found'))
        for (const id in this.gatewayMap) {
          const gateway = this.gatewayMap[id]
          const host = gateway.values.host
          this.debug('job %d: find gateway %s', jobs.length, id)
          jobs.push(events.once(gateway, 'initialised'))
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
      const updateWeatherEvery = 900 // Seconds!!! // 900 is 15 minutes
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

        https.get('https://api.open-meteo.com/v1/forecast?latitude=32.09&longitude=34.84&hourly=temperature_2m,relativehumidity_2m,weathercode,uv_index&current_weather=true&forecast_days=1&timezone=auto', res => {
          let data = []
          const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'
          that.log('Status Code:', res.statusCode)
          that.log('Date in Response header:', headerDate)

          res.on('data', chunk => {
            data.push(chunk)
          });

          res.on('end', () => {
            that.log('Response ended: ');
            const parsedData = JSON.parse(Buffer.concat(data).toString())

            if (parsedData) {
              const weatherNamesByPanelOrder = ['Sunny', 'Clear', 'Fair', 'Fair', 'Cloudy', 'Partly Cloudy', 'Partly Cloudy', 'Mostly Cloudy', 'Mostly Cloudy', 'Overcast', 'Shower', 'Thundershower', 'Hail', 'Light Rain', 'Moderate Rain', 'Heavy Rain', 'Storm', 'Heavy Storm', 'Severe Storm', 'Ice Rain', 'Sleet', 'Snow Flurry', 'Light Snow', 'Moderate Snow', 'Heavy Snow', 'Snowstorm', 'Dust', 'Sand', 'Duststorm', 'Sandstorm', 'Foggy', 'Haze', 'Windy', 'Blustery', 'Hurricane', 'Tropical Storm', 'Tornado', 'Cold', 'Hot', '--']
              const tempertaure = Math.round(parsedData.current_weather.temperature)
              const humidity = 0
              const weather = 39
              const uvIndex = 100

              for (let index = 0; index < that.allPanels.length; index++) {
                const panelsResourcePath = that.allPanels[index].split('/')
                const gateway = that.gatewayMap[panelsResourcePath[1]]
                if (gateway.initialised) {
                  gateway.sendFeelPageDataToPanel(panelsResourcePath, gateway.id.toLowerCase(), '0d020055', weather.toString(16).padStart(8, '0'))
                  gateway.sendFeelPageDataToPanel(panelsResourcePath, gateway.id.toLowerCase(), '00040055', gateway.getAqaraHexFromInt(tempertaure).toString(16).padStart(4, '0') + '0000')
                  gateway.sendFeelPageDataToPanel(panelsResourcePath, gateway.id.toLowerCase(), '00050055', gateway.getAqaraHexFromInt(humidity).toString(16).padStart(4, '0') + '0000')
                  gateway.sendFeelPageDataToPanel(panelsResourcePath, gateway.id.toLowerCase(), '00060055', gateway.getAqaraHexFromInt(uvIndex).toString(16).padStart(4, '0') + '0000')
                }
                break;
              }
            }
          });
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
      } else {
        const gateway = this.gatewayMap[context.gid]
        if (gateway != null) {
          gateway.addAccessory(id)
        }
      }
    } catch (error) { this.error(error) }
  }
}

module.exports = DeconzPlatform
