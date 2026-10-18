import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const port = Number(process.env.API_PORT ?? 8787)
const apiKey = process.env.CREAO_API_KEY
const agentId = process.env.CREAO_AGENT_ID
const maxBodyBytes = 15 * 1024 * 1024

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(value))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > maxBodyBytes) reject(new Error('Image is too large (15 MB maximum)'))
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function creao(path, options = {}) {
  const response = await fetch(`https://developer.creao.ai${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message ?? payload.message ?? `Creao request failed (${response.status})`)
  return payload
}

async function recognize(imageDataUrl) {
  const run = await creao('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: agentId,
      input: {
        task: 'Analyze this sheet-music image. Return ONLY valid JSON with this exact shape: {"title": string, "key": number, "timeSignature": [number, number], "measures": [{"notes": [{"pitch": "C4", "duration": "quarter"}]}]}. Use MIDI-compatible pitches and durations of breve, whole, half, quarter, eighth, or 16th.',
        image_data_url: imageDataUrl,
      },
    }),
  })
  let result = run
  for (let attempt = 0; attempt < 60 && !['completed', 'failed', 'cancelled'].includes(result.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    result = await creao(`/v1/runs/${run.run_id}`)
  }
  if (result.status !== 'completed') throw new Error(`Creao run ${result.status ?? 'timed out'}`)
  const text = result.result?.text
  if (typeof text !== 'string') throw new Error('Creao completed without a text result')
  return text
}

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {})
  if (req.method !== 'POST' || req.url !== '/api/recognize-sheet') return json(res, 404, { error: 'Not found' })
  if (!apiKey || !agentId) return json(res, 503, { error: 'CREAO_API_KEY and CREAO_AGENT_ID must be configured on the server' })
  try {
    const body = JSON.parse((await readBody(req)).toString('utf8'))
    if (typeof body.image !== 'string' || !body.image.startsWith('data:image/')) {
      return json(res, 400, { error: 'A data URL image is required' })
    }
    return json(res, 200, { request_id: randomUUID(), text: await recognize(body.image) })
  } catch (error) {
    console.error('Sheet recognition failed:', error)
    return json(res, 502, { error: error instanceof Error ? error.message : 'Sheet recognition failed' })
  }
}).listen(port, () => console.log(`Creao bridge listening on http://localhost:${port}`))
