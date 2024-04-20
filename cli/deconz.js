#!/usr/bin/env node

// deconz.js
// Copyright © 2018-2024 Erik Baauw. All rights reserved.
//
// Command line interface to deCONZ gateway.

'use strict'

const { DeconzTool } = require('hb-deconz-tools')
const pkgJson = require('../package.json')

new DeconzTool(pkgJson).main()
