// homebridge-deconz/lib/DeconzAccessory/Platform.js
// Copyright© 2022-2023 Arye Levin. All rights reserved.
//
// Homebridge plugin for deCONZ.

import { AccessoryDelegate } from 'homebridge-lib/AccessoryDelegate'
import { DeconzAccessory } from '../DeconzAccessory/index.js'
import { DeconzService } from '../DeconzService/index.js'
import '../DeconzService/Platform.js'
import * as http from 'node:http'
import * as concat from 'concat-stream'

/** Delegate class for a HomeKit accessory, corresponding to a light device
  * or groups resource.
  * @extends AccessoryDelegate
  * @memberof AccessoryDelegate
  */
class Platform extends AccessoryDelegate {
  /** Instantiate a delegate for an accessory corresponding to a device.
    * @param {DeconzPlatform} platform - The platform.
    */
  constructor (platform) {
    super(platform, { name: 'Main Platform', id: 'MainPlatform' })

    this.service = new DeconzService.Platform(this, {
      name: this.name + ' Service',
      primaryService: true
    })

    const webserverPort = this.platform._configJson.controlServerPort || 5007
    const server = http.createServer((req, res) => {
      req.pipe(concat((body) => {
        console.log(body.toString())
        // const params = JSON.parse(body.toString())
        // const { gatewayId, accessoryId, subtype, characteristic, value } = params
        // this.platform.gatewayMap[gatewayId]?.accessoriesById[accessoryId]?.serviceBySubtype[subtype]?._service?.getCharacteristic(characteristic)?.value = value
        res.end(JSON.stringify(params) + '\n')
      }))
    })

    //var server = http.createServer(self.handleRequest.bind(this));
    server.listen(webserverPort, () => {
      console.log("deCONZ is listening on port %s", webserverPort)
    })

    server.on('error', (err) => {
      console.log("deCONZ Port %s Server %s ", webserverPort, err)
    })

    this.myServer = server

    // this.identify()

    setImmediate(() => {
      this.debug('initialised')
      this.emit('initialised')
    })
  }

  sendPUTRequestToServer(gatewayId, accessoryId, subtype, characteristic, value) {
    const jsonObject = {gatewayId, accessoryId, subtype, characteristic, value}
    const data = JSON.stringify(jsonObject)

    const options = {
      hostname: "127.0.0.1",
      port: platform._configJson.useHTTPRequestsForPUTWithPort,
      path: "/",
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }

    const that = this

    const req = http.request(options, (res) => {
      // that.log(`statusCode: ${res.statusCode}`)

      if (res.statusCode === 200) {
        that.log('Command sent and received successfully')
      }

      res.on('data', (d) => {
        // process.stdout.write(d)
        that.log(d)
      })
    })

    req.on('error', (error) => {
      console.error(error)
    })

    req.write(data)
    req.end()
  }
}

DeconzAccessory.Platform = Platform
