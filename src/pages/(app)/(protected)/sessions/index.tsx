/**
 * Sessions list — tutors create sessions, students join one with a code.
 * The query only returns sessions the caller owns or was added to
 * (RecordRoom 'collaborator' read rule), so there is no client-side filter.
 */

import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutations, useQuery, useUser } from 'deepspace'
import { Badge, Button, EmptyState, Input, useToast } from '@/components/ui'
import { callAction, makeJoinCode, parseIds } from '@/lib/actions'

export interface Session {
  title: string
  topic?: string
  joinCode: string
  ownerId: string
  studentIds?: string
}

export default function SessionsPage() {
  const { user } = useUser()
  const navigate = useNavigate()
  const toast = useToast()
  const { records, status } = useQuery<Session>('sessions')
  const { createConfirmed, ready } = useMutations<Session>('sessions')

  const [title, setTitle] = useState('')
  const [topic, setTopic] = useState('')
  const [code, setCode] = useState('')
  const [creating, setCreating] = useState(false)
  const [joining, setJoining] = useState(false)

  const sessions = useMemo(
    () => [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [records],
  )

  const handleCreate = async () => {
    if (!title.trim()) return
    setCreating(true)
    try {
      const id = await createConfirmed({
        title: title.trim(),
        topic: topic.trim(),
        joinCode: makeJoinCode(),
      } as Session)
      setTitle('')
      setTopic('')
      navigate(`/sessions/${id}`)
    } catch {
      toast.error('Could not create the session')
    } finally {
      setCreating(false)
    }
  }

  const handleJoin = async () => {
    setJoining(true)
    const res = await callAction<{ sessionId: string }>('joinSession', { code })
    setJoining(false)
    if (!res.success) {
      toast.error(res.error)
      return
    }
    setCode('')
    navigate(`/sessions/${res.data.sessionId}`)
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-foreground">Tutoring sessions</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Start a session as the tutor, or join one with the code your tutor shared.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="font-medium text-foreground">Start a session</h2>
          <div className="mt-3 space-y-2">
            <Input
              data-testid="session-title"
              placeholder="Title, e.g. Calc I with Maya"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Input
              data-testid="session-topic"
              placeholder="Topic, e.g. chain rule"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
            <Button
              data-testid="session-create"
              className="w-full"
              onClick={handleCreate}
              disabled={!ready || !title.trim()}
              loading={creating}
            >
              Create session
            </Button>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="font-medium text-foreground">Join with a code</h2>
          <div className="mt-3 space-y-2">
            <Input
              data-testid="join-code"
              placeholder="6-character code"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && handleJoin()}
            />
            <Button
              data-testid="join-submit"
              variant="secondary"
              className="w-full"
              onClick={handleJoin}
              disabled={code.length !== 6}
              loading={joining}
            >
              Join session
            </Button>
          </div>
        </section>
      </div>

      <h2 className="mt-10 text-lg font-medium text-foreground">Your sessions</h2>
      {status === 'loading' ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : sessions.length === 0 ? (
        <EmptyState
          title="No sessions yet"
          description="Create one above, or ask your tutor for a join code."
        />
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
          {sessions.map((s) => {
            const isTutor = s.data.ownerId === user?.id
            const students = parseIds(s.data.studentIds).length
            return (
              <li key={s.recordId}>
                <Link
                  to={`/sessions/${s.recordId}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{s.data.title}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {s.data.topic || 'No topic'} · {students} student{students === 1 ? '' : 's'}
                    </p>
                  </div>
                  <Badge variant={isTutor ? 'default' : 'secondary'}>{isTutor ? 'Tutor' : 'Student'}</Badge>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
