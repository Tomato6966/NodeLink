import os from 'node:os'
import process from 'node:process'

function handler(nodelink, req, res, sendResponse) {
  const expectedFrames = 3000

  let players = 0
  let playingPlayers = 0
  let frameStats = { sent: 0, nulled: 0, deficit: 0 }

  for (const session of nodelink.sessions.values()) {
    if (!session.players) continue

    for (const player of session.players.values()) {
      players++
      if (player.isPlaying) playingPlayers++

      const sent = player.sentFrames || 0
      const nulled = player.nulledFrames || 0

      frameStats.sent += sent
      frameStats.nulled += nulled
      frameStats.deficit += expectedFrames - sent
    }
  }

  if (players === 0) frameStats = null

  const uptime = Math.floor(process.uptime() * 1000)
  const mem = process.memoryUsage()
  const memory = {
    free: os.freemem(),
    used: mem.heapUsed,
    allocated: mem.heapTotal,
    reservable: os.totalmem()
  }

  const cores = os.cpus().length
  const load = os.loadavg()[0]
  const cpu = {
    cores,
    systemLoad: load,
    NodelinkLoad: (load / cores).toFixed(2)
  }

  sendResponse(req, res, { players, playingPlayers, uptime, memory, cpu, frameStats }, 200)
}

export default {
  handler
}
