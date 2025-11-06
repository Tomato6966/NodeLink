import process from 'node:process'
import { getVersion } from '../utils.js'

async function handler(nodelink, req, res, sendResponse) {
  const enabledFilters = nodelink.options.filters.enabled || {}
  const filters = Object.keys(enabledFilters).filter(
    (key) => enabledFilters[key]
  )

  const response = {
    version: {
      semver: `${nodelink.version}`,
      ...getVersion('object')
    },
    buildTime: nodelink.gitInfo.commitTime,
    git: nodelink.gitInfo,
    node: process.version,
    voice: {
      name: '@performanc/voice',
      version: 'github:PerformanC/voice'
    },
    sourceManagers: nodelink.workerManager
      ? nodelink.supportedSourcesCache ||
        (nodelink.supportedSourcesCache = await nodelink.getSourcesFromWorker())
      : nodelink.sources?.sources
        ? Array.from(nodelink.sources.sources.keys())
        : [],
    filters,
    plugins: []
  }
  sendResponse(req, res, response, 200)
}

export default {
  handler
}
