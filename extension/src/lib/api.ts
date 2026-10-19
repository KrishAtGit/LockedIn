import type { components } from './api-types'

// Generated from the backend's OpenAPI spec (npm run api:types), so these can't drift from the server.
type Schemas = components['schemas']
export type ClassifyRequest = Schemas['ClassifyRequest']
export type ClassifyResponse = Schemas['ClassifyResponse']
export type JudgeRequest = Schemas['JudgeRequest']
export type JudgeResponse = Schemas['JudgeResponse']
export type Health = Schemas['Health']
export type Category = ClassifyResponse['category']

export class ApiError extends Error {}

async function call<T>(baseUrl: string, path: string, timeoutMs: number, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(new URL(path, baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new ApiError(err instanceof Error && err.name === 'TimeoutError' ? 'Timed out' : 'Unreachable')
  }
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`)
  return (await response.json()) as T
}

export const api = {
  health: (baseUrl: string) => call<Health>(baseUrl, '/health', 5_000),
  classify: (baseUrl: string, req: ClassifyRequest) => call<ClassifyResponse>(baseUrl, '/classify', 30_000, req),
  // The server waits up to ~20s for the model before falling back, so give it a little longer than that.
  judge: (baseUrl: string, req: JudgeRequest) => call<JudgeResponse>(baseUrl, '/judge-reason', 30_000, req),
}
