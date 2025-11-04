import { sendResponse } from '../utils.js'

function handler(nodelink, req, res) {
  const pm = nodelink.pluginManager
  const names = pm?.getPluginList?.() || []
  const routes = pm?.getRoutes?.()
  const pluginStatic = routes ? Array.from(routes.static.keys()) : []
  const pluginDynamic = routes ? routes.dynamic.map(([regex]) => String(regex)) : []

  return sendResponse(
    req,
    res,
    {
      count: names.length,
      plugins: names,
      http: {
        static: pluginStatic,
        dynamic: pluginDynamic
      }
    },
    200
  )
}

export default {
  handler,
  methods: ['GET']
}

