function readVarint(buffer, offset) {
  let val = 0
  let shift = 0
  let byte
  let current = offset

  do {
    if (current >= buffer.length) throw new Error('Varint out of bounds')
    byte = buffer[current++]
    val |= (byte & 127) << shift
    shift += 7
  } while (byte & 128)

  return { val, next: current }
}

function skipField(buffer, offset, wireType) {
  if (wireType === 0) return readVarint(buffer, offset).next
  if (wireType === 1) return offset + 8
  if (wireType === 2) {
    const len = readVarint(buffer, offset)
    return len.next + len.val
  }
  if (wireType === 5) return offset + 4
  throw new Error(`Unsupported wire type: ${wireType}`)
}

function decodeArtist(buffer) {
  let offset = 0
  const artist = { artistUri: '', artistName: '', artistImgUrl: '' }
  while (offset < buffer.length) {
    try {
      const key = readVarint(buffer, offset)
      offset = key.next
      const wireType = key.val & 7
      const fieldNumber = key.val >>> 3
      if (wireType !== 2) {
        offset = skipField(buffer, offset, wireType)
        continue
      }
      const len = readVarint(buffer, offset)
      offset = len.next
      const valBuf = buffer.subarray(offset, offset + len.val)
      offset += len.val
      switch (fieldNumber) {
        case 1: artist.artistUri = valBuf.toString('utf8'); break
        case 2: artist.artistName = valBuf.toString('utf8'); break
        case 3: artist.artistImgUrl = valBuf.toString('utf8'); break
      }
    } catch { break }
  }
  return artist
}

function decodeCanvas(buffer) {
  let offset = 0
  const canvas = { id: '', canvasUrl: '', trackUri: '', artist: {}, canvasUri: '' }
  while (offset < buffer.length) {
    try {
      const key = readVarint(buffer, offset)
      offset = key.next
      const wireType = key.val & 7
      const fieldNumber = key.val >>> 3
      if (wireType !== 2) {
        offset = skipField(buffer, offset, wireType)
        continue
      }
      const len = readVarint(buffer, offset)
      offset = len.next
      const valBuf = buffer.subarray(offset, offset + len.val)
      offset += len.val
      switch (fieldNumber) {
        case 1: canvas.id = valBuf.toString('utf8'); break
        case 2: canvas.canvasUrl = valBuf.toString('utf8'); break
        case 5: canvas.trackUri = valBuf.toString('utf8'); break
        case 6: canvas.artist = decodeArtist(valBuf); break
        case 11: canvas.canvasUri = valBuf.toString('utf8'); break
      }
    } catch { break }
  }
  return canvas
}

function decodeCanvasResponse(buffer) {
  let offset = 0
  const canvases = []
  while (offset < buffer.length) {
    try {
      const key = readVarint(buffer, offset)
      offset = key.next
      const wireType = key.val & 7
      const fieldNumber = key.val >>> 3
      if (fieldNumber === 1 && wireType === 2) {
        const len = readVarint(buffer, offset)
        offset = len.next
        const canvasBuf = buffer.subarray(offset, offset + len.val)
        offset += len.val
        canvases.push(decodeCanvas(canvasBuf))
      } else {
        offset = skipField(buffer, offset, wireType)
      }
    } catch { break }
  }
  return { canvasesList: canvases }
}

export async function fetchCanvas(trackUri, token) {
  try {
    const trackUriBuf = Buffer.from(trackUri)
    const trackBuf = Buffer.concat([Buffer.from([0x0a, trackUriBuf.length]), trackUriBuf])
    const requestBuf = Buffer.concat([Buffer.from([0x0a, trackBuf.length]), trackBuf])

    const res = await fetch('https://spclient.wg.spotify.com/canvaz-cache/v0/canvases', {
      method: 'POST',
      body: requestBuf,
      headers: {
        'Accept': 'application/protobuf',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Spotify/9.0.34.593 iOS/18.4 (iPhone15,3)',
        'Authorization': `Bearer ${token}`
      }
    })

    if (!res.ok) return null
    
    const arrayBuffer = await res.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    return { data: decodeCanvasResponse(buffer) }
  } catch { return null }
}
