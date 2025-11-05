import process from 'node:process'
import { getVersion } from '../utils.js'

async function handler(nodelink, req, res, sendResponse) {
  const enabledFilters = nodelink.options.filters.enabled || {}
  const filters = Object.keys(enabledFilters).filter(
    (key) => enabledFilters[key]
  )

  let sourceManagers
  if (nodelink.workerManager) {
    sourceManagers = nodelink.supportedSourcesCache
    if (!sourceManagers) {
      sourceManagers = await nodelink.getSourcesFromWorker()
      nodelink.supportedSourcesCache = sourceManagers
    }
  } else {
    sourceManagers = nodelink.sources?.sources
      ? Array.from(nodelink.sources.sources.keys())
      : []
  }

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
    sourceManagers,
    filters,
    plugins: (await nodelink.pluginManager.getPlugins()) || []
  }
  sendResponse(req, res, response, 200)
}

export default {
  handler
}
