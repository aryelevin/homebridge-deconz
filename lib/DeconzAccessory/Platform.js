// homebridge-deconz/lib/DeconzAccessory/Platform.js
// Copyright© 2022-2023 Arye Levin. All rights reserved.
//
// Homebridge plugin for deCONZ.

import { AccessoryDelegate } from 'homebridge-lib/AccessoryDelegate'
import { DeconzAccessory } from '../DeconzAccessory/index.js'
import { DeconzService } from '../DeconzService/index.js'
import '../DeconzService/Platform.js'
import * as http from 'node:http'

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

    const webserverPort = this.platform._configJson.controlServerPort
    if (webserverPort) {
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.headers['content-type'] === 'application/json') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk.toString(); // Collect data chunks
          });
          req.on('end', () => {
            try {
              const jsonData = JSON.parse(body); // Parse the collected body as JSON
              this.log('Received JSON data:', jsonData);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ message: 'JSON received successfully!' }));

              const { gatewayId, accessoryId, subtype, characteristic, value } = jsonData
              this.platform.gatewayMap[gatewayId]?.accessoryById[accessoryId]?.serviceBySubtype[subtype]?._characteristicDelegates[characteristic]?._characteristic?.setValue(value)
            } catch (error) {
              this.error('Error parsing JSON:', error);
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON format' }));
            }
          });
        } else {
          res.writeHead(405, { 'Content-Type': 'text/plain' });
          res.end('Method Not Allowed or Invalid Content-Type');
        }
      })

      //var server = http.createServer(self.handleRequest.bind(this));
      server.listen(webserverPort, () => {
        this.log("deCONZ is listening on port %s", webserverPort)
      })

      server.on('error', (err) => {
        this.log("deCONZ Port %s Server %s ", webserverPort, err)
      })

      this.myServer = server
    }
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
      port: this.platform._configJson.portToUseForHomeassistant,
      path: "/",
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }

    const that = this

    const req = http.request(options, (res) => {
      this.log(`statusCode: ${res.statusCode}`)

      if (res.statusCode === 200) {
        this.log('Command sent and received successfully')
      }

      res.on('data', (d) => {
        // process.stdout.write(d)
        console.log(d)
      })
    })

    req.on('error', (error) => {
      this.error(error)
    })

    req.write(data)
    req.end()
  }
}

DeconzAccessory.Platform = Platform
