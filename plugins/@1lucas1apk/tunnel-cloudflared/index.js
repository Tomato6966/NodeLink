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

  const tunnel = spawn(
    bin,
    ["tunnel", "run", "--token", token, "--url", `http://127.0.0.1:${port}`],
    { stdio: "inherit", env: process.env }
  )

  const stopAll = () => {
    try { tunnel.kill("SIGTERM") } catch {}
  }

  process.on("SIGINT", stopAll)
  process.on("SIGTERM", stopAll)
  process.on("beforeExit", stopAll)

  logger(`Tunnel started on port ${port}`)
}
