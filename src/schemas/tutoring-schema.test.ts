import { describe, expect, it } from 'vitest'
import { canRead } from 'deepspace/worker'
import type { CollectionSchema } from 'deepspace/schema'
import { problemsSchema, sessionsSchema, solutionsSchema, submissionsSchema } from './tutoring-schema'
import { extractJson, parseIds } from '../actions/index'

const tutor = 'user_tutor'
const student = 'user_student'
const stranger = 'user_stranger'

// Uses the SDK's own RecordRoom read check, so these tests exercise the real rule.
function reads(schema: CollectionSchema, record: ReturnType<typeof rec>, userId: string) {
  return canRead(schema, 'member', record, userId)
}

function rec(data: Record<string, unknown>) {
  return { data, createdBy: data.ownerId as string }
}

describe('tutoring access rules', () => {
  const session = rec({ ownerId: tutor, studentIds: JSON.stringify([student]) })

  it('lets the tutor and enrolled students read a session, but not strangers', () => {
    expect(reads(sessionsSchema, session, tutor)).toBe(true)
    expect(reads(sessionsSchema, session, student)).toBe(true)
    expect(reads(sessionsSchema, session, stranger)).toBe(false)
  })

  it('never lets members write the student list directly', () => {
    expect(sessionsSchema.permissions.member.writableFields).not.toContain('studentIds')
  })

  it('hides solutions from students', () => {
    const solution = rec({ ownerId: tutor })
    expect(reads(solutionsSchema, solution, tutor)).toBe(true)
    expect(reads(solutionsSchema, solution, student)).toBe(false)
  })

  it('shows a submission to its student and the tutor only', () => {
    const sub = rec({ ownerId: student, studentIds: JSON.stringify([tutor]) })
    expect(reads(submissionsSchema, sub, student)).toBe(true)
    expect(reads(submissionsSchema, sub, tutor)).toBe(true)
    expect(reads(submissionsSchema, sub, stranger)).toBe(false)
  })

  it('only lets actions create problems', () => {
    expect(problemsSchema.permissions.member.create).toBe(false)
    expect(submissionsSchema.permissions.member.create).toBe(false)
  })
})

describe('action helpers', () => {
  it('reads JSON from fenced or chatty model replies', () => {
    expect(extractJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }])
    expect(extractJson('Here you go: {"correct": true, "feedback": "ok"}')).toEqual({
      correct: true,
      feedback: 'ok',
    })
    expect(() => extractJson('no json here')).toThrow()
  })

  it('parses collaborator lists defensively', () => {
    expect(parseIds('["a","b"]')).toEqual(['a', 'b'])
    expect(parseIds('not json')).toEqual([])
    expect(parseIds(undefined)).toEqual([])
  })
})

describe('assistant and canvas helpers', () => {
  it('keeps only complete problems and caps the count', async () => {
    const { cleanProblems } = await import('../actions/index')
    const out = cleanProblems(
      [
        { question: 'Q1', hint: 'h', solution: 'S1' },
        { question: 'no solution' },
        { question: '  ', solution: 'blank question' },
        { question: 'Q2', solution: 'S2' },
      ],
      5,
    )
    expect(out).toEqual([
      { question: 'Q1', hint: 'h', solution: 'S1' },
      { question: 'Q2', hint: '', solution: 'S2' },
    ])
    expect(cleanProblems('not a list')).toEqual([])
  })

  it('maps whiteboard and file canvases back to their session', async () => {
    const { canvasSessionId } = await import('../server/realtime-routes')
    expect(canvasSessionId('sess1')).toBe('sess1')
    expect(canvasSessionId('sess1__file__f9')).toBe('sess1')
    expect(canvasSessionId('sess1__file__')).toBeNull()
    expect(canvasSessionId('__file__f9')).toBeNull()
    expect(canvasSessionId('a__file__b__file__c')).toBeNull()
  })

  it('turns a freehand stroke into a small relative path', async () => {
    const { simplifyStroke, strokeToShape } = await import('../components/canvas/CanvasView')
    const pts = [
      { x: 10, y: 10 },
      { x: 10.2, y: 10.1 },
      { x: 20, y: 30 },
    ]
    const simple = simplifyStroke(pts)
    expect(simple).toHaveLength(2)
    expect(strokeToShape(simple)).toEqual({ x: 10, y: 10, width: 10, height: 20, points: '0,0 10,20' })
  })
})
