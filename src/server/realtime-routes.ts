/**
 * WebSocket routing for app-owned Durable Objects.
 *
 * Caller identity in query parameters and headers is never trusted. Routes
 * scrub it and forward verified JWT identity in internal-only headers; the
 * documents-aware Yjs route additionally resolves an application role from
 * the documents collection.
 */

import type { Context, Hono } from 'hono'
import { authenticatedRoomRequest, resolveAppRole, verifyJwt } from 'deepspace/worker'
import type { JwtVerifierConfig, VerifyResult } from 'deepspace/worker'
import type { AppContext, Env } from '../../worker.js'

function jwtConfig(env: Env): JwtVerifierConfig {
  return { publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER }
}

function wsRoute(
  doNamespace: (env: Env) => DurableObjectNamespace,
  extraIdentity?: (auth: VerifyResult, env: Env) => { role?: string } | Promise<{ role?: string }>,
) {
  return async (c: Context<AppContext>) => {
    const id = c.req.param('roomId') ?? c.req.param('docId') ?? c.req.param('scopeId')
    if (!id) return new Response('Not found', { status: 404 })
    const url = new URL(c.req.url)
    const token = url.searchParams.get('token')

    let auth: VerifyResult | null = null
    if (token) {
      auth = (await verifyJwt(jwtConfig(c.env), token)).result
      if (!auth) return new Response('Unauthorized', { status: 401 })
    }
    const roomRequest = authenticatedRoomRequest(
      c.req.raw,
      auth,
      auth ? await extraIdentity?.(auth, c.env) : undefined,
    )

    const namespace = doNamespace(c.env)
    const stub = namespace.get(namespace.idFromName(id))
    return stub.fetch(roomRequest)
  }
}

const FILE_CANVAS_SEPARATOR = '__file__'

/** The session a canvas docId belongs to, or null if the id is malformed. */
export function canvasSessionId(docId: string): string | null {
  const [sessionId, fileId, ...rest] = docId.split(FILE_CANVAS_SEPARATOR)
  if (!sessionId || rest.length > 0) return null
  if (fileId !== undefined && !fileId) return null
  return sessionId
}

/** True when `userId` is the tutor or an enrolled student of session `sessionId`. */
async function isSessionParticipant(env: Env, sessionId: string, userId: string): Promise<boolean> {
  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
  try {
    const res = await stub.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': env.OWNER_USER_ID,
          'X-App-Action': 'true',
        },
        body: JSON.stringify({
          tool: 'records.get',
          params: { collection: 'sessions', recordId: sessionId },
        }),
      }),
    )
    const json = (await res.json()) as {
      success?: boolean
      data?: { record?: { data?: { ownerId?: string; studentIds?: string } } }
    }
    const session = json.success ? json.data?.record?.data : undefined
    if (!session) return false
    return session.ownerId === userId || parseAccessList(session.studentIds).includes(userId)
  } catch {
    return false
  }
}

type DocsYjsRole = 'admin' | 'member' | 'viewer'

interface DocumentRecordForAccess {
  ownerId?: string
  collaborators?: string
  editors?: string
}

type DocumentAccessLookup =
  | { kind: 'found'; doc: DocumentRecordForAccess }
  | { kind: 'not-docs-room' }
  | { kind: 'error' }

function parseAccessList(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

async function getDocumentForAccess(env: Env, docId: string): Promise<DocumentAccessLookup> {
  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
  try {
    const res = await stub.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': env.OWNER_USER_ID,
          'X-App-Action': 'true',
        },
        body: JSON.stringify({
          tool: 'records.get',
          params: { collection: 'documents', recordId: docId },
        }),
      }),
    )
    const json = (await res.json()) as {
      success?: boolean
      error?: string
      data?: { record?: { data?: DocumentRecordForAccess } }
    }
    if (json.success && json.data?.record?.data) {
      return { kind: 'found', doc: json.data.record.data }
    }
    if (json.error?.startsWith('Schema not registered for collection: documents')) {
      return { kind: 'not-docs-room' }
    }
    return { kind: 'error' }
  } catch {
    return { kind: 'error' }
  }
}

async function resolveDocsYjsRole(
  env: Env,
  docId: string,
  userId: string,
): Promise<DocsYjsRole | null> {
  const lookup = await getDocumentForAccess(env, docId)
  if (lookup.kind === 'not-docs-room') return 'member'
  if (lookup.kind === 'error') return null
  const { doc } = lookup
  if (doc.ownerId === userId || userId === env.OWNER_USER_ID) return 'admin'

  const editors = parseAccessList(doc.editors)
  if (editors.includes(userId)) return 'member'

  const collaborators = parseAccessList(doc.collaborators)
  if (collaborators.includes(userId)) return 'viewer'

  return null
}

export function registerRealtimeRoutes(app: Hono<AppContext>): void {
  app.get(
    '/ws/:roomId',
    wsRoute((env) => env.RECORD_ROOMS),
  )

  app.get('/ws/yjs/:docId', async (c) => {
    const docId = c.req.param('docId')
    const url = new URL(c.req.url)
    const token = url.searchParams.get('token')
    const auth = token ? (await verifyJwt(jwtConfig(c.env), token)).result : null
    if (!auth) return new Response('Unauthorized', { status: 401 })

    const role = await resolveDocsYjsRole(c.env, docId, auth.userId)
    if (!role) return new Response('Forbidden', { status: 403 })

    const roomRequest = authenticatedRoomRequest(c.req.raw, auth, { role })

    const stub = c.env.YJS_ROOMS.get(c.env.YJS_ROOMS.idFromName(docId))
    return stub.fetch(roomRequest)
  })

  // A canvas belongs to a tutoring session. Its docId is either the session's
  // recordId (the whiteboard) or `<sessionId>__file__<fileId>` (the shared
  // annotation layer over an uploaded file). Only that session's tutor and
  // students may connect.
  app.get('/ws/canvas/:docId', async (c) => {
    const docId = c.req.param('docId')
    const token = new URL(c.req.url).searchParams.get('token')
    const auth = token ? (await verifyJwt(jwtConfig(c.env), token)).result : null
    if (!auth) return new Response('Unauthorized', { status: 401 })

    const sessionId = canvasSessionId(docId)
    if (!sessionId || !(await isSessionParticipant(c.env, sessionId, auth.userId))) {
      return new Response('Forbidden', { status: 403 })
    }
    const role = await resolveAppRole(c.env, auth.userId)
    const roomRequest = authenticatedRoomRequest(c.req.raw, auth, { role })
    const stub = c.env.CANVAS_ROOMS.get(c.env.CANVAS_ROOMS.idFromName(docId))
    return stub.fetch(roomRequest)
  })

  app.get(
    '/ws/presence/:scopeId',
    wsRoute((env) => env.PRESENCE_ROOMS),
  )

  app.get(
    '/ws/cron/:roomId',
    wsRoute(
      (env) => env.CRON_ROOMS,
      // Authenticated users get their current app role. Anonymous connections
      // have no role and CronRoom enforces them as read-only viewers.
      async (auth, env) => ({ role: await resolveAppRole(env, auth.userId) }),
    ),
  )

  app.get(
    '/ws/jobs/:roomId',
    wsRoute((env) => env.JOB_ROOMS),
  )
}
