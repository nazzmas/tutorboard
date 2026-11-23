/**
 * TutorBoard schemas.
 *
 * Access model: a tutor owns a session; students are added to the session's
 * `studentIds` collaborator list by the `joinSession` server action (students
 * cannot edit that list themselves). Every session-scoped collection copies
 * the same collaborator list so RecordRoom's 'collaborator' rule
 * (owner OR listed collaborator) scopes reads server-side.
 *
 * Problems and their solutions are split on purpose: students can read a
 * problem but never its solution row, which only the tutor ('own') can read.
 * Answer checking happens in a server action that reads the solution with
 * RBAC off and returns only feedback.
 */

import type { CollectionSchema } from 'deepspace/schema'

const ownerColumn = {
  name: 'ownerId',
  storage: 'text',
  interpretation: 'plain',
  required: true,
  userBound: true,
  immutable: true,
} as const

const collaboratorsColumn = {
  name: 'studentIds',
  storage: 'text',
  interpretation: 'plain',
  default: '[]',
} as const

export const sessionsSchema: CollectionSchema = {
  name: 'sessions',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain', required: true, maxLength: 120 },
    { name: 'topic', storage: 'text', interpretation: 'plain', maxLength: 200 },
    { name: 'joinCode', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { ...ownerColumn },
    { ...collaboratorsColumn },
  ],
  ownerField: 'ownerId',
  collaboratorsField: 'studentIds',
  permissions: {
    viewer: { read: 'collaborator', create: false, update: false, delete: false },
    // Tutors create sessions and may rename them; the student list is only
    // ever changed by the joinSession action.
    member: {
      read: 'collaborator',
      create: true,
      update: 'own',
      delete: 'own',
      writableFields: ['title', 'topic', 'joinCode'],
    },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

export const problemsSchema: CollectionSchema = {
  name: 'problems',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'question', storage: 'text', interpretation: 'plain', required: true },
    { name: 'hint', storage: 'text', interpretation: 'plain' },
    { name: 'difficulty', storage: 'text', interpretation: 'plain' },
    { name: 'position', storage: 'number', interpretation: 'plain' },
    { ...ownerColumn },
    { ...collaboratorsColumn },
  ],
  ownerField: 'ownerId',
  collaboratorsField: 'studentIds',
  permissions: {
    viewer: { read: 'collaborator', create: false, update: false, delete: false },
    // Problems are only created by the generateProblems action.
    member: { read: 'collaborator', create: false, update: false, delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

export const solutionsSchema: CollectionSchema = {
  name: 'solutions',
  columns: [
    { name: 'problemId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'solution', storage: 'text', interpretation: 'plain', required: true },
    { ...ownerColumn },
  ],
  ownerField: 'ownerId',
  permissions: {
    viewer: { read: false, create: false, update: false, delete: false },
    // Only the tutor who generated the problem can read the worked solution.
    member: { read: 'own', create: false, update: false, delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

export const submissionsSchema: CollectionSchema = {
  name: 'submissions',
  columns: [
    { name: 'problemId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'answer', storage: 'text', interpretation: 'plain', required: true, maxLength: 4000 },
    { name: 'correct', storage: 'number', interpretation: 'plain' },
    { name: 'feedback', storage: 'text', interpretation: 'plain' },
    { ...ownerColumn },
    // The tutor is the single collaborator, so the tutor sees every student's
    // attempts while students only see their own.
    { ...collaboratorsColumn },
  ],
  ownerField: 'ownerId',
  collaboratorsField: 'studentIds',
  permissions: {
    viewer: { read: 'collaborator', create: false, update: false, delete: false },
    // Submissions are only created by the checkAnswer action.
    member: { read: 'collaborator', create: false, update: false, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

export const sessionFilesSchema: CollectionSchema = {
  name: 'session_files',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'fileName', storage: 'text', interpretation: 'plain', required: true },
    { name: 'fileKey', storage: 'text', interpretation: 'plain', required: true },
    { name: 'mimeType', storage: 'text', interpretation: 'plain', required: true },
    { name: 'fileSize', storage: 'number', interpretation: 'plain', required: true },
    { ...ownerColumn },
    { ...collaboratorsColumn },
  ],
  ownerField: 'ownerId',
  collaboratorsField: 'studentIds',
  permissions: {
    viewer: { read: 'collaborator', create: false, update: false, delete: false },
    // Rows are written by the shareSessionFile action, which checks session
    // membership and copies the participant list.
    member: { read: 'collaborator', create: false, update: false, delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

export const tutoringSchemas: CollectionSchema[] = [
  sessionsSchema,
  problemsSchema,
  solutionsSchema,
  submissionsSchema,
  sessionFilesSchema,
]
