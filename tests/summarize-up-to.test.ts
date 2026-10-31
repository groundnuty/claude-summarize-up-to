import { expect, mock, test } from 'claude-code/testing'
import type { SessionCompactInput, SessionMessage } from 'claude-code'

import { continuationsOf, cutsOf, sizeOf } from '../hooks/cut'

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

test('until a compaction has reached the mod, it refuses to cut', async ($, on) => {
  let isCompacted = false
  mock.clock(on)
  on('session.messages', () => ({ value: ROWS }))
  on('session.compact', () => {
    isCompacted = true

    return { skip: 'test' }
  })

  const ran = await $.command.run(typed('70%'))
  const listed = await $.command.run(typed(''))

  expect(ran.text).toMatch(/^Not run: no compaction has reached this mod/)
  expect(listed.text).toMatch(/cc-plugin-sec-default/)
  expect(isCompacted).toBe(false)
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
  // its summarizer, which answers one summary message. The mocked clock
  // holds the command's own timer.
  mock.clock(on)
  on('session.messages', () => ({ value: ROWS }))
  on('session.compact', (_, e) => {
    seen = e

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  await warm($)
  const ran = await $.command.run(typed('#2 keep the API decisions'))
  expect(ran.text).toMatch(/^Summarizing everything before the peer message at \d+% \("@critic: second result"\)/)

  // The compaction the command starts, as the engine raises it: over the
  // whole transcript, each message carrying its handle.
  const done = await $.session.compact({ trigger: 'plugin', messages: ROWS, instructions: 'keep the API decisions' })

  expect(seen?.messages.map(m => m.handle)).toEqual(['h0', 'h1', 'h2', 'h3', 'h4', 'h5'])
  expect(seen?.instructions).toMatch(/starting with this message:\n"@critic: second result"/)
  expect(seen?.instructions).toMatch(/Also: keep the API decisions/)
  expect(done.messages?.map(m => m.handle ?? m.text)).toEqual(['SUMMARY', 'h6', 'h7'])
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

  await warm($)
  const ran = await $.command.run(typed('50%'))
  expect(ran.text).toMatch(/^Summarizing everything before the step at \d+% \("step \d"\)/)

  const done = await $.session.compact({ trigger: 'plugin', messages: SOLO })
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
  await warm($)
  await $.command.run(typed('60%'))
  await $.session.compact({ trigger: 'plugin', messages: BATCH })

  expect(seen?.messages.map(m => m.handle)).not.toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
  expect(seen?.messages.at(-1)?.handle).not.toBe('p4')
})

test('where the engine refuses the mod a compaction, the cut stays armed for /compact', async ($, on) => {
  let seen: SessionCompactInput | undefined
  const logs: string[] = []
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: ROWS }))
  on('ui.log', (_, e) => {
    logs.push(e.text)

    return { value: undefined }
  })
  on('session.compact', (_, e) => {
    // A headless session: a plugin's own compaction is refused.
    if (e.trigger !== 'manual' && e.trigger !== 'precompute') throw new Error('not available in a headless session')
    seen = e

    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })

  await warm($)
  await $.command.run(typed('#2 keep the API decisions'))
  await clock.advance(200 + 3 * 2000 + 100)
  expect(logs.at(-1)).toMatch(/The cut stays armed: run \/compact to apply it/)

  // The person's /compact, with notes of its own.
  const done = await $.session.compact({ trigger: 'manual', messages: ROWS, instructions: 'mention the deadline' })

  expect(seen?.messages.map(m => m.handle)).toEqual(['h0', 'h1', 'h2', 'h3', 'h4', 'h5'])
  expect(seen?.instructions).toMatch(/Also: keep the API decisions\nmention the deadline/)
  expect(done.messages?.map(m => m.handle ?? m.text)).toEqual(['SUMMARY', 'h6', 'h7'])
  expect(logs.at(-1)).toMatch(/^summarize-up-to: summarized everything before the peer message/)
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
  const share = Math.round((100 * head.reduce((n, r) => n + sizeOf(r), 0)) / SOLO.reduce((n, r) => n + sizeOf(r), 0))

  expect(Math.abs(share - 65)).toBeLessThanOrEqual(8)
  expect([...head, ...tail].map(r => r.handle)).toEqual(SOLO.map(r => r.handle))
  expect(tail[0]?.role).toBe('assistant')
  expect(head.at(-1)?.toolResults?.length).toBe(1)
  expect(logs.at(-1)).toMatch(/^summarize-up-to: auto-compaction summarized everything before the step/)
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
