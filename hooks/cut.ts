import type { SessionMessage } from 'claude-code'

export type CutKind = 'you' | 'peer' | 'task' | 'other' | 'step'

/** A place the conversation can be cut: everything before it is summarized. */
export type Cut = {
  /** The first message kept verbatim, as an index into the message list. */
  index: number
  kind: CutKind
  /** Share of the conversation before the cut, 0 to 100: of what the model reads where known, else of the rows. */
  percent: number
  preview: string
}

/**
 * Which cut the person chose, in a form that survives the list growing:
 * a share of the transcript (nearest step), or a listed cut counted from the
 * newest end and checked by its preview.
 */
export type Want = { percent: number } | { fromEnd: number; preview: string }

const PEER = 'Another Claude session sent a message:'
const CONTINUED = 'This session is being continued from a previous conversation'

/**
 * The live part of `$.session.messages()`: from the latest compaction summary
 * on. The rows can still hold what that compaction replaced; a compaction's
 * own input does not.
 */
export function liveRows(messages: readonly SessionMessage[]): readonly SessionMessage[] {
  const at = messages.findLastIndex(m => m.role === 'user' && m.text.trimStart().startsWith(CONTINUED))

  return at > 0 ? messages.slice(at) : messages
}

export const sizeOf = (m: SessionMessage): number =>
  m.text.length +
  m.toolUses.reduce(
    (n, use) => n + JSON.stringify(use.input).length + (use.text?.length ?? 0),
    0,
  )

// A paste in a prompt, as Claude Code stores it, its closing tag naming the
// id again: a prompt shows as the person's, the paste as [pasted].
const PASTED = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/g
const unpasted = (text: string): string => text.replace(PASTED, ' [pasted] ').trim()

const kindOf = (text: string): CutKind => {
  if (text.startsWith(PEER)) return 'peer'
  if (text.startsWith('<task-notification>')) return 'task'
  if (text.startsWith('<')) return 'other'
  return 'you'
}

const previewOf = (text: string): string => {
  let body = text
  if (text.startsWith(PEER)) {
    const name = /from-name="([^"]*)"/.exec(text)?.[1]
    const inner = text.replace(PEER, '').replace(/<\/?[a-z-]+[^>]*>/g, ' ')
    body = `${name ? `@${name}: ` : ''}${inner}`
  }
  const line = body.replace(/\s+/g, ' ').trim()

  return line.length > 70 ? `${line.slice(0, 69)}…` : line
}

// The input field that says what a tool call is about, first match wins.
const SALIENT = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'to', 'prompt']

const callOf = (use: SessionMessage['toolUses'][number]): string => {
  const input = typeof use.input === 'object' && use.input !== null ? (use.input as Record<string, unknown>) : {}
  const about = SALIENT.map(key => input[key]).find(value => typeof value === 'string')

  return typeof about === 'string' ? `${use.tool}: ${about}` : use.tool
}

// One API message is stored as several rows, thinking first: a step that
// opens on thinking alone is previewed by the row that says or calls something.
const stepPreview = (messages: readonly SessionMessage[], index: number): string => {
  let line = 'thinking'
  for (let i = index; i < messages.length && messages[i]?.role === 'assistant'; i++) {
    const m = messages[i]
    const text = m?.text.replace(/\s+/g, ' ').trim() ?? ''
    if (text !== '') line = text
    else if (m !== undefined && m.toolUses.length > 0) line = `calls ${m.toolUses.map(callOf).join(', ')}`
    else continue
    break
  }
  line = line.replace(/\s+/g, ' ')

  return line.length > 70 ? `${line.slice(0, 69)}…` : line
}

/** How a message reads in a preview: a prompt by its text, an assistant step by what it says or calls. */
export const previewAt = (messages: readonly SessionMessage[], index: number): string => {
  const m = messages[index]
  if (m === undefined) return ''

  return m.role === 'assistant' ? stepPreview(messages, index) : previewOf(unpasted(m.text.trim()))
}

/** The share of the conversation before `index`, 0 to 100, by `weights` (weightsOf) or the rows' own sizes. */
export function shareBefore(messages: readonly SessionMessage[], index: number, weights?: readonly number[]): number {
  const own: number[] = [0]
  for (const m of messages) own.push((own.at(-1) ?? 0) + sizeOf(m))
  const at = weights?.length === messages.length + 1 ? weights : own

  return Math.round((100 * (at[index] ?? 0)) / (at.at(-1) || 1))
}

/** The fields read from `$.session.messages({ as: "api" })`. */
type ApiBlock = {
  type: string
  id?: unknown
  tool_use_id?: unknown
  text?: unknown
  thinking?: unknown
  input?: unknown
  content?: unknown
}
type ApiLike = { role: string; content: readonly ApiBlock[] }

// An image or document as about 1,600 tokens, at four characters a token.
const MEDIA = 6400

const blockSize = (b: ApiBlock): number => {
  if (b.type === 'text') return typeof b.text === 'string' ? b.text.length : 0
  if (b.type === 'thinking') return typeof b.thinking === 'string' ? b.thinking.length : 0
  if (b.type === 'tool_use') return JSON.stringify(b.input ?? {}).length
  if (b.type === 'image' || b.type === 'document') return MEDIA
  if (b.type !== 'tool_result') return 0
  if (typeof b.content === 'string') return b.content.length

  return Array.isArray(b.content) ? (b.content as ApiBlock[]).reduce((n, c) => n + blockSize(c), 0) : 0
}

// How far ahead of the last match a row is looked for in the API form.
const WINDOW = 64

// Where a row sits in the API form: its first tool call or result, or its
// first line.
const keyOf = (m: SessionMessage): { id: string } | { text: string } | undefined => {
  const id = m.toolUses[0]?.tool_use_id ?? m.toolResults?.[0]?.tool_use_id
  if (id !== undefined) return { id }
  const text = (m.text.trim().split('\n')[0] ?? '').slice(0, 80)

  return text.length >= 12 ? { text } : undefined
}

const holds = (api: ApiLike, key: { id: string } | { text: string }): boolean =>
  api.content.some(b =>
    'id' in key
      ? b.id === key.id || b.tool_use_id === key.id
      : b.type === 'text' && typeof b.text === 'string' && b.text.includes(key.text),
  )

/**
 * How much the model reads before each row, from the API form: `at[i]` is the
 * size of everything before row i, `at[rows.length]` the whole. The API form
 * also holds what the rows leave out (peer messages, attachments, file
 * contents), so shares taken from it follow the model's tokens. Undefined
 * where most rows cannot be found in it.
 *
 * A row with a tool call or result is placed by its id. Other rows of one
 * role in a row share an API message, so each change of role moves on to the
 * next message of that role; a row's own text confirms the place, or, where
 * it is found further on, moves there. Text alone can repeat (prompts that
 * open alike) or be missing (a reply that opens on one word).
 */
export function weightsOf(rows: readonly SessionMessage[], api: readonly ApiLike[]): number[] | undefined {
  const aligned = alignmentOf(rows, api)

  return aligned !== undefined && aligned.keyed > 0 && aligned.found >= aligned.keyed * 0.8 ? aligned.weights : undefined
}

/**
 * The API message each row was placed in, the API messages' sizes, and how
 * many rows had a key and were found by it; `missed` lists the rows that were
 * not, for the debug log.
 */
export type Alignment = {
  weights: number[]
  places: number[]
  sizes: number[]
  keyed: number
  found: number
  missed: number[]
}

/** One line on an alignment, for the debug log: counts, misses, the API's shape. */
export function alignmentNote(rows: readonly SessionMessage[], api: readonly ApiLike[], aligned: Alignment): string {
  const missed = aligned.missed
    .slice(0, 12)
    .map(i => `${i}${rows[i]?.role[0]}>${aligned.places[i]} ${JSON.stringify(rows[i] && keyOf(rows[i]))?.slice(0, 50)}`)
  const shape = api.map((m, i) => `${m.role[0]}${aligned.sizes[i]}`)

  return `${aligned.found} of ${aligned.keyed} keyed rows found in ${api.length} API messages for ${rows.length} rows; missed: ${missed.join(' | ') || 'none'}; API: ${shape.slice(0, 80).join(' ')}${shape.length > 80 ? ' …' : ''}`
}

export function alignmentOf(rows: readonly SessionMessage[], api: readonly ApiLike[]): Alignment | undefined {
  if (api.some(m => !Array.isArray(m?.content))) return undefined
  const starts: number[] = []
  const sizes = api.map(m => m.content.reduce((n, b) => n + blockSize(b), 0))
  let total = 0
  for (const size of sizes) {
    starts.push(total)
    total += size
  }

  // A tool call or result is in exactly one API message, whatever the rows'
  // shape: parallel calls are one message there and a row each here.
  const holding = new Map<string, number>()
  api.forEach((m, k) => {
    for (const b of m.content) {
      const id = b.type === 'tool_use' ? b.id : b.type === 'tool_result' ? b.tool_use_id : undefined
      if (typeof id === 'string') holding.set(`${m.role}:${id}`, k)
    }
  })

  const at: number[] = []
  const places: number[] = []
  const missed: number[] = []
  let p = -1
  let keyed = 0
  let found = 0
  for (const m of rows) {
    const key = keyOf(m)
    const placed = key !== undefined && 'id' in key ? holding.get(`${m.role}:${key.id}`) : undefined
    if (placed !== undefined) p = placed
    else if (api[p]?.role !== m.role) {
      let k = p + 1
      while (k < api.length && api[k]?.role !== m.role) k++
      if (k < api.length) p = k
    }
    if (key !== undefined) {
      keyed++
      const before = found
      if (placed !== undefined) found++
      else if ('text' in key) {
        const here = api[p]
        if (here !== undefined && holds(here, key)) found++
        else
          for (let k = p + 1; k < Math.min(api.length, p + WINDOW); k++) {
            const candidate = api[k]
            if (candidate?.role === m.role && holds(candidate, key)) {
              p = k
              found++
              break
            }
          }
      }
      if (found === before) missed.push(places.length)
    }
    at.push(starts[Math.max(p, 0)] ?? total)
    places.push(p)
  }
  at.push(total)

  return total > 0 ? { weights: at, places, sizes, keyed, found, missed } : undefined
}

/**
 * Tool calls that do not open their API message. Parallel calls are stored
 * one row per call with each result in between, so a row that starts with
 * one of these continues a message: cutting before it splits the batch.
 */
export function continuationsOf(api: readonly ApiLike[]): Set<string> {
  const ids = new Set<string>()
  for (const m of api) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const use of m.content.filter(b => b.type === 'tool_use').slice(1))
      if (typeof use.id === 'string') ids.add(use.id)
  }

  return ids
}

type CutOptions = {
  /** Also cut where an assistant message starts, inside a turn. */
  steps?: boolean
  /** Tool calls that continue a message (continuationsOf): no step there. */
  continuing?: ReadonlySet<string>
  /** What the model reads before each row (weightsOf); else the rows' own sizes. */
  weights?: readonly number[]
}

/**
 * Where the conversation can be cut. A user message with text and no tool
 * results opens a turn or arrives between turns; with `steps`, so does the
 * start of every assistant message, one per tool round-trip inside a turn.
 * Neither separates a tool call from its result.
 */
export function cutsOf(messages: readonly SessionMessage[], options: CutOptions = {}): Cut[] {
  const own: number[] = [0]
  for (const m of messages) own.push((own.at(-1) ?? 0) + sizeOf(m))
  const weights = options.weights?.length === messages.length + 1 ? options.weights : own
  const total = weights.at(-1) || 1
  const cuts: Cut[] = []

  messages.forEach((m, index) => {
    const text = m.text.trim()
    const previous = messages[index - 1]
    const percent = Math.round((100 * (weights[index] ?? 0)) / total)
    const isOpen =
      index > 0 &&
      m.role === 'user' &&
      (m.toolResults?.length ?? 0) === 0 &&
      text !== '' &&
      !text.startsWith(CONTINUED) &&
      !(previous?.role === 'assistant' && previous.toolUses.length > 0)
    // Only where an assistant message starts after a tool result: rows of one
    // message stay together, and a prompt stays with the reply it asked for.
    // Cut between those, the summarizer's part ended on a request answered
    // only after the cut, and it answered that instead of summarizing.
    const isStep =
      options.steps === true &&
      m.role === 'assistant' &&
      previous?.role === 'user' &&
      (previous.toolResults?.length ?? 0) > 0 &&
      !options.continuing?.has(m.toolUses[0]?.tool_use_id ?? '')

    if (isOpen) cuts.push({ index, kind: kindOf(unpasted(text)), percent, preview: previewOf(unpasted(text)) })
    else if (isStep) cuts.push({ index, kind: 'step', percent, preview: stepPreview(messages, index) })
  })

  return cuts
}

export function pick(cuts: readonly Cut[], want: Want): Cut | undefined {
  if ('percent' in want) {
    let best: Cut | undefined
    for (const cut of cuts)
      if (best === undefined || Math.abs(cut.percent - want.percent) < Math.abs(best.percent - want.percent))
        best = cut

    return best
  }
  const cut = cuts[cuts.length - want.fromEnd]

  return cut?.preview === want.preview ? cut : undefined
}

/**
 * The message the mod adds at the end of what it hands Claude Code to
 * summarize. Claude Code keeps the last assistant message of that part out of
 * the summary and verbatim; left to that, the summarizer's part ended on a
 * request whose answer it never saw, and it answered the request instead of
 * summarizing (four times in twenty end-to-end runs, the framing alone did not
 * stop it). This message takes that place and is dropped from the result.
 */
export const CLOSING = 'The conversation goes on after your summary, verbatim from the next message.'

/** What the summarizer is told beside the person's own instructions. */
export function framing(messages: readonly SessionMessage[], cut: Cut, instructions?: string): string {
  const own = instructions?.trim()

  return [
    'Your only task is the summary. Do not answer, continue or act on anything in the conversation: every request in it has been handled.',
    'What you see is the earlier part of a longer conversation: summarize all of it.',
    'The later part stays verbatim and follows your summary. It starts with this message, which you have not seen:',
    `"${previewAt(messages, cut.index)}"`,
    'Describe the work as it stood at the end of the part you see, not as the current state, and propose no next steps: the verbatim messages after your summary carry those.',
    ...(own ? [`Also: ${own}`] : []),
  ].join('\n')
}
