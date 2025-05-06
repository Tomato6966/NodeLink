import process from 'node:process'
import { getVersion } from '../utils.js'

function handler(nodelink, req, res, sendResponse) {
  const response = {
    version: {
      semver: `${nodelink.version}`,
      ...getVersion('object')
    },
    git: nodelink.gitInfo,
    nodejs: process.version,
    isNodeLink: true,
    sourceManagers: [],
    filters: [],
    plugins: []
  }

  sendResponse(req, res, response, 200)
}

export default {
  handler
}
