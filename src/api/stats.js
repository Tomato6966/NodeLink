import os from 'node:os'
import process from 'node:process'

function handler(nodelink, req, res, sendResponse) {
  const { players, playingPlayers } = nodelink.statistics
  let frameStats = null
  if (players > 0) {
    frameStats = { sent: 0, nulled: 0, deficit: 0, expected: 0 }
    for (const session of nodelink.sessions.values()) {
      if (!session.players) continue
      for (const player of session.players.values()) {
        if (!player.connection) continue
        const sent = player.connection.statistics.packetsSent || 0
        const nulled = player.connection.statistics.packetsLost || 0
        const expectedFrames = player.connection.statistics.packetsExpect || 0
        frameStats.sent += sent
        frameStats.nulled += nulled
        frameStats.expected += expectedFrames
      }
    }
    frameStats.deficit += Math.max(0, expectedFrames - sent)
  }

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
    nodelinkLoad: (load / cores).toFixed(2)
  }

  const payload = {
    players,
    playingPlayers,
    uptime,
    memory,
    cpu,
    frameStats
  }

  sendResponse(req, res, payload, 200)
}

export default { handler }
