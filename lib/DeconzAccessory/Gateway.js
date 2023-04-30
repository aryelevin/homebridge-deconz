// homebridge-deconz/lib/DeconzAccessory/Gateway.js
// Copyright© 2022-2023 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

'use strict'

const {
  AccessoryDelegate, HttpClient, OptionParser, Colour, timeout
} = require('homebridge-lib')

const Deconz = require('../Deconz')
const DeconzAccessory = require('../DeconzAccessory')
const DeconzService = require('../DeconzService')

const migration = {
  name: 'homebridge-deconz',
  description: 'migration',
  classid: 1
}

const http = require('http')

var longPressTimeoutIDs = {}

const rtypes = ['lights', 'sensors', 'groups']

const periodicEvents = [
  { rate: 60, event: 1002 },
  { rate: 3600, event: 1004 },
  { rate: 86400, event: 1003 }
]

/** Delegate class for a deCONZ gateway.
  * @extends AccessoryDelegate
  * @memberof DeconzAccessory
  */
class Gateway extends AccessoryDelegate {
  /** Instantiate a gateway delegate.
    * @param {DeconzPlatform} platform - The platform plugin.
    * @param {Object} params - Parameters.
    * @param {Object} params.config - The response body of an unauthenticated
    * GET `/config` (from {@link DeconzDiscovery#config config()}.
    * @param {string} params.host - The gateway hostname or IP address and port.
    */
  constructor (platform, params) {
    super(platform, {
      id: params.config.bridgeid,
      name: params.config.name,
      manufacturer: 'dresden elektronik',
      model: params.config.modelid + ' / ' + params.config.devicename,
      firmware: '0.0.0',
      software: params.config.swversion,
      category: platform.Accessory.Categories.BRIDGE
    })

    this.gateway = this
    this.id = params.config.bridgeid
    this.recommendedSoftware = this.platform.packageJson.engines.deCONZ

    /** Persisted properties.
      * @type {Object}
      * @property {Object} config - Response body of unauthenticated
      * GET `/config` (from {@link DeconzDiscovery#config config()}.
      * @property {Object} fullState - The gateway's full state, from the
      * last time the gateway was polled.
      * @property {Object.<String, Object>} settingsById - The persisted settings, maintained through
      * the Homebridge UI.
      */
    this.context // eslint-disable-line no-unused-expressions
    this.context.config = params.config
    if (this.context.settingsById == null) {
      this.context.settingsById = {}
    }
    if (this.context.fullState != null) {
      this.analyseFullState(this.context.fullState, {
        analyseOnly: true,
        logUnsupported: true
      })
    }

    this.addPropertyDelegate({
      key: 'apiKey',
      silent: true
    }).on('didSet', (value) => {
      this.client.apiKey = value
    })

    this.addPropertyDelegate({
      key: 'brightnessAdjustment',
      value: 1,
      silent: true
    })

    this.addPropertyDelegate({
      key: 'expose',
      value: true,
      silent: true
    }).on('didSet', async (value) => {
      try {
        this.service.values.statusActive = value
        if (value) {
          await this.connect()
        } else {
          await this.reset()
        }
      } catch (error) { this.error(error) }
    })

    this.addPropertyDelegate({
      key: 'heartrate',
      value: 30,
      silent: true
    })

    this.addPropertyDelegate({
      key: 'host',
      value: params.host,
      silent: true
    }).on('didSet', (value) => {
      if (this.client != null) {
        this.client.host = value
      }
      if (this.wsClient != null) {
        this.wsClient.host = this.values.host.split(':')[0] +
          ':' + this.values.wsPort
      }
    })

    this.addPropertyDelegate({
      key: 'periodicEvents',
      value: true,
      silent: true
    })

    this.addPropertyDelegate({
      key: 'restart',
      value: false,
      silent: true
    }).on('didSet', async (value) => {
      if (value) {
        try {
          await this.client.restart()
          this.values.search = false
          this.values.unlock = false
          return
        } catch (error) { this.warn(error) }
      }
    })

    this.addPropertyDelegate({
      key: 'search',
      value: false,
      silent: true
    }).on('didSet', async (value) => {
      if (value) {
        try {
          await this.client.search()
          await timeout(120000)
          this.values.search = false
          return
        } catch (error) { this.warn(error) }
      }
    })

    this.addPropertyDelegate({
      key: 'unlock',
      value: false,
      silent: true
    }).on('didSet', async (value) => {
      if (value) {
        try {
          await this.client.unlock()
          await timeout(60000)
          this.values.unlock = false
          return
        } catch (error) { this.warn(error) }
      }
    })

    this.addPropertyDelegate({
      key: 'wsPort',
      value: 443,
      silent: true
    }).on('didSet', (value) => {
      if (this.wsClient != null) {
        this.wsClient.host = this.values.host.split(':')[0] +
          ':' + this.values.wsPort
      }
    })

    this.log(
      '%s %s gateway v%s', this.values.manufacturer, this.values.model,
      this.values.software
    )
    if (this.values.software !== this.recommendedSoftware) {
      this.warn('recommended version: deCONZ v%s', this.recommendedSoftware)
    }

    /** Map of Accessory delegates by id for the gateway.
      * @type {Object<string, DeconzAccessory.Device>}
      */
    this.accessoryById = {}

    /** Map of Accessory delegates by rpath for the gateway.
      * @type {Object<string, DeconzAccessory.Device>}
      */
    this.accessoryByRpath = {}

    this.defaultTransitionTime = 0.4

    /** Map of errors by device ID trying to expose the corresponding accessory.
      * @type {Object<string, Error>}
      */
    this.exposeErrorById = {}

    /** The service delegate for the Gateway Settings settings.
      * @type {DeconzService.GatewaySettings}
      */
    this.service = new DeconzService.Gateway(this, {
      name: this.name + ' Gateway',
      primaryService: true,
      host: params.host
    })

    /** The service delegate for the Stateless Programmable Switch service.
      * @type {DeconzService.Button}
      */
    this.buttonService = new DeconzService.Button(this, {
      name: this.name + ' Button',
      button: 1,
      events: DeconzService.Button.SINGLE | DeconzService.Button.DOUBLE |
        DeconzService.Button.LONG
    })

    this.createClient()
    this.createWsClient()
    this.heartbeatEnabled = true
    this
      .on('identify', this.identify)
      .once('heartbeat', (beat) => { this.initialBeat = beat })
      .on('heartbeat', this.heartbeat)
      .on('shutdown', this.shutdown)
  }

  get transitionTime () { return this.service.values.transitionTime }

  async resetTransitionTime () {
    if (this.resetting) {
      return
    }
    this.resetting = true
    await timeout(this.platform.config.waitTimeUpdate)
    this.service.values.transitionTime = this.defaultTransitionTime
    this.resetting = false
  }

  /** Log debug messages.
    */
  identify () {
    this.log(
      '%s %s gateway v%s (%d accessories for %d devices, %d resources)',
      this.values.manufacturer, this.values.model, this.values.software,
      this.nAccessories, this.nDevices, this.nResourcesMonitored
    )
    if (this.values.software !== this.recommendedSoftware) {
      this.warn('recommended version: deCONZ v%s', this.recommendedSoftware)
    }
    if (this.context.migration != null) {
      this.log(
        'migration: %s: %d resources',
        this.context.migration, this.nResourcesMonitored
      )
    }
    if (this.logLevel > 2) {
      this.vdebug(
        '%d gateway resouces: %j', this.nResources,
        Object.keys(this.resourceByRpath).sort()
      )
      this.vdebug(
        '%d gateway devices: %j', this.nDevices,
        Object.keys(this.deviceById).sort()
      )
      this.vdebug(
        '%d accessories: %j', this.nAccessories,
        Object.keys(this.accessoryById).sort()
      )
      this.vdebug(
        'monitoring %d resources: %j', this.nResourcesMonitored,
        Object.keys(this.accessoryByRpath).sort()
      )
      const exposeErrors = Object.keys(this.exposeErrorById).sort()
      this.vdebug(
        '%d accessories with expose errors: %j', exposeErrors.length,
        exposeErrors
      )
      const settings = Object.keys(this.context.settingsById).sort()
      this.vdebug(
        'settings: %d devices: %j', settings.length, settings)
    }
  }

  /** Update properties from gateway announcement.
    * @param {string} host - The gateway hostname or IP address and port.
    * @param {Object} config - The response body of an unauthenticated
    * GET `/config` (from {@link DeconzDiscovery#config config()}.
    */
  async found (host, config) {
    try {
      this.values.host = host
      this.context.config = config
      this.values.software = config.swversion
      if (!this.initialised) {
        this.debug('initialising...')
        await this.connect()
      }
    } catch (error) {
      this.error(error)
    }
  }

  async shutdown () {
    this.service.values.statusActive = false
    return this.wsClient.close()
  }

  /** Called every second.
    * @param {integer} beat
    */
  async heartbeat (beat) {
    beat -= this.initialBeat
    try {
      if (this.values.periodicEvents && beat > 0) {
        for (const { rate, event } of periodicEvents) {
          if (beat % rate === 0) {
            this.buttonService.update(event)
          }
        }
      }
      if (beat - this.pollBeat >= this.values.heartrate || this.pollNext) {
        this.pollBeat = beat
        await this.poll()
      }

      const putStateEvery = 5 // Seconds!!!
      if (beat % putStateEvery === 0) {
        // this.log('Heartbeat! ' + beat)
        const keysArray = Object.keys(this.accessoryByRpath)
        if (keysArray.length) {
          var index = (beat / putStateEvery) % (keysArray.length)
          // this.log('putState: ' + index + ', id: ' + keysArray[index])
          if (!keysArray[index].startsWith('/sensors')) {
            const a = this.accessoryByRpath[keysArray[index]]
            if (a && (a.values.serviceName === 'Light' || a.values.serviceName === 'Switch' || a.values.serviceName === 'Outlet')) {
              a.service.putState()
            }
          }
        }
      }
    } catch (error) { this.error(error) }
  }

  update (config) {
    this.values.software = config.swversion
    this.values.firmware = config.fwversion
    this.values.wsPort = config.websocketport
    this.service.update(config)
    if (this.checkApiKeys) {
      const myEntry = config.whitelist[this.values.apiKey]
      for (const key in config.whitelist) {
        if (key !== this.values.apiKey) {
          const entry = config.whitelist[key]
          if (entry.name === myEntry.name) {
            this.warn('%s: potentially stale api key: %j', key, entry)
          }
        }
      }
      delete this.checkApiKeys
    }
  }

  /** Create {@link DeconzAccessory.Gateway#client}.
    */
  createClient () {
    /** REST API client for the gateway.
      * @type {DeconzClient}
      */
    this.client = new Deconz.ApiClient({
      apiKey: this.values.apiKey,
      config: this.context.config,
      host: this.values.host,
      maxSockets: this.platform.config.parallelRequests,
      timeout: this.platform.config.timeout,
      waitTimePut: this.platform.config.waitTimePut,
      waitTimePutGroup: this.platform.config.waitTimePutGroup,
      waitTimeResend: this.platform.config.waitTimeResend
    })
    this.client
      .on('error', (error) => {
        if (error instanceof HttpClient.HttpError) {
          if (error.request.id !== this.requestId) {
            this.log(
              'request %d: %s %s%s', error.request.id,
              error.request.method, error.request.resource,
              error.request.body == null ? '' : ' ' + error.request.body
            )
            this.requestId = error.request.id
          }
          this.warn('request %s: %s', error.request.id, error)
          return
        }
        this.warn(error)
      })
      .on('request', (request) => {
        this.debug(
          'request %d: %s %s%s', request.id,
          request.method, request.resource,
          request.body == null ? '' : ' ' + request.body
        )
        this.vdebug(
          'request %s: %s %s%s', request.id,
          request.method, request.url,
          request.body == null ? '' : ' ' + request.body
        )
      })
      .on('response', (response) => {
        this.vdebug(
          'request %d: response: %j', response.request.id,
          response.body
        )
        this.debug(
          'request %s: %d %s', response.request.id,
          response.statusCode, response.statusMessage
        )
      })
  }

  // Added by me: Arye Levin

  fromHexStringToBytes = hexString =>
    new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

  toHexStringFromBytes = bytes =>
    bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');

  toHexStringFromCharacterString = charStr =>
    this.toHexStringFromBytes(charStr.split ('').map (function (c) { return c.charCodeAt (0); }))

  toCharacterStringFromBytes = bytes =>
    bytes.map(function(v){ return String.fromCharCode(v); }).join('');
  
  getInt8 = uint8Data => 
    uint8Data << 24 >> 24;

  getUInt8 = int8Data => 
    int8Data << 24 >>> 24;
    
  getAqaraIntFromHex(hexInput) {
    //value to change
    var a = hexInput

    var b = 1
    var r = 0

    if (a > 0) {
        r = 1
        a -= 0x3f80
    }

    while (a > 0) {
        let k = 0x80 / b
        let n = Math.min(a / k, b)
        
        a -= k * n
        r += n
        
        b *= 2
    }
    
    return r
  }

  getAqaraHexFromInt(intInput) {
    //value to change
    var a = intInput

    var b = 1
    var r = 0

    if (a > 0) {
        r = 0x3f80
        a -= 1
    }

    while (a > 0) {
        let k = 0x80 / b
        let n = Math.min(a, b)
        
        a -= n
        r += k * n
        
        b *= 2
    }
    
    return r
  }

  sendFeelPageDataToPanel(pathComponents, device, parameter, content) {
    const dataToSend = '19aa7113446d21084110' + device + parameter + content
    this._writeDataToPanel(pathComponents, dataToSend)
  }

  sendStateToPanel(pathComponents, device, parameter, content) {
    const dataToSend = '19aa7113446d21054110' + device + parameter + content
    this._writeDataToPanel(pathComponents, dataToSend)
  }

  _writeDataToPanel(pathComponents, dataToSend) {
    let panelResourcePath = '/' + pathComponents[2] + '/' + pathComponents[3] + '/config'
    let that = this
    this.debug('Going to set "' + dataToSend + '" at panel: ' + panelResourcePath)
    this.client.put(panelResourcePath, {aqara_s1_communication: dataToSend}).then((obj) => {
      // that.context.fullState[pathComponents[2]][pathComponents[3]].config.aqara_s1_communication = dataToSend
      that.log('Successfully set "' + dataToSend + '" at panel: ' + panelResourcePath)
    }).catch((error) => {
      that.error('Error setting panel switch state %s: %s', panelResourcePath, error)
    })
  }

  setAqaraS1PanelsConfiguration() {
    // this.log(JSON.stringify(this.platform.config))
    const actionsConfigData = this.platform._configJson.actionsConfigData[this.id]
    this.debug('actionsConfigData contents: ' + JSON.stringify(actionsConfigData))
    if (actionsConfigData && Array.isArray(actionsConfigData) === false) {
      this.actionsConfigData = actionsConfigData
      
      let aqaraS1Panels = actionsConfigData.aqara_S1_panels
      if (aqaraS1Panels) {
        let panels = Object.keys(aqaraS1Panels)
        for (const panel of panels) {
          let panelData = aqaraS1Panels[panel]
          let panelControls = Object.keys(panelData)
          for (const panelControl of panelControls) {
            let controlData = panelData[panelControl]
            if (controlData.resources) {
              this.platform.panelsToResources['/' + this.id + panel + '/' + panelControl] = controlData.resources
              for (var i = controlData.resources.length - 1; i >= 0; i--) {
                var rid = controlData.resources[i];
                if (!this.platform.resourcesToPanels[rid]) {
                  this.platform.resourcesToPanels[rid] = []
                }
                this.platform.resourcesToPanels[rid].push('/' + this.id + panel + '/' + panelControl)
              }
            }
          }
        }
        this.debug('panelsToResources: ' + JSON.stringify(this.platform.panelsToResources))
        this.debug('resourcesToPanels: ' + JSON.stringify(this.platform.resourcesToPanels))
      }
    }
    
    // Now, go and set online/offline for all possible devices to know if they're set on the panel, and add/remove them on the reponse.
    if (this.actionsConfigData && Array.isArray(this.actionsConfigData) === false) {
      let aqaraS1Panels = this.actionsConfigData.aqara_S1_panels
      if (aqaraS1Panels) {
        if (!this.context.aqaraS1PanelsConfiguration) {
          this.context.aqaraS1PanelsConfiguration = {}
        }

        if (!this.configurationCommandsToExecute) {
          this.configurationCommandsToExecute = []
        }

        let switchsData = {}
        // Char string is:      lights/1            lights/2            lights/3            lights/4            lights/5            curtain1            curtain2            curtain3            air_cond            tempsnsr
        const devicesSerial = ['6c69676874732f31', '6c69676874732f32', '6c69676874732f33', '6c69676874732f34', '6c69676874732f35', '6375727461696e31', '6375727461696e32', '6375727461696e33', '6169725f636f6e64', '74656d70736e7372'] // array of devices serial which is configured when setup is done
        const devicesControl = ['light_1', 'light_2' , 'light_3', 'light_4', 'light_5', 'curtain_1', 'curtain_2', 'curtain_3', 'ac', 'temperature_sensor'] // array of config names
        // | Temp Sensor | AC Page | Curtain 1 | Curtain 2 | Curtain 3 | Light 1 | Light 2 | Light 3 | Light 4 | Light 5 |
        // | ----------- | ------- | --------- | --------- | --------- | ------- | ------- | ------- | ------- | ------- |
        // | 01-02       | 03-08   | 09-0c     | 0f-12     | 15-18     | 1b-20   | 21-26   | 27-2c   | 2d-32   | 33-38   |
        const slotsRanges = {
          temperature_sensor: [0x01, 0x02],
          ac: [0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
          curtain_1: [0x09, 0x0a, 0x0b, 0x0c],
          curtain_2: [0x0f, 0x10, 0x11, 0x12],
          curtain_3: [0x15, 0x16, 0x17, 0x18],
          light_1: [0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20],
          light_2: [0x21, 0x22, 0x23, 0x24, 0x25, 0x26],
          light_3: [0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c],
          light_4: [0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32],
          light_5: [0x33, 0x34, 0x35, 0x36, 0x37, 0x38]
        }

        const slotPrefixes = {
          temperature_sensor: '604a55b7',
          ac: '6044f76a',
          curtain_1: '604f651f',
          curtain_2: '604f651f',
          curtain_3: '604f651f',
          light_1: '604f7448',
          light_2: '604f7448',
          light_3: '604f7448',
          light_4: '604f7448',
          light_5: '604f7448'
        }

        // Char string is:     scene_01            scene_02            scene_03            scene_04            scene_05            scene_06
        const sceneSerials = ['7363656e655f3031', '7363656e655f3032', '7363656e655f3033', '7363656e655f3034', '7363656e655f3035', '7363656e655f3036']
        const sceneControls = ['scene_1', 'scene_2', 'scene_3', 'scene_4', 'scene_5', 'scene_6']
        const sceneIDs = ['6046990601', '6046990602', '6046990603', '6046990604', '6046990605', '6046990606']

        var commandsFunctionsToExecute = []

        let panels = Object.keys(aqaraS1Panels)
        for (const panel of panels) {
          let panelData = aqaraS1Panels[panel]
          let panelResourceType = panel.split('/')[1]
          let panelLightID = panel.split('/')[2]
          let panelLightObject = this.context.fullState[panelResourceType][panelLightID]
          if (panelLightObject) {
            let panelUniqueId = panelLightObject.uniqueid.split('-')
            let panelSerial = panelUniqueId[0].replace(/:/g, '')

            if (!switchsData[panelSerial]) {
              switchsData[panelSerial] = {}
            }

            if (panelData.switch) {
              switchsData[panelSerial][panelUniqueId[1]] = {text: panelData.switch.name, icon: panelData.switch.icon}
            }

            if (panelUniqueId[1] === '01' && panelResourceType === 'sensors') {
              switchsData[panelSerial].resourcePath = panel + '/config'

              let parsedData = this.context.aqaraS1PanelsConfiguration[this.id + '_' + panelSerial]

              if (!parsedData) {
                parsedData = {}
                this.context.aqaraS1PanelsConfiguration[this.id + '_' + panelSerial] = parsedData
              }
              if (!parsedData.names) {
                parsedData.names = {}
              }

              for (var i = devicesSerial.length - 1; i >= 0; i--) {
                const deviceSerial = devicesSerial[i]
                const deviceName = devicesControl[i]
                const deviceConfig = panelData[deviceName]
                const slots = slotsRanges[deviceName]
                const slotPrefix = slotPrefixes[deviceName]

                if (slots) {
                  if (deviceConfig) {
                    // TODO: Later compose the command in a more flexible way so all the sizes and integrity will be calculated here and not hardcoded.
                    // TODO: Check that the config haven't changed in a new config (Need to check how this is possible to be done... Maybe try to set CT/Color and see what is the response...)
                    let commandsToExecute = []
                    if (i <= 4) { // Lights
                      // On/Off, general type...
                      commandsToExecute.push('40aa7138468c0201d8024140' + slotPrefix + slots[0].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '04010055' + '260a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '08bfaab9d8d7b4ccac08bfaab9d8d7b4ccac08bfaab9d8d7b4')
                      commandsToExecute.push('13aa710b468c020204ccac0000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '3' + (deviceConfig.type === 'color' ? '2' : '3') + '00')
                      // Brightness
                      commandsToExecute.push('3aaa7134448de0024131' + slotPrefix + slots[1].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '0e010055' + '170a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '0ac1c1b6c8b0d9b7d6b1c8000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0' + (deviceConfig.type === 'color' ? '2' : '4') + '00')
                      // Name
                      commandsToExecute.push('37aa7131448ee202412e' + slotPrefix + slots[4].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa5' + '140a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '08c9e8b1b8c3fbb3c60000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0' + (deviceConfig.type === 'color' ? 'a' : 'b') + '00')
                      // Online/Offline
                      commandsToExecute.push('39aa7133448fdf024130' + slotPrefix + slots[5].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '080007fd' + '160a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '0ac9e8b1b8d4dacfdfc0eb0000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '3' + (deviceConfig.type === 'color' ? 'c' : 'd') + '00')
                      if (deviceConfig.type === 'ct') {
                        // Color Temperature
                        commandsToExecute.push('36aa713044670a02412d' + slotPrefix + slots[2].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '0e020055' + '130a0506c9abcec2d6b5000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0300')
                      } else if (deviceConfig.type === 'color') {
                        // Color
                        commandsToExecute.push('36aa713044234e02412d' + slotPrefix + slots[3].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '0e080055' + '130a0506d1d5c9ab7879000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0100')
                      }
                    } else if (i <= 7) { // Curtains
                      // Opening/Closing/Stopped
                      commandsToExecute.push('38aa713244016e02412f' + slotPrefix + slots[0].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '0e020055' + '150a0408b4b0c1b1d7b4ccac000000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) + 5) + '3200')
                      // Position
                      commandsToExecute.push('3caa713644fe6d024133' + slotPrefix + slots[1].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '01010055' + '190a040000010ab4b0c1b1b4f2bfaab0d90000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) + 5) + '0c00')
                      // Online/Offline
                      commandsToExecute.push('39aa713344ff6f024130' + slotPrefix + slots[2].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '080007fd' + '160a040ac9e8b1b8d4dacfdfc0eb0000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) + 5) + '3c00')
                      // Name
                      commandsToExecute.push('37aa713144007002412e' + slotPrefix + slots[3].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa5' + '140a0408c9e8b1b8c3fbb3c60000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) + 5) + '0a00')
                    } else if (i == 8) { // AC
                      // On/Off, general type...
                      commandsToExecute.push((deviceConfig.internal_thermostat ? '38aa713244204f02412f' : '3aaa713444ef7e024131') + slotPrefix + slots[0].toString(16).padStart(2, '0') + panelSerial + deviceSerial + (deviceConfig.internal_thermostat ? '0e020055' : '0e200055') + (deviceConfig.internal_thermostat ? '150a0608bfd8d6c6d7b4ccac000000000000012e0000' : '1708060abfd5b5f7d1b9cbf5d7b4000000000000012e0000'))
                      // Online/Offline
                      commandsToExecute.push('39aa713344f07e024130' + slotPrefix + slots[1].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '080007fd' + '1608060ac9e8b1b8d4dacfdfc0eb0000000000012e6400')
                      // Name
                      commandsToExecute.push('37aa713144f17f02412e' + slotPrefix + slots[2].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa5' + '14080608c9e8b1b8c3fbb3c60000000000012e1300')
                      // Modes
                      commandsToExecute.push('39aa713344f27c024130' + slotPrefix + slots[3].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa7' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e1000')
                      // Fan Modes
                      commandsToExecute.push('39aa713344f37b024130' + slotPrefix + slots[4].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa8' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e1100')
                      // Temperatures Ranges
                      commandsToExecute.push('39aa713344f47a024130' + slotPrefix + slots[5].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa9' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e0100')
                    } else if (i == 9) { // Temperature Sensor
                      // Temperature
                      commandsToExecute.push('3caa7136444a21024133' + slotPrefix + slots[0].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '00010055' + '1908023e00640a74656d706572617475720000000000012c0600')
                      // Humidity
                      commandsToExecute.push('3aaa7134444b22024131' + slotPrefix + slots[1].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '00020055' + '1708021d00640868756d69646974790000000000012c0900')
                    }
                    if (!parsedData[i] || JSON.stringify(parsedData[i]) !== JSON.stringify(commandsToExecute)) {
                      this.configurationCommandsToExecute.push({commands: commandsToExecute,
                                                                meta: { index: 0, 
                                                                        deviceIndex: i, 
                                                                        panelSerial: panelSerial, 
                                                                        panelResourcePath: panel,
                                                                        failureCount: 0 }})
                    } else {
                      // Maybe update the state of controlled device??? No, it should be in sync if server restarted. If device restarted it asks the data by itself.
                      // Update device names if any changes...
                      if (!parsedData.names[i] || parsedData.names[i] !== deviceConfig.name) {
                        const name = deviceConfig.name
                        const dataToSend = this.generateNameCommand(name, deviceSerial)
                        // Save a copy/references of the relevant values and separate commands with 1000ms delay...
                        let that = this
                        let deviceIndex = i
                        function executeCommand(index) {
                          that.log('Going to send: ' + dataToSend)
                          that.client.put(panel + '/config', {aqara_s1_communication: dataToSend}).then((obj) => {
                            parsedData.names[deviceIndex] = name
                            if (index < commandsFunctionsToExecute.length) {
                              setTimeout(function(){commandsFunctionsToExecute[index](index+1)}, 1000)
                            }
                          }).catch((error) => {
                            // TODO: Retry??? Continue to the next command???
                          })
                        }
                        commandsFunctionsToExecute.push(executeCommand)
                      }
                    }
                  } else {
                    if (parsedData[i]) {
                      // Send removal commands...
                      let commandsToExecute = []
                      for (var ii = slots.length - 1; ii >= 0; ii--) {
                        commandsToExecute.push('22aa711c4498ed044119' + slotPrefix + slots[ii].toString(16).padStart(2, '0') + panelSerial + '000000000000000000000000')
                      }
                      this.configurationCommandsToExecute.push({commands: commandsToExecute,
                                                                meta: { index: 0, 
                                                                        deviceIndex: i, 
                                                                        panelSerial: panelSerial, 
                                                                        panelResourcePath: panel,
                                                                        failureCount: 0 }})
                    }
                  }
                }

                // // TODO: now set all as Online, but later make sure to mark offline devices if they're offline...
                // let that = this
                // commandsAmount ++
                // setTimeout(function() {
                //   let cmdToSend = '19aa7113446d21054110' + deviceSerial + '080007fd' + '0000000' + (panelData[devicesControl[i]] ? '1' : '0')
                //   that.log(cmdToSend)
                //   that.client.put(panel + '/config', {aqara_s1_communication: cmdToSend}).then((obj) => {
                    
                //   }).catch((error) => {
                    
                //   })
                // }, 500 * commandsAmount)
              }

              let numberOfConfiguredScenes = 0
              let unusedSceneIDs = ''
              let configuredScenesData = ''
              for (let index = 0; index < sceneControls.length; index++) {
                const sceneName = sceneControls[index]
                const sceneConfig = panelData[sceneName]
                if (sceneConfig) {
                  numberOfConfiguredScenes ++
                  // TODO: trim the name to the max of what possible on the panel...
                  configuredScenesData += (sceneIDs[index] + sceneSerials[index] + sceneConfig.icon.toString(16).padStart(2, '0') + sceneConfig.name.length.toString(16).padStart(2, '0') + this.toHexStringFromCharacterString(sceneConfig.name))
                } else {
                  unusedSceneIDs += sceneIDs[index]
                }
              }

              let commandsToExecute = []
              if (unusedSceneIDs.length) {
                const unconfiguredScenesDataSize = unusedSceneIDs.length / 2
                const totalSize = 9 + unconfiguredScenesDataSize
                const commandSize = totalSize - 6
                const paramsSize = commandSize - 3 // Basically, just unconfiguredScenesDataSize...
                const counter = '6d'
                const integrity = 512 - (parseInt('aa', 16) + parseInt('73', 16) + commandSize + parseInt('44', 16) + parseInt(counter, 16))
                const dataToSend = totalSize.toString(16).padStart(2, '0') + 'aa73' + commandSize.toString(16).padStart(2, '0') + '44' + counter + this.getUInt8(integrity).toString(16).padStart(2, '0') + '0241' + paramsSize.toString(16).padStart(2, '0') + unusedSceneIDs
                commandsToExecute.push(dataToSend)
              }
              if (configuredScenesData.length) {
                const configuredScenesDataSize = configuredScenesData.length / 2
                const totalSize = 9 + configuredScenesDataSize
                if (totalSize <= 0x40) {
                  const commandSize = totalSize - 6
                  const paramsSize = commandSize - 3 // Basically, just configuredScenesData...
                  const counter = '6d'
                  const integrity = 512 - (parseInt('aa', 16) + parseInt('73', 16) + commandSize + parseInt('44', 16) + parseInt(counter, 16))
                  const dataToSend = totalSize.toString(16).padStart(2, '0') + 'aa73' + commandSize.toString(16).padStart(2, '0') + '44' + counter + this.getUInt8(integrity).toString(16).padStart(2, '0') + '0141' + paramsSize.toString(16).padStart(2, '0') + configuredScenesData
                  commandsToExecute.push(dataToSend)
                } else {
                  let generatedCommandsDataIndex = 0
                  let dataParts = []

                  const firstCommandDataSize = 53
                  const restCommandsDataSize = 56
                  while (generatedCommandsDataIndex < configuredScenesDataSize) {
                    let stringEndPos = 0
                    if (dataParts.length === 0) {
                      stringEndPos = generatedCommandsDataIndex + firstCommandDataSize
                    } else {
                      stringEndPos = generatedCommandsDataIndex + Math.min(restCommandsDataSize, (configuredScenesDataSize - generatedCommandsDataIndex))
                    }
                    dataParts.push(configuredScenesData.substring(generatedCommandsDataIndex * 2, stringEndPos * 2))
                    generatedCommandsDataIndex = stringEndPos
                  }

                  for (let index = 0; index < dataParts.length; index++) {
                    const data = dataParts[index]
                    if (index === 0) {
                      const partCommandsTotalSize = 11 + (data.length / 2)
                      const commandSize = partCommandsTotalSize - 8
                      const paramsSize = configuredScenesDataSize
                      const counter = '6d'
                      const integrity = 512 - (parseInt('aa', 16) + parseInt('73', 16) + commandSize + parseInt('46', 16) + parseInt(counter, 16) + parseInt(dataParts.length, 16) + parseInt(index + 1, 16))
                      const dataToSend = partCommandsTotalSize.toString(16).padStart(2, '0') + 'aa73' + commandSize.toString(16).padStart(2, '0') + '46' + counter + dataParts.length.toString(16).padStart(2, '0') + (index + 1).toString(16).padStart(2, '0') + this.getUInt8(integrity).toString(16).padStart(2, '0') + '0141' + paramsSize.toString(16).padStart(2, '0') + data
                      commandsToExecute.push(dataToSend)
                    } else {
                      const partCommandsTotalSize = 8 + (data.length / 2)
                      const commandSize = partCommandsTotalSize - 8 // Basically, just data.length / 2...
                      const counter = '6d'
                      const integrity = 512 - (parseInt('aa', 16) + parseInt('73', 16) + commandSize + parseInt('46', 16) + parseInt(counter, 16) + parseInt(dataParts.length, 16) + parseInt(index + 1, 16))
                      const dataToSend = partCommandsTotalSize.toString(16).padStart(2, '0') + 'aa73' + commandSize.toString(16).padStart(2, '0') + '46' + counter + dataParts.length.toString(16).padStart(2, '0') + (index + 1).toString(16).padStart(2, '0') + this.getUInt8(integrity).toString(16).padStart(2, '0') + data
                      commandsToExecute.push(dataToSend)
                    }
                  }
                }
              }

              if (!parsedData.scenes || JSON.stringify(parsedData.scenes) !== JSON.stringify(commandsToExecute)) {
                this.configurationCommandsToExecute.push({commands: commandsToExecute,
                                                          meta: { index: 0, 
                                                                  deviceIndex: 'scenes', 
                                                                  panelSerial: panelSerial, 
                                                                  panelResourcePath: panel,
                                                                  failureCount: 0 }})
              }
            }
          }
        }

        let switchesPanels = Object.keys(switchsData)
        for (const switches of switchesPanels) {
          let switchesDataObject = switchsData[switches]
          if (switchesDataObject['01'] && switchesDataObject.resourcePath) {
            let panelLightID = switchesDataObject.resourcePath.split('/')[2]
            let panelLightObject = this.context.fullState.sensors[panelLightID]
            var object = {}
            var anyUpdate = false

            if (panelLightObject.config.aqara_s1_switch1_icon !== switchesDataObject['01'].icon) {
              object.aqara_s1_switch1_icon = switchesDataObject['01'].icon
              anyUpdate = true
            }
            if (panelLightObject.config.aqara_s1_switch1_text !== switchesDataObject['01'].text) {
              object.aqara_s1_switch1_text = switchesDataObject['01'].text
              anyUpdate = true
            }
            if (switchesDataObject['02']) {
              if (panelLightObject.config.aqara_s1_switch2_icon !== switchesDataObject['02'].icon) {
                object.aqara_s1_switch2_icon = switchesDataObject['02'].icon
                anyUpdate = true
              }
              if (panelLightObject.config.aqara_s1_switch2_text !== switchesDataObject['02'].text) {
                object.aqara_s1_switch2_text = switchesDataObject['02'].text
                anyUpdate = true
              }
            }
            if (switchesDataObject['03']) {
              if (panelLightObject.config.aqara_s1_switch3_icon !== switchesDataObject['03'].icon) {
                object.aqara_s1_switch3_icon = switchesDataObject['03'].icon
                anyUpdate = true
              }
              if (panelLightObject.config.aqara_s1_switch3_text !== switchesDataObject['03'].text) {
                object.aqara_s1_switch3_text = switchesDataObject['03'].text
                anyUpdate = true
              }
            }

            var switchesConfiguration = 1
            if (switchesDataObject['02'] && switchesDataObject['03']) {
              switchesConfiguration = 7
            }
            else if (switchesDataObject['02']) {
              switchesConfiguration = 3
            }
            else if (switchesDataObject['03']) {
              switchesConfiguration = 5
            }
            if (panelLightObject.config.aqara_s1_switches_config !== switchesConfiguration) {
              object.aqara_s1_switches_config = switchesConfiguration
              anyUpdate = true
            }

            if (anyUpdate) {
              let that = this
              let dataObject = object
              let resourcePathToUse = switchesDataObject.resourcePath
              function executeCommand(index) {
                that.log('Going to send: ' + JSON.stringify(dataObject) + ', to: ' + resourcePathToUse)
                that.client.put(resourcePathToUse, dataObject).then((obj) => {
                  if (index < commandsFunctionsToExecute.length) {
                    setTimeout(function(){commandsFunctionsToExecute[index](index+1)}, 1000)
                  }
                }).catch((error) => {
                  // TODO: Retry??? Continue to the next command???
                })
              }
              commandsFunctionsToExecute.push(executeCommand)
            }
          }
        }
        if (commandsFunctionsToExecute.length) {
          commandsFunctionsToExecute[0](1);
        }
        if (this.configurationCommandsToExecute.length) {
          this.configurationCommandTimeout() // So it will not remove the first command...
        }
      }
    }

    // TODO: update switches state (on/off) on the state restore of the light (file loading of the state).
  }

  configurationCommandTimeout() {
    this.lastCommandTimeout = undefined // this will make the executeNextConfigurationCommand() function to retry the last function again...
    this.executeNextConfigurationCommand()
  }

  executeNextConfigurationCommand() {
    const succeededCommand = this.lastCommandTimeout !== undefined
    if (succeededCommand) {
      // cancel the timeout...
      clearTimeout(this.lastCommandTimeout)
      // advance the command index and if a device is fully configured, save its data.
      const currentConfiguredDeviceCommandsArray = this.configurationCommandsToExecute.length ? this.configurationCommandsToExecute[this.configurationCommandsToExecute.length - 1] : undefined
      if (currentConfiguredDeviceCommandsArray !== undefined) {
        if (currentConfiguredDeviceCommandsArray.meta.index + 1 === currentConfiguredDeviceCommandsArray.commands.length || currentConfiguredDeviceCommandsArray.meta.failureCount >= 3) {
          if (currentConfiguredDeviceCommandsArray.meta.failureCount < 3) {
            const deviceIndex = currentConfiguredDeviceCommandsArray.meta.deviceIndex
            this.log('Finished configuration for deviceIndex ' + deviceIndex + ', Saving the sent commands in the context.')
            let parsedData = this.context.aqaraS1PanelsConfiguration[this.id + '_' + currentConfiguredDeviceCommandsArray.meta.panelSerial]
            if (currentConfiguredDeviceCommandsArray.commands[0].endsWith('000000000000000000000000')) { // Its a removed configuration...
              delete parsedData[deviceIndex]
            } else {
              parsedData[deviceIndex] = currentConfiguredDeviceCommandsArray.commands
            }
          }
          // Remove this device from the configuration commands array
          this.configurationCommandsToExecute.pop()
        } else {
          currentConfiguredDeviceCommandsArray.meta.index ++
        }
      }
    }

    if (this.configurationCommandsToExecute.length) {
      const currentConfiguredDeviceCommandsArray = this.configurationCommandsToExecute[this.configurationCommandsToExecute.length - 1]

      // Check that the resource is reachable...
      if (this.deviceById[currentConfiguredDeviceCommandsArray.meta.panelSerial.toUpperCase()].resource.body.state.reachable !== true) {
        this.error('Configuration cannot being sent to unreachable accessories, skipping...')
        this.lastCommandTimeout = undefined
        this.configurationCommandsToExecute.pop()
        this.executeNextConfigurationCommand()
        return
      }

      // send the commands on the queue...
      const dataToSend = currentConfiguredDeviceCommandsArray.commands[currentConfiguredDeviceCommandsArray.meta.index]
      this.debug('Going to send: ' + dataToSend + ' to panel resource: ' + currentConfiguredDeviceCommandsArray.meta.panelResourcePath)
      this.client.put(currentConfiguredDeviceCommandsArray.meta.panelResourcePath + '/config', {aqara_s1_communication: dataToSend}).then((obj) => {
        this.log('Sent: ' + dataToSend + ' to panel resource: ' + currentConfiguredDeviceCommandsArray.meta.panelResourcePath + ', which is a command of device index: ' + currentConfiguredDeviceCommandsArray.meta.deviceIndex + ', command no. ' + (currentConfiguredDeviceCommandsArray.meta.index + 1) + ' of ' + currentConfiguredDeviceCommandsArray.commands.length + ' commands')
      }).catch((error) => {
        // Retry will happen at our timeout (or already happened if the error is a timeout error which is long than our timeout of 5 seconds below...)
        if (error) {
          
        }
      })
      // set a timeout timer...
      const that = this
      this.lastCommandTimeout = setTimeout(function() {
        currentConfiguredDeviceCommandsArray.meta.failureCount ++
        if (currentConfiguredDeviceCommandsArray.meta.failureCount >= 3) {
          that.executeNextConfigurationCommand()
        } else {
          // In case the timed out command is a multiple parts command (type 46), go back to the first part in the commands set...
          if (currentConfiguredDeviceCommandsArray.commands[currentConfiguredDeviceCommandsArray.meta.index][9] === '6') {
            const currentCommandPartNo = parseInt(currentConfiguredDeviceCommandsArray.commands[currentConfiguredDeviceCommandsArray.meta.index].substring(14, 16), 16)
            currentConfiguredDeviceCommandsArray.meta.index -= (currentCommandPartNo - 1)
          }
          that.configurationCommandTimeout()
        }
      }, 5000) // 5 seconds timeout
    } else {
      this.log('Finished all configuration commands')
    }
  }

  // TODO: Handle weather data asked from panel (after panel reboot for example)...
  processIncomingDataFromAqaraS1(updateData, rpath) {
    const dataStartIndex = 1

    let dataArray = this.fromHexStringToBytes(updateData)

    let commandCategory = dataArray[dataStartIndex + 1] // (71=to device, 72=from device and 73=is for all scenes transactions [config and usage])
    let commandType = dataArray[dataStartIndex + 3] // 84=Attribute report of states, 24=ACK for commands, 44 commands for device (shouldn't happen here), 46=multi-part commands for device (also shouldn't happen here), c6=Multipart commands ACKs...
    
    const integrityByteIndex = commandType === 0xc6 ? (dataStartIndex + 7) : (dataStartIndex + 5)
    let commandActionByteIndex = dataStartIndex + 6

    let sum = dataArray[dataStartIndex] + dataArray[dataStartIndex + 1] + dataArray[dataStartIndex + 2] + dataArray[dataStartIndex + 3] + dataArray[dataStartIndex + 4] + this.getInt8(dataArray[integrityByteIndex])
    if (commandType === 0xc6) {
      sum += (dataArray[dataStartIndex + 5] + dataArray[dataStartIndex + 6])
      commandActionByteIndex = dataStartIndex + 8
    }
    const commandAction = dataArray[commandActionByteIndex] // 1=state report/scenes config, 2=configs, 3=scenes activation, 4=removals, 5=set state/states ACKs, 6=state request
  
    this.debug('Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum)

    if (sum === 512 || sum === 256 || sum === 768) {
      if (commandType === 0x84) {
        const paramsSize = dataArray[dataStartIndex + 8]

        const deviceSerial = [dataArray[dataStartIndex + 9], dataArray[dataStartIndex + 10], dataArray[dataStartIndex + 11], dataArray[dataStartIndex + 12], dataArray[dataStartIndex + 13], dataArray[dataStartIndex + 14], dataArray[dataStartIndex + 15], dataArray[dataStartIndex + 16]]
        const stateParam = [dataArray[dataStartIndex + 17], dataArray[dataStartIndex + 18], dataArray[dataStartIndex + 19], dataArray[dataStartIndex + 20]]
  
        this.debug('commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16) + ', deviceSerial: ' + deviceSerial + ', stateParam: ' + stateParam)
  
        const deviceResourceType = this.toCharacterStringFromBytes(deviceSerial)
        const deviceSerialStr = this.toHexStringFromBytes(deviceSerial)

        if (commandCategory === 0x72 && commandAction === 0x01) { // State of device is reported.
          if (this.platform.platformAccessory.service.values.switchesOn) {
            if (deviceResourceType === 'air_cond' && stateParam[0] === 0x0e && stateParam[2] === 0x00 && stateParam[3] === 0x55 && (stateParam[1] === 0x20 || stateParam[1] === 0x02)) { // Updated Air conditioner/Heater-Cooler device state
              let onOff = dataArray[dataStartIndex + 21] >= 0x10
              let mode = dataArray[dataStartIndex + 21] - (onOff ? 0x10 : 0x0)
              let fan = parseInt(dataArray[dataStartIndex + 22].toString(16).padStart(2, '0').slice(0 , 1), 16)
              let setTemperature = dataArray[dataStartIndex + 23]
              this.log('On/Off: ' + onOff + ', Mode: ' + mode + ', Fan: ' + fan + ', Set Temperature: ' + setTemperature)
    
              let resources = this.platform.panelsToResources['/' + this.id + rpath + '/ac']
              for (var i = resources.length - 1; i >= 0; i--) {
                let resourceItem = resources[i];
                let pathComponents = resourceItem.split( '/' )
                let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
    
                if (accessoryToControl) {
                  accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.Active).setValue(onOff)
                  if (onOff) {
                    accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.TargetHeaterCoolerState).setValue(mode === 0 ? this.platform.Characteristics.hap.TargetHeaterCoolerState.HEAT : mode === 1 ? this.platform.Characteristics.hap.TargetHeaterCoolerState.COOL : this.platform.Characteristics.hap.TargetHeaterCoolerState.AUTO)
                    accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.RotationSpeed).setValue(fan === 0 ? 25 : fan === 1 ? 50 : fan === 2 ? 75 : 100)
                    if (mode === 0 || mode === 1) {
                      accessoryToControl.service._service.getCharacteristic(mode === 0 ? this.platform.Characteristics.hap.HeatingThresholdTemperature : this.platform.Characteristics.hap.CoolingThresholdTemperature).setValue(setTemperature)
                    }
                  }
                }
              }
            } else if (deviceResourceType.startsWith('curtain')) {
              if (stateParam[0] === 0x01 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Position
                // const positionCoverion = {'0000': 0, '3f80': 1, '4000': 2, '4040': 3, '4080': 4, '40a0': 5, '40c0': 6, '40e0': 7, '4100': 8, '4110': 9, '4120': 10,'4130': 11,'4140': 12,'4150': 13,'4160': 14,'4170': 15,'4180': 16,'4188': 17,'4190': 18,'4198': 19,'41a0': 20,'41a8': 21,'41b0': 22,'41b8': 23,'41c0': 24,'41c8': 25,'41d0': 26,'41d8': 27,'41e0': 28,'41e8': 29,'41f0': 30,'41f8': 31,'4200': 32,'4204': 33,'4208': 34,'420c': 35,'4210': 36,'4214': 37,'4218': 38,'421c': 39,'4220': 40,'4224': 41,'4228': 42,'422c': 43,'4230': 44,'4234': 45,'4238': 46,'423c': 47,'4240': 48,'4244': 49,'4248': 50,'424c': 51,'4250': 52,'4254': 53,'4258': 54,'425c': 55,'4260': 56,'4264': 57,'4268': 58,'426c': 59,'4270': 60,'4274': 61,'4278': 62,'427c': 63,'4280': 64,'4282': 65,'4284': 66,'4286': 67,'4288': 68,'428a': 69,'428c': 70,'428e': 71,'4290': 72,'4292': 73,'4294': 74,'4296': 75,'4298': 76,'429a': 77,'429c': 78,'429e': 79,'42a0': 80,'42a2': 81,'42a4': 82,'42a6': 83,'42a8': 84,'42aa': 85,'42ac': 86,'42ae': 87,'42b0': 88,'42b2': 89,'42b4': 90,'42b6': 91,'42b8': 92,'42ba': 93,'42bc': 94,'42be': 95,'42c0': 96,'42c2': 97,'42c4': 98,'42c6': 99,'42c8': 100}
                let position = this.getAqaraIntFromHex(( ( (dataArray[dataStartIndex + 21] & 0xFF) << 8) | (dataArray[dataStartIndex + 22] & 0xFF) )) // positionCoverion[dataArray[dataStartIndex + 21].toString(16).padStart(2, '0') + dataArray[dataStartIndex + 22].toString(16).padStart(2, '0')]
                this.log('Position: ' + position)
                
                let resources = this.platform.panelsToResources['/' + this.id + rpath + '/curtain_' + deviceResourceType.charAt(deviceResourceType.length-1)]
                for (var i = resources.length - 1; i >= 0; i--) {
                  let resourceItem = resources[i];
                  let pathComponents = resourceItem.split( '/' )
                  let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
      
                  if (accessoryToControl && accessoryToControl.service._service.testCharacteristic(this.platform.Characteristics.hap.TargetPosition)) {
                    accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.TargetPosition).setValue(position)
                  }
                }
              } else if (stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Position State
                let positionState = dataArray[dataStartIndex + 24]
                this.log('Position State: ' + positionState)
                
                let resources = this.platform.panelsToResources['/' + this.id + rpath + '/curtain_' + deviceResourceType.charAt(deviceResourceType.length-1)]
                for (var i = resources.length - 1; i >= 0; i--) {
                  let resourceItem = resources[i];
                  let pathComponents = resourceItem.split( '/' )
                  let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
      
                  if (accessoryToControl && accessoryToControl.service._service.testCharacteristic(this.platform.Characteristics.hap.PositionState)) {
                    if (positionState < 0x02) {
                      accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.TargetPosition).setValue(positionState === 0x01 ? 100 : 0)
                    } else {
                      accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.HoldPosition).setValue(true)
                      accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.HoldPosition).setValue(false)
                    }
                    accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.PositionState).setValue(positionState === 0x01 ? this.platform.Characteristics.hap.PositionState.INCREASING : positionState === 0x00 ? this.platform.Characteristics.hap.PositionState.DECREASING : this.platform.Characteristics.hap.PositionState.STOPPED)
                  }
                }
              }
            } else if (deviceResourceType.startsWith('lights/')) {
              let onOff = undefined
              let brightness = undefined
              let colorTemperature = undefined
              let colorX = undefined
              let colorY = undefined
    
              if (stateParam[0] === 0x04 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light On/Off
                onOff = dataArray[dataStartIndex + 24] === 0x01
                this.log('On/Off: ' + onOff)
              } else if (stateParam[0] === 0x0e && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Brightness
                brightness = dataArray[dataStartIndex + 24]
                this.log('Brightness: ' + brightness)
              } else if (stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light CT
                colorTemperature = parseInt(dataArray[dataStartIndex + 23].toString(16).padStart(2, '0') + dataArray[dataStartIndex + 24].toString(16).padStart(2, '0'), 16)
                this.log('Color Temperature: ' + colorTemperature)
              } else if (stateParam[0] === 0x0e && stateParam[1] === 0x08 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Color
                colorX = parseInt(dataArray[dataStartIndex + 21].toString(16).padStart(2, '0') + dataArray[dataStartIndex + 22].toString(16).padStart(2, '0'), 16)
                colorY = parseInt(dataArray[dataStartIndex + 23].toString(16).padStart(2, '0') + dataArray[dataStartIndex + 24].toString(16).padStart(2, '0'), 16)
                this.log('Color X: ' + colorX + ', Color Y: ' + colorY)
              }
              let resources = this.platform.panelsToResources['/' + this.id + rpath + '/light_' + deviceResourceType.charAt(deviceResourceType.length-1)]
              for (var i = resources.length - 1; i >= 0; i--) {
                let resourceItem = resources[i]
                let pathComponents = resourceItem.split('/')
                let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
    
                if (accessoryToControl) {
                  if (onOff !== undefined) {
                    accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.On).setValue(onOff)
                    // accessoryToControl.service.values.on = onOff
                  }
                  if (brightness !== undefined) {
                    accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.Brightness).setValue(brightness)
                  }
                  if (colorTemperature !== undefined) {
                    accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.ColorTemperature).setValue(colorTemperature)
                  }
                  if (colorX !== undefined && colorY !== undefined) {
                    const { h, s } = Colour.xyToHsv([colorX / 65535.0, colorY / 65535.0], accessoryToControl.service.capabilities.gamut)
                        
                    accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.Hue).setValue(h)
                    accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.Saturation).setValue(s)
                  }
                }
              }
            }
          }
        } else if (commandCategory === 0x71 && commandAction === 0x06) { // Panel asking for data...
          this.debug('Asked data for param: ' + stateParam)
          if (stateParam[0] === 0x08 && stateParam[1] === 0x00 && stateParam[2] === 0x1f && stateParam[3] === 0xa5) { // Names
            if (this.actionsConfigData.aqara_S1_panels[rpath]) {
              // this.log(this.actionsConfigData.aqara_S1_panels[rpath])
              // this.log(deviceResourceType.startsWith('lights/') ? 'light_' + deviceResourceType.charAt(deviceResourceType.length-1) : deviceResourceType.startsWith('curtain') ? 'curtain_' + deviceResourceType.charAt(deviceResourceType.length-1) : 'ac')
              const name = this.actionsConfigData.aqara_S1_panels[rpath][deviceResourceType.startsWith('lights/') ? 'light_' + deviceResourceType.charAt(deviceResourceType.length-1) : deviceResourceType.startsWith('curtain') ? 'curtain_' + deviceResourceType.charAt(deviceResourceType.length-1) : 'ac'].name
  
              const dataToSend = this.generateNameCommand(name, deviceSerialStr)
              this._writeDataToPanel(('/' + this.id + rpath).split('/'), dataToSend)
            }
          } else if (stateParam[0] === 0x08 && stateParam[1] === 0x00 && stateParam[2] === 0x07 && stateParam[3] === 0xfd) { // Online/Offline
            // TODO: maybe set the state, on groups always online, on others, use the device.reachable state. What with multiple devices resources controller with one device???
            this.sendStateToPanel(('/' + this.id + rpath).split('/'), deviceSerialStr, '080007fd', '00000001') // Just respond with "Online" mode...
          } else if (deviceResourceType === 'air_cond') {
            if (stateParam[0] === 0x0e && stateParam[2] === 0x00 && stateParam[3] === 0x55 && (stateParam[1] === 0x20 || stateParam[1] === 0x02)) { // Air conditioner/Heater-Cooler device state
              const panelDevicePath = '/' + this.id + rpath + '/ac'
              const pathComponents = this.platform.panelsToResources[panelDevicePath][0].split('/')
              const accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
  
              if (accessoryToControl) {
                accessoryToControl.service.updatePanel(panelDevicePath.split('/'))
              }
            }
          } else if (deviceResourceType.startsWith('curtain')) {
            if (stateParam[0] === 0x01 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Position
              const panelDevicePath = '/' + this.id + rpath + '/curtain_' + deviceResourceType.charAt(deviceResourceType.length-1)
              const pathComponents = this.platform.panelsToResources[panelDevicePath][0].split( '/' )
              const accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
  
              if (accessoryToControl) {
                accessoryToControl.service.updatePanelPositionState(panelDevicePath.split('/'))
              } else {
                this.sendStateToPanel(('/' + this.id + rpath).split('/'), deviceSerialStr, '01010055', this.getAqaraHexFromInt(0).toString(16).padStart(4, '0') + '0000')
              }
            } else if (stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Position State
              const panelDevicePath = '/' + this.id + rpath + '/curtain_' + deviceResourceType.charAt(deviceResourceType.length-1)
              const pathComponents = this.platform.panelsToResources[panelDevicePath][0].split( '/' )
              const accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
  
              if (accessoryToControl) {
                accessoryToControl.service.updatePanelMovementState(panelDevicePath.split('/'))
              } else {
                this.sendStateToPanel(('/' + this.id + rpath).split('/'), deviceSerialStr, '0e020055', '00000002')
              }
            }
          } else if (deviceResourceType.startsWith('lights/')) {
            const panelDevicePath = '/' + this.id + rpath + '/light_' + deviceResourceType.charAt(deviceResourceType.length-1)
            const pathComponents = this.platform.panelsToResources[panelDevicePath][0].split( '/' )
            const accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
  
            if (accessoryToControl && accessoryToControl.values.serviceName === 'Light') {
              if (stateParam[0] === 0x04 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light On/Off
                accessoryToControl.service.updatePanelOnOffState(panelDevicePath.split('/'))
              } else if (stateParam[0] === 0x0e && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Brightness
                accessoryToControl.service.updatePanelBrightnessState(panelDevicePath.split('/'))
              } else if (stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light CT
                accessoryToControl.service.updatePanelColorTemperatureState(panelDevicePath.split('/'))
              } else if (stateParam[0] === 0x0e && stateParam[1] === 0x08 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Color
                accessoryToControl.service.updatePanelColorState(panelDevicePath.split('/'))
              }
            }
          }
        } else if (commandCategory === 0x71 && commandAction === 0x07) { // TODO: check what it is, it seems to be ACKs for completed lights configuration commmands somehow, not sure yet... Also, it seems it waiiting to some response from the coordinator, IDK what i should send yet...
          // Seems to be an error configuration setup report (basically resending the commands fixes it...)
          // Might be i can just ignore it and let my timeout technique to resend the data...
          this.log('Light configuration notification received... from: ' + rpath + ', Hex data: ' + updateData)
        } else if (commandCategory === 0x73 && commandAction === 0x03) {
          this.log('Scene Activated... from: ' + rpath + ', Hex data: ' + updateData)
        } else {
          this.error('Unknown message from: ' + rpath + ', Hex data: ' + updateData + ', Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum + ', commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16))
        }
      } else if (commandType === 0x24) {
        let paramsSize = dataArray[dataStartIndex + 8]
        
        if (commandCategory === 0x71 && commandAction === 0x02) { // ACKs for confguration commmands...
          if (this.configurationCommandsToExecute.length) {
            const configuredSlotID = this.toHexStringFromBytes([dataArray[dataStartIndex + 10], dataArray[dataStartIndex + 11], dataArray[dataStartIndex + 12], dataArray[dataStartIndex + 13], dataArray[dataStartIndex + 14]])
            const currentConfiguredDeviceCommandsObject = this.configurationCommandsToExecute[this.configurationCommandsToExecute.length - 1]
            let currentCommand = currentConfiguredDeviceCommandsObject.commands[currentConfiguredDeviceCommandsObject.meta.index]
            let slotIdIndex = 20
            if (currentCommand[9] === '6') {
              slotIdIndex = 24
              // check we're in the last commands part and set currentCommand to the first command of series...
              // const totalParts =  dataArray[dataStartIndex + 5]
              const partNo =  dataArray[dataStartIndex + 6]
              currentCommand = currentConfiguredDeviceCommandsObject.commands[currentConfiguredDeviceCommandsObject.meta.index - (partNo - 1)]
            }
            const commandSlotID = currentCommand.substring(slotIdIndex, slotIdIndex + 10)
            if (commandSlotID === configuredSlotID) {
              this.log('Configuration command Slot ID ' + configuredSlotID + ' ACK...')
              this.executeNextConfigurationCommand()
            }
          }
        } else if (commandCategory === 0x71 && commandAction === 0x04) { // ACKs for configuration removal commmands...
          this.log('Configuration removal command ACK...')
          this.executeNextConfigurationCommand()
        } else if (commandCategory === 0x73 && commandAction === 0x01) { // ACKs for scene configuration commmands...
          // TODO: Maybe check that the rpath is the current command path, this is suffecient because we have only one command per panel...
          this.log('Scene configuration command ACK...')
          this.executeNextConfigurationCommand()
        } else if (commandCategory === 0x73 && commandAction === 0x02) { // ACKs for unused scenes configuration commmands...
          // TODO: Maybe check that the rpath is the current command path, this is suffecient because we have only one command per panel...
          this.log('Unused scenes configuration command ACK...')
          this.executeNextConfigurationCommand()
        } else if (commandCategory === 0x71 && commandAction === 0x05) { // ACKs for state commmands...
          let deviceSerial = [dataArray[dataStartIndex + 10], dataArray[dataStartIndex + 11], dataArray[dataStartIndex + 12], dataArray[dataStartIndex + 13], dataArray[dataStartIndex + 14], dataArray[dataStartIndex + 15], dataArray[dataStartIndex + 16], dataArray[dataStartIndex + 17]]
  
          this.debug('commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16) + ', deviceSerial: ' + deviceSerial)
    
          const deviceResourceType = this.toCharacterStringFromBytes(deviceSerial)
          const deviceSerialStr = this.toHexStringFromBytes(deviceSerial)
  
          if (dataArray[dataStartIndex + 9] === 0x01) { // A device is missing... (We sent a state to unconfigured device. For example, we sent a light on/off state for light_1 while it isn't configured on the panel, so, we should (re)configure it...
            
          } else if (dataArray[dataStartIndex + 9] === 0x00) {
            this.log('State update ACK, Param: 0x' + dataArray[dataStartIndex + 18] + '.')
            if (!this.actionsConfigData.aqara_S1_panels[rpath] || (deviceResourceType.startsWith('lights/') && !this.actionsConfigData.aqara_S1_panels[rpath]['light_' + deviceResourceType.charAt(deviceResourceType.length-1)]) || (deviceResourceType.startsWith('curtain') && !this.actionsConfigData.aqara_S1_panels[rpath]['curtain_' + deviceResourceType.charAt(deviceResourceType.length-1)]) || (deviceResourceType === 'air_cond' && !this.actionsConfigData.aqara_S1_panels[rpath]['ac'])) { // A device is configured on the panel, but shouldn't be there (removed from config...), so, we should remove its configuration...
              
            }
          }
        } else if (commandCategory === 0x71 && commandAction === 0x08) { // ACKs for feel page updates commmands...
          let deviceSerial = [dataArray[dataStartIndex + 10], dataArray[dataStartIndex + 11], dataArray[dataStartIndex + 12], dataArray[dataStartIndex + 13], dataArray[dataStartIndex + 14], dataArray[dataStartIndex + 15], dataArray[dataStartIndex + 16], dataArray[dataStartIndex + 17]]
  
          this.debug('commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16) + ', deviceSerial: ' + deviceSerial)
          
          // deviceSerial should be === this.id for non temperature sensor weather updates...
          if (dataArray[dataStartIndex + 9] === 0x01) { // A device is missing...
            
          } else if (dataArray[dataStartIndex + 9] === 0x00) {
            this.log('Weather data update ACK, Param: 0x' + dataArray[dataStartIndex + 18] + '.')
            if (!this.actionsConfigData.aqara_S1_panels[rpath] || ((dataArray[dataStartIndex + 18] === 0x01 || dataArray[dataStartIndex + 18] === 0x02) && !this.actionsConfigData.aqara_S1_panels[rpath]['temperature_sensor'])) { // A device is set on the device, but shouldn't be there (removed from config...)
              
            }
          }
        } else {
          this.error('Unknown message from: ' + rpath + ', Hex data: ' + updateData + ', Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum + ', commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16))
        }
      } else if (commandType === 0xc6) {
        if (commandCategory === 0x71 && commandAction === 0x02) { // For multipart device configuration commands...
          const totalParts =  dataArray[dataStartIndex + 5]
          const partNo =  dataArray[dataStartIndex + 6]
          this.log('Multipart commands ACK received, part ' + partNo + ' of ' + totalParts + ' total.')
          if (partNo < totalParts) {
            if (this.configurationCommandsToExecute.length) {
              const currentCommandIndex = this.configurationCommandsToExecute[this.configurationCommandsToExecute.length - 1].meta.index
              if (partNo === currentCommandIndex + 1) {
                this.executeNextConfigurationCommand()
              }
            }
          } else {
            // We should receive now commandType === 0x24 && commandCategory === 0x71 && commandAction === 0x02 above...
          }
        } else if (commandCategory === 0x73 && commandAction === 0x01) { // For multipart scene configuration commands...
          const totalParts =  dataArray[dataStartIndex + 5]
          const partNo =  dataArray[dataStartIndex + 6]
          this.log('Multipart commands ACK received, part ' + partNo + ' of ' + totalParts + ' total.')
          if (partNo < totalParts) {
            if (this.configurationCommandsToExecute.length) {
              const commandsSetData = this.configurationCommandsToExecute[this.configurationCommandsToExecute.length - 1]
              const commandBytes = this.fromHexStringToBytes(commandsSetData.commands[commandsSetData.meta.index])
              if (partNo === commandBytes[7]) {
                this.executeNextConfigurationCommand()
              }
            }
          } else {
            // We should receive now commandType === 0x24 && commandCategory === 0x73 && commandAction === 0x01 above...
          }
        } else {
          this.error('Unknown message from: ' + rpath + ', Hex data: ' + updateData + ', Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum + ', commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16))
        }
      } else {
        this.error('Unknown message from: ' + rpath + ', Hex data: ' + updateData + ', Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum + ', commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16))
      }
    } else {
      this.error('Unknown message from: ' + rpath + ', Hex data: ' + updateData + ', Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum + ', commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16))
    }
  }

  generateNameCommand(name, device) {
    const nameSize = name.length
    const nameHex = this.toHexStringFromCharacterString(name)

    const totalSize = 21 + 1 + nameSize
    const commandSize = totalSize - 6
    const paramsSize = commandSize - 3
    const counter = '6d'
    const integrity = 512 - (parseInt('aa', 16) + parseInt('71', 16) + commandSize + parseInt('44', 16) + parseInt(counter, 16))

    const that = this
    const dataToSend = totalSize.toString(16).padStart(2, '0') + 'aa71' + commandSize.toString(16).padStart(2, '0') + '44' + counter + this.getUInt8(integrity).toString(16).padStart(2, '0') + '0541' + paramsSize.toString(16).padStart(2, '0') + device + '08001fa5' + nameSize.toString(16).padStart(2, '0') + nameHex
    this.log('Name data: ' + dataToSend)

    return dataToSend
  }
  // End of Added by me: Arye Levin

  /** Create {@link DeconzAccessory.Gateway#wsclient}.
    */
  createWsClient () {
    /** Client for gateway web socket notifications.
      * @type {DeconzWsClient}
      */
    this.wsClient = new Deconz.WsClient({
      host: this.values.host.split(':')[0] + ':' + this.values.wsPort,
      retryTime: 15
    })
    this.wsClient
      .on('error', (error) => {
        this.warn('websocket communication error: %s', error)
      })
      .on('listening', (url) => {
        this.log('websocket connected to %s', url)
      })
      .on('changed', (rtype, rid, body) => {
        try {
          const rpath = '/' + rtype + '/' + rid
          this.vdebug('%s: changed: %j', rpath, body)
          const accessory = this.accessoryByRpath[rpath]

          if (this.initialised) {
            // if (rtype === 'lights' && (rid === '14' || rid === '34')) {
              // this.log(JSON.stringify(body.state))
            // }
            if (rtype === 'sensors' && body.state !== undefined && body.state.buttonevent !== undefined && this.actionsConfigData && this.actionsConfigData[rid] && this.actionsConfigData[rid].length && this.platform.platformAccessory.service.values.switchesOn) {
              var actionsConfig = this.actionsConfigData[rid]
              var sensorTypeInt = actionsConfig[0] // 0 = Old IKEA round 5 button remote, 1 = Hue Switch Remote, 2 = New IKEA rect 4 buttons
              this.log('sensor: %s, event data: %s, config: %s', rid, JSON.stringify(body.state), JSON.stringify(actionsConfig))
              // Set the defaults...
              // if (!accessory.lastActions) {
              //   accessory.lastActions = {
              //     1002: 0,
              //     2002: 0,
              //     3002: 0,
              //     4002: 0,
              //     5002: 0,
              //     2001: 0,
              //     3001: 0
              //   };
              //   accessory.lastTimeoutID = undefined;
              // }

              for (var i = actionsConfig.length - 1; i >= 1; i--) {
                // First cancel any timeouts we've created for the long press handling...
                var keyForTimeoutAction = rid + i
                clearTimeout(longPressTimeoutIDs[keyForTimeoutAction])
                
                var actionConfig = actionsConfig[i]

                if ((sensorTypeInt === 2 && body.state.buttonevent === 1001) || body.state.buttonevent === 2001 || body.state.buttonevent === 3001 || body.state.buttonevent === 4001 || body.state.buttonevent === 5001) {
                  if (actionConfig.resourcePath && actionConfig.resourcePath.startsWith("/")) {
                    const pathComponents = actionConfig.resourcePath.split( '/' )
                    let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
                    if (accessoryToControl) {
                      const that = this
                      function repeatZBFunction(delay, timeoutKey) {
                        longPressTimeoutIDs[timeoutKey] = setTimeout(function() {
                          that.log('Long press being on ZigBee service!!!')
                          let continueRepeat = true
                          if (sensorTypeInt === 1) {
                            continueRepeat = false
                          }
                          var service = accessoryToControl.service._service;
                          if (((sensorTypeInt === 2 && body.state.buttonevent === 1001) || ((sensorTypeInt === 0 || sensorTypeInt === 1) && body.state.buttonevent === 2001)) && service.testCharacteristic(that.platform.Characteristics.hap.Brightness)) { // Start Increasing the Brightness and turn on at lowest brighness if Off...
                            if (!service.getCharacteristic(that.platform.Characteristics.hap.On).value) {
                              service.getCharacteristic(that.platform.Characteristics.hap.Brightness).setValue(1)
                              service.getCharacteristic(that.platform.Characteristics.hap.On).setValue(true)
                            } else {
                              const characteristic = service.getCharacteristic(that.platform.Characteristics.hap.Brightness)
                              const newBrightnessState = Math.min(100, characteristic.value + 5)
                              characteristic.setValue(newBrightnessState)
                              if (newBrightnessState === 100) {
                                continueRepeat = false
                              }
                            }
                          } else if (((sensorTypeInt === 2 && body.state.buttonevent === 2001) || ((sensorTypeInt === 0 || sensorTypeInt === 1) && body.state.buttonevent === 3001)) && service.testCharacteristic(that.platform.Characteristics.hap.Brightness)) {
                            const characteristic = service.getCharacteristic(that.platform.Characteristics.hap.Brightness)
                            const newBrightnessState = Math.max(1, characteristic.value - 5)
                            characteristic.setValue(newBrightnessState)
                            if (newBrightnessState === 1) {
                              continueRepeat = false
                            }
                          } else if (((sensorTypeInt === 2 && body.state.buttonevent === 3001) || (sensorTypeInt === 0 && body.state.buttonevent === 4001)) && service.testCharacteristic(that.platform.Characteristics.hap.ColorTemperature)) {
                            const characteristic = service.getCharacteristic(that.platform.Characteristics.hap.ColorTemperature)
                            const newColorTemperatureState = Math.max(153, characteristic.value - 32)
                            characteristic.setValue(newColorTemperatureState)
                            if (newColorTemperatureState === 153) { // TODO: take the min/max from the object itself...
                              continueRepeat = false
                            }
                          } else if (((sensorTypeInt === 2 && body.state.buttonevent === 4001) || (sensorTypeInt === 0 && body.state.buttonevent === 5001)) && service.testCharacteristic(that.platform.Characteristics.hap.ColorTemperature)) {
                            const characteristic = service.getCharacteristic(that.platform.Characteristics.hap.ColorTemperature)
                            const newColorTemperatureState = Math.min(500, characteristic.value + 32)
                            characteristic.setValue(newColorTemperatureState)
                            if (newColorTemperatureState === 500) {
                              continueRepeat = false
                            }
                          } else {
                            continueRepeat = false
                          }
                          if (continueRepeat) {
                            repeatZBFunction(300, timeoutKey)
                          }
                        }, delay)
                      }
                      repeatZBFunction(0, keyForTimeoutAction)
                    }
                  } else {
                    var actionToDo = actionConfig[body.state.buttonevent];//[accessory.lastActions[body.state.buttonevent]];
                    if (/*this.platform.state.remotes_on && */actionToDo) {
                      var jsonObject = JSON.parse(JSON.stringify(actionConfig.json))
                      jsonObject.action = actionToDo;

                      const data = JSON.stringify(jsonObject)
                      
                      const options = {
                        hostname: actionConfig.host,
                        port: actionConfig.port,
                        path: actionConfig.path,
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'Content-Length': data.length
                        }
                      }

                      const that = this

                      var repeatFunction = function(delay, timeoutKey) {
                        longPressTimeoutIDs[timeoutKey] = setTimeout(function() {
                          that.log('Long press being on URL!!!')

                          const req = http.request(options, res => {
                            that.log(`statusCode: ${res.statusCode}`)
                          
                            if (res.statusCode == 200) {
                              that.log('Command sent and received successfully')
                            }

                            res.on('data', d => {
                              // process.stdout.write(d)
                              that.log(d)
                            })
                          })
                          
                          req.on('error', error => {
                            console.error(error)
                          })
                          
                          req.write(data)
                          req.end()
                          
                          repeatFunction(300, timeoutKey)
                        }, delay)
                      }
                      repeatFunction(0, keyForTimeoutAction)
                    }
                  }
                } else if (body.state.buttonevent === 1000 || ((sensorTypeInt === 0 || sensorTypeInt === 1) && body.state.buttonevent === 1001) || body.state.buttonevent === 1002 || body.state.buttonevent === 2000 || body.state.buttonevent === 2002 || body.state.buttonevent === 3000 || body.state.buttonevent === 3002 || body.state.buttonevent === 4000 || body.state.buttonevent === 4002 || body.state.buttonevent === 5002) {
                  if (actionConfig.resourcePath && actionConfig.resourcePath.startsWith("/")) {
                    var pathComponents = actionConfig.resourcePath.split( '/' )
                    let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
                    if (accessoryToControl) {
                      var service = accessoryToControl.service._service;
                      if ((sensorTypeInt === 0 || sensorTypeInt === 1) && body.state.buttonevent === 1001) { // Turn On with default settings (including CT)...
                        service.getCharacteristic(this.platform.Characteristics.hap.On).setValue(true)
                        service.getCharacteristic(this.platform.Characteristics.hap.Brightness).setValue(100)
                        service.getCharacteristic(this.platform.Characteristics.hap.ColorTemperature).setValue(363) // TODO: use a config file to know the right default...
                      } else if (sensorTypeInt === 0 && body.state.buttonevent === 1002) { // Toggle power and only if on, set to full brightness...
                        let characteristic = service.getCharacteristic(this.platform.Characteristics.hap.On)
                        const newPowerState = !characteristic.value
                        characteristic.setValue(newPowerState)
                        if (newPowerState && service.testCharacteristic(this.platform.Characteristics.hap.Brightness)) {
                            characteristic = service.getCharacteristic(this.platform.Characteristics.hap.Brightness)
                            if (characteristic.value !== 100) {
                                characteristic.setValue(100)
                            }
                        }
                      } else if ((sensorTypeInt === 1 && body.state.buttonevent === 1000)) { // Turn On at full brightness...
                        let characteristic = service.getCharacteristic(this.platform.Characteristics.hap.On)
                        const originalValue = characteristic.value
                        characteristic.setValue(true)
                        if (originalValue && service.testCharacteristic(this.platform.Characteristics.hap.Brightness)) {
                          characteristic = service.getCharacteristic(this.platform.Characteristics.hap.Brightness)
                          if (characteristic.value !== 100) {
                            characteristic.setValue(100)
                          }
                        }
                      } else if ((sensorTypeInt === 2 && body.state.buttonevent === 1002)) { // Turn On at full brightness and if On already just increase the brightness...
                        let characteristic = service.getCharacteristic(this.platform.Characteristics.hap.On)
                        const originalValue = characteristic.value
                        if (!originalValue) {
                          characteristic.setValue(true)
                        }
                        if (service.testCharacteristic(this.platform.Characteristics.hap.Brightness)) {
                          characteristic = service.getCharacteristic(this.platform.Characteristics.hap.Brightness)
                          if (!originalValue) {
                            if (characteristic.value !== 100) {
                              characteristic.setValue(100)
                            }
                          } else {
                            const newBrightnessState = Math.min(100, characteristic.value + 5)
                            characteristic.setValue(newBrightnessState)
                          }
                        }
                      } else if (((sensorTypeInt === 1 && body.state.buttonevent === 2000) || (sensorTypeInt === 0 && body.state.buttonevent === 2002)) && service.testCharacteristic(this.platform.Characteristics.hap.Brightness)) { // Turn On with lowest brightness or increase the brightness if On already
                        if (!service.getCharacteristic(this.platform.Characteristics.hap.On).value) {
                          service.getCharacteristic(this.platform.Characteristics.hap.Brightness).setValue(1)
                          service.getCharacteristic(this.platform.Characteristics.hap.On).setValue(true)
                        } else {
                          const characteristic = service.getCharacteristic(this.platform.Characteristics.hap.Brightness);
                          const newBrightnessState = Math.min(100, characteristic.value + 5)
                          characteristic.setValue(newBrightnessState)
                        }
                      } else if ((/*(sensorTypeInt === 2 && body.state.buttonevent === 2002) || Handled down there, acts as Turn Off, on long press it acts as dim down... */(sensorTypeInt === 1 && body.state.buttonevent === 3000) || (sensorTypeInt === 0 && body.state.buttonevent === 3002)) && service.testCharacteristic(this.platform.Characteristics.hap.Brightness)) { // Decrease the brightness
                        const characteristic = service.getCharacteristic(this.platform.Characteristics.hap.Brightness);
                        const newBrightnessState = Math.max(1, characteristic.value - 5)
                        characteristic.setValue(newBrightnessState)
                      } else if (((sensorTypeInt === 2 && body.state.buttonevent === 3002) || (sensorTypeInt === 0 && body.state.buttonevent === 4002)) && service.testCharacteristic(this.platform.Characteristics.hap.ColorTemperature)) { // Increase the CT
                        const characteristic = service.getCharacteristic(this.platform.Characteristics.hap.ColorTemperature)
                        const newColorTemperatureState = Math.max(153, characteristic.value - 32)
                        characteristic.setValue(newColorTemperatureState)
                      } else if (((sensorTypeInt === 2 && body.state.buttonevent === 4002) || (sensorTypeInt === 0 && body.state.buttonevent === 5002)) && service.testCharacteristic(this.platform.Characteristics.hap.ColorTemperature)) { // Decrease the CT
                        const characteristic = service.getCharacteristic(this.platform.Characteristics.hap.ColorTemperature)
                        const newColorTemperatureState = Math.min(500, characteristic.value + 32)
                        characteristic.setValue(newColorTemperatureState)
                      } else if ((sensorTypeInt === 2 && body.state.buttonevent === 2002) || (sensorTypeInt === 1 && body.state.buttonevent === 4000)) {
                        const characteristic = service.getCharacteristic(this.platform.Characteristics.hap.On)
                        characteristic.setValue(false)
                      }
                    }
                  } else {
                    var actionToDo = actionConfig[body.state.buttonevent];//[accessory.lastActions[body.state.buttonevent]];
                    if (/*this.platform.state.remotes_on && */actionToDo) {
                      var jsonObject = JSON.parse(JSON.stringify(actionConfig.json)) // Object.assign({}, actionConfig.json);
                      // if (accessory.lastActions[body.state.buttonevent] === actionConfig[body.state.buttonevent].length - 1) {
                      //     accessory.lastActions[body.state.buttonevent] = 0;
                      // } else {
                      //     accessory.lastActions[body.state.buttonevent] ++;
                      // }
                      jsonObject.action = actionToDo
                      
                      const data = JSON.stringify(jsonObject)
                
                      const options = {
                        hostname: actionConfig.host,
                        port: actionConfig.port,
                        path: actionConfig.path,
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'Content-Length': data.length
                        }
                      }

                      const that = this

                      const req = http.request(options, res => {
                        that.log(`statusCode: ${res.statusCode}`)
                      
                        if (res.statusCode == 200) {
                          that.log('Command sent and received successfully')
                        }

                        res.on('data', d => {
                          // process.stdout.write(d)
                          that.log(d)
                        })
                      })
                      
                      req.on('error', error => {
                        that.error(error)
                      })
                      
                      req.write(data)
                      req.end()
                    }
                  }
                } else if (body.state.buttonevent === 1003 || body.state.buttonevent === 2003 || body.state.buttonevent === 3003 || body.state.buttonevent === 4003 || body.state.buttonevent === 5003) {
                  // if (accessory.lastActions[body.state.buttonevent - 2] === actionConfig[body.state.buttonevent - 2].length - 1) {
                  //     accessory.lastActions[body.state.buttonevent - 2] = 0;
                  // } else {
                  //     accessory.lastActions[body.state.buttonevent - 2] ++;
                  // }
                }
              }
            } else if (this.context.fullState[rtype][rid] && this.context.fullState[rtype][rid].modelid === "lumi.switch.n4acn4") {
              if (rtype === 'sensors' && body.config !== undefined && body.config.aqara_s1_communication !== undefined && /*body.config.aqara_s1_communication !== this.context.fullState[rtype][rid].config.aqara_s1_communication && */!(/*body.config.aqara_s1_communication[4] === '7' && body.config.aqara_s1_communication[5] === '1' && */body.config.aqara_s1_communication[8] === '4' && (body.config.aqara_s1_communication[9] === '4' || body.config.aqara_s1_communication[9] === '6'))) { // Command Category 71 and Command Type 44/46 is our sent commands, so ignore these...
                this.debug('Aqara panel sent data %s', JSON.stringify(body))
                let updateData = body.config.aqara_s1_communication
                // this.context.fullState[rtype][rid].config.aqara_s1_communication = updateData
                this.debug('Received data from aqara S1 Panel: ' + rpath + ', data: ' + updateData)
    
                this.processIncomingDataFromAqaraS1(updateData, rpath)
              } else if (rtype === 'lights' && body.state !== undefined && body.state.on !== undefined && body.state.on !== this.context.fullState.lights[rid].state.on) {
                this.log('Received on/off switch state aqara S1 Panel:' + rpath + ', state: ' + body.state.on)
                this.context.fullState.lights[rid].state.on = body.state.on
                if (this.platform.panelsToResources['/' + this.id + rpath + '/switch'] !== undefined && this.platform.platformAccessory.service.values.switchesOn) {
                  let resources = this.platform.panelsToResources['/' + this.id + rpath + '/switch']
                  for (var i = resources.length - 1; i >= 0; i--) {
                    let resourceItem = resources[i];
                    let pathComponents = resourceItem.split( '/' )
                    let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
        
                    if (accessoryToControl) {
                      accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.On).setValue(body.state.on)
                    }
                  }
                }
              }
            }
          }

          if (accessory != null) {
            /** Emitted when a change notificatoin for a resource has been
              * received over the web socket.
              * @event DeconzAccessory.Device#changed
              * @param {string} rpath - The resource path.
              * @param {Object} body - The resource body.
              */
            accessory.emit('changed', rpath, body)
          }
        } catch (error) {
          this.warn('websocket error: %s', error)
        }
      })
      .on('added', (rtype, rid, body) => {
        this.vdebug('/%s/%d: added: %j', rtype, rid, body)
        this.pollNext = true
        this.pollFullState = true
      })
      .on('deleted', (rtype, rid) => {
        this.vdebug('/%s/%d: deleted', rtype, rid)
        this.pollNext = true
        this.pollFullState = true
      })
      .on('closed', (url, retryTime) => {
        if (retryTime > 0) {
          this.log(
            'websocket connection to %s closed - retry in %ds', url, retryTime
          )
        } else {
          this.log('websocket connection to %s closed', url)
        }
      })
  }

  /** Connect to the gateway.
    *
    * Try for two minutes to obtain an API key, when no API key is available.
    * When the API key has been obtained, open the web socket, poll the
    * gateway, and analyse the full state.
    */
  async connect (retry = 0) {
    if (!this.values.expose) {
      this.warn('unlock gateway and set Expose to obtain an API key')
      return
    }
    try {
      if (this.values.apiKey == null) {
        this.values.apiKey =
          await this.client.getApiKey('homebridge-deconz')
      }
      this.wsClient.listen()
      this.service.values.restart = false
      this.service.values.statusActive = true
      this.checkApiKeys = true
      for (const id in this.exposeErrorById) {
        this.resetExposeError(id)
      }
      this.pollNext = true
      this.pollFullState = true
    } catch (error) {
      if (
        error instanceof Deconz.ApiError && error.type === 101 && retry < 8
      ) {
        this.log('unlock gateway to obtain API key - retrying in 15s')
        await timeout(15000)
        return this.connect(retry + 1)
      }
      this.error(error)
      this.values.expose = false
    }
  }

  /** Reset the gateway delegate.
    *
    * Delete the API key from the gateway.
    * Close the web socket connection.
    * Delete all accessories and services associated to devices exposed by
    * the gateway.
    */
  async reset () {
    if (this.values.apiKey == null) {
      return
    }
    try {
      try {
        await this.deleteMigration()
        await this.client.deleteApiKey()
      } catch (error) {}
      this.values.apiKey = null
      await this.wsClient.close()
      for (const id in this.accessoryById) {
        if (id !== this.id) {
          this.deleteAccessory(id)
        }
      }
      this.exposeErrors = {}
      this.context.settingsById = {}
      this.context.fullState = null
      this.values.logLevel = 2
    } catch (error) { this.error(error) }
  }

  // ===========================================================================

  /** Blacklist or (re-)expose a gateway device.
    *
    * Delete the associated accessory.  When blacklisted, add the associated
    * device settings delegate to the Gateway accessory, otherwise (re-)add
    * the associated accessory.
    * @params {string} id - The device ID.
    * @params {boolean} expose - Set to `false` to blacklist the device.
    */
  exposeDevice (id, expose) {
    if (id === this.id) {
      throw new RangeError(`${id}: gateway ID`)
    }
    if (this.deviceById[id] == null) {
      throw new RangeError(`${id}: unknown device ID`)
    }
    this.context.settingsById[id].expose = expose
    this.pollNext = true
  }

  /** Re-expose an accessory.
    *
    * Delete the accessory delegate, but keep the HAP accessory, including
    * the persisted context.
    * The delegate will be re-created when the gateway is next polled.
    * @params {string} id - The device ID.
    * @params {boolean} expose - Set to `false` to blacklist the device.
    */
  reExposeAccessory (id) {
    if (id === this.id) {
      throw new RangeError(`${id}: gateway ID`)
    }
    if (this.accessoryById[id] == null) {
      throw new RangeError(`${id}: unknown accessory ID`)
    }
    this.deleteAccessory(id, true)
    this.pollNext = true
  }

  /** Add the accessory for the device.
    * @params {string} id - The device ID.
    * @return {?DeconzAccessory} - The accessory delegate.
    */
  addAccessory (id) {
    if (id === this.id) {
      throw new RangeError(`${id}: gateway ID`)
    }
    if (this.deviceById[id] == null) {
      throw new RangeError(`${id}: unknown device ID`)
    }
    if (this.accessoryById[id] == null) {
      const device = this.deviceById[id]
      delete this.exposeErrorById[id]
      const { body } = device.resource
      this.debug('%s: add accessory', body.name)
      let { serviceName } = device.resource
      if (DeconzAccessory[serviceName] == null) {
        // this.warn('%s: %s: not yet supported %s type', body.name, body.type, rtype)
        serviceName = 'Sensor'
      }
      const accessory = new DeconzAccessory[serviceName](this, device)
      this.accessoryById[id] = accessory
      this.monitorResources(accessory, true)
      accessory.once('exposeError', (error) => {
        accessory.warn(error)
        this.exposeErrorById[id] = error
      })
    }
    return this.accessoryById[id]
  }

  /** Delete the accessory delegate and associated HomeKit accessory.
    * @params {string} id - The device ID.
    * @params {boolean} [delegateOnly=false] - Delete the delegate, but keep the
    * associated HomeKit accessory (including context).
    */
  deleteAccessory (id, delegateOnly = false) {
    if (id === this.id) {
      throw new RangeError(`${id}: gateway ID`)
    }
    if (this.accessoryById[id] != null) {
      this.monitorResources(this.accessoryById[id], false)
      this.log('%s: delete accessory', this.accessoryById[id].name)
      this.accessoryById[id].destroy(delegateOnly)
      delete this.accessoryById[id]
      if (this.exposeErrorById[id] != null) {
        delete this.exposeErrorById[id]
      } else if (!delegateOnly) {
        const id = Object.keys(this.exposeErrorById)[0]
        if (id != null) {
          this.log(
            '%s: resetting after expose error: %s', id, this.exposeErrorById[id]
          )
          this.deleteAccessory(id)
          this.deleteService(id)
        }
      }
    }
  }

  /** Enable / disable accessory events for resource.
    * @param {DeconzAccessory.Device} accessory - The accessory delegate.
    * @param {boolean} monitor - Enable or disable events.
    */
  monitorResources (accessory, monitor = true) {
    const { id, rpaths } = accessory
    for (const rpath of rpaths) {
      if (!monitor) {
        accessory.debug('unsubscribe from %s', rpath)
        delete this.accessoryByRpath[rpath]
      } else if (this.accessoryByRpath[rpath] != null) {
        accessory.warn(new Error('%s: already monitored by', rpath, id))
      } else {
        accessory.debug('subscribe to %s', rpath)
        this.accessoryByRpath[rpath] = accessory
      }
    }
  }

  /** Reset expose error for device.
    *
    * Remove the un-exposed accessory, so it will be re-created on next poll.
    * @params {string} id - The device ID.
    */
  resetExposeError (id) {
    this.log(
      '%s: resetting after expose error: %s', id, this.exposeErrorById[id]
    )
    this.deleteAccessory(id)
    this.deleteService(id)
  }

  /** Assert that migration resourcelink exists and is valid.
    */
  async checkMigration () {
    if (this.context.migration != null) {
      try {
        const response = await this.client.get(this.context.migration)
        if (
          response.name !== migration.name ||
          response.description !== migration.description ||
          response.classid !== migration.classid ||
          response.owner !== this.client.apiKey
        ) {
          // not my migration resourcelink
          this.warn('%s: migration resourcelink no longer valid', this.context.migration)
          this.context.migration = null
        }
      } catch (error) {
        if (error.statusCode === 404) {
          this.warn('%s: migration resourcelink no longer exists', this.context.migration)
          this.context.migration = null
        }
      }
    }
  }

  /** Create or update migration resourcelink.
    */
  async updateMigration () {
    await this.checkMigration()
    if (this.context.migration == null) {
      const response = await this.client.post('/resourcelinks', {
        name: migration.name,
        description: migration.description,
        classid: migration.classid,
        links: Object.keys(this.accessoryByRpath).sort()
      })
      this.context.migration = '/resourcelinks/' + response.success.id
    } else {
      await this.client.put(this.context.migration, {
        links: Object.keys(this.accessoryByRpath).sort()
      })
    }
  }

  /** Delete migration resourcelink.
    */
  async deleteMigration () {
    await this.checkMigration()
    if (this.context.migration != null) {
      await this.client.delete(this.context.migration)
      this.context.migration = null
    }
  }

  // ===========================================================================

  _deviceToMap (id, details = false) {
    const device = this.deviceById[id]
    if (device == null) {
      return { status: 404 } // Not Found
    }
    const body = {
      expose: details ? undefined : this.accessoryById[device.id] != null,
      id: details ? device.id : undefined,
      manufacturer: device.resource.manufacturer,
      model: device.resource.model,
      name: device.resource.body.name,
      resources: device.rpaths,
      settings: details
        ? {
            expose: this.accessoryById[device.id] != null,
            outlet: undefined, // expose as _Outlet_
            switch: undefined, // expose as _Switch
            valve: undefined // expose as _Valve_
          }
        : undefined,
      type: device.resource.rtype,
      zigbee: device.zigbee
    }
    return { status: 200, body }
  }

  async onUiGet (path) {
    this.debug('ui request: GET %s', path.join('/'))
    if (path.length === 0) {
      const body = {
        host: this.values.host,
        id: this.id,
        manufacturer: this.values.manufacturer,
        model: this.values.model,
        name: this.name,
        settings: this.values.apiKey == null
          ? {
              expose: this.values.expose,
              logLevel: this.values.logLevel
            }
          : {
              brightnessAdjustment: this.values.brightnessAdjustment * 100,
              expose: this.values.expose,
              heartrate: this.values.heartrate,
              logLevel: this.values.logLevel,
              periodicEvents: this.values.periodicEvents,
              restart: this.values.restart,
              search: this.values.search,
              unlock: this.values.unlock
            }
      }
      return { status: 200, body }
    }
    if (path[0] === 'accessories') {
      if (path.length === 1) {
        const body = {}
        for (const id of Object.keys(this.accessoryById).sort()) {
          body[id] = this.accessoryById[id].onUiGet().body
        }
        return { status: 200, body }
      }
      if (path.length === 2) {
        const id = path[1].replace(/:/g, '').toUpperCase()
        if (this.accessoryById[id] == null) {
          return { status: 404 } // Not Found
        }
        return this.accessoryById[id].onUiGet(true)
      }
    }
    if (path[0] === 'devices') {
      if (path.length === 1) {
        const body = {}
        for (const id of Object.keys(this.deviceById).sort()) {
          body[id] = this._deviceToMap(id).body
        }
        return { status: 200, body }
      }
      if (path.length === 2) {
        return this._deviceToMap(path[1].replace(/:/g, '').toUpperCase(), true)
      }
    }
    return { status: 403 } // Forbidden
  }

  async onUiPut (path, body) {
    this.debug('ui request: PUT %s %j', path.join('/'), body)
    if (path.length === 0) {
      return { status: 405 } // Method Not Allowed
    }
    if (path[0] === 'settings') {
      const settings = {}
      const optionParser = new OptionParser(settings, true)
      optionParser
        .on('userInputError', (error) => {
          this.warn(error)
        })
        .boolKey('expose')
        .intKey('logLevel', 0, 3)
      if (this.values.apiKey != null) {
        optionParser
          .intKey('brightnessAdjustment', 10, 100)
          .intKey('heartrate', 1, 60)
          .boolKey('periodicEvents')
          .boolKey('restart')
          .boolKey('search')
          .boolKey('unlock')
      }
      optionParser.parse(body)

      const responseBody = {}
      for (const key in settings) {
        switch (key) {
          case 'brightnessAdjustment':
            this.values[key] = settings[key] / 100
            responseBody[key] = this.values[key]
            break
          case 'expose':
          case 'heartrate':
          case 'logLevel':
          case 'periodicEvents':
          case 'restart':
          case 'search':
          case 'unlock':
            this.values[key] = settings[key]
            responseBody[key] = this.values[key]
            break
          default:
            break
        }
      }
      return { status: 200, body: responseBody }
    }
    if (path[0] === 'accessories') {
      if (path.length < 3) {
        return { status: 405 } // Method Not Allowed
      }
      if (path.length === 3 && path[2] === 'settings') {
        const id = path[1].replace(/:/g, '').toUpperCase()
        if (this.accessoryById[id] == null) {
          return { status: 404 } // Not Found
        }
        return this.accessoryById[id].onUiPut(body)
      }
    }
    if (path[0] === 'devices') {
      if (path.length < 3) {
        return { status: 405 } // Method Not Allowed
      }
      if (path.length === 3 && path[2] === 'settings') {
        const id = path[1].replace(/:/g, '').toUpperCase()
        if (this.deviceById[id] == null) {
          return { status: 404 } // Not Found
        }
        if (body.expose != null) {
          this.exposeDevice(id, body.expose)
          return { status: 200, body: { expose: body.expose } }
        }
        return { status: 200 }
      }
    }
    return { status: 403 } // Forbidden
  }

  // ===========================================================================

  /** Poll the gateway.
    *
    * Periodically get the gateway full state and call
    * {@link DeconzAccessory.Gateway#analyseFullState()}.<br>
    */
  async poll () {
    if (this.polling || this.values.apiKey == null) {
      return
    }
    try {
      this.polling = true
      this.vdebug('%spolling...', this.pollNext ? 'priority ' : '')
      if (this.context.fullState == null || this.pollFullState) {
        const fullState = await this.client.get('/')
        fullState.groups[0] = await this.client.get('/groups/0')
        this.context.fullState = fullState
        this.pollFullState = false
      } else {
        const config = await this.client.get('/config')
        if (config.bridgeid === this.id && config.UTC == null) {
          this.values.expose = false
          this.values.apiKey = null
          await this.wsClient.close()
          return
        }
        this.context.fullState.config = config
        this.context.fullState.lights = await this.client.get('/lights')
        this.context.fullState.sensors = await this.client.get('/sensors')
        if (this.nDevicesByRtype.groups > 0) {
          this.context.fullState.groups = await this.client.get('/groups')
          this.context.fullState.groups[0] = await this.client.get('/groups/0')
        }
        if (this.nDevicesByRtype.schedules) {
          this.context.fullState.schedules = await this.client.get('/schedules')
        }
      }
      await this.analyseFullState(this.context.fullState)
    } catch (error) {
      this.error(error)
    } finally {
      this.vdebug('polling done')
      this.pollNext = false
      this.polling = false
    }
    if (!this.initialised) {
      this.initialised = true
      this.debug('initialised')
      this.emit('initialised')

      this.setAqaraS1PanelsConfiguration()
    }
  }

  /** Analyse the peristed full state of the gateway,
    * adding, re-configuring, and deleting delegates for corresponding HomeKit
    * accessories and services.
    *
    * The analysis consists of the following steps:
    * 1. Analyse the resources, updating:
    * {@link DeconzAccessory.Gateway#deviceById deviceById},
    * {@link DeconzAccessory.Gateway#deviceByRidByRtype deviceByRidByRtype},
    * {@link DeconzAccessory.Gateway#nDevices nDevices},
    * {@link DeconzAccessory.Gateway#nDevicesByRtype nDevicesByRtype},
    * {@link DeconzAccessory.Gateway#nResources nResources},
    * {@link DeconzAccessory.Gateway#resourceByRpath resourceByRpath}.
    * 2. Analyse (pre-existing) _Device_ accessories, emitting
    * {@link DeconzAccessory.Device#event.polled}, and calling
    * {@link DeconzAccessory.Gateway#deleteAccessory deleteAccessory()} for
    * stale accessories, corresponding to devices that have been deleted from
    * the gateway, blacklisted, or excluded by device primary resource type.
    * 3. Analyse (pre-existing) _Device Settings_ services, calling
    * {@link DeconzAccessory.Gateway#deleteService deleteService()}
    * for stale services, corresponding to devices that have been deleted from
    * the gateway, un-blacklisted, or excluded by device primary resource type.
    * 4. Analysing supported devices with enabled device primary resource types,
    * calling {@link DeconzAccessory.Gateway#addAccessory addAccessory()} and
    * {@link DeconzAccessory.Gateway#deleteService deleteService()} for new
    * _Device_ accessories, corresponding to devices added to the gateway,
    * un-blacklisted, or included by device primary resource type, and calling
    * {@link DeconzAccessory.Gateway#addService addService()} and
    * {@link DeconzAccessory.Gateway#deleteAccessory deleteAccessory()} for
    * accessories, corresponding to devices have been blacklisted.
    * @param {Object} fullState - The gateway full state, as returned by
    * {@link DeconzAccessory.Gateway#poll poll()}.
    * @param {Object} params - Parameters
    * @param {boolean} [params.logUnsupported=false] - Issue debug
    * messsages for unsupported resources.
    * @param {boolean} [params.analyseOnly=false]
    */
  async analyseFullState (fullState, params = {}) {
    /** Supported devices by device ID.
      *
      * Updated by
      * {@link DeconzAccessory.Gateway#analyseFullState analyseFullState()}.
      * @type {Object<string, Deconz.Device>}
      */
    this.deviceById = {}

    /** Supported resources by resource path.
      *
      * Updated by {@link DeconzAccessory.Gateway#analyseFullState analyseFullState()}.
      * @type {Object<string, Deconz.Resource>}
      */
    this.resourceByRpath = {}

    /** Supported devices by resource ID by resource type, of the primary
      * resource for the device.
      *
      * Updated by
      * {@link DeconzAccessory.Gateway#analyseFullState analyseFullState()}.
      * @type {Object<string, Object<string, Deconz.Device>>}
      */
    this.deviceByRidByRtype = {}

    /** Number of supported devices by resource type.
      *
      * Updated by
      * {@link DeconzAccessory.Gateway#analyseFullState analyseFullState()}.
      * @type {Object<string, integer>}
      */
    this.nDevicesByRtype = {}

    this.vdebug('analysing resources...')
    for (const rtype of rtypes) {
      this.deviceByRidByRtype[rtype] = {}
      for (const rid in fullState[rtype]) {
        try {
          const body = fullState[rtype][rid]
          this.analyseResource(rtype, rid, body, params.logUnsupported)
        } catch (error) { this.error(error) }
      }
    }

    /** Number of supported devices.
      *
      * Updated by
      * {@link DeconzAccessory.Gateway#analyseFullState analyseFullState()}.
      * @type {integer}
      */

    this.nDevices = Object.keys(this.deviceById).length

    /** Number of supported resources.
      *
      * Updated by
      * {@link DeconzAccessory.Gateway#analyseFullState analyseFullState()}.
      * @type {integer}
      */
    this.nResources = Object.keys(this.resourceByRpath).length

    this.vdebug('%d devices, %d resources', this.nDevices, this.nResources)
    for (const id in this.deviceById) {
      const device = this.deviceById[id]
      const { rtype, rid } = device.resource
      this.deviceByRidByRtype[rtype][rid] = device
    }
    for (const rtype of rtypes) {
      this.nDevicesByRtype[rtype] =
        Object.keys(this.deviceByRidByRtype[rtype]).length
      this.vdebug('%d %s devices', this.nDevicesByRtype[rtype], rtype)
    }

    if (params.analyseOnly) {
      return
    }

    this.update(fullState.config)

    let changed = false

    this.vdebug('analysing accessories...')
    for (const id in this.accessoryById) {
      try {
        if (
          this.deviceById[id] == null
        ) {
          delete this.context.settingsById[id]
          this.deleteAccessory(id)
          // this.deleteService(id)
          changed = true
        } else {
          /** Emitted when the gateway has been polled.
            * @event DeconzAccessory.Device#polled
            * @param {Deconz.Device} device - The updated device.
            */
          this.accessoryById[id].emit('polled', this.deviceById[id])
        }
      } catch (error) { this.error(error) }
    }

    for (const rtype of rtypes) {
      this.vdebug('analysing %s devices...', rtype)
      const rids = Object.keys(this.deviceByRidByRtype[rtype]).sort()
      for (const rid of rids) {
        try {
          const { id, zigbee } = this.deviceByRidByRtype[rtype][rid]
          if (this.context.settingsById[id] == null) {
            this.context.settingsById[id] = { expose: zigbee }
          }
          if (this.context.settingsById[id].expose) {
            if (this.accessoryById[id] == null) {
              this.addAccessory(id)
              changed = true
            }
          } else {
            if (this.accessoryById[id] != null) {
              this.deleteAccessory(id)
              changed = true
            }
          }
        } catch (error) { this.error(error) }
      }
    }

    this.nAccessories = Object.keys(this.accessoryById).length
    this.nResourcesMonitored = Object.keys(this.accessoryByRpath).length
    this.nExposeErrors = Object.keys(this.exposeErrorById).length
    if (this.nExposeErrors === 0) {
      this.vdebug('%d accessories', this.nAccessories)
    } else {
      this.vdebug(
        '%d accessories, %d expose errors', this.nAccessories, this.nExposeErrors
      )
    }

    if (changed) {
      await this.updateMigration()
      this.identify()
    }
  }

  /** Anayse a gateway resource, updating
    * {@link DeconzAccessory.Gateway#deviceById deviceById} and
    * {@link DeconzAccessory.Gateway#resourceByRpath resourceByRpath} for
    * supported resources.
    *
    * @param {string} rtype - The type of the resource:
    * `groups`, `lights`, or `sensors`.
    * @param {integer} rid - The resource ID of the resource.
    * @param {object} body - The body of the resource.
    * @param {boolean} logUnsupported - Issue a debug message for
    * unsupported resources.
    */
  analyseResource (rtype, rid, body, logUnsupported) {
    const resource = new Deconz.Resource(this, rtype, rid, body)
    const { id, serviceName } = resource
    if (id === this.id || serviceName === '') {
      const debug = (logUnsupported ? this.debug : this.vdebug).bind(this)
      debug(
        '%s: /%s/%d: %s: ignoring unsupported %s type',
        id, rtype, rid, body.type, rtype
      )
      return
    }
    if (serviceName == null) {
      const warn = (logUnsupported ? this.warn : this.vdebug).bind(this)
      warn(
        '%s: /%s/%d: %s: ignoring unknown %s type',
        id, rtype, rid, body.type, rtype
      )
      return
    }
    if (this.deviceById[id] == null) {
      this.deviceById[id] = new Deconz.Device(resource)
      this.vdebug('%s: device', id)
    } else {
      this.deviceById[id].addResource(resource)
    }
    const { rpath } = resource
    this.resourceByRpath[rpath] = resource
    this.vdebug('%s: %s: device resource', id, rpath)
  }
}

module.exports = Gateway
