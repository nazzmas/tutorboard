/**
 * Session room — whiteboard, AI practice problems, shared files you can mark
 * up together, and (for the tutor) an AI teaching assistant.
 *
 * Every query here is server-scoped by RecordRoom permissions; the
 * `where: { sessionId }` filters only pick this session out of the rows the
 * caller is already allowed to read.
 */

import { useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useR2Files, useUser, useUserLookup } from 'deepspace'
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from '@/components/ui'
import { CanvasView } from '@/components/canvas/CanvasView'
import { callAction, parseIds } from '@/lib/actions'
import { fileUrlToBase64, isViewable, useFilePages } from '@/hooks/useFilePages'
import type { Session } from './index'

interface Problem {
  sessionId: string
  question: string
  hint?: string
  difficulty?: string
  position?: number
  ownerId: string
}

interface Submission {
  problemId: string
  sessionId: string
  answer: string
  correct?: number
  feedback?: string
  ownerId: string
}

interface DraftProblem {
  question: string
  hint: string
  solution: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  fileName?: string
  problems?: DraftProblem[]
  added?: boolean
}

interface AttachedFile {
  recordId: string
  name: string
  mimeType: string
  url: string
}

interface SessionFile {
  sessionId: string
  fileName: string
  fileKey: string
  mimeType: string
  fileSize: number
  ownerId: string
}

export default function SessionRoomPage() {
  const { sessionId = '' } = useParams<{ sessionId: string }>()
  const { user } = useUser()
  const { getName } = useUserLookup()
  const { records: sessions, status } = useQuery<Session>('sessions')
  const session = sessions.find((s) => s.recordId === sessionId)

  // Tab and assistant state live here so they survive switching tabs.
  const [tab, setTab] = useState('board')
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<AttachedFile | null>(null)

  if (status === 'loading') {
    return <p className="p-8 text-sm text-muted-foreground">Loading session…</p>
  }
  if (!session) {
    return (
      <EmptyState
        title="Session not found"
        description="It may have been deleted, or you have not joined it yet."
      />
    )
  }

  const isTutor = session.data.ownerId === user?.id
  const students = parseIds(session.data.studentIds)

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <Link to="/sessions" className="text-xs text-muted-foreground hover:underline">
            ← All sessions
          </Link>
          <h1 className="truncate text-lg font-semibold text-foreground">{session.data.title}</h1>
          <p className="truncate text-sm text-muted-foreground">
            Tutor: {getName(session.data.ownerId) ?? 'Unknown'} · Students:{' '}
            {students.length ? students.map((id) => getName(id) ?? 'Student').join(', ') : 'none yet'}
          </p>
        </div>
        {isTutor && (
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-right">
            <p className="text-xs text-muted-foreground">Join code for students</p>
            <p data-testid="session-join-code" className="font-mono text-lg tracking-widest text-foreground">
              {session.data.joinCode}
            </p>
          </div>
        )}
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="flex min-h-0 flex-1 flex-col px-4 py-3">
        <TabsList>
          <TabsTrigger value="board">Whiteboard</TabsTrigger>
          <TabsTrigger value="practice">Practice</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          {isTutor && <TabsTrigger value="assistant">AI Assistant</TabsTrigger>}
        </TabsList>
        <TabsContent value="board" className="min-h-[480px] overflow-hidden rounded-lg border border-border">
          {/* The canvas room id is the session id; the worker only lets this session's members in. */}
          <CanvasView docId={sessionId} className="h-full min-h-[480px]" />
        </TabsContent>
        <TabsContent value="practice" className="overflow-y-auto">
          <PracticePanel sessionId={sessionId} isTutor={isTutor} defaultTopic={session.data.topic ?? ''} />
        </TabsContent>
        <TabsContent value="files" className="flex min-h-[480px] flex-col">
          <FilesPanel
            sessionId={sessionId}
            isTutor={isTutor}
            onAskAi={(file) => {
              setAttached(file)
              setDraft(
                'Review this homework. Tell me what the student got right, explain each mistake, ' +
                  'and write 3 similar practice problems for the parts they struggled with.',
              )
              setTab('assistant')
            }}
          />
        </TabsContent>
        {isTutor && (
          <TabsContent value="assistant" className="flex min-h-[480px] flex-col">
            <AssistantPanel
              sessionId={sessionId}
              topic={session.data.topic ?? ''}
              chat={chat}
              setChat={setChat}
              draft={draft}
              setDraft={setDraft}
              attached={attached}
              setAttached={setAttached}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Practice problems
// ---------------------------------------------------------------------------

function PracticePanel({
  sessionId,
  isTutor,
  defaultTopic,
}: {
  sessionId: string
  isTutor: boolean
  defaultTopic: string
}) {
  const toast = useToast()
  const { getName } = useUserLookup()
  const { records: problemRows } = useQuery<Problem>('problems', { where: { sessionId } })
  const { records: submissions } = useQuery<Submission>('submissions', { where: { sessionId } })
  const { records: solutions } = useQuery<{ problemId: string; solution: string }>('solutions', {
    where: { sessionId },
  })

  const [topic, setTopic] = useState(defaultTopic)
  const [count, setCount] = useState(3)
  const [level, setLevel] = useState('medium')
  const [instructions, setInstructions] = useState('')
  const [generating, setGenerating] = useState(false)

  const problems = useMemo(
    () => [...problemRows].sort((a, b) => (a.data.position ?? 0) - (b.data.position ?? 0)),
    [problemRows],
  )

  const generate = async () => {
    setGenerating(true)
    const res = await callAction<{ created: number }>('generateProblems', {
      sessionId,
      topic,
      count,
      level,
      instructions,
    })
    setGenerating(false)
    if (res.success) toast.success(`Added ${res.data.created} problem${res.data.created === 1 ? '' : 's'}`)
    else toast.error(res.error)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 py-2">
      {isTutor && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-medium text-foreground">Generate practice problems</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Input
              className="min-w-[200px] flex-1"
              placeholder="Topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
            <select
              aria-label="Difficulty"
              className="h-10 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
            <select
              aria-label="Number of problems"
              className="h-10 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} problem{n === 1 ? '' : 's'}
                </option>
              ))}
            </select>
            <Button onClick={generate} disabled={!topic.trim()} loading={generating}>
              Generate
            </Button>
          </div>
          <Textarea
            className="mt-2"
            rows={2}
            placeholder="Optional: what kind of problems? e.g. word problems about trains and speed, include units, 2 steps each"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Want something more specific? Ask in the AI Assistant tab and add its problems here with one click.
          </p>
        </section>
      )}

      {problems.length === 0 ? (
        <EmptyState
          title="No problems yet"
          description={isTutor ? 'Generate a set above.' : 'Your tutor has not added problems yet.'}
        />
      ) : (
        problems.map((p, i) => (
          <ProblemCard
            key={p.recordId}
            index={i + 1}
            problemId={p.recordId}
            problem={p.data}
            isTutor={isTutor}
            solution={solutions.find((s) => s.data.problemId === p.recordId)?.data.solution}
            attempts={submissions
              .filter((s) => s.data.problemId === p.recordId)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((s) => ({ ...s.data, id: s.recordId, by: getName(s.data.ownerId) ?? 'Student' }))}
          />
        ))
      )}
    </div>
  )
}

function ProblemCard({
  index,
  problemId,
  problem,
  isTutor,
  solution,
  attempts,
}: {
  index: number
  problemId: string
  problem: Problem
  isTutor: boolean
  solution?: string
  attempts: (Submission & { id: string; by: string })[]
}) {
  const toast = useToast()
  const [answer, setAnswer] = useState('')
  const [checking, setChecking] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [showSolution, setShowSolution] = useState(false)

  const check = async () => {
    setChecking(true)
    const res = await callAction<{ correct: boolean; feedback: string }>('checkAnswer', { problemId, answer })
    setChecking(false)
    if (!res.success) {
      toast.error(res.error)
      return
    }
    setAnswer('')
    if (res.data.correct) toast.success('Correct!', res.data.feedback)
    else toast.error('Not quite yet', res.data.feedback)
  }

  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-foreground">Problem {index}</h3>
        {problem.difficulty && <Badge variant="outline">{problem.difficulty}</Badge>}
      </div>
      <p className="mt-2 whitespace-pre-wrap text-foreground">{problem.question}</p>

      {problem.hint && (
        <button className="mt-2 text-sm text-primary hover:underline" onClick={() => setShowHint((v) => !v)}>
          {showHint ? 'Hide hint' : 'Show hint'}
        </button>
      )}
      {showHint && <p className="mt-1 text-sm text-muted-foreground">{problem.hint}</p>}

      {isTutor ? (
        solution && (
          <div className="mt-3">
            <button className="text-sm text-primary hover:underline" onClick={() => setShowSolution((v) => !v)}>
              {showSolution ? 'Hide solution' : 'Show solution (tutor only)'}
            </button>
            {showSolution && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{solution}</p>}
          </div>
        )
      ) : (
        <div className="mt-3 space-y-2">
          <Textarea
            placeholder="Your answer and work"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={3}
          />
          <Button onClick={check} disabled={!answer.trim()} loading={checking}>
            Check answer
          </Button>
        </div>
      )}

      {attempts.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-border pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {isTutor ? 'Student attempts' : 'Your attempts'}
          </p>
          {attempts.map((a) => (
            <div key={a.id} className="rounded-md bg-muted/40 p-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant={a.correct ? 'success' : 'warning'} size="sm">
                  {a.correct ? 'Correct' : 'Try again'}
                </Badge>
                {isTutor && <span className="text-muted-foreground">{a.by}</span>}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-foreground">{a.answer}</p>
              {a.feedback && <p className="mt-1 text-muted-foreground">{a.feedback}</p>}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Shared files
// ---------------------------------------------------------------------------

function FilesPanel({
  sessionId,
  isTutor,
  onAskAi,
}: {
  sessionId: string
  isTutor: boolean
  onAskAi: (file: AttachedFile) => void
}) {
  const toast = useToast()
  const { user } = useUser()
  const { getName } = useUserLookup()
  // App-scope uploads under an unguessable per-session path. See README for
  // why this tradeoff was chosen over per-user private storage.
  const { upload, isUploading } = useR2Files({ scope: 'app' })
  const { records } = useQuery<SessionFile>('session_files', { where: { sessionId } })
  const files = useMemo(() => [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [records])
  const [openId, setOpenId] = useState<string | null>(null)
  const open = files.find((f) => f.recordId === openId)

  const onPick = async (file: File | undefined) => {
    if (!file) return
    const key = `sessions/${sessionId}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, '_')}`
    const result = await upload(file, file.name, { key })
    if (!result.success || !result.url) {
      toast.error(result.error ?? 'Upload failed')
      return
    }
    const saved = await callAction<{ recordId: string }>('shareSessionFile', {
      sessionId,
      fileName: file.name,
      fileKey: result.url,
      mimeType: file.type || 'application/octet-stream',
      fileSize: file.size,
    })
    if (saved.success) {
      toast.success('File shared with the session')
      if (isViewable(file.type)) setOpenId(saved.data.recordId)
    } else toast.error(saved.error)
  }

  if (open) {
    return (
      <FileViewer
        sessionId={sessionId}
        file={open}
        isTutor={isTutor}
        onClose={() => setOpenId(null)}
        onAskAi={onAskAi}
      />
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 py-2">
      <label className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-border bg-card p-6 text-center hover:bg-muted/30">
        <span className="font-medium text-foreground">{isUploading ? 'Uploading…' : 'Upload homework or notes'}</span>
        <span className="text-sm text-muted-foreground">
          Photos or PDFs open right here so you can both write on them live.
        </span>
        <input
          type="file"
          accept="image/*,application/pdf,.doc,.docx,.txt"
          className="hidden"
          disabled={isUploading}
          onChange={(e) => {
            void onPick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </label>

      {files.length === 0 ? (
        <EmptyState title="No files yet" description="Upload homework or worksheets to work on them together." />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {files.map((f) => (
            <li key={f.recordId} className="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                onClick={() => setOpenId(f.recordId)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                {f.data.mimeType.startsWith('image/') ? (
                  <img src={f.data.fileKey} alt="" className="h-12 w-12 rounded object-cover" />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded bg-muted text-xs text-muted-foreground">
                    {f.data.fileName.split('.').pop()?.toUpperCase() ?? 'FILE'}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground hover:underline">{f.data.fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {f.data.ownerId === user?.id ? 'You' : (getName(f.data.ownerId) ?? 'Someone')} ·{' '}
                    {Math.max(1, Math.round(f.data.fileSize / 1024))} KB
                  </p>
                </div>
              </button>
              <Button size="sm" variant="outline" onClick={() => setOpenId(f.recordId)}>
                Open
              </Button>
              {isTutor && isViewable(f.data.mimeType) && (
                <Button
                  size="sm"
                  onClick={() =>
                    onAskAi({
                      recordId: f.recordId,
                      name: f.data.fileName,
                      mimeType: f.data.mimeType,
                      url: f.data.fileKey,
                    })
                  }
                >
                  Ask AI
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A shared file shown inline, with a live annotation layer both people can draw on. */
function FileViewer({
  sessionId,
  file,
  isTutor,
  onClose,
  onAskAi,
}: {
  sessionId: string
  file: { recordId: string; data: SessionFile }
  isTutor: boolean
  onClose: () => void
  onAskAi: (file: AttachedFile) => void
}) {
  const pages = useFilePages(file.data.fileKey, file.data.mimeType)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={onClose}>
          ← All files
        </Button>
        <p className="min-w-0 flex-1 truncate font-medium text-foreground">{file.data.fileName}</p>
        {isTutor && isViewable(file.data.mimeType) && (
          <Button
            size="sm"
            onClick={() =>
              onAskAi({
                recordId: file.recordId,
                name: file.data.fileName,
                mimeType: file.data.mimeType,
                url: file.data.fileKey,
              })
            }
          >
            Ask AI about this
          </Button>
        )}
      </div>

      {pages.status === 'loading' && <p className="p-6 text-sm text-muted-foreground">Opening file…</p>}
      {pages.status === 'error' && <p className="p-6 text-sm text-destructive">{pages.message}</p>}
      {pages.status === 'unsupported' && (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          This file type can&apos;t be shown here yet. Upload a photo or PDF to mark it up together, or{' '}
          <a href={file.data.fileKey} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            download it
          </a>
          .
        </div>
      )}
      {pages.status === 'ready' && (
        <div className="min-h-[520px] flex-1 overflow-hidden rounded-lg border border-border">
          {/* Separate canvas per file; the worker checks the session prefix before letting anyone in. */}
          <CanvasView
            docId={`${sessionId}__file__${file.recordId}`}
            background={pages.pages}
            className="h-full min-h-[520px]"
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// AI assistant (tutor only)
// ---------------------------------------------------------------------------

function AssistantPanel({
  sessionId,
  topic,
  chat,
  setChat,
  draft,
  setDraft,
  attached,
  setAttached,
}: {
  sessionId: string
  topic: string
  chat: ChatMessage[]
  setChat: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  draft: string
  setDraft: (v: string) => void
  attached: AttachedFile | null
  setAttached: (f: AttachedFile | null) => void
}) {
  const toast = useToast()
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const subject = topic || 'this topic'
  const suggestions = [
    `Write 3 word problems about ${subject} with real-world context`,
    `Write 2 hard multi-step problems on ${subject}`,
    `What are common mistakes students make with ${subject}, and how do I explain them?`,
    `Give me a 5-minute warm-up for ${subject}`,
  ]

  const send = async (text: string) => {
    const content = text.trim()
    if (!content || sending) return
    const userMsg: ChatMessage = { role: 'user', content, fileName: attached?.name }
    const next = [...chat, userMsg]
    setChat(next)
    setDraft('')
    setSending(true)

    let file: { name: string; mimeType: string; base64: string } | undefined
    if (attached) {
      try {
        file = { name: attached.name, mimeType: attached.mimeType, base64: await fileUrlToBase64(attached.url) }
      } catch (err) {
        setSending(false)
        toast.error(err instanceof Error ? err.message : 'Could not read the file')
        return
      }
    }

    const res = await callAction<{ reply: string; problems: DraftProblem[] }>('askAssistant', {
      sessionId,
      messages: next.map((m) => ({ role: m.role, content: m.content })),
      file,
    })
    setSending(false)
    if (!res.success) {
      toast.error(res.error)
      setChat(chat)
      setDraft(content)
      return
    }
    setAttached(null)
    setChat([...next, { role: 'assistant', content: res.data.reply, problems: res.data.problems }])
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  const addToPractice = async (index: number) => {
    const msg = chat[index]
    if (!msg?.problems?.length) return
    const res = await callAction<{ created: number }>('addProblems', { sessionId, problems: msg.problems })
    if (!res.success) {
      toast.error(res.error)
      return
    }
    toast.success(`Added ${res.data.created} problem${res.data.created === 1 ? '' : 's'} to Practice`)
    setChat((c) => c.map((m, i) => (i === index ? { ...m, added: true } : m)))
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-3 py-2">
      <div className="flex-1 space-y-3">
        {chat.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="font-medium text-foreground">Your teaching assistant</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Ask for any kind of problem, get ideas for explaining something, or open a student&apos;s homework in
              Files and click Ask AI. Only you can see this tab.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setDraft(s)}
                  className="rounded-full border border-border px-3 py-1 text-left text-xs text-foreground hover:bg-muted/50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {chat.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
                m.role === 'user' ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-foreground'
              }`}
            >
              {m.fileName && <p className="mb-1 text-xs opacity-80">📎 {m.fileName}</p>}
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.problems && m.problems.length > 0 && (
                <div className="mt-3 space-y-2">
                  {m.problems.map((p, j) => (
                    <DraftProblemCard key={j} index={j + 1} problem={p} />
                  ))}
                  <Button size="sm" disabled={m.added} onClick={() => void addToPractice(i)}>
                    {m.added ? 'Added to Practice' : `Add ${m.problems.length} to Practice`}
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
        {sending && <p className="text-sm text-muted-foreground">Thinking…</p>}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-0 space-y-2 rounded-lg border border-border bg-card p-3">
        {attached && (
          <div className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1 text-xs text-foreground">
            <span className="truncate">📎 {attached.name}</span>
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setAttached(null)}>
              Remove
            </button>
          </div>
        )}
        <Textarea
          rows={3}
          placeholder="Ask for problems, explanations, or a homework review…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send(draft)
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
          <Button onClick={() => void send(draft)} disabled={!draft.trim()} loading={sending}>
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}

function DraftProblemCard({ index, problem }: { index: number; problem: DraftProblem }) {
  const [showSolution, setShowSolution] = useState(false)
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <p className="text-xs font-medium text-muted-foreground">Problem {index}</p>
      <p className="mt-1 whitespace-pre-wrap text-foreground">{problem.question}</p>
      <button type="button" className="mt-1 text-xs text-primary hover:underline" onClick={() => setShowSolution((v) => !v)}>
        {showSolution ? 'Hide solution' : 'Show solution'}
      </button>
      {showSolution && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{problem.solution}</p>}
    </div>
  )
}
