import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import { CLOSING, alignmentNote, alignmentOf, continuationsOf, cutsOf, framing, liveRows, pick, previewAt, shareBefore, weightsOf } from './cut'
import type { Cut, Want } from './cut'

const NAME = 'summarize-up-to'
const SHOWN = 50
// After a dropped prompt is back in the box.
const REFILL_MS = 300
// After the cut is on disk, then once more for anything written late.
const RELINK_MS = [3000, 15000]
const RELINK_TRIES = 5

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

const thousands = (tokens: number): string =>
  tokens >= 1000 ? `about ${Math.round(tokens / 1000)}k tokens` : 'under 1k tokens'

// Claude Code's own count of the conversation: the context breakdown's
// Messages row, counted with the token-count API (the quick estimate ran low
// by a third on claude-haiku-4-5); else the estimate; else the whole context.
async function tokensOf($: EngineInterface): Promise<number | undefined> {
  for (const breakdown of ['full', 'summary'] as const) {
    const context = await $.session.usage({ breakdown }).then(
      usage => usage.context,
      () => undefined,
    )
    const row = context?.breakdown?.categories.find(c => c.kind === 'used' && c.name === 'Messages')
    if (row !== undefined) return row.tokens
    if (breakdown === 'summary') return context?.tokens
  }

  return undefined
}

// The conversation as the model reads it: it weighs each cut point, and
// tells step cuts which rows continue a batch of parallel tool calls.
async function apiOf($: EngineInterface) {
  try {
    return await $.session.messages({ as: 'api' })
  } catch {
    return undefined
  }
}

type View = { cuts: Cut[]; isWeighed: boolean }

// Shares are of what the model reads where the API form lines up with the
// rows, else of the rows alone.
function viewOf(rows: readonly SessionMessage[], api: Awaited<ReturnType<typeof apiOf>>, steps: boolean): View {
  const weights = api === undefined ? undefined : weightsOf(rows, api)
  const continuing = api === undefined || !steps ? undefined : continuationsOf(api)

  return { cuts: cutsOf(rows, { steps, continuing, weights }), isWeighed: weights !== undefined }
}

const messages = (n: number): string => `${n} message${n === 1 ? '' : 's'}`

// What /compact will do with the armed cut, said before anything happens.
function confirmation(rows: readonly SessionMessage[], view: View, cut: Cut, asked?: number, tokens?: number): string {
  // Tokens split by share only where the shares are of what the model reads.
  const share = (percent: number): string =>
    tokens === undefined || !view.isWeighed ? `${percent}%` : `${percent}%, ${thousands((tokens * percent) / 100)}`

  return [
    `Armed: /compact will summarize everything before ${describe(cut)}.`,
    ...(asked !== undefined && asked !== cut.percent
      ? [`You asked for ${asked}%; ${cut.percent}% is the nearest point that keeps tool calls whole.`]
      : []),
    `Summarized: ${messages(cut.index)} (${share(cut.percent)}). Kept verbatim: ${messages(rows.length - cut.index)} (${share(100 - cut.percent)}).`,
    view.isWeighed
      ? `Shares are of what the model reads${tokens === undefined ? '' : `: ${thousands(tokens)} of conversation by Claude Code's count`}.`
      : 'Shares are of the visible messages alone: the conversation as the model reads it could not be matched to them.',
    `Type /compact to go ahead, or /${NAME} cancel.`,
  ].join('\n')
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

// Claude Code saves a cut so that a resume would miss it: the kept tool
// results keep their links to entries from before the compaction, and a
// resume, following links back from the newest message, never reaches the
// summary. tools/relink.py points each at the entry before it, overwriting
// only those ids where they stand, and checks the chain is whole again.
type Relinked = { fixed: number; reaches: boolean; covered: number; total: number }

const relinkArgs = (root: string, id: string, ...rest: string[]): string[] => [
  'python3',
  `${root}/tools/relink.py`,
  '--session',
  id,
  ...rest,
]

async function relink($: EngineInterface, since: number, pass = 0, tries = 0, fixed = 0): Promise<void> {
  const id = await $.session.id().catch(() => undefined)
  if (id === undefined)
    return $.ui.log('could not save the cut so that a restart or resume keeps it (no session id). Do not restart or resume this session.')
  const run = await $.process
    .run(relinkArgs($.plugin.root, id, '--in-place', '--since', String(since)), { timeoutMs: 120_000 })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))
  if (run.exitCode === 3 && tries < RELINK_TRIES) {
    $.clock.after(RELINK_MS[0] ?? 3000, () => void relink($, since, pass, tries + 1, fixed))

    return
  }
  let result: Relinked | undefined
  try {
    result = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as Relinked
  } catch {
    result = undefined
  }
  if (run.exitCode === 0 && result?.reaches === true && result.covered === result.total) {
    const next = RELINK_MS[pass + 1]
    if (next !== undefined) {
      $.clock.after(next - (RELINK_MS[pass] ?? 0), () => void relink($, since, pass + 1, 0, fixed + result.fixed))

      return
    }
    const total = fixed + result.fixed

    return $.ui.log(
      `saved the cut so that a restart or resume keeps it${total > 0 ? ` (corrected ${total} links Claude Code wrote to before the compaction)` : ''}.`,
    )
  }
  const reason = (run.stderr.trim() || run.stdout.trim()).split('\n').at(-1) || `exit ${run.exitCode}`
  $.ui.log(
    [
      `could not save the cut so that a restart or resume keeps it (${reason}).`,
      'This session is fine while it runs. Before restarting or resuming it, run',
      `  ${relinkArgs($.plugin.root, id, '--write').join(' ')}`,
      'and resume the session id it prints.',
    ].join('\n'),
  )
}

// The command's answer, for /summarize-up-to and for the same line typed
// after a space.
async function answer($: EngineInterface, args: string): Promise<string> {
  const ask = parse(args)
  if (ask.kind === 'usage') return USAGE
  if (ask.kind === 'cancel') {
    const had = armed !== undefined
    armed = undefined

    return had ? 'Armed cut dropped; /compact summarizes the whole conversation again.' : 'No cut was armed.'
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

    return [
      armed !== undefined ? `Armed: /compact will summarize everything before ${armed.described}.` : 'No cut is armed.',
      `Partial auto-compaction: ${auto.isOn ? `on, summarizing the oldest ${auto.percent}%` : 'off'} (/config: ${NAME} options).`,
      `${at}; the context is ${context?.percent ?? '?'}% full. Set the threshold with /autocompact, e.g. /autocompact 900k.`,
      (await probe($)) ? 'Compaction reaches this mod in this session.' : UNREACHED,
      (await $.process.run(['python3', '--version']).then(r => r.exitCode === 0, () => false))
        ? 'python3 is here to save each cut so that a restart or resume keeps it.'
        : 'python3 is missing: a cut works, but a restart or resume would lose it. Install Python 3 before cutting.',
    ].join('\n')
  }

  const rows = liveRows(await $.session.messages())
  const api = await apiOf($)
  const turns = viewOf(rows, api, false)
  const isReached = await probe($)
  if (ask.kind === 'list') return `${listing(turns.cuts)}\n\n${isReached ? 'Compaction reaches this mod in this session.' : UNREACHED}`
  if (!isReached) return UNREACHED

  const view = ask.kind === 'percent' ? viewOf(rows, api, true) : turns
  const aligned = api === undefined ? undefined : alignmentOf(rows, api)
  if (api !== undefined && aligned !== undefined) $.ui.log(`arming; ${alignmentNote(rows, api, aligned)}`, { to: 'debug' })
  const chosen = ask.kind === 'percent' ? pick(view.cuts, { percent: ask.percent }) : turns.cuts[ask.ordinal - 1]
  if (chosen === undefined)
    return ask.kind === 'percent'
      ? 'Nothing to cut yet: the conversation has no message after its first.'
      : `No such cut point; there are ${turns.cuts.length}.\n\n${listing(turns.cuts)}`

  armed = {
    want:
      ask.kind === 'percent'
        ? { percent: ask.percent }
        : { fromEnd: turns.cuts.length - ask.ordinal + 1, preview: chosen.preview },
    notes: ask.notes,
    described: describe(chosen),
  }

  return confirmation(rows, view, chosen, ask.kind === 'percent' ? ask.percent : undefined, await tokensOf($))
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

  on('command.run', { command: NAME }, async ($, e) => ({ text: await answer($, e.args) })).catch(() => ({
    text: `${NAME} failed; nothing was armed.`,
  }))

  // A slash command typed after a space is no command: Claude Code passes it
  // to the model as text, and an agent may act on it. This mod's own command
  // runs as meant; /compact is held back, and the box offers it as meant, for
  // the person's Enter. Claude Code puts a dropped prompt back in the box, so
  // the box is set once it has.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const typed = /^\s+\/(compact|summarize-up-to)(?:\s+([\s\S]*))?$/.exec(e.text)
    if (e.command !== undefined || !isPerson || typed === null) return next(e)
    // What to read goes in a transcript line: Claude Code 2.1.302 shows a drop's
    // reason only for a moment.
    const meant = e.text.trimStart()
    if (typed[1] === 'compact') {
      $.ui.log(
        `held back "${meant}": with a space before the slash it would have gone to the model as text. The box now holds it without the space: press Enter to compact.`,
      )
      $.clock.after(REFILL_MS, () => void $.prompt.fill({ text: meant }))

      return { drop: `Held back by ${NAME}: a space before the slash.` }
    }
    $.ui.log(await answer($, typed[2] ?? ''))
    $.clock.after(REFILL_MS, () => void $.prompt.fill({ text: '' }))

    return { drop: `Typed after a space, so ${NAME} ran it as /${NAME}.` }
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    cutting = false
    if (e.agentId !== undefined) return next(e)
    reached = true
    // Claude Code can compute an auto-compaction ahead of time and install it
    // at the threshold without coming back here (behind a server flag of its
    // own). With partial auto-compaction on, the mod declines that, so the
    // compaction at the threshold comes through here as trigger auto.
    if (e.trigger === 'precompute' && auto.isOn) return { skip: `${NAME} cuts each auto-compaction when it runs` }
    // An armed cut applies to the person's /compact; with auto mode on, every
    // auto-compaction gets the configured share.
    const manual = e.trigger === 'manual' ? armed : undefined
    const isAuto = manual === undefined && e.trigger === 'auto' && auto.isOn
    const cut = manual ?? (isAuto ? { want: { percent: auto.percent } as Want, notes: '' } : undefined)
    if (cut === undefined) return next(e)
    if (manual !== undefined) armed = undefined

    const api = await apiOf($)
    const at = pick(viewOf(e.messages, api, 'percent' in cut.want).cuts, cut.want)
    const aligned = api === undefined ? undefined : alignmentOf(e.messages, api)
    $.ui.log(
      `cut at row ${at?.index ?? '-'} of ${e.messages.length}, API message ${at === undefined ? '-' : (aligned?.places[at.index] ?? '-')} of ${api?.length ?? '-'}, ${at?.percent ?? '-'}% summarized; ${api !== undefined && aligned !== undefined ? alignmentNote(e.messages, api, aligned) : 'no API form'}`,
      { to: 'debug' },
    )
    const head = at === undefined ? [] : e.messages.slice(0, at.index)
    // An auto-compaction must still free room: where no cut fits, or too little
    // precedes it to summarize, it runs as Claude Code's own.
    if (isAuto && (at === undefined || head.filter(m => m.role === 'assistant').length < 2)) {
      $.ui.log(`auto-compaction found no ${auto.percent}% cut with enough before it, so it summarized the whole conversation.`)

      return next(e)
    }
    if (at === undefined) return { skip: `${$.plugin.name}: the chosen cut point is no longer in the conversation` }

    // Stays set through the return: the engine checks the answer's shape after.
    cutting = true
    const since = Date.now()
    const notes = [cut.notes, e.instructions].map(n => n?.trim()).filter(Boolean).join('\n')
    let done
    try {
      const closing = { role: 'assistant' as const, text: CLOSING, toolUses: [] }
      done = await next({ ...e, messages: [...head, closing], instructions: framing(e.messages, at, notes || undefined) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      cutting = false
      if (isAuto) {
        $.ui.log(`the partial summary failed (${reason}), so auto-compaction summarized the whole conversation.`)

        return next(e)
      }

      // Core refusing the part before the cut ("fewer than 2 groups"): say why.
      return { skip: `${NAME}: not summarized: ${reason}` }
    }
    if (done.skip !== undefined) return done
    // By its text: Claude Code stamps a handle on the message it kept.
    const summary = done.messages.filter(m => !(m.role === 'assistant' && m.text.trim() === CLOSING))

    // Claude Code keeps part of what it was handed to summarize: the rows it
    // hands back beside its summary. Where verbatim text starts, and the share
    // summarized, come from those, whatever path the compaction took.
    const rowOf = new Map(e.messages.map((m, i) => [m.handle, i]))
    const keptFrom =
      summary.map(m => (m.handle === undefined ? undefined : rowOf.get(m.handle))).find(i => i !== undefined) ?? at.index
    const summarized = shareBefore(e.messages, keptFrom, api === undefined ? undefined : weightsOf(e.messages, api))
    $.ui.log(
      `${isAuto ? 'auto-compaction ' : ''}summarized everything before ${describe({ ...at, percent: summarized })}. That message and everything after it are kept verbatim` +
        (keptFrom < at.index
          ? `, and so ${at.index - keptFrom === 1 ? 'is the message' : `are the ${at.index - keptFrom} messages`} before it, which Claude Code kept: verbatim text starts at "${previewAt(e.messages, keptFrom)}".`
          : '.'),
    )
    $.clock.after(RELINK_MS[0] ?? 3000, () => void relink($, since))

    return {
      messages: [...summary, ...e.messages.slice(at.index)],
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
