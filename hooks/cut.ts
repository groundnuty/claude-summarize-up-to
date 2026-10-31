import type { SessionMessage } from 'claude-code'

export type CutKind = 'you' | 'peer' | 'task' | 'other' | 'step'

/** A place the conversation can be cut: everything before it is summarized. */
export type Cut = {
  /** The first message kept verbatim, as an index into the message list. */
  index: number
  kind: CutKind
  /** Share of the transcript's characters before the cut, 0 to 100. */
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

const stepPreview = (m: SessionMessage): string => {
  const text = m.text.replace(/\s+/g, ' ').trim()
  const tools = m.toolUses.map(use => use.tool).join(', ')
  const line = text !== '' ? text : tools !== '' ? `calls ${tools}` : '(no text)'

  return line.length > 70 ? `${line.slice(0, 69)}…` : line
}

/** The fields read from `$.session.messages({ as: "api" })`. */
type ApiLike = { role: string; content: readonly { type: string; id?: unknown }[] }

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
}

/**
 * Where the conversation can be cut. A user message with text and no tool
 * results opens a turn or arrives between turns; with `steps`, so does the
 * start of every assistant message, one per tool round-trip inside a turn.
 * Neither separates a tool call from its result.
 */
export function cutsOf(messages: readonly SessionMessage[], options: CutOptions = {}): Cut[] {
  const total = messages.reduce((n, m) => n + sizeOf(m), 0) || 1
  const cuts: Cut[] = []
  let before = 0

  messages.forEach((m, index) => {
    const text = m.text.trim()
    const previous = messages[index - 1]
    const percent = Math.round((100 * before) / total)
    const isOpen =
      index > 0 &&
      m.role === 'user' &&
      (m.toolResults?.length ?? 0) === 0 &&
      text !== '' &&
      !text.startsWith(CONTINUED) &&
      !(previous?.role === 'assistant' && previous.toolUses.length > 0)
    // Only where an assistant message starts: rows of one message stay together.
    const isStep =
      options.steps === true &&
      m.role === 'assistant' &&
      previous?.role === 'user' &&
      !options.continuing?.has(m.toolUses[0]?.tool_use_id ?? '')

    if (isOpen) cuts.push({ index, kind: kindOf(text), percent, preview: previewOf(text) })
    else if (isStep) cuts.push({ index, kind: 'step', percent, preview: stepPreview(m) })
    before += sizeOf(m)
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

/** What the summarizer is told beside the person's own instructions. */
export function framing(cut: Cut, instructions?: string): string {
  const own = instructions?.trim()

  return [
    'Summarize only the earlier part of this conversation. Its later part stays verbatim and follows your summary, starting with this message:',
    `"${cut.preview}"`,
    'Describe where the work stood at that point. Do not present it as the current state and do not propose next steps: the verbatim messages after your summary carry those.',
    ...(own ? [`Also: ${own}`] : []),
  ].join('\n')
}
