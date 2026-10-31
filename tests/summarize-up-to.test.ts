import { expect, mock, test } from 'claude-code/testing'
import type { SessionCompactInput, SessionMessage } from 'claude-code'

import { continuationsOf, cutsOf, sizeOf, weightsOf } from '../hooks/cut'

const peer = (name: string, body: string): string =>
  `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/${name}.sock" from-name="${name}">\n${body}\n</cross-session-message>`

const typed = (args: string) =>
  ({
    command: 'summarize-up-to',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  }) as const

// An ordinary compaction reaching the mod, as the engine's ahead-of-time
// precompute does in a long session.
const warm = ($: { session: { compact: (e: SessionCompactInput) => Promise<unknown> } }) =>
  $.session.compact({ trigger: 'precompute', messages: ROWS })

const user = (text: string, handle: string): SessionMessage => ({ role: 'user', text, toolUses: [], handle })
const assistant = (text: string, handle: string): SessionMessage => ({ role: 'assistant', text, toolUses: [], handle })

// A prompt, a long stretch, then two peer messages with a tool call between.
const ROWS: SessionMessage[] = [
  user('Start the survey', 'h0'),
  assistant('x'.repeat(600), 'h1'),
  user(peer('worker', 'first result'), 'h2'),
  {
    role: 'assistant',
    text: 'y'.repeat(200),
    toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/a' }, text: 'z'.repeat(100) }],
    handle: 'h3',
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'z'.repeat(100), isError: false }], handle: 'h4' },
  assistant('w'.repeat(100), 'h5'),
  user(peer('critic', 'second result'), 'h6'),
  assistant('v'.repeat(100), 'h7'),
]

// The refusal itself needs Claude Code's security default seated, which the
// test kit has no way to seat; here the probe is the only path.
test('with no compaction yet, a settings read shows a cut can apply, and the cut is armed', async ($, on) => {
  let reads = 0
  mock.clock(on)
  on('session.messages', () => ({ value: ROWS }))
  on('settings.read', (_, e, next) => {
    reads++

    return next(e)
  })

  const ran = await $.command.run(typed('#2'))
  const listed = await $.command.run(typed(''))

  expect(reads).toBeGreaterThan(0)
  expect(ran.text).toMatch(/^Armed: \/compact will summarize everything before the peer message/)
  expect(listed.text).toMatch(/Compaction reaches this mod in this session/)
})

test('peer messages are cut points; tool results and the first message are not', () => {
  const cuts = cutsOf(ROWS)

  expect(cuts.map(cut => [cut.index, cut.kind])).toEqual([
    [2, 'peer'],
    [6, 'peer'],
  ])
  expect(cuts[0]?.preview).toBe('@worker: first result')
})

test('a cut summarizes only what comes before it and keeps the rest whole', async ($, on) => {
  let seen: SessionCompactInput | undefined

  // Beneath the plugin these hooks stand for the engine; the last one for
  // its summarizer, which answers one summary message.
  mock.clock(on)
  on('session.messages', () => ({ value: ROWS }))
  on('session.compact', (_, e) => {
    seen = e

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  const ran = await $.command.run(typed('#2 keep the API decisions'))
  expect(ran.text).toMatch(/^Armed: \/compact will summarize everything before the peer message at \d+% \("@critic: second result"\)/)

  // The person's /compact, as the engine raises it: over the whole
  // transcript, each message carrying its handle, with notes of its own.
  const done = await $.session.compact({ trigger: 'manual', messages: ROWS, instructions: 'mention the deadline' })

  expect(seen?.messages.map(m => m.handle)).toEqual(['h0', 'h1', 'h2', 'h3', 'h4', 'h5'])
  expect(seen?.instructions).toMatch(/It starts with this message, which you have not seen:\n"@critic: second result"/)
  expect(seen?.instructions).toMatch(/Also: keep the API decisions\nmention the deadline/)
  expect(done.messages?.map(m => m.handle ?? m.text)).toEqual(['SUMMARY', 'h6', 'h7'])
})

test('arming starts nothing, and the cut ignores compactions it was not armed for', async ($, on) => {
  const triggers: (string | undefined)[] = []
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: ROWS }))
  on('session.compact', (_, e) => {
    triggers.push(e.trigger)

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  await $.command.run(typed('#2'))
  await clock.advance(30000)
  expect(triggers).toEqual([])

  // Another plugin's compaction passes through whole; the cut stays armed.
  const other = await $.session.compact({ trigger: 'plugin', messages: ROWS })
  expect(other.messages?.map(m => m.text)).toEqual(['SUMMARY'])
  const status = await $.command.run(typed('cancel'))
  expect(status.text).toMatch(/^Armed cut dropped/)
})

// One prompt, then the agent alone: six tool round-trips and a closing reply.
const SOLO: SessionMessage[] = [
  user('Run the whole migration', 's0'),
  ...Array.from({ length: 6 }, (_, i): SessionMessage[] => [
    {
      role: 'assistant',
      text: `step ${i + 1}`,
      toolUses: [{ tool_use_id: `b${i}`, tool: 'Bash', input: { command: `run ${i}` }, text: 'o'.repeat(200) }],
      handle: `a${i}`,
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `b${i}`, text: 'o'.repeat(200), isError: false }], handle: `r${i}` },
  ]).flat(),
  assistant('done', 's1'),
]

test('with no prompt to cut at, a percentage cuts between steps and keeps each tool call whole', async ($, on) => {
  let seen: SessionCompactInput | undefined
  mock.clock(on)
  on('session.messages', () => ({ value: SOLO }))
  on('session.compact', (_, e) => {
    seen = e

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  const listed = await $.command.run(typed(''))
  expect(listed.text).toMatch(/^No prompts or messages between turns/)

  const ran = await $.command.run(typed('50%'))
  expect(ran.text).toMatch(/^Armed: \/compact will summarize everything before the step at \d+% \("step \d"\)/)
  // No API form to weigh by here: shares of the rows, and no token figures.
  expect(ran.text).toMatch(/Summarized: \d+ messages \(\d+%\)\. Kept verbatim: \d+ messages \(\d+%\)\./)
  expect(ran.text).toMatch(/Shares are of the visible messages alone/)
  expect(ran.text).toMatch(/Type \/compact to go ahead, or \/summarize-up-to cancel\.$/)

  const done = await $.session.compact({ trigger: 'manual', messages: SOLO })
  const head = seen?.messages ?? []
  const tail = (done.messages ?? []).slice(1)

  // Cut mid-run, after a tool result and before the next assistant message.
  expect(head.at(-1)?.toolResults?.length).toBe(1)
  expect(tail[0]?.role).toBe('assistant')
  expect(head.length).toBeGreaterThan(4)
  expect(tail.length).toBeGreaterThan(4)
  // Every call in the kept part still has its result there.
  const called = tail.flatMap(m => m.toolUses.map(use => use.tool_use_id))
  const answered = tail.flatMap(m => (m.toolResults ?? []).map(r => r.tool_use_id))
  expect(answered).toEqual(called)
  expect(done.messages?.[0]?.text).toBe('SUMMARY')
})

// One API message with two streamed tool calls, stored one row per call.
const BATCH: SessionMessage[] = [
  user('Fix both files', 'p0'),
  assistant('a'.repeat(300), 'p1'),
  user(peer('critic', 'go on'), 'p2'),
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool: 'Edit', input: {}, text: 'e'.repeat(300) }], handle: 'p3' },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: 'e'.repeat(300), isError: false }], handle: 'p4' },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'y', tool: 'Edit', input: {}, text: 'e'.repeat(300) }], handle: 'p5' },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'y', text: 'e'.repeat(300), isError: false }], handle: 'p6' },
  assistant('b'.repeat(300), 'p7'),
]
const USER = 'user' as const
const ASSISTANT = 'assistant' as const
const BATCH_API = [
  { role: USER, content: [{ type: 'text', text: 'Fix both files' }] },
  { role: ASSISTANT, content: [{ type: 'text', text: 'a' }] },
  { role: USER, content: [{ type: 'text', text: 'go on' }] },
  {
    role: ASSISTANT,
    content: [
      { type: 'tool_use', id: 'x', name: 'Edit', input: {} },
      { type: 'tool_use', id: 'y', name: 'Edit', input: {} },
    ],
  },
  {
    role: USER,
    content: [
      { type: 'tool_result', tool_use_id: 'x', content: 'e' },
      { type: 'tool_result', tool_use_id: 'y', content: 'e' },
    ],
  },
  { role: ASSISTANT, content: [{ type: 'text', text: 'b' }] },
]

test('a step never cuts inside a batch of parallel tool calls', async ($, on) => {
  expect(cutsOf(BATCH, { steps: true }).map(cut => cut.index)).toContain(5)
  expect(cutsOf(BATCH, { steps: true, continuing: continuationsOf(BATCH_API) }).map(cut => cut.index)).not.toContain(5)

  // The row at 5 sits nearest 60%; the compaction reads the API form and
  // cuts at the next whole message instead.
  let seen: SessionCompactInput | undefined
  mock.clock(on)
  on('session.messages', (_, e) => ({ value: e.as === 'api' ? BATCH_API : BATCH }))
  on('session.compact', (_, e) => {
    seen = e

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })
  await $.command.run(typed('60%'))
  await $.session.compact({ trigger: 'manual', messages: BATCH })

  // A cut happened, and not between p4 and p5, the two halves of one message.
  expect(seen?.messages.length).toBeLessThan(BATCH.length)
  expect(seen?.messages.at(-1)?.handle).not.toBe('p4')
})

test('the person\'s /compact applies the armed cut and says so', async ($, on) => {
  const logs: string[] = []
  mock.clock(on)
  on('session.messages', () => ({ value: ROWS }))
  on('ui.log', (_, e) => {
    logs.push(e.text)

    return { value: undefined }
  })
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }))

  await $.command.run(typed('#2'))
  const done = await $.session.compact({ trigger: 'manual', messages: ROWS })

  expect(done.messages?.map(m => m.handle ?? m.text)).toEqual(['SUMMARY', 'h6', 'h7'])
  expect(logs.at(-1)).toMatch(/^summarized everything before the peer message/)
  // Used once: the next /compact is whole again.
  const again = await $.session.compact({ trigger: 'manual', messages: ROWS })
  expect(again.messages?.map(m => m.text)).toEqual(['SUMMARY'])
})

test('cancel drops an armed cut', async ($, on) => {
  let seen: SessionCompactInput | undefined
  mock.clock(on)
  on('session.messages', () => ({ value: ROWS }))
  on('session.compact', (_, e) => {
    seen = e

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  await warm($)
  await $.command.run(typed('#2'))
  const cancelled = await $.command.run(typed('cancel'))
  expect(cancelled.text).toMatch(/^Armed cut dropped/)

  await $.session.compact({ trigger: 'manual', messages: ROWS })
  expect(seen?.messages.length).toBe(ROWS.length)
})

const AUTO = { options: { auto_compact: true, summarize_percent: 65 } }

test('with partial auto-compaction on, an auto-compaction keeps the newest 35% verbatim', AUTO, async ($, on) => {
  let seen: SessionCompactInput | undefined
  const logs: string[] = []
  on('session.messages', (_, e) => ({ value: e.as === 'api' ? ([] as never) : SOLO }))
  on('ui.log', (_, e) => {
    logs.push(e.text)

    return { value: undefined }
  })
  on('session.compact', (_, e) => {
    seen = e

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  const done = await $.session.compact({ trigger: 'auto', messages: SOLO })
  const head = seen?.messages ?? []
  const tail = (done.messages ?? []).slice(1)
  // Claude Code also keeps the last assistant message before the cut: the
  // share summarized is what precedes that one.
  const kept = head.findLastIndex(r => r.role === 'assistant')
  const share = Math.round((100 * head.slice(0, kept).reduce((n, r) => n + sizeOf(r), 0)) / SOLO.reduce((n, r) => n + sizeOf(r), 0))

  expect(Math.abs(share - 65)).toBeLessThanOrEqual(8)
  expect([...head, ...tail].map(r => r.handle)).toEqual(SOLO.map(r => r.handle))
  expect(tail[0]?.role).toBe('assistant')
  expect(head.at(-1)?.toolResults?.length).toBe(1)
  expect(logs.at(-1)).toMatch(/^auto-compaction summarized everything before the step/)
})

test('with partial auto-compaction off, an auto-compaction passes through whole', async ($, on) => {
  let seen: SessionCompactInput | undefined
  on('session.compact', (_, e) => {
    seen = e

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  await $.session.compact({ trigger: 'auto', messages: SOLO })
  expect(seen?.messages.length).toBe(SOLO.length)
  expect(seen?.instructions).toBeUndefined()
})

test('an auto-compaction with too little before the cut runs as Claude Code\'s own', AUTO, async ($, on) => {
  let seen: SessionCompactInput | undefined
  const SHORT = SOLO.slice(0, 3)
  on('session.messages', (_, e) => ({ value: e.as === 'api' ? ([] as never) : SHORT }))
  on('ui.log', () => ({ value: undefined }))
  on('session.compact', (_, e) => {
    seen = e

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  await $.session.compact({ trigger: 'auto', messages: SHORT })
  expect(seen?.messages.length).toBe(SHORT.length)
})

test('when Claude Code refuses the partial summary, the auto-compaction falls back to a full one', AUTO, async ($, on) => {
  const calls: number[] = []
  on('session.messages', (_, e) => ({ value: e.as === 'api' ? ([] as never) : SOLO }))
  on('ui.log', () => ({ value: undefined }))
  on('session.compact', (_, e) => {
    calls.push(e.messages.length)
    if (e.messages.length < SOLO.length) throw new Error('Reactive compact: fewer than 2 groups')

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  const done = await $.session.compact({ trigger: 'auto', messages: SOLO })
  expect(calls.length).toBe(2)
  expect(calls[1]).toBe(SOLO.length)
  expect(done.messages?.map(m => m.text)).toEqual(['SUMMARY'])
})

test('a compaction nobody armed passes through whole', async ($, on) => {
  let seen: SessionCompactInput | undefined
  on('session.compact', (_, e) => {
    seen = e

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  await $.session.compact({ trigger: 'plugin', messages: ROWS })

  expect(seen?.messages.length).toBe(ROWS.length)
  expect(seen?.instructions).toBeUndefined()
})

test('a bare run lists the cut points without arming a cut', async ($, on) => {
  let seen: SessionCompactInput | undefined
  mock.clock(on)
  on('session.messages', () => ({ value: ROWS }))
  on('session.compact', (_, e) => {
    seen = e

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  const ran = await $.command.run(typed(''))
  expect(ran.text).toMatch(/#1 .*peer +@worker: first result/)
  expect(ran.text).toMatch(/#2 .*peer +@critic: second result/)

  await $.session.compact({ trigger: 'plugin', messages: ROWS })
  expect(seen?.messages.length).toBe(ROWS.length)
})

// Three short turns; the model also read a 6,000-character attachment with
// the first prompt, which no row holds.
const READ: SessionMessage[] = [
  user('Read the attached report first', 'r0'),
  assistant('a'.repeat(300), 'r1'),
  user('Now the second part of the work', 'r2'),
  assistant('b'.repeat(300), 'r3'),
  user('And the third part of the work', 'r4'),
  assistant('c'.repeat(300), 'r5'),
]
const READ_API = [
  { role: USER, content: [{ type: 'text', text: 'Read the attached report first' }, { type: 'text', text: 'R'.repeat(6000) }] },
  { role: ASSISTANT, content: [{ type: 'text', text: 'a'.repeat(300) }] },
  { role: USER, content: [{ type: 'text', text: 'Now the second part of the work' }] },
  { role: ASSISTANT, content: [{ type: 'text', text: 'b'.repeat(300) }] },
  { role: USER, content: [{ type: 'text', text: 'And the third part of the work' }] },
  { role: ASSISTANT, content: [{ type: 'text', text: 'c'.repeat(300) }] },
]

test('shares follow what the model reads, and tokens come from Claude Code\'s count', async ($, on) => {
  // Rows alone put the second prompt a third of the way in; the attachment
  // puts it near the end.
  expect(cutsOf(READ)[0]?.percent).toBeLessThan(40)
  expect(cutsOf(READ, { weights: weightsOf(READ, READ_API) })[0]?.percent).toBeGreaterThan(85)

  on('session.messages', (_, e) => ({ value: e.as === 'api' ? READ_API : READ }))
  on('session.usage', () => ({
    value: {
      context: {
        window: 200000,
        tokens: 90000,
        percent: 45,
        breakdown: { categories: [{ name: 'Messages', kind: 'used', tokens: 70000 }] },
      },
    } as never,
  }))

  const ran = await $.command.run(typed('#1'))
  expect(ran.text).toMatch(/^Armed: \/compact will summarize everything before the you message at (8[6-9]|9\d)% /)
  // Claude Code keeps the first reply too: one message summarized, five kept.
  expect(ran.text).toMatch(/Summarized: 1 message \(86%, about 60k tokens\)\. Kept verbatim: 5 messages \(14%, about 10k tokens\)\./)
  expect(ran.text).toMatch(/Claude Code also keeps the last reply before the cut, so the kept part starts 1 message earlier/)
  expect(ran.text).toMatch(/Shares are of what the model reads: about 70k tokens of conversation by Claude Code's count\./)
})

test('a step that opens on thinking alone is shown by what it calls', () => {
  const rows: SessionMessage[] = [
    user('Run the tests', 'q0'),
    assistant('', 'q1'),
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'm', tool: 'Bash', input: { command: 'make test' } }], handle: 'q2' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'm', text: 'ok', isError: false }], handle: 'q3' },
    assistant('All tests pass.', 'q4'),
  ]

  expect(cutsOf(rows, { steps: true }).map(cut => cut.preview)).toEqual(['calls Bash: make test', 'All tests pass.'])
})

const said = (text: string, kind = 'composer') => ({ text, origin: { kind }, wait: false }) as never

test('typed after a space, /compact is held back and this command still runs', async ($, on) => {
  const entered: string[] = []
  on('session.messages', () => ({ value: ROWS }))
  on('prompt.submit', (_, e) => {
    entered.push(e.text)

    return { text: e.text }
  })

  const boxes: string[] = []
  const logs: string[] = []
  const clock = mock.clock(on)
  on('ui.log', (_, e) => {
    logs.push(e.text)

    return { value: undefined }
  })
  on('prompt.fill', (_, e) => {
    boxes.push(e.text)

    return { isFilled: true } as never
  })

  // What to read is a transcript line; the drop's own reason is short.
  const compact = await $.prompt.submit(said(' /compact'))
  expect(compact.drop).toBe('Held back by summarize-up-to: a space before the slash.')
  expect(logs.at(-1)).toMatch(/^held back "\/compact": with a space before the slash it would have gone to the model as text/)
  const arm = await $.prompt.submit(said('  /summarize-up-to #2'))
  expect(arm.drop).toMatch(/^Typed after a space, so summarize-up-to ran it/)
  expect(logs.at(-1)).toMatch(/^Armed: \/compact will summarize everything before the peer message/)
  // Once Claude Code has put each back: /compact as meant, then an empty box.
  await clock.advance(1000)
  expect(boxes).toEqual(['/compact', ''])
  // Neither reached the model; a peer's message and ordinary text do.
  await $.prompt.submit(said(' /compact', 'peer'))
  await $.prompt.submit(said('  /compactly worded question'))
  expect(entered).toEqual([' /compact', '  /compactly worded question'])
})

test('after a cut, the mod saves it so that a resume keeps it, and says so', async ($, on) => {
  const runs: string[][] = []
  const logs: string[] = []
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: ROWS }))
  on('ui.log', (_, e) => {
    logs.push(e.text)

    return { value: undefined }
  })
  on('session.id', () => ({ value: 'S1' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])

    return { value: { exitCode: 0, stdout: 'patched\n{"fixed": 4, "reaches": true, "covered": 34, "total": 34}', stderr: '' } } as never
  })
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }))

  await $.command.run(typed('#2'))
  await $.session.compact({ trigger: 'manual', messages: ROWS })
  expect(runs).toEqual([])
  await clock.advance(20000)

  // Once the cut is on disk, and once more for anything written late.
  expect(runs.length).toBe(2)
  expect(runs[0]).toEqual(expect.arrayContaining(['python3', '--session', '--in-place', '--since']))
  expect(runs[0]?.[1]).toMatch(/\/tools\/relink\.py$/)
  expect(logs.at(-1)).toMatch(/^saved the cut so that a restart or resume keeps it \(corrected 8 links/)
})

test('where the cut cannot be saved for a restart, the mod says how to repair it', async ($, on) => {
  const logs: string[] = []
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: ROWS }))
  on('ui.log', (_, e) => {
    logs.push(e.text)

    return { value: undefined }
  })
  on('session.id', () => ({ value: 'S1' }))
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: 'env: python3: No such file or directory' } }) as never)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }))

  await $.command.run(typed('#2'))
  await $.session.compact({ trigger: 'manual', messages: ROWS })
  await clock.advance(5000)

  expect(logs.at(-1)).toMatch(/^could not save the cut so that a restart or resume keeps it \(env: python3: No such file or directory\)/)
  expect(logs.at(-1)).toMatch(/python3 \S+\/tools\/relink\.py --session \S+ --write/)
})

test('shares stay in step when prompts open alike and replies open on one word', () => {
  // Every prompt opens on the same pasted block; every reply on its code word
  // alone, too short to look for. The first turn also carried an attachment.
  const paste = '<pasted_content id="7df7">\n' + 'f'.repeat(400)
  const words = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']
  const rows: SessionMessage[] = words.flatMap((word, i) => [
    user(`${paste}\nStart with ${word}`, `u${i}`),
    assistant(`${word}\n\n${'r'.repeat(400)}`, `a${i}`),
  ])
  const api = words.flatMap((word, i) => [
    {
      role: USER,
      content: [
        { type: 'text', text: `${paste}\nStart with ${word}` },
        ...(i === 0 ? [{ type: 'text', text: 'A'.repeat(3200) }] : []),
      ],
    },
    { role: ASSISTANT, content: [{ type: 'text', text: `${word}\n\n${'r'.repeat(400)}` }] },
  ])

  // A cut at each turn's prompt summarizes everything the model read before
  // the reply kept with it, the attachment included.
  const sizes = api.map(m => m.content.reduce((n, b) => n + b.text.length, 0))
  const total = sizes.reduce((a, b) => a + b, 0)
  const expected = [1, 2, 3].map(turn => Math.round((100 * sizes.slice(0, 2 * turn - 1).reduce((a, b) => a + b, 0)) / total))
  expect(cutsOf(rows, { weights: weightsOf(rows, api) }).map(cut => cut.percent)).toEqual(expected)
  expect(expected[0]).toBeGreaterThan(50)
})

test('a prompt that opens on a paste is the person\'s, its paste shown as [pasted]', () => {
  const pasted = '\n\n<pasted_content id="e4dd">\n' + 'filler\n'.repeat(40) + '</pasted_content id="e4dd">\n\nCode word FOXTROT. Go on.'
  const rows: SessionMessage[] = [user('Start', 'p0'), assistant('a'.repeat(100), 'p1'), user(pasted, 'p2'), assistant('b', 'p3')]

  expect(cutsOf(rows).map(cut => [cut.kind, cut.preview])).toEqual([['you', '[pasted] Code word FOXTROT. Go on.']])
})

test('shares stay in step across a batch of parallel tool calls', () => {
  // The API form holds both calls in one message and both results in the
  // next; the rows hold a call, its result, the next call, its result.
  const rows: SessionMessage[] = [
    user('Fix both of the files now', 'b0'),
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool: 'Edit', input: {}, text: 'e'.repeat(300) }], handle: 'b1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: 'e'.repeat(300), isError: false }], handle: 'b2' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'y', tool: 'Edit', input: {}, text: 'e'.repeat(300) }], handle: 'b3' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'y', text: 'e'.repeat(300), isError: false }], handle: 'b4' },
    assistant('Both files are fixed now.', 'b5'),
    user('Now the next part of the work', 'b6'),
    assistant('The next part is done as well.', 'b7'),
  ]
  const api = [
    { role: USER, content: [{ type: 'text', text: 'Fix both of the files now' }] },
    {
      role: ASSISTANT,
      content: [
        { type: 'tool_use', id: 'x', name: 'Edit', input: {} },
        { type: 'tool_use', id: 'y', name: 'Edit', input: {} },
      ],
    },
    {
      role: USER,
      content: [
        { type: 'tool_result', tool_use_id: 'x', content: 'e'.repeat(3000) },
        { type: 'tool_result', tool_use_id: 'y', content: 'e'.repeat(3000) },
      ],
    },
    { role: ASSISTANT, content: [{ type: 'text', text: 'Both files are fixed now.' }] },
    { role: USER, content: [{ type: 'text', text: 'Now the next part of the work' }] },
    { role: ASSISTANT, content: [{ type: 'text', text: 'The next part is done as well.' }] },
  ]

  const weights = weightsOf(rows, api)
  expect(weights).toBeDefined()
  // A cut at the second prompt keeps the reply before it: everything up to
  // that reply's message, the batch's results included, is summarized.
  const sizes = [25, 4, 6000, 25, 29, 30]
  const total = sizes.reduce((a, b) => a + b, 0)
  expect(cutsOf(rows, { weights }).map(cut => cut.percent)).toEqual([Math.round((100 * (25 + 4 + 6000)) / total)])
})
