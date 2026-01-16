import fs from "node:fs"
import { spawn } from "node:child_process"

export default async function(nodelink, config, context) {
  if (context.type !== 'master') return

  const logger = (msg, level = 'info') => nodelink.logger(level, 'Cloudflared', msg)

  const token = config.token || process.env.CF_TUNNEL_TOKEN
  const port = nodelink.options.server.port || 3000

  if (!token) {
    logger('CF_TUNNEL_TOKEN not found. Plugin disabled.', 'warn')
    return
  }

  let cloudflared
  try {
    cloudflared = await import("cloudflared")
  } catch (e) {
    logger('Package "cloudflared" not found. Please install it in the plugin folder.', 'error')
    return
  }

  const { bin, install } = cloudflared

  if (!fs.existsSync(bin)) {
    logger('Installing cloudflared binary...')
    await install(bin)
  }

  logger(`Starting tunnel on port ${port}...`)

  const tunnel = spawn(
    bin,
    ["tunnel", "run", "--token", token, "--url", `http://127.0.0.1:${port}`],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env }
  )

  tunnel.stdout.on('data', (data) => {
    const msg = data.toString().trim()
    if (msg) logger(msg, 'debug')
  })

  tunnel.stderr.on('data', (data) => {
    const msg = data.toString().trim()
    if (msg.includes('Registered tunnel connection')) {
      logger('Tunnel connection established successfully.')
    }
  })

  tunnel.on('error', (err) => {
    logger(`Failed to start cloudflared: ${err.message}`, 'error')
  })

  tunnel.on('close', (code) => {
    if (code !== null && code !== 0 && code !== 1) {
      logger(`Cloudflared exited with code ${code}`, 'warn')
    }
  })

  nodelink.once('shutdown', () => {
    if (tunnel && !tunnel.killed) {
      logger('Closing tunnel...')
      tunnel.kill("SIGKILL")
    }
  })
}
