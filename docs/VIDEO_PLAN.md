# Demo video plan

The video is built from footage of the real app and your voiceover (script in [VOICEOVER.md](VOICEOVER.md)). We capture the footage from the app, you record the voice, and the two are edited together and rendered.

## Rules this video must meet

| Rule (Devpost) | How |
|---|---|
| Under 3:00 | Target about 2:45 including cards (hard limit 3:00); the script is timed at 150 words a minute |
| Shows the project running | Every scene is real footage of the hosted app, recorded from Chrome as it runs: clicks, live status changes, real PayPal sandbox pages. No mock-ups |
| Public on YouTube, plays when logged out | Upload as **Public**, then open it in a private window |
| No copyrighted music or material | No music. Map tiles are OpenStreetMap (credit in the end card). PayPal sandbox pages appear because the product uses PayPal |
| English | Voice and captions in English; the Spanish note is shown as product content and subtitled |
| Judges may not run the project | The video alone has to show the full story: problem, money landing, an attack, the agent side |

Video tips from the organisers apply: open with the problem and who it's for, cut loading screens, captions help, and an AI voice is allowed (we use yours).

## Format and tools

- **Picture:** 1920×1080, 30 fps, H.264 MP4, captured at 2× pixel density and scaled down so text stays sharp.
- **Footage:** `scripts/capture.ts`, which drives your installed Google Chrome over its DevTools protocol.
  - Stills: `npx tsx scripts/capture.ts <url> <file.png> --w 1920 --h 1080 --scale 2 [--js "<clicks>"]`.
  - Motion clips: `--record <ms>` saves real frames plus their timestamps, so a clip plays back at the speed it actually happened.
- **Edit and render:** [Remotion](https://www.remotion.dev) in a separate `video/` folder (not part of the app build). It ships its own ffmpeg, so nothing else needs installing. Each scene is a React component: footage, slow zooms onto the part being talked about, a highlight box, captions.
- **Audio:** your seven voice files, normalised to −16 LUFS, light noise reduction from your `room_tone.wav`, 150 ms fades. Room tone fills the gaps. No music.
- **Captions:** burned in (large, white on a black plate, bottom left; never on yellow, which in the product means "needs approval"), plus an `.srt` file uploaded to YouTube. They are timed from the script against each voice file's length; any line that's off gets fixed by hand.
- **Look:** the product's own design system (DESIGN.md): Overpass, guide-sign green, warning yellow, black. Title and end cards use the green sign board from the app. No gradients, no stock footage, no whooshes.

## Before capturing (on the day)

1. Wake the Render instance: open the site and wait for "Live".
2. Reset the demo (Mission control → Reset demo) so Approvals, Payouts and Audit start empty.
3. **You**, in your normal browser, check that the sandbox personal account that receives household 04's payment is ready, and the sandbox buyer account for the donation. Nobody else types your PayPal passwords: you log in on those two PayPal screens (scenes 4 and 6) and the screen is captured after.
4. **Your OK is needed:** the payout scene sends a real **sandbox** batch of $680 from the hosted demo, and the agent scene creates a $5 sandbox order. Both are sandbox money only.

## Shot list

Times match the voiceover blocks. "Still" = screenshot; "Clip" = recorded motion. The base URL is `https://firstlight.onrender.com`.

| # | Time | Voice | Shots | On screen |
|---|---|---|---|---|
| 1 | 0:00–0:20 | vo_01 | **Still (cold open)** the Chitré recipient's PayPal sandbox activity: $120 arriving with the fixed Spanish note (captured after you log in; crop out the email and login chrome). **Clip** Payouts items flipping to SUCCESS. **Still** `/` zoomed on the map | Opens on one woman's account and the note, subtitled. Then the 7 rows flipping. Title card (2 s): "Firstlight / Earthquake relief cash in minutes, no application needed / AI agent + PayPal Payouts". Lower third: "Nepal 2015: emergency cash took 2+ months (UNICEF)" |
| 2 | 0:20–0:44 | vo_02 | **Clip** `/?pace=slow` after reset, clicking **Run assessment**: the board lights stage by stage. **Still** the event card ("EMSC agrees"). **Still** the decision panel's exception items (Macaracas, Santiago: USGS reports deaths) | Lower third: "Synthetic test household, PayPal sandbox". Contrast card (3 s): "Other tools: apply, verify, wait weeks" / "Firstlight: enrolled in August. Paid within a minute of approval. No application." Highlight the exception items |
| 3 | 0:44–1:06 | vo_03 | **Still** the rule drawer for the Chitré household | Walk only three rows: R3 (amount from the table), R12 (nobody left out), and "Message PayPal sends" with the partner and help line. Callout: "The agent's draft is never sent" |
| 4 | 1:06–1:30 | vo_04 | **Clip** Approve → **Send $680.00 in payouts** → Payouts until SUCCESS (`--record 45000`, cut to ~8 s). **Still** the "Reconciled with PayPal" line with the $1.75 fee | Highlight box on the AG Grid "PayPal transaction" column as rows flip. Two labelled clocks: "all items SUCCESS +25 s (our audit log)" / "batch completed +34 s (PayPal's record)". Lower third: "PayPal-Request-Id = hash of the firewall verdict". Then the same transaction id on Payouts and in her PayPal activity |
| 5 | 1:30–1:58 | vo_05 | **Still** the compromised agent's raw plan JSON (attacker email, rcp_99) next to the `paypal.payout.created` audit entry (what PayPal was asked to pay). **Still** `/redteam` headline. **Still** the residual table | Three beats only: the hijacked plan vs what PayPal got; big "$0.00 to anyone not owed" with a 2 s view of the hand-written owed table (the oracle); end on the red "Insider swaps a payee: Not stopped" row. Caption: "Agent scripted to obey every injection, 27 attacks" |
| 6 | 1:58–2:22 | vo_06 | **Clip (primary, capture first)** the curl commands on `/agents`: create allowance in the form, `create_donation` for $50 → `ALLOWANCE_EXCEEDED`, then $5 → approval link; or `npm run samaritan` against the hosted site. **Clip (bonus)** a real AI assistant doing the same over MCP. **Still** (after you log in) the PayPal approval page. **Still** the receipt JSON. **Clip** `check_payout_plan` returning "attacker blocked, 6 households left out, $560" | On-screen labels "Agent asks" / "Server answers". Refusal on screen for at least 2 s. Receipt fields `paypalConfirmed.source: paypal_hosted_mcp`, `approval.bySamePayPalAccount: true` |
| 7 | 2:22–2:44 | vo_07 | **Still** `/audit` "Verify chain → Chain intact". **Still** `/payouts` "all four recorded batches match PayPal". Cards after that | End slate: "$680, 7 households, under a minute" and "27 attacks, $0 to anyone not owed, 1 we don't stop". "For cash programmes at Red Cross societies and NGOs". "The model proposes; the code disposes". "Built with PayPal, AG Grid, Render, APIMatic Context Plugin, Postman". firstlight.onrender.com, github.com/OR-6/firstlight, "PayPal sandbox: no real money moves", "Map data © OpenStreetMap contributors" |

Clicks used in the captures (passed with `--js`):

```text
Run assessment:   [...document.querySelectorAll('button')].find(b => /Run (a new )?assessment/.test(b.textContent))?.click()
Open household 04: [...document.querySelectorAll('[role=row],button')].find(e => e.textContent.includes('rcp_04'))?.click()
Compromised agent: [...document.querySelectorAll('button')].find(b => /Compromised agent/.test(b.getAttribute('aria-label') ?? ''))?.click()
Run all attacks:   [...document.querySelectorAll('button')].find(b => /Run all 27 attacks/.test(b.textContent))?.click()
Verify chain:      [...document.querySelectorAll('button')].find(b => /Verify chain/.test(b.textContent))?.click()
```

The approve form needs a name and a reason typed in, so that clip sets the field values first, then clicks Approve. It's scripted on the day against the live page.

## Edit, step by step

1. Capture the two PayPal stills first (recipient account, buyer approval), since they need your log-in and are the biggest risk on the day. Then capture every other still and clip into `video/public/` and check each one by eye. Retake anything with a loading state or a cold-start delay.
2. Scaffold Remotion in `video/` with one composition, `Firstlight`, at 1920×1080, 30 fps. Each scene is a `<Sequence>` whose length is its voice file's length plus a 0.3 s breath.
3. Build the scenes: stills with slow, eased zooms (no more than 1.15×, `Easing.bezier(0.4, 0, 0.2, 1)`), clips played from their timestamps, a highlight box and callout per scene, 8-frame cuts between scenes (no wipes or spins).
4. Lay in the voice files, mix as above, and build captions from the script timed to each file.
5. Render a draft MP4. Watch it fully once at normal speed, then check:
   - text readable at 720p
   - no frame shows a loading spinner, "Offline" or a cold start
   - every number on screen matches the voice
   - length under 3:00
6. Send you the draft. After your notes, render the final MP4 plus the `.srt`.

## What you send

- `vo_01.wav` … `vo_07.wav` and `room_tone.wav`.
- Your OK for the $680 sandbox payout and the $5 sandbox donation on the day of capture.
- Be at the keyboard for the two PayPal log-ins (recipient account, buyer account).
- For scene 6, an AI assistant with Firstlight added as an MCP server (you approve the $5 order on PayPal).

## Upload

- **Title:** "Firstlight: earthquake relief cash in minutes, no application needed (PayPal AI Hackathon)".
- **Description:** the elevator pitch, the live demo and repo links, and "Built on PayPal (Payouts, Orders v2, Webhooks) with an AI agent. PayPal sandbox; no real money moves."
- **Settings:** visibility Public. Upload the `.srt` as English captions. Custom thumbnail: the end card.
- **Last checks:** open the link logged out and in a private window. Then paste the link in the README (Video line), SUBMISSION.md §7 and the Devpost form.
