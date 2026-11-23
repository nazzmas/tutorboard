# TutorBoard

One room for a tutoring session: a live shared whiteboard, AI practice problems that grade
themselves without revealing the answer, homework you can mark up together in real time, and a
tutor-only AI teaching assistant.

Built on the [DeepSpace SDK](https://docs.deep.space).

## How it works

1. A tutor creates a session and gets a 6-character join code.
2. A student enters the code and is added to that session only.
3. Inside the session:
   - **Whiteboard**: a collaborative canvas with freehand pen, highlighter, shapes, typed text
     and live cursors. Scroll to move, Ctrl/Cmd + scroll to zoom.
   - **Practice**: the tutor generates problems on a topic, with optional free-text instructions
     ("word problems about trains, include units"). Students answer, and an AI grader compares
     their answer to a hidden worked solution and gives a hint-style nudge. The tutor sees every
     attempt.
   - **Files**: photos and PDFs open inside the session (PDF pages are rendered in the browser
     with PDF.js) on their own shared canvas, so tutor and student can write on the homework
     together live.
   - **AI Assistant (tutor only)**: a chat for asking for any kind of problem, teaching ideas, or
     a review of a student's homework file. Problems it writes can be added to Practice with one
     click, with their solutions kept hidden from students.

## DeepSpace pieces used

| Piece | Where | Why |
|---|---|---|
| Auth + RecordRoom RBAC (`ownerField`, `collaboratorsField`, `read: 'collaborator'`) | `src/schemas/tutoring-schema.ts` | Each session, problem, submission and file is readable only by that session's tutor and students, enforced by the server rather than by UI filters. |
| Realtime records (`useQuery`, `useMutations`) | `src/pages/(app)/(protected)/sessions/` | Problems, attempts and files appear live for everyone in the session. |
| Canvas room (`CanvasRoom`, `useCanvas`) | `src/components/canvas/`, `src/server/realtime-routes.ts` | The whiteboard and the per-file markup layers. Canvas ids are the session id or `<sessionId>__file__<fileId>`, and the WebSocket route checks session membership before connecting. |
| Server actions | `src/actions/index.ts` | `joinSession`, `generateProblems`, `checkAnswer`, `shareSessionFile`, `askAssistant`, `addProblems`. Actions run with RBAC off, so each one checks the caller belongs to the session first. |
| AI (`createDeepSpaceAI`, Anthropic) | `src/actions/index.ts` | Generates problems and grades answers. Billed to the calling user's token. |
| R2 file storage (`useR2Files`) | Files tab | Homework uploads. |

## Main tradeoff

Problems and their solutions live in **separate collections**. Students can read a problem but
never its `solutions` row, which only the tutor can read. Grading happens in a server action that
reads the solution with elevated access and returns only `{ correct, feedback }`. That costs an
extra collection and an AI call per check, but it is the only way to give instant feedback without
shipping the answer key to the student's browser.

## What I left out, and why

- **Video (LiveKit)**: tutors already use Zoom or FaceTime; adding video would have taken most of the
  time budget without improving the core loop.
- **Payments (Stripe)**: real, but separate from the session itself and adds setup without making a
  session better to use.
- **Chat (messaging feature)**: the SDK's messaging is public-channel only, and session chat must be
  private, so I did not bolt it on.

## Known limits / next steps

- Files are uploaded to app-scoped storage under an unguessable per-session path, and the URL is
  only stored on records that session's members can read. That is "anyone with the link" sharing.
  Next step: serve files through a worker route that checks session membership before streaming.
- The student list is snapshotted onto problems and files; `joinSession` back-fills it for late
  joiners. Removing a student from a session is not built yet.
- AI output is parsed as JSON with a tolerant extractor; a malformed reply shows a retry message.

## Run it

```bash
npm install
npx deepspace auth login
npx deepspace app init --json   # registers the app and its id
npx deepspace dev start
npx deepspace test run all       # includes the two-user join test in tests/tutoring.spec.ts
npx deepspace deploy
```
