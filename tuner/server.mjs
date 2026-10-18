import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const port = Number(process.env.API_PORT ?? 8787)
const apiKey = process.env.CREAO_API_KEY
const appId = process.env.CREAO_APP_ID ?? process.env.CREAO_AGENT_ID
const maxBodyBytes = 15 * 1024 * 1024
const jobs = new Map()
const jobTtlMs = 30 * 60 * 1000

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
  const response = await fetch(`https://agent.creao.ai${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = payload.error?.code ?? payload.error ?? payload.message
    const retryAfter = response.headers.get('retry-after')
    const error = new Error(code ? `Creao request failed (${response.status}): ${code}` : `Creao request failed (${response.status})`)
    error.status = response.status
    error.retryAfterMs = retryAfter ? Math.max(1000, Number(retryAfter) * 1000) : null
    throw error
  }
  return payload
}

async function artifactText(artifact) {
  if (typeof artifact?.text === 'string') return artifact.text
  if (typeof artifact?.content === 'string') return artifact.content
  if (typeof artifact?.url !== 'string') return null
  const response = await fetch(artifact.url, {
    headers: { Authorization: 'Bearer ' + apiKey },
    redirect: 'manual',
  })
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (!location) return null
    const redirected = await fetch(location)
    return redirected.ok ? redirected.text() : null
  }
  return response.ok ? response.text() : null
}

async function recognize(imageDataUrl) {
  const run = await creao(`/api/v1/apps/${appId}/runs`, {
    method: 'POST',
    body: JSON.stringify({
      inputs: {
        task: 'Analyze this sheet-music image. Return ONLY valid JSON with this exact shape: {"title": string, "key": number, "timeSignature": [number, number], "measures": [{"notes": [{"pitch": "C4", "duration": "quarter"}]}]}. Use MIDI-compatible pitches and durations of breve, whole, half, quarter, eighth, or 16th.',
        image_data_url: imageDataUrl,
      },
    }),
  })
  let result = run
  let delayMs = 5000
  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline && !['completed', 'failed', 'cancelled'].includes(result.status)) {
    await new Promise(resolve => setTimeout(resolve, delayMs))
    try {
      result = await creao(`/api/v1/apps/${appId}/runs/${run.id}`)
      delayMs = 5000
    } catch (error) {
      if (error?.status !== 429) throw error
      delayMs = error.retryAfterMs ?? Math.min(delayMs * 2, 60000)
      console.warn(`CREAO rate limited status polling; retrying in ${delayMs} ms`)
    }
  }
  if (result.status !== 'completed') throw new Error(`Creao run ${result.status ?? 'timed out'}`)
  const output = result.result ?? {}
  for (const artifact of Array.isArray(output.artifacts) ? output.artifacts : []) {
    if (!/notes\.normalized\.json|json/i.test(`${artifact.title ?? ''} ${artifact.id ?? ''}`)) continue
    const text = await artifactText(artifact)
    if (text) return text
  }
  if (typeof output.text === 'string') return output.text
  if (typeof output.chatText === 'string') return output.chatText
  throw new Error('Creao completed without readable text or notes JSON artifact')
}

function startJob(imageDataUrl) {
  const id = randomUUID()
  const job = { id, status: 'running', createdAt: Date.now() }
  jobs.set(id, job)
  void recognize(imageDataUrl).then(text => {
    job.status = 'completed'
    job.text = text
  }).catch(error => {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : 'Sheet recognition failed'
    console.error(`Sheet recognition job ${id} failed:`, error)
  }).finally(() => {
    setTimeout(() => jobs.delete(id), jobTtlMs)
  })
  return job
}

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {})
  if (req.method === 'GET' && req.url === '/') return json(res, 200, { ok: true, service: 'sheet-recognition-bridge' })
  if (req.method === 'GET' && req.url.startsWith('/api/recognize-sheet/')) {
    const id = req.url.slice('/api/recognize-sheet/'.length)
    const job = jobs.get(id)
    if (!job) return json(res, 404, { error: 'Recognition job not found' })
    return json(res, 200, {
      job_id: job.id,
      status: job.status,
      ...(job.text ? { text: job.text } : {}),
      ...(job.error ? { error: job.error } : {}),
    })
  }
  if (req.method !== 'POST' || req.url !== '/api/recognize-sheet') return json(res, 404, { error: 'Not found' })
  if (!apiKey || !appId) return json(res, 503, { error: 'CREAO_API_KEY and CREAO_APP_ID must be configured on the server' })
  try {
    const body = JSON.parse((await readBody(req)).toString('utf8'))
    if (typeof body.image !== 'string' || !body.image.startsWith('data:image/')) {
      return json(res, 400, { error: 'A data URL image is required' })
    }
    const job = startJob(body.image)
    return json(res, 202, { job_id: job.id, status: job.status })
  } catch (error) {
    console.error('Sheet recognition failed:', error)
    return json(res, 502, { error: error instanceof Error ? error.message : 'Sheet recognition failed' })
  }
}).listen(port, () => console.log(`Creao bridge listening on http://localhost:${port}`))
