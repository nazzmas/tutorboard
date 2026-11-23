/**
 * TutorBoard home — what the app is for, and the way in.
 */

import { Link } from 'react-router-dom'
import { useAuthProfileReady } from 'deepspace'
import { Button } from '@/components/ui'

const FEATURES = [
  {
    title: 'Shared whiteboard',
    body: 'Tutor and student draw on the same board live, with each other’s cursors visible.',
  },
  {
    title: 'AI practice problems',
    body: 'The tutor generates a problem set on any topic. Students get feedback on each answer without seeing the solution.',
  },
  {
    title: 'Homework uploads',
    body: 'Students drop in photos or PDFs of their work so the tutor sees it before and during the session.',
  },
]

export default function HomePage() {
  const { isSignedIn, user } = useAuthProfileReady({ requireUser: true })

  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col justify-center gap-10 px-6 py-16 text-foreground">
      <div className="space-y-4">
        <p className="text-sm font-medium uppercase tracking-wide text-primary">TutorBoard</p>
        <h1 className="text-4xl font-semibold leading-tight">One room for a tutoring session.</h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          A whiteboard, practice problems that check themselves, and the student’s homework, shared between a
          tutor and their students in real time.
        </p>
        <div className="flex items-center gap-3">
          <Link to="/sessions">
            <Button size="lg">{isSignedIn ? 'Go to your sessions' : 'Get started'}</Button>
          </Link>
          {isSignedIn && user && (
            <span className="text-sm text-muted-foreground">Signed in as {user.name ?? user.email}</span>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-lg border border-border bg-card p-4">
            <h2 className="font-medium">{f.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
