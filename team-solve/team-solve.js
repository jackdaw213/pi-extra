export const meta = {
  name: 'team-solve',
  description: 'Team-solve a coding task: plan, two divergent proposals, one implementer, captured test run, adversarial review, one capped repair round, final verify gate. Pattern ported from memdoor examples/workflows/team-solve.',
  phases: [
    { title: 'Plan' },
    { title: 'Ideate' },
    { title: 'Solve' },
    { title: 'Test' },
    { title: 'Review' },
    { title: 'Repair' },
    { title: 'Verify' },
  ],
}

// args: { task: string, testCommand?: string, scratchDir?: string }
// Args may arrive JSON-stringified depending on the caller — accept both.
let a = args
if (typeof a === 'string') {
  try { a = JSON.parse(a) } catch { a = {} }
}
// Evidence ledger: plan.md, proposal-a.md, proposal-b.md, solution-notes.md,
// test-output.txt. Default location is /tmp/team-solve/<epoch>/ — the plan
// agent creates it (the script itself cannot call Date.now()); args.scratchDir
// overrides. Downstream agents read artifacts from disk, never trust upstream
// claims. testCommand runs from the session cwd and must exit 0.
const OVERRIDE = (a && a.scratchDir) || null
const TASK = a && a.task
if (!TASK || typeof TASK !== 'string') {
  return { error: 'args.task (string) is required' }
}
const TEST = (a && a.testCommand) || null

const DISCIPLINE =
  'Work fresh: read the files from disk before deciding; never rely on another agent\'s claims. ' +
  'When done, verify your output file exists and re-read it once.'

const PLAN_SCHEMA = {
  type: 'object', required: ['goal', 'angleA', 'angleB', 'runDir'],
  properties: {
    goal: { type: 'string' }, angleA: { type: 'string' }, angleB: { type: 'string' },
    runDir: { type: 'string' },
  },
}
const NOTE_SCHEMA = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } }
const SOLVE_SCHEMA = {
  type: 'object', required: ['changedFiles', 'approach'],
  properties: { changedFiles: { type: 'array', items: { type: 'string' } }, approach: { type: 'string' } },
}
const TEST_SCHEMA = {
  type: 'object', required: ['pass', 'outputTail'],
  properties: { pass: { type: 'boolean' }, outputTail: { type: 'string' } },
}
const REVIEW_SCHEMA = {
  type: 'object', required: ['verdict', 'reasons'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request-changes'] },
    reasons: { type: 'array', items: { type: 'string' } },
  },
}

// 1 — Plan: create the run dir, restate the goal, split into two angles.
const dirInstruction = OVERRIDE
  ? `The run directory is "${OVERRIDE}" — mkdir -p it first and use it for everything below.`
  : `First run this in bash: mkdir -p "/tmp/team-solve/$(date +%s)". Use that exact directory as the run directory for everything below, and report it as runDir.`
const plan = await agent(
  `${dirInstruction}\nThen read the task below. Write <run directory>/plan.md: a one-paragraph restatement of the goal, the constraints, and the definition of done. Then invent TWO deliberately divergent implementation angles (A and B) — different structure, not cosmetic variants — and describe each in 2-3 sentences. ${DISCIPLINE}\n\nTASK: ${TASK}`,
  { label: 'plan', phase: 'Plan', schema: PLAN_SCHEMA })
if (!plan) return { error: 'plan agent failed' }
const SCRATCH = OVERRIDE ||
  (plan.runDir && typeof plan.runDir === 'string' && plan.runDir.startsWith('/tmp/team-solve/')
    ? plan.runDir
    : '/tmp/team-solve/run')

// 2 — Ideate: both angles in parallel. Barrier is required: the solver reads both.
const ideas = (await parallel([
  ['a', plan.angleA], ['b', plan.angleB],
].map(([k, angle]) => () =>
  agent(
    `Read ${SCRATCH}/plan.md. Write ${SCRATCH}/proposal-${k}.md for this angle: "${angle}" — concrete approach, step list, main risk. 10 lines max. ${DISCIPLINE}\n\nTASK: ${TASK}`,
    { label: `ideate-${k}`, phase: 'Ideate', schema: NOTE_SCHEMA }))))
  .filter(Boolean)
if (ideas.length === 0) return { error: 'both ideation agents failed' }

// 3 — Solve: pick or merge the strongest proposal, implement it.
const solved = await agent(
  `Read ${SCRATCH}/plan.md, ${SCRATCH}/proposal-a.md and ${SCRATCH}/proposal-b.md. Pick the stronger approach (merging is allowed) and implement the task in the current working directory. Write ${SCRATCH}/solution-notes.md: what you changed, the exact file paths touched, and how it satisfies the definition of done. Do not create or modify ${SCRATCH}/test-output.txt. ${DISCIPLINE}\n\nTASK: ${TASK}`,
  { label: 'solve', phase: 'Solve', schema: SOLVE_SCHEMA })
if (!solved) return { error: 'solve agent failed', plan, ideas }

// 4 — Test: capture the artifact; the exit code decides, not the model.
// With testCommand the agent captures output and the gate re-runs the command
// to enforce exit 0 (agent claim + hard check).
let test = null
if (TEST) {
  test = await agent(
    `Run this command from the working directory exactly as given:\n  ${TEST}\nSave complete stdout+stderr, with the exit code as "exit=N" on the last line, to ${SCRATCH}/test-output.txt. Change no code. ${DISCIPLINE}`,
    { label: 'test', phase: 'Test', gate: TEST })
} else {
  test = await agent(
    `Decide the minimal objective check that proves the task is done. If no test exists, write one under ${SCRATCH}/, run it, and save complete output with "exit=N" on the last line to ${SCRATCH}/test-output.txt. Do not modify implementation code in this step. ${DISCIPLINE}\n\nTASK: ${TASK}`,
    { label: 'test:auto', phase: 'Test', schema: TEST_SCHEMA })
}

// 5 — Review: adversarial, artifact-grounded, hands off the keyboard.
const review = await agent(
  `You are the reviewer. Read ${SCRATCH}/solution-notes.md, every file it claims to have changed, and ${SCRATCH}/test-output.txt. Inspect the actual captured results, not the implementer's claims: quote the real lines that prove or disprove each claim. Do not modify any file. Verdict "approve" only if the implementation satisfies the definition of done AND the test artifact is genuine.`,
  { label: 'review', phase: 'Review', schema: REVIEW_SCHEMA })

// 6 — Repair: exactly one round, hard-capped like the memdoor original.
const testFailed = TEST ? test === null : !(test && test.pass)
const reviewRejected = review && review.verdict === 'request-changes'
let repaired = null
if (testFailed || reviewRejected) {
  const why = [
    ...(testFailed ? ['The test gate failed; read ' + SCRATCH + '/test-output.txt.'] : []),
    ...(reviewRejected ? ['The reviewer requested changes: ' + review.reasons.join('; ')] : []),
  ].join(' ')
  repaired = await agent(
    `${why} Fix the implementation accordingly (one round only — do not loop). Keep ${SCRATCH}/solution-notes.md accurate: update it with the fix. ${TEST ? 'The command ' + TEST + ' must exit 0 afterwards.' : 'Re-run the test you find in ' + SCRATCH + ' and update test-output.txt.'} ${DISCIPLINE}\n\nTASK: ${TASK}`,
    { label: 'repair', phase: 'Repair', schema: SOLVE_SCHEMA, ...(TEST ? { gate: TEST } : {}) })
}

// 7 — Verify: the final gate decides the run.
let verified = false
if (TEST) {
  verified = (await agent(
    `Re-run this command exactly as given and change nothing:\n  ${TEST}`,
    { label: 'verify', phase: 'Verify', gate: TEST })) !== null
} else {
  const v = await agent(
    `Read ${SCRATCH}/test-output.txt, re-run the test script it records, and confirm the task is done. Save fresh output with "exit=N" on the last line to ${SCRATCH}/test-output.txt. ${DISCIPLINE}\n\nTASK: ${TASK}`,
    { label: 'verify:auto', phase: 'Verify', schema: TEST_SCHEMA })
  verified = v !== null && v.pass
}

return {
  verified,
  repaired: repaired !== null,
  review: review ? review.verdict : 'no-review',
  plan: plan.goal,
  notes: `${SCRATCH}/solution-notes.md`,
  testOutput: `${SCRATCH}/test-output.txt`,
  testCommand: TEST,
}
