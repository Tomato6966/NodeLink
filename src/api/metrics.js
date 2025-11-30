/**
 * 
 * @param {import('../index').NodelinkServer} nodelink 
 * @param {*} req 
 * @param {*} res 
 * @returns 
 */
async function handler(nodelink, req, res) {
    const register = nodelink.statsManager.promRegister;

    if (!register) {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('Metrics are disabled')
      return true
    }

    res.writeHead(200, { 'Content-Type': register.contentType })

    res.end(await register.metrics())
    return true
  }
  
  export default {
    handler
  }
  