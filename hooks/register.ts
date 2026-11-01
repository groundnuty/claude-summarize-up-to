import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import { CLOSING, alignmentNote, alignmentOf, continuationsOf, cutsOf, framing, liveRows, pick, previewAt, shareBefore, weightsOf } from './cut'
import type { Cut, Want } from './cut'

const NAME = 'summarize-up-to'
const SHOWN = 50
// After a dropped prompt is back in the box.
const REFILL_MS = 300
// After a start, a resume or a reload, before checking compaction reaches the mod.
const STARTUP_MS = 3000
// After the cut is on disk, then once more for anything written late.
const RELINK_MS = [3000, 15000]
const RELINK_TRIES = 5

const USAGE = [
  `/${NAME}            list the cut points: your prompts and the notifications between turns`,
  `/${NAME} 20% [notes] every /compact in this project summarizes the oldest 20%, until you set another share`,
  `/${NAME} 0%          every /compact summarizes the whole conversation, as without the mod`,
  `/${NAME} #12 [notes] the next /compact only: summarize everything before listed point 12`,
  `/${NAME} cancel      drop a cut armed with #n`,
  `/${NAME} status      the share /compact uses, partial auto-compaction, and when Claude Code auto-compacts`,
  '/compact full              summarize the whole conversation, this once',
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

// What /compact will do, said before anything happens: for a share set for
// every /compact, what it comes to now; for a cut armed once, where it falls.
function confirmation(
  rows: readonly SessionMessage[],
  view: View,
  cut: Cut,
  set: { percent: number } | undefined,
  tokens?: number,
): string {
  // Tokens split by share only where the shares are of what the model reads.
  const share = (percent: number): string =>
    tokens === undefined || !view.isWeighed ? `${percent}%` : `${percent}%, ${thousands((tokens * percent) / 100)}`

  return [
    ...(set !== undefined
      ? [
          `Set: every /compact in this project now summarizes the oldest ${set.percent}%, until you set another share.`,
          `Now that is everything before ${describe(cut)}.`,
          ...(set.percent !== cut.percent ? [`${cut.percent}% is the nearest point to ${set.percent}% that keeps tool calls whole.`] : []),
        ]
      : [`Armed for the next /compact only: it will summarize everything before ${describe(cut)}.`]),
    `Summarized: ${messages(cut.index)} (${share(cut.percent)}). Kept verbatim: ${messages(rows.length - cut.index)} (${share(100 - cut.percent)}).`,
    view.isWeighed
      ? `Shares are of what the model reads${tokens === undefined ? '' : `: ${thousands(tokens)} of conversation by Claude Code's count`}.`
      : 'Shares are of the visible messages alone: the conversation as the model reads it could not be matched to them.',
    set !== undefined
      ? 'Type /compact to compact now; /compact full summarizes everything, this once.'
      : `Type /compact to go ahead, or /${NAME} cancel.`,
  ].join('\n')
}

// The share every plain /compact summarizes, per project (the session's root
// folder): set with the command and kept in the mod's store across sessions;
// until then, the /config option. Kept in memory too, should the store fail.
let plainDefault = 65
const sessionShares = new Map<string, number>()

async function shareKey($: EngineInterface): Promise<string> {
  return `share:${await $.session.root().catch(() => '')}`
}

async function standingShare($: EngineInterface): Promise<{ percent: number; isSet: boolean }> {
  const key = await shareKey($)
  const stored = await $.store.get(key).catch(() => undefined)
  const percent = typeof stored === 'number' ? stored : sessionShares.get(key)

  return percent === undefined ? { percent: plainDefault, isSet: false } : { percent, isSet: true }
}

async function setShare($: EngineInterface, percent: number): Promise<boolean> {
  const key = await shareKey($)
  sessionShares.set(key, percent)

  return $.store.set(key, percent).then(
    () => true,
    () => false,
  )
}

const shareLine = (share: { percent: number; isSet: boolean }): string =>
  share.percent === 0
    ? `/compact summarizes the whole conversation (${share.isSet ? `set with /${NAME} 0%` : '/config default'}).`
    : `/compact summarizes the oldest ${share.percent}% (${share.isSet ? `set with /${NAME}` : '/config default'}); /compact full summarizes everything.`

// A cut armed at a listed point (#n), applied by the person's next /compact
// only; notes given with a share go with the next /compact too. The mod never
// starts a compaction itself: Claude Code does not run a mod's session.compact
// hook on a compaction that mod started, so the cut would be lost and the whole
// conversation summarized. A reload drops both.
type Armed = { want: Want; notes: string; described: string }
let armed: Armed | undefined
let nextNotes = ''
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
  'Not cutting: in this session Claude Code keeps compaction away from user mods, so a compaction here would summarize the whole conversation.',
  "That is Claude Code's built-in security default (cc-plugin-sec-default), seated in Team and Enterprise organizations and on machines with managed settings, and once seated it holds until the session ends.",
  'Restart the session under a personal login on a machine without managed settings (/exit, then claude --resume <id>), or have an administrator seat the mod ahead of it with managed prependPlugins.',
].join('\n')

// Where the mod cannot cut, no compaction should run on its own: Claude Code's
// would summarize everything, typed or automatic. DISABLE_COMPACT, which it
// reads at each check, switches compaction off for this process alone. Claude
// Code lets a mod switch it off but not on again ("only the environment Claude
// Code starts with, or Claude Code itself, may give it this value"), so it
// stays off until the session ends; a person who wants compaction there anyway
// starts it with DISABLE_COMPACT=0, which the mod leaves alone.
const OFF = 'DISABLE_COMPACT'
let isSwitchedOff = false

async function switchOff($: EngineInterface): Promise<boolean> {
  if (isSwitchedOff) return true
  if ((await $.env.get('DISABLE_COMPACT').catch(() => undefined)) !== undefined) return false
  const done = await $.env.set('DISABLE_COMPACT', '1').catch(() => ({ deny: 'failed' }))
  isSwitchedOff = done.deny === undefined

  return isSwitchedOff
}

const SWITCHED_OFF = `So the mod has switched compaction off in this session (${OFF}=1, which nothing but a restart undoes): no auto-compaction runs here, /compact is an unknown command, and at the context limit the agent stops rather than lose its context. To compact here anyway, start the session with ${OFF}=0 in its environment; the mod then leaves compaction alone, and a compaction summarizes everything.`
const NOT_SWITCHED_OFF = `The mod could not switch compaction off here: a /compact you type is held back, but an auto-compaction would summarize everything.`

// What a held-back /compact says, with the way to cut and the way not to.
async function heldBack($: EngineInterface): Promise<string> {
  const id = await $.session.id().catch(() => '<session id>')
  const share = await standingShare($).catch(() => ({ percent: plainDefault, isSet: false }))

  return [
    `held back /compact: in this session Claude Code keeps compaction away from user mods (its security default, cc-plugin-sec-default), so it would summarize the whole conversation, not the oldest ${share.percent}%.`,
    `To cut, restart this session under a personal login on a machine without managed settings: /exit, then claude --resume ${id} in this folder; /${NAME} status then says compaction reaches this mod.`,
    'To summarize everything anyway: /compact full',
  ].join('\n')
}

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
    const had = armed !== undefined || nextNotes !== ''
    armed = undefined
    nextNotes = ''

    return `${had ? 'Armed cut dropped.' : 'No cut was armed.'} ${shareLine(await standingShare($))}`
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

    // Where compaction cannot reach the mod, that leads: the shares below it
    // would not apply.
    const isReached = await probe($)

    return [
      ...(isReached ? [] : [UNREACHED, (await switchOff($)) ? SWITCHED_OFF : NOT_SWITCHED_OFF, '']),
      shareLine(await standingShare($)),
      ...(armed !== undefined ? [`Armed for the next /compact only: everything before ${armed.described}.`] : []),
      `Partial auto-compaction: ${auto.isOn ? `on, summarizing the oldest ${auto.percent}%` : 'off'} (/config: ${NAME} options).`,
      `${at}; the context is ${context?.percent ?? '?'}% full. Set the threshold with /autocompact, e.g. /autocompact 900k.`,
      ...(isReached ? ['Compaction reaches this mod in this session.'] : []),
      (await $.process.run(['python3', '--version']).then(r => r.exitCode === 0, () => false))
        ? 'python3 is here to save each cut so that a restart or resume keeps it.'
        : 'python3 is missing: a cut works, but a restart or resume would lose it. Install Python 3 before cutting.',
    ].join('\n')
  }

  const rows = liveRows(await $.session.messages())
  const api = await apiOf($)
  const turns = viewOf(rows, api, false)
  const isReached = await probe($)
  if (ask.kind === 'list')
    return `${listing(turns.cuts)}\n\n${shareLine(await standingShare($))}\n${isReached ? 'Compaction reaches this mod in this session.' : UNREACHED}`
  if (!isReached) return UNREACHED

  // A share set for every /compact: kept, and what it comes to now. A cut
  // armed at a listed point before it no longer stands.
  if (ask.kind === 'percent') {
    armed = undefined
    nextNotes = ask.notes.trim()
    const isStored = await setShare($, ask.percent)
    const stored = isStored ? '' : '\nThe mod could not store the share, so it holds for this session only.'
    if (ask.percent === 0)
      return `Set: every /compact in this project now summarizes the whole conversation, as without the mod, until you set another share.${stored}`
    const view = viewOf(rows, api, true)
    const aligned = api === undefined ? undefined : alignmentOf(rows, api)
    if (api !== undefined && aligned !== undefined) $.ui.log(`share set; ${alignmentNote(rows, api, aligned)}`, { to: 'debug' })
    const chosen = pick(view.cuts, { percent: ask.percent })
    if (chosen === undefined)
      return `Set: every /compact in this project now summarizes the oldest ${ask.percent}%, until you set another share. Nothing to cut yet: the conversation has no point to cut at.${stored}`

    return `${confirmation(rows, view, chosen, { percent: ask.percent }, await tokensOf($))}${stored}`
  }

  const chosen = turns.cuts[ask.ordinal - 1]
  if (chosen === undefined) return `No such cut point; there are ${turns.cuts.length}.\n\n${listing(turns.cuts)}`
  armed = {
    want: { fromEnd: turns.cuts.length - ask.ordinal + 1, preview: chosen.preview },
    notes: ask.notes,
    described: describe(chosen),
  }

  return confirmation(rows, turns, chosen, undefined, await tokensOf($))
}

export const register: Register = (on, options) => {
  auto = {
    isOn: options.auto_compact === true,
    percent: typeof options.summarize_percent === 'number' ? options.summarize_percent : DEFAULT_PERCENT,
  }
  plainDefault = typeof options.compact_percent === 'number' ? options.compact_percent : DEFAULT_PERCENT

  // Observe only: every read gets the engine's answer unchanged.
  on('settings.read', ($, e, next) => {
    reached = true

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description: 'Set the share every /compact summarizes, keeping the rest verbatim; or cut once at a listed point',
      argumentHint: '[n% | #n | cancel | status] [notes]',
    })
    // A start, a resume or a reload under Claude Code's security default:
    // compaction is switched off and that said at once, before anything
    // compacts. Once the session has settled.
    $.clock.after(STARTUP_MS, () => {
      void (async () => {
        if (await probe($)) return
        $.ui.log(`${UNREACHED}\n${(await switchOff($)) ? SWITCHED_OFF : NOT_SWITCHED_OFF}`)
      })().catch(() => undefined)
    })

    return next(e)
  })

  // Where Claude Code's security default keeps compaction away from this mod,
  // /compact would summarize everything. Commands reach the mod through
  // command.run, which the default does not pass over: /compact is held back
  // there, so a forgotten guard cannot cost a curated context. "/compact full"
  // runs, as a plain one. Where the mod has switched compaction off, Claude
  // Code itself makes /compact an unknown command, and this never runs.
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    if (await probe($)) return next(e)
    if (!/^full$/i.test(e.args.trim())) return { text: await heldBack($) }

    return next({ ...e, args: '' })
  }).catch(($, e, next) => next(e))

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
    // The person's /compact: a cut armed at a listed point, else the share set
    // for every /compact, which stays; "/compact full" summarizes everything.
    // With auto mode on, every auto-compaction gets the configured share.
    const isPerson = e.trigger === 'manual'
    if (isPerson && /^full$/i.test(e.instructions?.trim() ?? '')) {
      armed = undefined
      nextNotes = ''

      return next({ ...e, instructions: undefined })
    }
    const standing = isPerson && armed === undefined ? await standingShare($) : undefined
    const isStanding = standing !== undefined && standing.percent > 0
    const manual: Armed | undefined = isPerson
      ? (armed ?? (isStanding ? { want: { percent: standing.percent }, notes: nextNotes, described: '' } : undefined))
      : undefined
    if (isPerson) {
      armed = undefined
      nextNotes = ''
    }
    const isAuto = manual === undefined && e.trigger === 'auto' && auto.isOn
    const cut = manual ?? (isAuto ? { want: { percent: auto.percent } as Want, notes: '' } : undefined)
    if (cut === undefined) return next(e)

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
    if (at === undefined)
      return {
        skip: isStanding
          ? `${NAME}: no point to cut at ${standing.percent}% yet; /compact full summarizes everything`
          : `${NAME}: the chosen cut point is no longer in the conversation`,
      }

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
          : '.') +
        (isStanding ? ` Every /compact here summarizes the oldest ${standing.percent}%, until you set another share.` : '') +
        " Claude Code's status line shows 0% until the next answer; /context counts the context now.",
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
