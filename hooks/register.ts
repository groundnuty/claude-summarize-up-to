import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import { continuationsOf, cutsOf, framing, liveRows, pick, sizeOf } from './cut'
import type { Cut, Want } from './cut'

const NAME = 'summarize-up-to'
const SHOWN = 50

const USAGE = [
  `/${NAME}            list the cut points: your prompts and the notifications between turns`,
  `/${NAME} 70% [notes] arm a cut at the step nearest 70%, inside a turn too; then type /compact`,
  `/${NAME} #12 [notes] arm a cut at listed point 12; then type /compact`,
  `/${NAME} cancel      drop the armed cut`,
  `/${NAME} status      the armed cut, partial auto-compaction, and when Claude Code auto-compacts`,
].join('\n')

type Ask =
  | { kind: 'list' }
  | { kind: 'cancel' }
  | { kind: 'status' }
  | { kind: 'usage' }
  | { kind: 'percent'; percent: number; notes: string }
  | { kind: 'ordinal'; ordinal: number; notes: string }

function parse(args: string): Ask {
  const text = args.trim()
  if (text === '' || text === 'list') return { kind: 'list' }
  if (text === 'cancel') return { kind: 'cancel' }
  if (text === 'status') return { kind: 'status' }
  const percent = /^(\d{1,3})%\s*([\s\S]*)$/.exec(text)
  if (percent?.[1] !== undefined && Number(percent[1]) <= 100)
    return { kind: 'percent', percent: Number(percent[1]), notes: percent[2] ?? '' }
  const ordinal = /^#(\d+)\s*([\s\S]*)$/.exec(text)
  if (ordinal?.[1] !== undefined)
    return { kind: 'ordinal', ordinal: Number(ordinal[1]), notes: ordinal[2] ?? '' }

  return { kind: 'usage' }
}

function listing(cuts: readonly Cut[]): string {
  if (cuts.length === 0)
    return `No prompts or messages between turns to cut at yet. A percentage still cuts between any two steps of a turn.\n\n${USAGE}`
  const hidden = Math.max(0, cuts.length - SHOWN)
  const rows = cuts.slice(hidden).map((cut, i) => {
    const n = `#${hidden + i + 1}`.padEnd(5)
    const at = `${cut.percent}%`.padStart(4)

    return `${n}${at}  ${cut.kind.padEnd(5)} ${cut.preview}`
  })

  return [
    'Cut points, oldest first. The chosen message and everything after it stay verbatim.',
    ...(hidden > 0 ? [`(${hidden} older cut points not shown)`] : []),
    ...rows,
    '',
    USAGE,
  ].join('\n')
}

const describe = (cut: Cut): string =>
  `${cut.kind === 'step' ? 'the step' : `the ${cut.kind} message`} at ${cut.percent}% ("${cut.preview}")`

// About four characters to a token: enough to tell 20k from 200k.
const tokens = (rows: readonly SessionMessage[]): string => {
  const k = Math.round(rows.reduce((n, m) => n + sizeOf(m), 0) / 4000)

  return k >= 1 ? `about ${k}k tokens` : 'under 1k tokens'
}

// What /compact will do with the armed cut, said before anything happens.
function confirmation(rows: readonly SessionMessage[], cut: Cut, asked?: number): string {
  const before = rows.slice(0, cut.index)
  const after = rows.slice(cut.index)

  return [
    `Armed: /compact will summarize everything before ${describe(cut)}.`,
    ...(asked !== undefined && asked !== cut.percent
      ? [`You asked for ${asked}%; ${cut.percent}% is the nearest point that keeps tool calls whole.`]
      : []),
    `Summarized: ${before.length} messages (${cut.percent}%, ${tokens(before)}). Kept verbatim: ${after.length} messages (${100 - cut.percent}%, ${tokens(after)}).`,
    'Claude Code may keep a message or two more before the cut.',
    `Type /compact to go ahead, or /${NAME} cancel.`,
  ].join('\n')
}

// Step cuts skip rows that continue a parallel batch; without the API form
// they fall back to every assistant row after a user row.
async function stepsOf($: EngineInterface, rows: readonly SessionMessage[]): Promise<Cut[]> {
  try {
    return cutsOf(rows, { steps: true, continuing: continuationsOf(await $.session.messages({ as: 'api' })) })
  } catch {
    return cutsOf(rows, { steps: true })
  }
}

// The cut the command armed, applied by the person's next /compact. The mod
// never starts a compaction itself: Claude Code does not run a mod's
// session.compact hook on a compaction that mod started, so the cut would be
// lost and the whole conversation summarized. A reload drops the armed cut.
type Armed = { want: Want; notes: string; described: string }
let armed: Armed | undefined
// Set while the compaction hook cuts, and until the next compaction, for its
// catch handler.
let cutting = false
// Whether compaction reaches this mod. Claude Code's built-in security default
// (cc-plugin-sec-default, seated in Team and Enterprise organizations and on
// machines with managed settings) passes session.compact past user plugins,
// and settings.read with it; a cut there would never apply. Seeing either
// event proves the default does not stand in the way; the command probes with
// a settings read before it gives up.
let reached = false
const reachedNow = (): boolean => reached

// The userConfig options, read at each (re)load: /config changes reload.
const DEFAULT_PERCENT = 65
let auto = { isOn: false, percent: DEFAULT_PERCENT }

const UNREACHED = [
  'Not armed: in this session Claude Code keeps compaction away from user mods, so /compact would summarize the whole conversation.',
  "That is Claude Code's built-in security default (cc-plugin-sec-default), seated in Team and Enterprise organizations and on machines with managed settings.",
  'An administrator can seat the mod ahead of it with managed prependPlugins.',
].join('\n')

// A settings read raises settings.read, which the security default passes
// over exactly where it passes over session.compact.
async function probe($: EngineInterface): Promise<boolean> {
  if (!reachedNow()) {
    try {
      await $.settings.read()
    } catch {
      // A read that fails proves nothing either way.
    }
  }

  return reachedNow()
}

export const register: Register = (on, options) => {
  auto = {
    isOn: options.auto_compact === true,
    percent: typeof options.summarize_percent === 'number' ? options.summarize_percent : DEFAULT_PERCENT,
  }

  // Observe only: every read gets the engine's answer unchanged.
  on('settings.read', ($, e, next) => {
    reached = true

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description: 'Arm a cut at any point, inside agent-driven turns too; /compact then summarizes only what precedes it',
      argumentHint: '[#n | n% | cancel | status] [notes]',
    })

    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const ask = parse(e.args)
    if (ask.kind === 'usage') return { text: USAGE }
    if (ask.kind === 'cancel') {
      const had = armed !== undefined
      armed = undefined

      return { text: had ? 'Armed cut dropped; /compact summarizes the whole conversation again.' : 'No cut was armed.' }
    }
    if (ask.kind === 'status') {
      const context = await $.session.usage({ breakdown: 'summary' }).then(u => u.context, () => undefined)
      const window = context?.breakdown
      const at =
        context === undefined
          ? 'the auto-compaction threshold is unknown'
          : window === undefined || !window.isAutoCompactEnabled || window.autoCompactThreshold === undefined
            ? 'auto-compaction is off'
            : `Claude Code auto-compacts at ${Math.round(window.autoCompactThreshold / 1000)}k tokens (${Math.round((100 * window.autoCompactThreshold) / window.rawMaxTokens)}% of ${Math.round(window.rawMaxTokens / 1000)}k)`

      return {
        text: [
          armed !== undefined ? `Armed: /compact will summarize everything before ${armed.described}.` : 'No cut is armed.',
          `Partial auto-compaction: ${auto.isOn ? `on, summarizing the oldest ${auto.percent}%` : 'off'} (/config: ${NAME} options).`,
          `${at}; the context is ${context?.percent ?? '?'}% full. Set the threshold with /autocompact, e.g. /autocompact 900k.`,
          (await probe($)) ? 'Compaction reaches this mod in this session.' : UNREACHED,
        ].join('\n'),
      }
    }

    const rows = liveRows(await $.session.messages())
    const cuts = cutsOf(rows)
    const isReached = await probe($)
    if (ask.kind === 'list') return { text: `${listing(cuts)}\n\n${isReached ? 'Compaction reaches this mod in this session.' : UNREACHED}` }
    if (!isReached) return { text: UNREACHED }

    const chosen =
      ask.kind === 'percent' ? pick(await stepsOf($, rows), { percent: ask.percent }) : cuts[ask.ordinal - 1]
    if (chosen === undefined)
      return {
        text:
          ask.kind === 'percent'
            ? 'Nothing to cut yet: the conversation has no message after its first.'
            : `No such cut point; there are ${cuts.length}.\n\n${listing(cuts)}`,
      }

    armed = {
      want:
        ask.kind === 'percent'
          ? { percent: ask.percent }
          : { fromEnd: cuts.length - ask.ordinal + 1, preview: chosen.preview },
      notes: ask.notes,
      described: describe(chosen),
    }

    return { text: confirmation(rows, chosen, ask.kind === 'percent' ? ask.percent : undefined) }
  }).catch(() => ({ text: `${NAME} failed; nothing was armed.` }))

  on('session.compact', async ($, e, next) => {
    cutting = false
    if (e.agentId !== undefined) return next(e)
    reached = true
    // An armed cut applies to the person's /compact; with auto mode on, every
    // auto-compaction gets the configured share.
    const manual = e.trigger === 'manual' ? armed : undefined
    const isAuto = manual === undefined && e.trigger === 'auto' && auto.isOn
    const cut = manual ?? (isAuto ? { want: { percent: auto.percent } as Want, notes: '' } : undefined)
    if (cut === undefined) return next(e)
    if (manual !== undefined) armed = undefined

    const at = pick('percent' in cut.want ? await stepsOf($, e.messages) : cutsOf(e.messages), cut.want)
    const head = at === undefined ? [] : e.messages.slice(0, at.index)
    // An auto-compaction must still free room: where no cut fits, or too little
    // precedes it to summarize, it runs as Claude Code's own.
    if (isAuto && (at === undefined || head.filter(m => m.role === 'assistant').length < 2)) {
      $.ui.log(`${NAME}: auto-compaction found no ${auto.percent}% cut with enough before it, so it summarized the whole conversation.`)

      return next(e)
    }
    if (at === undefined) return { skip: `${$.plugin.name}: the chosen cut point is no longer in the conversation` }

    // Stays set through the return: the engine checks the answer's shape after.
    cutting = true
    const notes = [cut.notes, e.instructions].map(n => n?.trim()).filter(Boolean).join('\n')
    let done
    try {
      done = await next({ ...e, messages: head, instructions: framing(at, notes || undefined) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      cutting = false
      if (isAuto) {
        $.ui.log(`${NAME}: the partial summary failed (${reason}), so auto-compaction summarized the whole conversation.`)

        return next(e)
      }

      // Core refusing the part before the cut ("fewer than 2 groups"): say why.
      return { skip: `${NAME}: not summarized: ${reason}` }
    }
    if (done.skip !== undefined) return done

    $.ui.log(
      `${NAME}: ${isAuto ? 'auto-compaction ' : ''}summarized everything before ${describe(at)}. That message and everything after it are kept verbatim.`,
    )

    return {
      messages: [...done.messages, ...e.messages.slice(at.index)],
      ...(done.usage !== undefined && { usage: done.usage }),
    }
  }).catch(($, e, next) => {
    if (!cutting) return next(e)

    // Mid-cut, a skipped hook would let the compaction run over the whole
    // conversation, and replaying `next` would keep the summary without the
    // verbatim tail: leave the conversation as it was.
    return { skip: `${NAME}: the partial summary failed, so the conversation is left as it was` }
  })
}
