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

    this.setAqaraS1PanelsConfiguration()
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
setAqaraS1PanelsConfiguration() {
  // this.log(JSON.stringify(this.platform.config))
  const actionsConfigData = this.platform._configJson.actionsConfigData[this.id]
  this.log('actionsConfigData contents: ' + JSON.stringify(actionsConfigData))
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
      this.log('panelsToResources: ' + JSON.stringify(this.platform.panelsToResources))
      this.log('resourcesToPanels: ' + JSON.stringify(this.platform.resourcesToPanels))
    }
  }
  
  // Now, go and set online/offline for all possible devices to know if they're set on the panel, and add/remove them on the reponse.
  if (this.actionsConfigData && Array.isArray(this.actionsConfigData) === false) {
    let aqaraS1Panels = this.actionsConfigData.aqara_S1_panels
    if (aqaraS1Panels) {
      if (!this.context.aqaraS1PanelsConfiguration) {
        this.context.aqaraS1PanelsConfiguration = {}
      }

      let switchsData = {}

      let devicesSerial = ['6c69676874732f01', '6c69676874732f02', '6c69676874732f03', '6c69676874732f04', '6c69676874732f05', '6375727461696e01', '6375727461696e02', '6375727461696e03', '6169725f636f6e64'] // array of devices serial which is configured when setup is done
      let devicesControl = ['light_1', 'light_2' , 'light_3', 'light_4', 'light_5', 'curtain_1', 'curtain_2', 'curtain_3', 'ac'] // array of config names
      // | Temp Sensor | AC Page | Curtain 1 | Curtain 2 | Curtain 3 | Light 1 | Light 2 | Light 3 | Light 4 | Light 5 |
      // | ----------- | ------- | --------- | --------- | --------- | ------- | ------- | ------- | ------- | ------- |
      // | 01-02       | 03-08   | 09-0c     | 0f-12     | 15-18     | 1b-20   | 21-26   | 27-2c   | 2d-32   | 33-38   |
      let slotsRanges = {
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

      var commandsAmount = 5 // Total count the commands for applying delay between the commands. (wait 5 seconds for the first command...)
      var succeededCommands = 0 // To count if all commands per device was performed successfully.
      var commandsFunctionsToExecute = []

      let panels = Object.keys(aqaraS1Panels)
      for (const panel of panels) {
        let panelData = aqaraS1Panels[panel]
        let panelLightID = panel.split('/')[2]
        let panelLightObject = this.context.fullState.lights[panelLightID]
        if (panelLightObject) {
          let panelUniqueId = panelLightObject.uniqueid.split('-')
          let panelSerial = panelUniqueId[0].replace(/:/g, '')

          if (!switchsData[panelSerial]) {
            switchsData[panelSerial] = {}
          }

          if (panelData.switch) {
            switchsData[panelSerial][panelUniqueId[1]] = {text: panelData.switch.name, icon: panelData.switch.icon}
          }

          if (panelUniqueId[1] === '01') {
            switchsData[panelSerial].resourcePath = panel + '/state'

            let parsedData = this.context.aqaraS1PanelsConfiguration[this.id + '_' + panelLightID]

            if (!parsedData) {
              parsedData = {}
              this.context.aqaraS1PanelsConfiguration[this.id + '_' + panelLightID] = parsedData
            }
            if (!parsedData.names) {
              parsedData.names = {}
            }

            for (var i = devicesSerial.length - 1; i >= 0; i--) {
              let deviceSerial = devicesSerial[i]
              let deviceName = devicesControl[i]
              let deviceConfig = panelData[deviceName]
              let slots = slotsRanges[deviceName]

              if (slots) {
                if (deviceConfig) {
                  // TODO: Later compose the command in a more flexible way so all the sizes and integrity will be calculated here and not hardcoded.
                  // TODO: Check that the config haven't changed in a new config (Need to check how this is possible to be done... Maybe try to set CT/Color and see what is the response...)
                  let commandsToExecute = []
                  if (i <= 4) { // Lights
                    // On/Off, general type...
                    commandsToExecute.push('40aa7138468c0201d8024140604f7448' + slots[0].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '04010055260a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '08bfaab9d8d7b4ccac08bfaab9d8d7b4ccac08bfaab9d8d7b4')
                    commandsToExecute.push('13aa710b468c020204ccac0000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '3' + (deviceConfig.type === 'color' ? '2' : '3') + '00')
                    // Brightness
                    commandsToExecute.push('3aaa7134448de0024131604f7448' + slots[1].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '0e010055170a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '0ac1c1b6c8b0d9b7d6b1c8000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0' + (deviceConfig.type === 'color' ? '2' : '4') + '00')
                    // Name
                    commandsToExecute.push('37aa7131448ee202412e604f7448' + slots[4].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa5140a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '08c9e8b1b8c3fbb3c60000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0' + (deviceConfig.type === 'color' ? 'a' : 'b') + '00')
                    // Online/Offline
                    commandsToExecute.push('39aa7133448fdf024130604f7448' + slots[5].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '080007fd160a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '0ac9e8b1b8d4dacfdfc0eb0000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '3' + (deviceConfig.type === 'color' ? 'c' : 'd') + '00')
                    if (deviceConfig.type === 'ct') {
                      // Color Temperature
                      commandsToExecute.push('36aa713044670a02412d604f7448' + slots[2].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '0e020055130a0506c9abcec2d6b5000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0300')
                    } else if (deviceConfig.type === 'color') {
                      // Color
                      commandsToExecute.push('36aa713044234e02412d604f7448' + slots[3].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '0e080055130a0506d1d5c9ab7879000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0100')
                    }
                  } else if (i <= 7) { // curtains
                    // Opening/Closing/Stoping
                    commandsToExecute.push('38aa713244016e02412f604f651f' + slots[0].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '0e020055' + '150a0408b4b0c1b1d7b4ccac000000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) + 5) + '3200')
                    // Position
                    commandsToExecute.push('3caa713644fe6d024133604f651f' + slots[1].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '01010055' + '190a040000010ab4b0c1b1b4f2bfaab0d90000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) + 5) + '0c00')
                    // Online/Offline
                    commandsToExecute.push('39aa713344ff6f024130604f651f' + slots[2].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '080007fd' + '160a040ac9e8b1b8d4dacfdfc0eb0000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) + 5) + '3c00')
                    // Name
                    commandsToExecute.push('37aa713144007002412e604f651f' + slots[3].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa5' + '140a0408c9e8b1b8c3fbb3c60000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) + 5) + '0a00')
                  } else if (i == 8) { // AC
                    // On/Off, general type...
                    commandsToExecute.push((deviceConfig.internal_thermostat ? '38aa713244204f02412f' : '3aaa713444ef7e024131') + '6044f76a' + slots[0].toString(16).padStart(2, '0') + panelSerial + deviceSerial + (deviceConfig.internal_thermostat ? '0e020055' : '0e200055') + (deviceConfig.internal_thermostat ? '150a0608bfd8d6c6d7b4ccac000000000000012e0000' : '1708060abfd5b5f7d1b9cbf5d7b4000000000000012e0000'))
                    // Online/Offline
                    commandsToExecute.push('39aa713344f07e0241306044f76a' + slots[1].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '080007fd' + '1608060ac9e8b1b8d4dacfdfc0eb0000000000012e6400')
                    // Name
                    commandsToExecute.push('37aa713144f17f02412e6044f76a' + slots[2].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa5' + '14080608c9e8b1b8c3fbb3c60000000000012e1300')
                    // Modes
                    commandsToExecute.push('39aa713344f27c0241306044f76a' + slots[3].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa7' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e1000')
                    // Fan Modes
                    commandsToExecute.push('39aa713344f37b0241306044f76a' + slots[4].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa8' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e1100')
                    // Temperatures Ranges
                    commandsToExecute.push('39aa713344f47a0241306044f76a' + slots[5].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa9' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e0100')
                  }
                  if (!parsedData[i] || JSON.stringify(parsedData[i]) !== JSON.stringify(commandsToExecute)) {
                    for (var ii = commandsToExecute.length - 1; ii >= 0; ii--) {
                      // Save a copy/references of the relevant values and separate commands with 1000ms delay...
                      let that = this
                      let cmdToSend = commandsToExecute[ii]
                      let deviceIndex = i
                      let commmands = commandsToExecute
                      let commandIndex = ii
                      function executeCommand(index) {
                        that.log('Going to send: ' + cmdToSend)
                        that.client.put(panel + '/state', {aqara_s1_panel_communication: cmdToSend}).then((obj) => {
                          succeededCommands++
                          that.log('Sent: ' + cmdToSend + ', indexed: ' + commandIndex + ', which is a command of device index: ' + deviceIndex + ', succeeded: ' + succeededCommands + ', commands length: ' + commmands.length)
                          if (succeededCommands === commmands.length) {
                            that.log('Going to write sent commands for deviceIndex: ' + deviceIndex + '.')
                            parsedData[deviceIndex] = commmands
                            parsedData.names[deviceIndex] = deviceConfig.name
                          }
                          if (commandIndex === 0) {
                            succeededCommands = 0
                          }
                          if (index < commandsFunctionsToExecute.length) {
                            commandsFunctionsToExecute[index](index+1)
                          }
                        }).catch((error) => {
                          // TODO: Retry??? Continue to the next command???
                          if (commandIndex === 0) {
                            succeededCommands = 0
                          }
                        })
                      }
                      commandsFunctionsToExecute.push(executeCommand)
                    }
                  } else {
                    // Maybe update the state of controlled device??? No, it should be in sync if server restarted. If device restarted it asks the data by itself.
                    // Update device names if any changes...
                    if (!parsedData.names[i] || parsedData.names[i] !== deviceConfig.name) {
                      // TODO: Convert to function to avoid the double code (here and on listen() function)
                      let name = deviceConfig.name
    
                      const toHexString = bytes =>
                        bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');

                      const getUInt8 = int8Data => 
                        int8Data << 24 >>> 24;
                      
                      let nameSize = name.length
                      let nameHex = toHexString(name.split ('').map (function (c) { return c.charCodeAt (0); }))
    
                      let totalSize = 21 + 1 + nameSize
                      let commandSize = totalSize - 6
                      let paramsSize = commandSize - 3
                      let counter = '6d'
                      let integrity = 512 - (parseInt('aa', 16) + parseInt('71', 16) + commandSize + parseInt('44', 16) + parseInt(counter, 16))
    
                      let dataToSend = totalSize.toString(16).padStart(2, '0') + 'aa71' + commandSize.toString(16).padStart(2, '0') + '44' + counter + getUInt8(integrity).toString(16).padStart(2, '0') + '0541' + paramsSize.toString(16).padStart(2, '0') + deviceSerial + '08001fa5' + nameSize.toString(16).padStart(2, '0') + nameHex
                      this.log('Name data: ' + dataToSend)

                      // Save a copy/references of the relevant values and separate commands with 1000ms delay...
                      let that = this
                      let deviceIndex = i
                      function executeCommand(index) {
                        that.log('Going to send: ' + dataToSend)
                        that.client.put(panel + '/state', {aqara_s1_panel_communication: dataToSend}).then((obj) => {
                          parsedData.names[deviceIndex] = name
                          if (index < commandsFunctionsToExecute.length) {
                            commandsFunctionsToExecute[index](index+1)
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
                    for (var ii = slots.length - 1; ii >= 0; ii--) {
                      // separate commands with 1000ms delay...
                      let that = this
                      let cmdToSend = '22aa711c4498ed0441196044f0ed' + slots[ii].toString(16).padStart(2, '0') + panelSerial + '000000000000000000000000'
                      let deviceIndex = i
                      function executeCommand(index) {
                        that.log('Going to send: ' + cmdToSend)
                        that.client.put(panel + '/state', {aqara_s1_panel_communication: cmdToSend}).then((obj) => {
                          if (parsedData[deviceIndex]) {
                            delete parsedData[deviceIndex]
                          }
                          if (index < commandsFunctionsToExecute.length) {
                            commandsFunctionsToExecute[index](index+1)
                          }
                        }).catch((error) => {
                          // TODO: Retry??? Continue to the next command???
                        })
                      }
                      commandsFunctionsToExecute.push(executeCommand)
                    }
                  }
                }
              }



              // // TODO: now set all as Online, but later make sure to mark offline devices if they're offline...
              // // separate commands with 500ms delay...
              // let that = this
              // commandsAmount ++
              // setTimeout(function() {
              //   let cmdToSend = '19aa7113446d21054110' + deviceSerial + '080007fd' + '0000000' + (panelData[devicesControl[i]] ? '1' : '0')
              //   console.log(cmdToSend)
              //   that.client.put(panel + '/state', {aqara_s1_panel_communication: cmdToSend}).then((obj) => {
                  
              //   }).catch((error) => {
                  
              //   })
              // }, 500 * commandsAmount)
            }
          }
        }
      }

      let switchesPanels = Object.keys(switchsData)
      for (const switches of switchesPanels) {
        let switchesDataObject = switchsData[switches]
        if (switchesDataObject['01'] && switchesDataObject.resourcePath) {
          let panelLightID = switchesDataObject.resourcePath.split('/')[2]
          let panelLightObject = this.context.fullState.lights[panelLightID]
          var object = {}
          var anyUpdate = false

          if (panelLightObject.state.aqara_s1_switch1_icon !== switchesDataObject['01'].icon) {
            object.aqara_s1_switch1_icon = switchesDataObject['01'].icon
            anyUpdate = true
          }
          if (panelLightObject.state.aqara_s1_switch1_text !== switchesDataObject['01'].text) {
            object.aqara_s1_switch1_text = switchesDataObject['01'].text
            anyUpdate = true
          }
          if (switchesDataObject['02']) {
            if (panelLightObject.state.aqara_s1_switch2_icon !== switchesDataObject['02'].icon) {
              object.aqara_s1_switch2_icon = switchesDataObject['02'].icon
              anyUpdate = true
            }
            if (panelLightObject.state.aqara_s1_switch2_text !== switchesDataObject['02'].text) {
              object.aqara_s1_switch2_text = switchesDataObject['02'].text
              anyUpdate = true
            }
          }
          if (switchesDataObject['03']) {
            if (panelLightObject.state.aqara_s1_switch3_icon !== switchesDataObject['03'].icon) {
              object.aqara_s1_switch3_icon = switchesDataObject['03'].icon
              anyUpdate = true
            }
            if (panelLightObject.state.aqara_s1_switch3_text !== switchesDataObject['03'].text) {
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
          if (panelLightObject.state.aqara_s1_switches_config !== switchesConfiguration) {
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
                  commandsFunctionsToExecute[index](index+1)
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
    }
  }

  // TODO: update switches state (on/off) on the state restore of the light (file loading of the state).
}

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

          // if (rtype === 'lights' && (rid === '14' || rid === '34')) {
            // console.log(JSON.stringify(body.state))
          // }
          if (rtype === 'sensors' && body.state !== undefined && body.state.buttonevent !== undefined && this.actionsConfigData && this.actionsConfigData[rid] && this.actionsConfigData[rid].length && this.platform.platformAccessory.service.values.switchesOn) {
            var actionsConfig = this.actionsConfigData[rid];
            var sensorTypeInt = actionsConfig[0];
            this.log('sensor: %s, event data: %s, config: %s', rid, JSON.stringify(body.state), JSON.stringify(actionsConfig));
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
              var keyForTimeoutAction = rid + i;
              clearTimeout(longPressTimeoutIDs[keyForTimeoutAction]);
              
              var actionConfig = actionsConfig[i];

              if (body.state.buttonevent === 2001 || body.state.buttonevent === 3001 || body.state.buttonevent === 4001 || body.state.buttonevent === 5001) {
                if (actionConfig.resourcePath && actionConfig.resourcePath.startsWith("/")) {
                  var pathComponents = actionConfig.resourcePath.split( '/' );
                  let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
                  if (accessoryToControl) {
                    var repeatZBFunction = function(delay, timeoutKey) {
                      longPressTimeoutIDs[timeoutKey] = setTimeout(function() {
                        console.log('Long press being on ZigBee service!!!');
                        var continueRepeat = true;
                        if (sensorTypeInt == 1) {
                          continueRepeat = false;
                        }
                        var service = accessoryToControl.service._service;
                        if (body.state.buttonevent === 2001 && service.testCharacteristic(this.platform.Characteristics.hap.Brightness)) {
                          if (!service.getCharacteristic(this.platform.Characteristics.hap.On).value) {
                            service.getCharacteristic(this.platform.Characteristics.hap.Brightness).setValue(1);
                            service.getCharacteristic(this.platform.Characteristics.hap.On).setValue(true);
                          } else {
                            var characteristic = service.getCharacteristic(this.platform.Characteristics.hap.Brightness);
                            var newBrightnessState = Math.min(100, characteristic.value + 5);
                            characteristic.setValue(newBrightnessState);
                            if (newBrightnessState === 100) {
                              continueRepeat = false;
                            }
                          }
                        } else if (body.state.buttonevent === 3001 && service.testCharacteristic(this.platform.Characteristics.hap.Brightness)) {
                          var characteristic = service.getCharacteristic(this.platform.Characteristics.hap.Brightness);
                          var newBrightnessState = Math.max(1, characteristic.value - 5);
                          characteristic.setValue(newBrightnessState);
                          if (newBrightnessState === 1) {
                            continueRepeat = false;
                          }
                        } else if (sensorTypeInt == 0 && body.state.buttonevent === 4001 && service.testCharacteristic(this.platform.Characteristics.hap.ColorTemperature)) {
                          var characteristic = service.getCharacteristic(this.platform.Characteristics.hap.ColorTemperature);
                          var newColorTemperatureState = Math.max(153, characteristic.value - 32);
                          characteristic.setValue(newColorTemperatureState);
                          if (newColorTemperatureState === 153) { // TODO: take the min/max from the object itself...
                            continueRepeat = false;
                          }
                        } else if (sensorTypeInt == 0 && body.state.buttonevent === 5001 && service.testCharacteristic(this.platform.Characteristics.hap.ColorTemperature)) {
                          var characteristic = service.getCharacteristic(this.platform.Characteristics.hap.ColorTemperature);
                          var newColorTemperatureState = Math.min(500, characteristic.value + 32);
                          characteristic.setValue(newColorTemperatureState);
                          if (newColorTemperatureState === 500) {
                            continueRepeat = false;
                          }
                        } else {
                          continueRepeat = false;
                        }
                        if (continueRepeat) {
                          repeatZBFunction(300, timeoutKey);
                        }
                      }, delay);
                    }
                    repeatZBFunction(0, keyForTimeoutAction);
                  }
                } else {
                  var actionToDo = actionConfig[body.state.buttonevent];//[accessory.lastActions[body.state.buttonevent]];
                  if (/*this.platform.state.remotes_on && */actionToDo) {
                    var jsonObject = JSON.parse(JSON.stringify(actionConfig.json));
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

                    var repeatFunction = function(delay, timeoutKey) {
                      longPressTimeoutIDs[timeoutKey] = setTimeout(function() {
                        console.log('Long press being on URL!!!');

                        const req = http.request(options, res => {
                          console.log(`statusCode: ${res.statusCode}`)
                        
                          if (res.statusCode == 200) {
                            console.log('Command sent and received successfully')
                          }

                          res.on('data', d => {
                            // process.stdout.write(d)
                            console.log(d)
                          })
                        })
                        
                        req.on('error', error => {
                          console.error(error)
                        })
                        
                        req.write(data)
                        req.end()
                        
                        repeatFunction(300, timeoutKey);
                      }, delay);
                    }
                    repeatFunction(0, keyForTimeoutAction);
                  }
                }
              } else if (body.state.buttonevent === 1000 || body.state.buttonevent === 1001 || body.state.buttonevent === 1002 || body.state.buttonevent === 2000 || body.state.buttonevent === 2002 || body.state.buttonevent === 3000 || body.state.buttonevent === 3002 || body.state.buttonevent === 4000 || body.state.buttonevent === 4002 || body.state.buttonevent === 5002) {
                if (actionConfig.resourcePath && actionConfig.resourcePath.startsWith("/")) {
                  var pathComponents = actionConfig.resourcePath.split( '/' )
                  let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
                  if (accessoryToControl) {
                    var service = accessoryToControl.service._service;
                    if (body.state.buttonevent === 1001) {
                      service.getCharacteristic(this.platform.Characteristics.hap.On).setValue(true);
                      service.getCharacteristic(this.platform.Characteristics.hap.Brightness).setValue(100);
                      service.getCharacteristic(this.platform.Characteristics.hap.ColorTemperature).setValue(363); // TODO: use a config file to know the right default...
                    } else if (sensorTypeInt == 0 && body.state.buttonevent === 1002) {
                      var characteristic = service.getCharacteristic(this.platform.Characteristics.hap.On);
                      var newPowerState = !characteristic.value;
                      characteristic.setValue(newPowerState > 0);
                      if (newPowerState && service.testCharacteristic(this.platform.Characteristics.hap.Brightness)) {
                          characteristic = service.getCharacteristic(this.platform.Characteristics.hap.Brightness);
                          if (characteristic.value !== 100) {
                              characteristic.setValue(100);
                          }
                      }
                    } else if (sensorTypeInt == 1 && body.state.buttonevent === 1000) {
                      var characteristic = service.getCharacteristic(this.platform.Characteristics.hap.On);
                      var originalValue = characteristic.value;
                      characteristic.setValue(1);
                      if (originalValue && service.testCharacteristic(this.platform.Characteristics.hap.Brightness)) {
                        characteristic = service.getCharacteristic(this.platform.Characteristics.hap.Brightness);
                        if (characteristic.value !== 100) {
                          characteristic.setValue(100);
                        }
                      }
                    } else if (((sensorTypeInt == 0 && body.state.buttonevent === 2002) || (sensorTypeInt == 1 && body.state.buttonevent === 2000)) && service.testCharacteristic(Characteristic.Brightness)) {
                      if (!service.getCharacteristic(this.platform.Characteristics.hap.Characteristic.On).value) {
                        service.getCharacteristic(this.platform.Characteristics.hap.Characteristic.Brightness).setValue(1);
                        service.getCharacteristic(this.platform.Characteristics.hap.Characteristic.On).setValue(true);
                      } else {
                        var characteristic = service.getCharacteristic(this.platform.Characteristics.hap.Brightness);
                        var newBrightnessState = Math.min(100, characteristic.value + 5);
                        characteristic.setValue(newBrightnessState);
                      }
                    } else if (((sensorTypeInt == 0 && body.state.buttonevent === 3002) || (sensorTypeInt == 1 && body.state.buttonevent === 3000)) && service.testCharacteristic(Characteristic.Brightness)) {
                      var characteristic = service.getCharacteristic(this.platform.Characteristics.hap.Brightness);
                      var newBrightnessState = Math.max(1, characteristic.value - 5);
                      characteristic.setValue(newBrightnessState);
                    } else if (sensorTypeInt == 0 && body.state.buttonevent === 4002 && service.testCharacteristic(this.platform.Characteristics.hap.ColorTemperature)) {
                      var characteristic = service.getCharacteristic(this.platform.Characteristics.hap.ColorTemperature);
                      var newColorTemperatureState = Math.max(153, characteristic.value - 32);
                      characteristic.setValue(newColorTemperatureState);
                    } else if (sensorTypeInt == 0 && body.state.buttonevent === 5002 && service.testCharacteristic(this.platform.Characteristics.hap.ColorTemperature)) {
                      var characteristic = service.getCharacteristic(this.platform.Characteristics.hap.ColorTemperature);
                      var newColorTemperatureState = Math.min(500, characteristic.value + 32);
                      characteristic.setValue(newColorTemperatureState);
                    } else if (sensorTypeInt == 1 && body.state.buttonevent === 4000) {
                      var characteristic = service.getCharacteristic(this.platform.Characteristics.hap.On);
                      characteristic.setValue(false);
                    }
                  }
                } else {
                  var actionToDo = actionConfig[body.state.buttonevent];//[accessory.lastActions[body.state.buttonevent]];
                  if (/*this.platform.state.remotes_on && */actionToDo) {
                    var jsonObject = JSON.parse(JSON.stringify(actionConfig.json)); // Object.assign({}, actionConfig.json);
                    // if (accessory.lastActions[body.state.buttonevent] === actionConfig[body.state.buttonevent].length - 1) {
                    //     accessory.lastActions[body.state.buttonevent] = 0;
                    // } else {
                    //     accessory.lastActions[body.state.buttonevent] ++;
                    // }
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

                    const req = http.request(options, res => {
                      console.log(`statusCode: ${res.statusCode}`)
                    
                      if (res.statusCode == 200) {
                        console.log('Command sent and received successfully')
                      }

                      res.on('data', d => {
                        // process.stdout.write(d)
                        console.log(d)
                      })
                    })
                    
                    req.on('error', error => {
                      console.error(error)
                    })
                    
                    req.write(data)
                    req.end()
                  }
                }
              } else if (body.state.buttonevent === 2003 || body.state.buttonevent === 3003 || body.state.buttonevent === 4003 || body.state.buttonevent === 5003) {
                // if (accessory.lastActions[body.state.buttonevent - 2] === actionConfig[body.state.buttonevent - 2].length - 1) {
                //     accessory.lastActions[body.state.buttonevent - 2] = 0;
                // } else {
                //     accessory.lastActions[body.state.buttonevent - 2] ++;
                // }
              }
            }
          } else if (rtype === 'lights' && this.context.fullState.lights[rid] && this.context.fullState[rtype][rid].modelid === "lumi.switch.n4acn4") {
            if (body.state !== undefined && body.state['aqara_s1_panel_communication'] !== undefined && body.state['aqara_s1_panel_communication'] !== this.context.fullState.lights[rid].state.aqara_s1_panel_communication) {
              this.log('aqara panel sent data %s', body)
              let updateData = body.state['aqara_s1_panel_communication']
              this.context.fullState.lights[rid].state.aqara_s1_panel_communication = updateData
              this.log('Received data from aqara S1 Panel: ' + rpath + ', data: ' + updateData)
  
              const fromHexString = hexString =>
                new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
  
              const toHexString = bytes =>
                bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');
              
              let dataArray = fromHexString(updateData)
              if (dataArray[0] === 0xf2 && dataArray[1] === 0xff && dataArray[2] === 0x41) { // Only commands which the device sent will be proccessed, commands without this begining is just what we sent from here, thus not relevant. (the API push it to our socket automatically since it set to the device state object)
    
                const getInt8 = uint8Data => 
                  uint8Data << 24 >> 24;
    
                const getUInt8 = int8Data => 
                  int8Data << 24 >>> 24;
                
                let sum = dataArray[4] + dataArray[5] + dataArray[6] + dataArray[7] + dataArray[8] + getInt8(dataArray[9])
    
                this.debug('Data array: ' + dataArray + ', Integrity: ' + dataArray[9] + ', Signed integrity: ' + getInt8(dataArray[9]) + ', Sum: ' + sum)
    
                if (sum === 512) {
                  let commandCategory = dataArray[5] // (71 to device, 72 from device and 73 is for all scenes transactions [config and usage])
                  let commandType = dataArray[7] // 84=Attribute report of states, 24=ACK for state commands, 44 commands for device (shouldn't happen here), 46=multi-part commands for device (also shouldn't happen here)
                  let commandAction = dataArray[10] // 1=state report/scenes config, 2=configs, 3=scenes activation, 4=removals, 5=set state/states ACKs, 6=state request
                  let paramsSize = dataArray[12]
                  let deviceSerial = commandType === 0x24 ? [dataArray[14], dataArray[15], dataArray[16], dataArray[17], dataArray[18], dataArray[19], dataArray[20], dataArray[21]] : [dataArray[13], dataArray[14], dataArray[15], dataArray[16], dataArray[17], dataArray[18], dataArray[19], dataArray[20]]
                  let stateParam = commandType === 0x24 ? [] : [dataArray[21], dataArray[22], dataArray[23], dataArray[24]]
      
                  this.debug('commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16) + ', deviceSerial: ' + deviceSerial + ', stateParam: ' + stateParam)
    
                  var deviceResourceType = undefined
                  if (deviceSerial[0] === 0x6c && deviceSerial[1] === 0x69 && deviceSerial[2] === 0x67 && deviceSerial[3] === 0x68 && deviceSerial[4] === 0x74 && deviceSerial[5] === 0x73 && deviceSerial[6] === 0x2f) {
                    deviceResourceType = 'lights/'
                  } else if (deviceSerial[0] === 0x63 && deviceSerial[1] === 0x75 && deviceSerial[2] === 0x72 && deviceSerial[3] === 0x74 && deviceSerial[4] === 0x61 && deviceSerial[5] === 0x69 && deviceSerial[6] === 0x6e) {
                    deviceResourceType = 'curtain'
                  } else if (deviceSerial[0] === 0x61 && deviceSerial[1] === 0x69 && deviceSerial[2] === 0x72 && deviceSerial[3] === 0x5f && deviceSerial[4] === 0x63 && deviceSerial[5] === 0x6f && deviceSerial[6] === 0x6e && deviceSerial[7] === 0x64) {
                    deviceResourceType = 'air_cond'
                  }
  
                  if (deviceResourceType) {
                    if (commandCategory === 0x72 && commandType === 0x84 && commandAction === 0x01 && this.platform.platformAccessory.service.values.switchesOn) { // State of device is reported.
                      if (deviceResourceType === 'air_cond' && stateParam[0] === 0x0e && stateParam[2] === 0x00 && stateParam[3] === 0x55 && (stateParam[1] === 0x20 || stateParam[1] === 0x02)) { // Updated Air conditioner/Heater-Cooler device state
                        let onOff = dataArray[25] >= 0x10
                        let mode = dataArray[25] - (onOff ? 0x10 : 0x0)
                        let fan = parseInt(dataArray[26].toString(16).padStart(2, '0').slice(0 , 1), 16)
                        let setTemperature = dataArray[27]
                        this.log('On/Off: ' + onOff + ', Mode: ' + mode + ', Fan: ' + fan + ', Set Temperature: ' + setTemperature)
  
                        let resources = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/ac']
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
                      } else if (deviceResourceType === 'curtain' && stateParam[0] === 0x01 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Position
                        // const positionCoverion = {'0000': 0, '3f80': 1, '4000': 2, '4040': 3, '4080': 4, '40a0': 5, '40c0': 6, '40e0': 7, '4100': 8, '4110': 9, '4120': 10,'4130': 11,'4140': 12,'4150': 13,'4160': 14,'4170': 15,'4180': 16,'4188': 17,'4190': 18,'4198': 19,'41a0': 20,'41a8': 21,'41b0': 22,'41b8': 23,'41c0': 24,'41c8': 25,'41d0': 26,'41d8': 27,'41e0': 28,'41e8': 29,'41f0': 30,'41f8': 31,'4200': 32,'4204': 33,'4208': 34,'420c': 35,'4210': 36,'4214': 37,'4218': 38,'421c': 39,'4220': 40,'4224': 41,'4228': 42,'422c': 43,'4230': 44,'4234': 45,'4238': 46,'423c': 47,'4240': 48,'4244': 49,'4248': 50,'424c': 51,'4250': 52,'4254': 53,'4258': 54,'425c': 55,'4260': 56,'4264': 57,'4268': 58,'426c': 59,'4270': 60,'4274': 61,'4278': 62,'427c': 63,'4280': 64,'4282': 65,'4284': 66,'4286': 67,'4288': 68,'428a': 69,'428c': 70,'428e': 71,'4290': 72,'4292': 73,'4294': 74,'4296': 75,'4298': 76,'429a': 77,'429c': 78,'429e': 79,'42a0': 80,'42a2': 81,'42a4': 82,'42a6': 83,'42a8': 84,'42aa': 85,'42ac': 86,'42ae': 87,'42b0': 88,'42b2': 89,'42b4': 90,'42b6': 91,'42b8': 92,'42ba': 93,'42bc': 94,'42be': 95,'42c0': 96,'42c2': 97,'42c4': 98,'42c6': 99,'42c8': 100}
                        let position = this.getAqaraIntFromHex(( ( (dataArray[25] & 0xFF) << 8) | (dataArray[26] & 0xFF) )) // positionCoverion[dataArray[25].toString(16).padStart(2, '0') + dataArray[26].toString(16).padStart(2, '0')]
                        this.log('Position: ' + position)
                        
                        let resources = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/curtain_' + deviceSerial[7]]
                        for (var i = resources.length - 1; i >= 0; i--) {
                          let resourceItem = resources[i];
                          let pathComponents = resourceItem.split( '/' )
                          let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
    
                          if (accessoryToControl && accessoryToControl.service._service.testCharacteristic(this.platform.Characteristics.hap.TargetPosition)) {
                            accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.TargetPosition).setValue(position)
                          }
                        }
                      } else if (deviceResourceType === 'curtain' && stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Position State
                        let positionState = dataArray[28]
                        this.log('Position State: ' + positionState)
                        
                        let resources = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/curtain_' + deviceSerial[7]]
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
                      } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x04 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light On/Off
                        let onOff = dataArray[28] === 0x01
                        this.log('On/Off: ' + onOff)
                        
                        let resources = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/light_' + deviceSerial[7]]
                        for (var i = resources.length - 1; i >= 0; i--) {
                          let resourceItem = resources[i];
                          let pathComponents = resourceItem.split( '/' )
                          let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
    
                          if (accessoryToControl) {
                            accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.On).setValue(onOff)
                            // accessoryToControl.service.values.on = onOff
                          }
                        }
                      } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Brightness
                        let brightness = dataArray[28]
                        this.log('Brightness: ' + brightness)
                        
                        let resources = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/light_' + deviceSerial[7]]
                        for (var i = resources.length - 1; i >= 0; i--) {
                          let resourceItem = resources[i];
                          let pathComponents = resourceItem.split( '/' )
                          let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
    
                          if (accessoryToControl) {
                            accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.Brightness).setValue(brightness)
                          }
                        }
                      } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light CT
                        let colorTemperature = parseInt(dataArray[27].toString(16).padStart(2, '0') + dataArray[28].toString(16).padStart(2, '0'), 16)
                        this.log('Color Temperature: ' + colorTemperature)
                        
                        let resources = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/light_' + deviceSerial[7]]
                        for (var i = resources.length - 1; i >= 0; i--) {
                          let resourceItem = resources[i];
                          let pathComponents = resourceItem.split( '/' )
                          let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
    
                          if (accessoryToControl) {
                            accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.ColorTemperature).setValue(colorTemperature)
                          }
                        }
                      } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x08 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Color
                        let colorX = parseInt(dataArray[25].toString(16).padStart(2, '0') + dataArray[26].toString(16).padStart(2, '0'), 16)
                        let colorY = parseInt(dataArray[27].toString(16).padStart(2, '0') + dataArray[28].toString(16).padStart(2, '0'), 16)
                        this.log('Color X: ' + colorX + ', Color Y: ' + colorY)
    
                        let resources = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/light_' + deviceSerial[7]]
                        for (var i = resources.length - 1; i >= 0; i--) {
                          let resourceItem = resources[i];
                          let pathComponents = resourceItem.split( '/' )
                          let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
    
                          if (accessoryToControl) {
                            const { h, s } = Colour.xyToHsv([colorX / 65535.0, colorY / 65535.0], accessoryToControl.service.capabilities.gamut)
                                
                            accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.Hue).setValue(h)
                            accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.Saturation).setValue(s)
                          }
                        }
                      }
                    } else if (commandCategory === 0x71 && commandType === 0x84 && commandAction === 0x06) {
                      this.debug('Asked data for param: ' + stateParam)
                      if (deviceResourceType === 'air_cond' && stateParam[0] === 0x0e && stateParam[2] === 0x00 && stateParam[3] === 0x55 && (stateParam[1] === 0x20 || stateParam[1] === 0x02)) { // Updated Air conditioner/Heater-Cooler device state
                        let panelDevicePath = '/' + this.id + '/' + rtype + '/' + rid + '/ac'
                        let pathComponents = this.platform.panelsToResources[panelDevicePath][0].split('/')
                        let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
      
                        if (accessoryToControl) {
                          accessoryToControl.service.updatePanel(panelDevicePath.split('/'))
                        }
                      } else if (deviceResourceType === 'curtain' && stateParam[0] === 0x01 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Position
                        let pathComponents = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/curtain_' + deviceSerial[7]][0].split( '/' )
                        let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
      
                        if (accessoryToControl && accessoryToControl.service.testCharacteristic(this.platform.Characteristics.hap.TargetPosition)) {
                          let hkPosition = accessoryToControl.service.getCharacteristic(this.platform.Characteristics.hap.TargetPosition).value
                          // const positionToAqaraHex = {0: '0000', 1: '3f80', 2: '4000', 3: '4040', 4: '4080', 5: '40a0', 6: '40c0', 7: '40e0', 8: '4100', 9: '4110', 10: '4120', 11: '4130', 12: '4140', 13: '4150', 14: '4160', 15: '4170', 16: '4180', 17: '4188', 18: '4190', 19: '4198', 20: '41a0', 21: '41a8', 22: '41b0', 23: '41b8', 24: '41c0', 25: '41c8', 26: '41d0', 27: '41d8', 28: '41e0', 29: '41e8', 30: '41f0', 31: '41f8', 32: '4200', 33: '4204', 34: '4208', 35: '420c', 36: '4210', 37: '4214', 38: '4218', 39: '421c', 40: '4220', 41: '4224', 42: '4228', 43: '422c', 44: '4230', 45: '4234', 46: '4238', 47: '423c', 48: '4240', 49: '4244', 50: '4248', 51: '424c', 52: '4250', 53: '4254', 54: '4258', 55: '425c', 56: '4260', 57: '4264', 58: '4268', 59: '426c', 60: '4270', 61: '4274', 62: '4278', 63: '427c', 64: '4280', 65: '4282', 66: '4284', 67: '4286', 68: '4288', 69: '428a', 70: '428c', 71: '428e', 72: '4290', 73: '4292', 74: '4294', 75: '4296', 76: '4298', 77: '429a', 78: '429c', 79: '429e', 80: '42a0', 81: '42a2', 82: '42a4', 83: '42a6', 84: '42a8', 85: '42aa', 86: '42ac', 87: '42ae', 88: '42b0', 89: '42b2', 90: '42b4', 91: '42b6', 92: '42b8', 93: '42ba', 94: '42bc', 95: '42be', 96: '42c0', 97: '42c2', 98: '42c4', 99: '42c6', 100: '42c8'}
                          let position = this.getAqaraHexFromInt(hkPosition).toString(16).padStart(4, '0') // positionToAqaraHex[hkPosition]
                          this.log.info('HK Position: ' + hkPosition + ', Aqara Position: ' + position)
                          
                          this.client.put(rpath + '/state', {aqara_s1_panel_communication: '19aa7113446d210541106375727461696e' + deviceSerial[7].toString(16).padStart(2, '0') + '01010055' + position + '0000'}).then((obj) => {
                
                          }).catch((error) => {
                            
                          })
                        }
                      } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x04 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light On/Off
                        let pathComponents = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/light_' + deviceSerial[7]][0].split( '/' )
                        let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
      
                        if (accessoryToControl) {
                          let onOff = accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.On).value
                          this.log('On/Off: ' + onOff)
                          
                          this.client.put(rpath + '/state', {aqara_s1_panel_communication: '19aa7113446d210541106c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0') + '04010055' + '0000000' + (onOff ? '1' : '0')}).then((obj) => {
                
                          }).catch((error) => {
                            
                          })
                        }
                      } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Brightness
                        let pathComponents = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/light_' + deviceSerial[7]][0].split( '/' )
                        let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
      
                        if (accessoryToControl) {
                          let brightness = accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.Brightness).value
                          this.log('Brightness: ' + brightness)
                          
                          this.client.put(rpath + '/state', {aqara_s1_panel_communication: '19aa7113446d210541106c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0') + '0e010055' + '000000' + brightness.toString(16).padStart(2, '0')}).then((obj) => {
                
                          }).catch((error) => {
                            
                          })
                        }
                      } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light CT
                        let pathComponents = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/light_' + deviceSerial[7]][0].split( '/' )
                        let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
      
                        if (accessoryToControl) {
                          let colorTemperature = accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.ColorTemperature).value
                          this.log('Color Temperature: ' + colorTemperature)
                          
                          this.client.put(rpath + '/state', {aqara_s1_panel_communication: '19aa7113446d210541106c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0') + '0e020055' + '0000' + colorTemperature.toString(16).padStart(4, '0')}).then((obj) => {
                
                          }).catch((error) => {
                            
                          })
                        }
                      } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x08 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Color
                        let pathComponents = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/light_' + deviceSerial[7]][0].split( '/' )
                        let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
      
                        if (accessoryToControl) {
                          let hue = accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.Hue).value
                          let sat = accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.Saturation).value
                          this.log('Color Hue: ' + hue + ', Color Saturation: ' + sat)
        
                          const xy = Colour.hsvToXy(hue, sat, accessoryToControl.service.capabilities.gamut)
                          this.log('Color X: ' + xy[0] + ', Color Y: ' + xy[1])
                          
                          this.client.put(rpath + '/state', {aqara_s1_panel_communication: '19aa7113446d210541106c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0') + '0e080055' + Math.round(xy[0] * 65535).toString(16).padStart(4, '0') + Math.round(xy[1] * 65535).toString(16).padStart(4, '0')}).then((obj) => {
                
                          }).catch((error) => {
                            
                          })
                        }
                      } else if (stateParam[0] === 0x08 && stateParam[1] === 0x00 && stateParam[2] === 0x1f && stateParam[3] === 0xa5 && this.actionsConfigData.aqara_S1_panels['/' + rtype + '/' + rid]) { // Names
                        // console.log(this.actionsConfigData.aqara_S1_panels['/' + rtype + '/' + rid])
                        // console.log(deviceResourceType === 'lights/' ? 'light_' + deviceSerial[7] : deviceResourceType === 'curtain' ? 'curtain_' + deviceSerial[7] : 'ac')
                        let name = this.actionsConfigData.aqara_S1_panels['/' + rtype + '/' + rid][deviceResourceType === 'lights/' ? 'light_' + deviceSerial[7] : deviceResourceType === 'curtain' ? 'curtain_' + deviceSerial[7] : 'ac'].name
      
                        let nameSize = name.length
                        let nameHex = toHexString(name.split ('').map (function (c) { return c.charCodeAt (0); }))
      
                        let totalSize = 21 + 1 + nameSize
                        let commandSize = totalSize - 6
                        let paramsSize = commandSize - 3
                        let counter = '6d'
                        let integrity = 512 - (parseInt('aa', 16) + parseInt('71', 16) + commandSize + parseInt('44', 16) + parseInt(counter, 16))
      
                        let dataToSend = totalSize.toString(16).padStart(2, '0') + 'aa71' + commandSize.toString(16).padStart(2, '0') + '44' + counter + getUInt8(integrity).toString(16).padStart(2, '0') + '0541' + paramsSize.toString(16).padStart(2, '0') + (deviceResourceType === 'lights/' ? ('6c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0')) : deviceResourceType === 'curtain' ? ('6375727461696e' + deviceSerial[7].toString(16).padStart(2, '0')) : '6169725f636f6e64') + '08001fa5' + nameSize.toString(16).padStart(2, '0') + nameHex
                        this.log('Name data: ' + dataToSend)
                        this.client.put(rpath + '/state', {aqara_s1_panel_communication: dataToSend}).then((obj) => {
              
                        }).catch((error) => {
                          
                        })
                      } else if (stateParam[0] === 0x08 && stateParam[1] === 0x00 && stateParam[2] === 0x07 && stateParam[3] === 0xfd) { // Online/Offline
                        // TODO: set the state, on groups always online, on others, use the device.reachable state.
                        this.client.put(rpath + '/state', {aqara_s1_panel_communication: '19aa7113446d21054110' + (deviceResourceType === 'lights/' ? ('6c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0')) : deviceResourceType === 'curtain' ? ('6375727461696e' + deviceSerial[7].toString(16).padStart(2, '0')) : '6169725f636f6e64') + '080007fd' + '00000001'}).then((obj) => {
              
                        }).catch((error) => {
                          
                        })
                      }
                    } else if (commandCategory === 0x71 && commandType === 0x24 && commandAction === 0x05) { // ACKs for state commmands
                      if (dataArray[13] === 0x01) { // A device is missing...
                        
                      } else if (dataArray[13] === 0x00 && (!this.actionsConfigData.aqara_S1_panels['/' + rtype + '/' + rid] || (deviceResourceType === 'lights/' && !this.actionsConfigData.aqara_S1_panels['/' + rtype + '/' + rid]['light_' + deviceSerial[7]]) || (deviceResourceType === 'curtain' && !this.actionsConfigData.aqara_S1_panels['/' + rtype + '/' + rid]['curtain_' + deviceSerial[7]]) || (deviceResourceType === 'air_cond' && !this.actionsConfigData.aqara_S1_panels['/' + rtype + '/' + rid]['ac']))) { // A device is set on the device, but shouldn't be there (removed from config...)
  
                      }
                    }
                  }
                }
              }
            } else if (body.state !== undefined && body.state['on'] !== undefined && body.state['on'] !== this.context.fullState.lights[rid].state.on) {
              this.debug('Received on/off switch state aqara S1 Panel:' + rpath + ', state: ' + body.state['on'])
              this.context.fullState.lights[rid].state.on = body.state['on']
              if (this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/switch'] !== undefined && this.platform.platformAccessory.service.values.switchesOn) {
                let resources = this.platform.panelsToResources['/' + this.id + '/' + rtype + '/' + rid + '/switch']
                for (var i = resources.length - 1; i >= 0; i--) {
                  let resourceItem = resources[i];
                  let pathComponents = resourceItem.split( '/' )
                  let accessoryToControl = this.platform.gatewayMap[pathComponents[1]].accessoryByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
      
                  if (accessoryToControl) {
                    accessoryToControl.service._service.getCharacteristic(this.platform.Characteristics.hap.On).setValue(body.state['on'])
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
        if (this.context.migration != null) {
          await this.client.delete(this.context.migration)
        }
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
      this.context.migration = null
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
      if (this.context.migration == null) {
        const response = await this.client.post('/resourcelinks', {
          name: 'homebridge-deconz',
          description: 'migration',
          classid: 1,
          links: Object.keys(this.accessoryByRpath).sort()
        })
        this.context.migration = '/resourcelinks/' + response.success.id
      } else {
        await this.client.put(this.context.migration, {
          links: Object.keys(this.accessoryByRpath).sort()
        })
      }
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
