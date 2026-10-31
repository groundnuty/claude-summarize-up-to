import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import { continuationsOf, cutsOf, framing, liveRows, pick } from './cut'
import type { Cut, Want } from './cut'

const NAME = 'summarize-up-to'
const SHOWN = 50
// The engine refuses a compaction from inside the command's own hook, so the
// command starts it from a timer once the session is idle again.
const START_MS = 200
const RETRY_MS = 2000
const RETRIES = 3

const USAGE = [
  `/${NAME}            list the cut points: your prompts and the notifications between turns`,
  `/${NAME} #12 [notes] summarize everything before cut 12; it and all after stay verbatim`,
  `/${NAME} 70% [notes] cut at the step nearest 70%, inside a turn too: any message boundary that keeps tool calls whole`,
  `/${NAME} cancel      drop a cut that is still armed for the next /compact`,
  `/${NAME} status      partial auto-compaction, its share, and when Claude Code auto-compacts`,
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

// Step cuts skip rows that continue a parallel batch; without the API form
// they fall back to every assistant row after a user row.
async function stepsOf($: EngineInterface, rows: readonly SessionMessage[]): Promise<Cut[]> {
  try {
    return cutsOf(rows, { steps: true, continuing: continuationsOf(await $.session.messages({ as: 'api' })) })
  } catch {
    return cutsOf(rows, { steps: true })
  }
}

// The cut the command armed, consumed by the next compaction this mod or the
// person starts (`/compact`); a reload loses it.
type Armed = { want: Want; notes: string }
let armed: Armed | undefined
let applied: Cut | undefined
// Set while the compaction hook cuts, and until the next compaction, for its
// catch handler.
let cutting = false
// Whether compaction reaches this mod. Claude Code's built-in security default
// (cc-plugin-sec-default, seated in Team and Enterprise organizations and on
// machines with managed settings) passes session.compact past user plugins,
// and settings.read with it; a cut started there would summarize the whole
// conversation. Seeing either event proves the default does not stand in the
// way; the command probes with a settings read before it gives up.
let reached = false
const reachedNow = (): boolean => reached

// The userConfig options, read at each (re)load: /config changes reload.
const DEFAULT_PERCENT = 65
let auto = { isOn: false, percent: DEFAULT_PERCENT }

const UNREACHED = [
  "Not run: in this session Claude Code keeps compaction away from user mods, so a cut would summarize the whole conversation.",
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
// Read through calls: the compaction hook changes both while we await.
const appliedCut = (): Cut | undefined => applied
const armedCut = (): Armed | undefined => armed

async function summarize($: EngineInterface, cut: Armed, tries = 0): Promise<void> {
  if (armedCut() !== cut) return
  applied = undefined
  try {
    const done = await $.session.compact({ instructions: cut.notes.trim() || undefined })
    if (done.skip !== undefined) {
      armed = undefined

      return $.ui.log(`${NAME}: not summarized: ${done.skip}`)
    }
  } catch (error) {
    // Most likely a turn started in the meantime: try again once it may be over.
    if (tries < RETRIES) {
      $.clock.after(RETRY_MS, () => void summarize($, cut, tries + 1))

      return
    }
    // A headless session, for one, compacts only inside a /compact turn.
    const reason = error instanceof Error ? error.message : String(error)

    return $.ui.log(
      `${NAME}: could not start the compaction (${reason}). The cut stays armed: run /compact to apply it, or /${NAME} cancel.`,
    )
  }

  if (appliedCut() === undefined) {
    armed = undefined
    $.ui.log(`${NAME}: the compaction ran without this mod's cut, so it covered the whole conversation.`)
  }
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
      description: 'Summarize up to any point, inside agent-driven turns too, keeping the rest verbatim',
      argumentHint: '[#n | n% | cancel] [notes]',
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
          `Partial auto-compaction: ${auto.isOn ? `on, summarizing the oldest ${auto.percent}%` : 'off'} (/config: ${NAME} options).`,
          `${at}; the context is ${context?.percent ?? '?'}% full. Set the threshold with /autocompact, e.g. /autocompact 900k.`,
          (await probe($)) ? 'Compaction reaches this mod in this session.' : UNREACHED,
          ...(armed !== undefined ? ['A cut is armed for the next /compact.'] : []),
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

    const cut: Armed = {
      want:
        ask.kind === 'percent'
          ? { percent: ask.percent }
          : { fromEnd: cuts.length - ask.ordinal + 1, preview: chosen.preview },
      notes: ask.notes,
    }
    armed = cut
    applied = undefined
    $.clock.after(START_MS, () => void summarize($, cut))

    return { text: `Summarizing everything before ${describe(chosen)}…` }
  }).catch(() => ({ text: `${NAME} failed before summarizing anything.` }))

  on('session.compact', async ($, e, next) => {
    cutting = false
    if (e.agentId !== undefined) return next(e)
    reached = true
    // A cut the person armed applies to their /compact or the mod's own;
    // with auto mode on, every auto-compaction gets the configured share.
    const manual = e.trigger === 'plugin' || e.trigger === 'manual' ? armed : undefined
    const isAuto = manual === undefined && e.trigger === 'auto' && auto.isOn
    const cut: Armed | undefined = manual ?? (isAuto ? { want: { percent: auto.percent }, notes: '' } : undefined)
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

    applied = at
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
