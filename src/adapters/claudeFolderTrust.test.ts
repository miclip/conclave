/**
 * Answering Claude Code's folder-trust dialog (#108).
 *
 *   node --test src/adapters/claudeFolderTrust.test.ts
 *
 * The dialog is drawn by a real `claude` in a pty, so the temptation is to test this by
 * spawning one and grepping the screen. That test would prove the least interesting half: the
 * screen is where the QUESTION appears, and everything worth asserting here is about the
 * ANSWER -- which keys were sent, how many times, and to which directory. So the acceptance is
 * driven against a fake pty and checked against the record it returns and the writes it made.
 *
 * The buffers below are not hand-written prose. They carry the cursor-positioning escapes a
 * real Claude Code TUI emits BETWEEN words, because that is precisely the property that made
 * the first version of the detection never match anything.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  acceptFolderTrustDialog,
  dismissableModalVisible,
  answerableFolderTrustDialog,
  bootFailureMessage,
  folderTrustDialogVisible,
  type FolderTrustAcceptance,
  type TrustDialogPty,
} from './claude.ts'

const ESC = '\u001b'

/** The dialog as it lands in a pty buffer: words separated by cursor moves, not spaces. */
const DIALOG =
  `${ESC}[2GQuick${ESC}[8Gsafety${ESC}[15Gcheck:${ESC}[22GIs${ESC}[25Gthis${ESC}[30Ga` +
  `${ESC}[32Gproject${ESC}[40Gyou${ESC}[44Gcreated${ESC}[2G${ESC}[38;2;177;185;249m` +
  `${ESC}[4G1.${ESC}[8GYes,${ESC}[12GI${ESC}[14Gtrust${ESC}[20Gthis${ESC}[25Gfolder` +
  `${ESC}[2G${ESC}[4G2.${ESC}[8GNo,${ESC}[12Gexit`

/** An ordinary composer, with nothing outstanding. */
const COMPOSER = `${ESC}[2G>${ESC}[4GTry${ESC}[8G"fix${ESC}[12Gthe${ESC}[16Gbuild"${ESC}[?2004h`

/**
 * Screens that carry a piece of the dialog and are NOT the dialog.
 *
 * Three carry its WORDING and no menu, one carries a MENU and none of its wording. Typing at
 * any of them submits a turn whose entire content is `1`. `broad` records which of them the
 * loose reading mistakes for the dialog, since that is the gap the strict one exists to close.
 * The last is not hypothetical in the slightest: it is what a session looking at this very
 * adapter has on screen.
 */
const IMPOSTORS: { what: string; screen: string; broad: boolean }[] = [
  {
    what: 'the model narrating the phrase',
    broad: true,
    screen:
      `${ESC}[2GI${ESC}[4Gwill${ESC}[9Gtrust${ESC}[15Gthis${ESC}[20Gfolder${ESC}[27Gand` +
      `${ESC}[31Gcarry${ESC}[37Gon${ESC}[40Greading`,
  },
  {
    what: 'the question quoted in prose, with no menu',
    broad: true,
    screen:
      `${ESC}[2GIs${ESC}[5Gthis${ESC}[10Ga${ESC}[12Gproject${ESC}[20Gyou${ESC}[24Gcreated` +
      `${ESC}[32G?${ESC}[34Gis${ESC}[37Gwhat${ESC}[42Git${ESC}[45Gasks`,
  },
  {
    // The other half of the pair: menu structure and a confirmation line, and not one word
    // about trusting anything. The broad reading does not see it; the strict one must not
    // either, because `1` here picks a colour scheme.
    what: 'a numbered menu that is about something else',
    broad: false,
    screen:
      `${ESC}[2GSelect${ESC}[9Ga${ESC}[11Gtheme${ESC}[2G${ESC}[4G1.${ESC}[8GDark` +
      `${ESC}[2G${ESC}[4G2.${ESC}[8GLight${ESC}[2GEnter${ESC}[10Gto${ESC}[13Gconfirm`,
  },
  {
    what: 'this adapter on screen in an editor',
    broad: true,
    screen:
      `${ESC}[2Gconst${ESC}[8GFOLDER_TRUST_DIALOG${ESC}[28G=${ESC}[30G/trust${ESC}[37Gthis` +
      `${ESC}[42Gfolder|Is${ESC}[52Gthis${ESC}[57Ga${ESC}[59Gproject${ESC}[67Gyou` +
      `${ESC}[71Gcreated/i`,
  },
  {
    // The whole dialog, with the trusting option moved off `1`. This is the mistake that costs
    // the most: `1` here is a narrower grant than the one being asked for, and on a build that
    // ordered it "1. No, exit" it would decline. Everything else about the screen is genuine,
    // so only the check that option 1 IS the trusting one refuses it.
    what: 'the real dialog with the options renumbered',
    broad: true,
    screen:
      `${ESC}[2GQuick${ESC}[8Gsafety${ESC}[15Gcheck:${ESC}[22GIs${ESC}[25Gthis${ESC}[30Ga` +
      `${ESC}[32Gproject${ESC}[40Gyou${ESC}[44Gcreated${ESC}[2G${ESC}[4G1.${ESC}[8GYes,` +
      `${ESC}[13Gjust${ESC}[18Gthis${ESC}[23Gsession${ESC}[2G${ESC}[4G2.${ESC}[8GNo,` +
      `${ESC}[12Gexit${ESC}[2G${ESC}[4G3.${ESC}[8GYes,${ESC}[13GI${ESC}[15Gtrust` +
      `${ESC}[21Gthis${ESC}[26Gfolder${ESC}[2GEnter${ESC}[10Gto${ESC}[13Gconfirm`,
  },
  {
    // Both option lines and no question and no confirmation line: a search result, a changelog,
    // release notes quoting the menu. It has the two halves that look most like a live dialog
    // and none of what makes it one.
    what: 'the option lines quoted with no question and nothing to confirm',
    broad: true,
    screen:
      `${ESC}[2GRelease${ESC}[10Gnotes:${ESC}[17Gthe${ESC}[21Gprompt${ESC}[28Gnow` +
      `${ESC}[32Greads${ESC}[2G${ESC}[4G1.${ESC}[8GYes,${ESC}[13GI${ESC}[15Gtrust` +
      `${ESC}[21Gthis${ESC}[26Gfolder${ESC}[2G${ESC}[4G2.${ESC}[8GNo,${ESC}[12Gexit`,
  },
]

/** Records what was written, in order. Nothing here interprets it. */
class FakePty implements TrustDialogPty {
  output: string
  readonly writes: string[] = []
  constructor(output: string) {
    this.output = output
  }
  write(data: string): void {
    this.writes.push(data)
  }
}

/** No sleeping in the offline suite: the settle gaps are real but nothing here needs them. */
const FAST = { settleMs: 0, now: () => 1_700_000_000_000 }

test('the dialog is detected only once the escapes are stripped', () => {
  assert.doesNotMatch(DIALOG, /trust this folder/, 'not contiguous in the raw buffer')
  assert.equal(folderTrustDialogVisible(DIALOG), true)
  assert.equal(answerableFolderTrustDialog(TRUST_DIALOG_WITH_AFFORDANCE), true)
  assert.equal(folderTrustDialogVisible(COMPOSER), false)
  assert.equal(answerableFolderTrustDialog(COMPOSER), false)
})

test('a screen that merely mentions trusting a folder is never typed at', async () => {
  // The two readings differ exactly where it matters. The broad one is what explains a failure
  // AFTER the readiness window has expired, and over-matching there costs a wrong sentence in a
  // message. The strict one is what authorises a keystroke, and over-matching there submits a
  // turn saying `1` in a session that was working perfectly.
  for (const { what, screen, broad } of IMPOSTORS) {
    assert.equal(folderTrustDialogVisible(screen), broad, `${what}: the broad reading`)
    assert.equal(answerableFolderTrustDialog(screen), false, `${what}: is not answerable`)

    const pty = new FakePty(screen)
    const accepted = await acceptFolderTrustDialog(pty, '/Users/x/repo', FAST)
    assert.equal(accepted, undefined, `${what}: nothing may be accepted`)
    assert.deepEqual(pty.writes, [], `${what}: and nothing may be written`)
  }
})

test('the option about to be pressed is the one that trusts, checked rather than assumed', () => {
  // The keystroke is `1`. If a future build renumbers the menu, the signature stops matching and
  // the run fails with a diagnostic -- rather than confidently pressing "No, exit".
  const swapped = DIALOG.replace('1.', '9.').replace('2.', '1.')
  assert.equal(folderTrustDialogVisible(swapped), true, 'still recognisably the dialog')
  assert.equal(answerableFolderTrustDialog(swapped), false, 'but not one we know how to answer')

  // Half a dialog is not a dialog: the accept option without the decline option is what a
  // partially drawn screen looks like, and pressing Enter into one is a guess.
  const stillDrawing = DIALOG.slice(0, DIALOG.indexOf('2.'))
  assert.equal(answerableFolderTrustDialog(stillDrawing), false)
})

test('accepting sends exactly "1" then Enter, and records both', async () => {
  const pty = new FakePty(DIALOG)
  const accepted = await acceptFolderTrustDialog(pty, '/Users/x/workspace/conclave', FAST)

  // The record, not the screen. "A prompt appeared" and "option 1 was confirmed" are
  // different claims, and only the second one clears the dialog.
  assert.deepEqual(accepted, {
    directory: '/Users/x/workspace/conclave',
    keys: ['1', '\r'],
    at: 1_700_000_000_000,
  } satisfies FolderTrustAcceptance)
  // Option 1 is "Yes, I trust this folder"; 2 is "No, exit". Sending them in the wrong order,
  // or confirming without selecting, is indistinguishable from success until the session
  // fails to start a minute later.
  assert.deepEqual(pty.writes, ['1', '\r'])
})

test('a session with no dialog is never typed into', async () => {
  const pty = new FakePty(COMPOSER)
  const accepted = await acceptFolderTrustDialog(pty, '/Users/x/workspace/conclave', FAST)

  assert.equal(accepted, undefined)
  // The hazard this guards: `1` and Enter landing in a live composer submits a turn whose
  // entire content is `1`, in a session that was working perfectly.
  assert.deepEqual(pty.writes, [], 'nothing may be written when no dialog is up')
})

test('polling a cumulative buffer accepts once, not once per poll', async () => {
  // The readiness wait polls every 100ms and the pty buffer never forgets, so the dialog text
  // is still in it long after it has been answered — and by then the composer is live.
  const pty = new FakePty(DIALOG)
  let held: FolderTrustAcceptance | undefined
  for (let i = 0; i < 5; i++) {
    const next = await acceptFolderTrustDialog(pty, '/Users/x/repo', { ...FAST, prior: held })
    if (i === 0) assert.notEqual(next, undefined, 'the first poll should answer it')
    else assert.equal(next, held, 'a later poll must return the acceptance already held')
    held = next
    pty.output += `${ESC}[2Gwelcome${ESC}[10Gback`
  }
  assert.deepEqual(pty.writes, ['1', '\r'], 'exactly one acceptance across five polls')
})

test('a boot that fails after we answered says what it sent, and still offers the by-hand remedy', () => {
  const trust: FolderTrustAcceptance = { directory: '/Users/x/repo', keys: ['1', '\r'], at: 1 }
  const msg = bootFailureMessage({ screen: DIALOG, cwd: '/Users/x/repo', alive: true, trust })

  // The remedy is NOT withheld on the grounds that the automation just failed at it. The two
  // are not the same act: a human at a terminal can answer a dialog whose shape or timing
  // defeated a driver, and a stuck run with no next step is worse than one repeating itself.
  assert.match(msg, /accept it by hand/, 'the interactive remedy still stands for a human')
  assert.match(msg, /hasTrustDialogAccepted to true in ~\/\.claude\.json/)

  // The directory in the position that says which one was ACCEPTED, not merely somewhere in
  // the message: the remedy sentence names a path too, and matching that would pass on a
  // message that never said what was answered.
  assert.match(msg, /folder-trust dialog for \/Users\/x\/repo and conclave answered it/)
  assert.match(msg, /sent 1 then Enter/, 'and exactly what it sent, since that is what failed')
  assert.match(msg, /did not take/)
  // `claude -p` returns a cheerful OK in the very directory where every interactive session is
  // stuck, because headless mode never shows the dialog. Naming it is the difference between a
  // ten-minute diagnosis and an afternoon of one (#108).
  assert.match(msg, /claude -p .* NOT a valid test/)
  assert.match(msg, /--dangerously-skip-permissions does NOT cover it/)
})

test('the pre-existing diagnostics survive, including the unanswered-dialog one', () => {
  // Answering can itself fail to run — a build where the detection never matched, a dialog
  // whose wording changed. The message that shipped before #108 is still the right one there,
  // so it is asserted rather than assumed.
  const stuck = bootFailureMessage({ screen: DIALOG, cwd: '/Users/x/repo', alive: true })
  assert.match(stuck, /waiting on its folder-trust dialog for \/Users\/x\/repo/)
  assert.match(stuck, /hasTrustDialogAccepted to true in ~\/\.claude\.json/)
  assert.match(stuck, /Conclave answers this dialog itself/, 'seeing it here is itself a fact')

  // A dialog that is up but not in a shape the signature covers. The message must say that
  // nothing was typed and that this was deliberate, or the reader concludes the acceptance is
  // broken and goes looking for a bug in it rather than teaching it the new shape.
  const unknown = bootFailureMessage({
    screen: IMPOSTORS[3]!.screen + DIALOG.slice(0, DIALOG.indexOf('2.')),
    cwd: '/Users/x/repo',
    alive: true,
  })
  assert.match(unknown, /did NOT answer it/)
  assert.match(unknown, /shape it does not recognise/)
  assert.match(unknown, /will not press a numbered option whose meaning it has not confirmed/)
  assert.match(unknown, /run `claude` in that directory once and accept/, 'the remedy still stands')

  const dead = bootFailureMessage({ screen: COMPOSER, cwd: '/Users/x/repo', alive: false })
  assert.match(dead, /exited before reporting SessionStart/)
  assert.match(dead, /conclave config check/)

  const slow = bootFailureMessage({ screen: COMPOSER, cwd: '/Users/x/repo', alive: true })
  assert.match(slow, /did not report SessionStart within the readiness window/)
  assert.match(slow, /raise readyTimeoutMs/)
})

/**
 * The setup modal that is DECLINED rather than answered (#120).
 *
 * A different failure from the trust gate, and a different remedy. This one appears MID-SESSION
 * -- observed between an implementer's first and second turn -- and it does not block the boot,
 * it silently eats every keystroke after it. The text was typed, never became a prompt, no hook
 * could fire for a turn that never started, and the run died reporting a hook failure.
 *
 * The buffer below is the real screen, captured from the failing run with the cursor-positioning
 * escapes a TUI puts between words.
 */
const AUTO_MODE_MODAL =
  '\x1b[2J\x1b[H  \x1b[4G❯ /auto-mode-setup \x1b[24G──────────────────── \x1b[52GSet up auto mode for your \x1b[78Genvironment? \n' +
  ' Claude Code reads this \x1b[26Gproject, your recent Claude \x1b[56Gsessions, and optionally your \x1b[88Gshell history \n' +
  ' How you use Claude here ◀ \x1b[30GMixed ▶ \n ❯ Also scan shell history [✔] \n Also scan your other repos [ ] \n Continue \n' +
  ' ←/→ to change usage · \x1b[26GEnter to continue · \x1b[50GEsc to cancel \n'

test('the setup modal is recognised through the escapes a real TUI emits', () => {
  assert.equal(dismissableModalVisible(AUTO_MODE_MODAL), true)
})

test('a screen that merely names the modal is not treated as one', () => {
  // A model narrating what it is doing, or this source file open in the child's editor. The
  // title alone must not authorise a keystroke, for the reason the trust signature gives.
  const narrating =
    '\x1b[2J\x1b[H ⏺ I will check whether \x1b[30G/auto-mode-setup \x1b[52Gis what blocked the send. \n' +
    ' ❯ \x1b[4Gsay something \n'
  assert.equal(dismissableModalVisible(narrating), false)
})

test('the live composer after a turn is not a modal', () => {
  const composer =
    '\x1b[2J\x1b[H ⏺ Done. \n ❯ \x1b[4G \n ⏵⏵ bypass permissions on \x1b[34G(shift+tab to cycle) \n'
  assert.equal(dismissableModalVisible(composer), false)
})

/**
 * The trust dialog AS CURRENTLY DRAWN, which is the fixture that makes the next test bite.
 *
 * Captured from a real pty on 2.1.232. The older `DIALOG` fixture above predates the
 * confirmation row, and without `Esc to cancel` on screen it cannot discriminate between a
 * modal to decline and a dialog to accept -- a title-less signature passed against it.
 */
const TRUST_DIALOG_WITH_AFFORDANCE =
  `${ESC}[2GQuick${ESC}[8Gsafety${ESC}[15Gcheck:${ESC}[22GIs${ESC}[25Gthis${ESC}[30Ga` +
  `${ESC}[32Gproject${ESC}[40Gyou${ESC}[44Gcreated${ESC}[2G` +
  `${ESC}[4G1.${ESC}[8GYes,${ESC}[12GI${ESC}[14Gtrust${ESC}[20Gthis${ESC}[25Gfolder` +
  `${ESC}[2G${ESC}[4G2.${ESC}[8GNo,${ESC}[12Gexit` +
  `${ESC}[2G${ESC}[4GEnter${ESC}[10Gto${ESC}[13Gconfirm${ESC}[22G·${ESC}[24GEsc to cancel`

test('the trust dialog is not mistaken for a modal to decline', () => {
  // The one that must NOT match, and the reason the title is required rather than the
  // affordance: the folder-trust dialog also offers "Esc to cancel", and it is the dialog this
  // adapter exists to ACCEPT (#108). Matching on the affordance alone would send Esc at it and
  // turn a working boot into a declined one.
  assert.equal(dismissableModalVisible(TRUST_DIALOG_WITH_AFFORDANCE), false)
  assert.equal(answerableFolderTrustDialog(TRUST_DIALOG_WITH_AFFORDANCE), true)
})
