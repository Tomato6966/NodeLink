function handler(nodelink, req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end(`${nodelink.version}`)
  return true
}

export default {
  handler
}
