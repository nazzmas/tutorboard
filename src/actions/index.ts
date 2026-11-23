/**
 * TutorBoard server actions.
 *
 * Actions run with record-room RBAC OFF (see src/server/action-routes.ts), so
 * every action below loads the session first and checks that the caller is
 * its tutor or one of its students before reading or writing anything.
 */

import { generateText } from 'ai'
import { createDeepSpaceAI } from 'deepspace/worker'
import type { ActionContext, ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'

const AI_MODEL = 'claude-haiku-5-5'
const MAX_PROBLEMS = 8

type SessionData = {
  title: string
  topic?: string
  joinCode: string
  ownerId: string
  studentIds?: string
}
type ProblemData = { sessionId: string; question: string; ownerId: string }
type SharedRow = { ownerId: string; studentIds?: string }
type SolutionData = { solution: string }

function fail(error: string): ActionResult {
  return { success: false, error } as ActionResult
}

function ok(data: unknown): ActionResult {
  return { success: true, data } as ActionResult
}

export function parseIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string')
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Every participant except the record owner, as the JSON collaborator list. */
function collaboratorsFor(session: SessionData, ownerId: string): string {
  const everyone = [session.ownerId, ...parseIds(session.studentIds)]
  return JSON.stringify([...new Set(everyone)].filter((id) => id !== ownerId))
}

type SessionAccess =
  | { ok: true; session: SessionData; isTutor: boolean }
  | { ok: false; result: ActionResult }

async function loadSession(ctx: ActionContext<Env>, sessionId: unknown): Promise<SessionAccess> {
  if (typeof sessionId !== 'string' || !sessionId) {
    return { ok: false, result: fail('sessionId is required') }
  }
  const res = await ctx.tools.get<SessionData>('sessions', sessionId)
  const session = res.success ? (res.data.record?.data ?? null) : null
  if (!session) return { ok: false, result: fail('Session not found') }
  const isTutor = session.ownerId === ctx.userId
  const isStudent = parseIds(session.studentIds).includes(ctx.userId)
  if (!isTutor && !isStudent) return { ok: false, result: fail('You are not part of this session') }
  return { ok: true, session, isTutor }
}

/** Pull the first JSON value out of a model reply (tolerates ```json fences). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : text).trim()
  const start = body.search(/[[{]/)
  if (start < 0) throw new Error('No JSON in model reply')
  return JSON.parse(body.slice(start))
}

function modelFor(ctx: ActionContext<Env>) {
  // Bill the signed-in caller, not the app owner.
  return createDeepSpaceAI(ctx.env, 'anthropic', { authToken: ctx.callerJwt })(AI_MODEL)
}

type DraftProblem = { question?: unknown; hint?: unknown; solution?: unknown }
export type CleanProblem = { question: string; hint: string; solution: string }

/** Keep only well-formed problems, trimmed to sane lengths. */
export function cleanProblems(raw: unknown, max = MAX_PROBLEMS): CleanProblem[] {
  if (!Array.isArray(raw)) return []
  const out: CleanProblem[] = []
  for (const item of raw as DraftProblem[]) {
    if (!item || typeof item.question !== 'string' || typeof item.solution !== 'string') continue
    if (!item.question.trim() || !item.solution.trim()) continue
    out.push({
      question: item.question.trim().slice(0, 4000),
      hint: typeof item.hint === 'string' ? item.hint.trim().slice(0, 1000) : '',
      solution: item.solution.trim().slice(0, 6000),
    })
    if (out.length >= max) break
  }
  return out
}

/** Write problems plus their hidden solutions for a session. Returns how many were saved. */
async function saveProblems(
  ctx: ActionContext<Env>,
  sessionId: string,
  session: SessionData,
  items: CleanProblem[],
  difficulty: string,
): Promise<number> {
  const existing = await ctx.tools.query('problems', { where: { sessionId }, limit: 500 })
  let position = existing.success ? existing.data.records.length : 0
  let created = 0
  for (const item of items) {
    const problem = await ctx.tools.create('problems', {
      sessionId,
      question: item.question,
      hint: item.hint,
      difficulty,
      position: position++,
      ownerId: ctx.userId,
      studentIds: collaboratorsFor(session, ctx.userId),
    })
    const problemId = problem.success ? problem.data.recordId : undefined
    if (!problemId) continue
    await ctx.tools.create('solutions', {
      problemId,
      sessionId,
      solution: item.solution,
      ownerId: ctx.userId,
    })
    created++
  }
  return created
}

const MAX_FILE_BASE64 = 6_000_000 // ~4.5 MB of raw file
const ASSISTANT_FILE_TYPES = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/

type ChatTurn = { role: 'user' | 'assistant'; content: string }

function cleanHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (m): m is ChatTurn =>
        !!m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0,
    )
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }))
}

const ASSISTANT_SYSTEM =
  'You are a teaching assistant helping a tutor plan and run a one-on-one tutoring session. ' +
  'The tutor may ask you to write practice problems (any style: word problems, multi-step, ' +
  'conceptual, exam-style, with real-world context, etc.), explain how to teach an idea, or ' +
  'review a photo or PDF of a student\'s homework. When reviewing homework, say what the student ' +
  'did well, point out each mistake and why it happened, and suggest what to practice next. ' +
  'Reply with ONLY a JSON object: {"reply": string, "problems": [{"question": string, "hint": string, ' +
  '"solution": string}]}. "reply" is your message to the tutor in plain text (short paragraphs or ' +
  'dash lists, no markdown headers). Put any practice problems you write in "problems" (each ' +
  'solution is a worked solution ending with the final answer) and do not repeat them inside ' +
  '"reply". Use an empty array when you are not writing problems. Use plain text math ' +
  '(x^2, sqrt(x)), no LaTeX.'

export const actions: Record<string, ActionHandler<Env>> = {
  /** A student redeems a join code and is added to the session (and its problems/files). */
  joinSession: async (ctx) => {
    const code = String(ctx.params.code ?? '').trim().toUpperCase()
    if (!/^[A-Z0-9]{6}$/.test(code)) return fail('Join codes are 6 letters or numbers')

    const found = await ctx.tools.query<SessionData>('sessions', {
      where: { joinCode: code },
      limit: 1,
    })
    const record = found.success ? found.data.records[0] : undefined
    if (!record) return fail('No session with that code')

    const session = record.data
    if (session.ownerId === ctx.userId) return ok({ sessionId: record.recordId })

    const students = parseIds(session.studentIds)
    if (!students.includes(ctx.userId)) {
      students.push(ctx.userId)
      const studentIds = JSON.stringify(students)
      const updated = await ctx.tools.update('sessions', record.recordId, { studentIds })
      if (!updated.success) return fail('Could not join the session')

      // Problems and shared files snapshot the participant list; extend them
      // so a late joiner sees what was already posted.
      for (const collection of ['problems', 'session_files']) {
        const rows = await ctx.tools.query<SharedRow>(collection, {
          where: { sessionId: record.recordId },
          limit: 200,
        })
        const list = rows.success ? rows.data.records : []
        for (const row of list) {
          const ids = parseIds(row.data.studentIds)
          if (!ids.includes(ctx.userId)) {
            await ctx.tools.update(collection, row.recordId, {
              studentIds: JSON.stringify([...ids, ctx.userId]),
            })
          }
        }
      }
    }
    return ok({ sessionId: record.recordId })
  },

  /** Tutor-only: ask the model for practice problems and store problems + hidden solutions. */
  generateProblems: async (ctx) => {
    const access = await loadSession(ctx, ctx.params.sessionId)
    if (!access.ok) return access.result
    if (!access.isTutor) return fail('Only the tutor can generate problems')

    const topic = String(ctx.params.topic ?? access.session.topic ?? '').trim().slice(0, 200)
    if (!topic) return fail('Give a topic to generate problems for')
    const count = Math.min(Math.max(Number(ctx.params.count) || 3, 1), MAX_PROBLEMS)
    const level = String(ctx.params.level ?? 'medium').slice(0, 40)
    const instructions = String(ctx.params.instructions ?? '').trim().slice(0, 1000)

    const { text } = await generateText({
      model: modelFor(ctx),
      system:
        'You write practice problems for a one-on-one tutoring session. Follow the tutor\'s ' +
        'instructions about style closely (for example word problems, multi-step, conceptual, ' +
        'real-world context). Reply with ONLY a JSON array. Each item: {"question": string, ' +
        '"hint": string, "solution": string (worked solution ending with the final answer)}. ' +
        'Use plain text math (x^2, sqrt(x)), no LaTeX.',
      prompt:
        `Topic: ${topic}\nDifficulty: ${level}\nNumber of problems: ${count}` +
        (instructions ? `\nTutor's instructions: ${instructions}` : ''),
    })

    let items: CleanProblem[]
    try {
      items = cleanProblems(extractJson(text), count)
    } catch {
      return fail('The AI reply could not be read. Try again.')
    }

    const sessionId = String(ctx.params.sessionId)
    const created = await saveProblems(ctx, sessionId, access.session, items, level)
    if (created === 0) return fail('No problems were created. Try a more specific topic.')
    return ok({ created })
  },

  /**
   * Tutor-only chat with the teaching assistant. Optionally includes one
   * uploaded file (image or PDF, sent by the tutor's browser as base64) so the
   * assistant can review homework. Returns a reply plus any drafted problems;
   * nothing is saved until the tutor calls addProblems.
   */
  askAssistant: async (ctx) => {
    const access = await loadSession(ctx, ctx.params.sessionId)
    if (!access.ok) return access.result
    if (!access.isTutor) return fail('Only the tutor can use the assistant')

    const history = cleanHistory(ctx.params.messages)
    const last = history[history.length - 1]
    if (!last || last.role !== 'user') return fail('Write a message first')

    const file = ctx.params.file as { name?: unknown; mimeType?: unknown; base64?: unknown } | undefined
    let filePart: { type: 'file'; data: string; mediaType: string; filename?: string } | null = null
    if (file) {
      const mimeType = String(file.mimeType ?? '')
      const base64 = String(file.base64 ?? '')
      if (!ASSISTANT_FILE_TYPES.test(mimeType)) return fail('The assistant can read images (PNG, JPG, GIF, WebP) and PDFs')
      if (!base64 || base64.length > MAX_FILE_BASE64) return fail('That file is too large for the assistant (about 4 MB max)')
      filePart = { type: 'file', data: base64, mediaType: mimeType, filename: String(file.name ?? 'file').slice(0, 200) }
    }

    const topic = access.session.topic ? ` The session topic is "${access.session.topic}".` : ''
    const messages = history.map((m, i) =>
      i === history.length - 1 && filePart
        ? {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: `Attached file: ${filePart.filename}\n\n${m.content}` },
              filePart,
            ],
          }
        : m,
    )

    const { text } = await generateText({
      model: modelFor(ctx),
      system: ASSISTANT_SYSTEM + topic,
      messages,
    })

    let reply = text.trim()
    let problems: CleanProblem[] = []
    try {
      const parsed = extractJson(text) as { reply?: unknown; problems?: unknown }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (typeof parsed.reply === 'string') reply = parsed.reply.trim()
        problems = cleanProblems(parsed.problems)
      }
    } catch {
      // Not JSON: show the raw reply with no problems attached.
    }
    return ok({ reply: reply.slice(0, 8000), problems })
  },

  /** Tutor-only: save problems drafted by the assistant into the session's practice list. */
  addProblems: async (ctx) => {
    const access = await loadSession(ctx, ctx.params.sessionId)
    if (!access.ok) return access.result
    if (!access.isTutor) return fail('Only the tutor can add problems')
    const items = cleanProblems(ctx.params.problems)
    if (items.length === 0) return fail('No problems to add')
    const difficulty = String(ctx.params.difficulty ?? 'custom').slice(0, 40)
    const created = await saveProblems(ctx, String(ctx.params.sessionId), access.session, items, difficulty)
    if (created === 0) return fail('Could not save the problems')
    return ok({ created })
  },

  /** Student submits an answer; the model grades it against the hidden solution. */
  checkAnswer: async (ctx) => {
    const problemId = ctx.params.problemId
    const answer = String(ctx.params.answer ?? '').trim().slice(0, 4000)
    if (typeof problemId !== 'string' || !problemId) return fail('problemId is required')
    if (!answer) return fail('Write an answer first')

    const problemRes = await ctx.tools.get<ProblemData>('problems', problemId)
    const problem = problemRes.success ? (problemRes.data.record?.data ?? null) : null
    if (!problem) return fail('Problem not found')

    const access = await loadSession(ctx, problem.sessionId)
    if (!access.ok) return access.result

    const solRes = await ctx.tools.query<SolutionData>('solutions', {
      where: { problemId },
      limit: 1,
    })
    const solution = solRes.success ? solRes.data.records[0]?.data.solution : undefined
    if (!solution) return fail('This problem has no stored solution')

    const { text } = await generateText({
      model: modelFor(ctx),
      system:
        'You grade a student answer against a reference solution. Accept equivalent forms. ' +
        'Reply with ONLY JSON: {"correct": boolean, "feedback": string}. Feedback is 1-3 ' +
        'encouraging sentences that point at the mistake without revealing the full solution.',
      prompt: `Question: ${problem.question}\nReference solution: ${solution}\nStudent answer: ${answer}`,
    })

    let verdict: { correct?: unknown; feedback?: unknown }
    try {
      verdict = extractJson(text) as typeof verdict
    } catch {
      return fail('The AI reply could not be read. Try again.')
    }
    const correct = verdict.correct === true
    const feedback = typeof verdict.feedback === 'string' ? verdict.feedback : ''

    await ctx.tools.create('submissions', {
      problemId,
      sessionId: problem.sessionId,
      answer,
      correct: correct ? 1 : 0,
      feedback,
      ownerId: ctx.userId,
      // The tutor (problem owner) can review every attempt.
      studentIds: JSON.stringify(problem.ownerId === ctx.userId ? [] : [problem.ownerId]),
    })
    return ok({ correct, feedback })
  },

  /** Record an uploaded file against a session so every participant can see it. */
  shareSessionFile: async (ctx) => {
    const access = await loadSession(ctx, ctx.params.sessionId)
    if (!access.ok) return access.result
    const { fileName, fileKey, mimeType, fileSize } = ctx.params
    if (typeof fileName !== 'string' || typeof fileKey !== 'string' || !fileKey) {
      return fail('fileName and fileKey are required')
    }
    const res = await ctx.tools.create('session_files', {
      sessionId: String(ctx.params.sessionId),
      fileName: fileName.slice(0, 200),
      fileKey,
      mimeType: typeof mimeType === 'string' ? mimeType : 'application/octet-stream',
      fileSize: Number(fileSize) || 0,
      ownerId: ctx.userId,
      studentIds: collaboratorsFor(access.session, ctx.userId),
    })
    return res.success ? ok({ recordId: res.data.recordId }) : fail('Could not save the file')
  },
}
