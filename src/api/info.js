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
    isNodelink: true,
    sourceManagers: nodelink.workerManager
      ? nodelink.supportedSourcesCache ||
        (nodelink.supportedSourcesCache = await nodelink.getSourcesFromWorker())
      : nodelink.sources?.sources
        ? Array.from(nodelink.sources.sources.keys())
        : [],
    filters,
    plugins: nodelink.pluginManager
      ? Array.from(nodelink.pluginManager.loadedPlugins.values()).map((p) => ({
          name: p.name,
          version: p.meta?.version || '0.0.0',
          author: p.meta?.author || null,
          path: p.path || null
        }))
      : []
  }
  sendResponse(req, res, response, 200)
}

export default {
  handler
}
