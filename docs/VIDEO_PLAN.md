# Demo video plan

The video is built from footage of the real app and your voiceover (script in [VOICEOVER.md](VOICEOVER.md)). We capture the footage from the app, you record the voice, and the two are edited together and rendered.

## Rules this video must meet

| Rule (Devpost) | How |
|---|---|
| Under 3:00 | Target about 2:50 including cards; the script is timed at 150 words a minute |
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
| 1 | 0:00–0:20 | vo_01 | **Clip (cold open)** Payouts items flipping to SUCCESS (from scene 4's capture, first 4 s). **Still** `/` zoomed on the map | Opens on the money landing with a chip "M7.7 Panama, 17:56 UTC → $680 in 7 accounts". Then the title card (2 s): "Firstlight / Earthquake relief cash in minutes, no application needed / AI agent + PayPal Payouts". Lower third: "Nepal 2015: emergency cash took 2+ months (UNICEF)" then "Early cash: 36% less likely to go a day without eating (WFP)" |
| 2 | 0:20–0:44 | vo_02 | **Clip** `/?pace=slow` after reset, clicking **Run assessment**: the board lights stage by stage. **Still** the event card ("EMSC agrees"). **Still** the agent panel's exception requests (Macaracas, Santiago: USGS reports deaths) | Lower third: "Synthetic test household, PayPal sandbox". Contrast card (2 s): "Other tools: apply, verify, wait weeks" / "Firstlight: enrolled in August, paid on 9 October". Highlight the exception request |
| 3 | 0:44–1:06 | vo_03 | **Still** the rule drawer for the Chitré household. **Still** the "Message PayPal sends" box | 8 s highlight walk down the plain-English checks. Then the fixed Spanish note with the partner name and help line, subtitled. Callout: "The agent's draft is never sent" |
| 4 | 1:06–1:32 | vo_04 | **Clip** Approve → **Send $680.00 in payouts** → Payouts until SUCCESS (`--record 45000`, cut to ~8 s). **Still** the "Reconciled with PayPal" chip. **Still** Audit `paypal.webhook` entries. **Still** (after you log in) the recipient's PayPal activity with the payment and note | Split screen: Payouts left, the recipient's PayPal account right, the **same transaction id highlighted on both**. Timer from the audit log's own timestamps (sent → all paid). Lower third: "PayPal-Request-Id = hash of the firewall verdict" |
| 5 | 1:32–2:02 | vo_05 | **Still** the compromised agent's raw plan JSON next to the `paypal.payout.created` audit entry (what PayPal was actually asked to pay). **Still** `/redteam` suite result. **Clip** the plan page "Draft the firewall's plan" after a held plan (local capture). **Still** the residual table | Caption: "Scripted agent that obeys every injection; 27 payloads, 21 distinct plan mutations; oracle: hand-written owed table". Big number "$0.00 to anyone not owed". 2 s card: "Sentinel on unseen attacks: patterns 8/30, classifier 26/30, so it's advisory". Highlight the red "Insider swaps a payee: Not stopped" row |
| 6 | 2:02–2:24 | vo_06 | **Clip** `/agents`: create an allowance ("Assistant", $5, 24 h). **Clip** a real AI assistant (any MCP client) with Firstlight at `/mcp`: asked to give $50 it gets `ALLOWANCE_EXCEEDED`, then $5 goes through. **Fallback clip** the same two calls with the curl commands on /agents, or `npm run samaritan` against the hosted site. **Still** (after you log in) the PayPal approval page. **Still** the receipt JSON | End on the receipt fields `paypalConfirmed.source: paypal_hosted_mcp`, `matchesReceipt: true`, `approval.bySamePayPalAccount: true` |
| 7 | 2:24–2:44 | vo_07 | **Still** the GitHub Actions run, all steps green (typecheck, tests, lint, red team). Cards after that | End slate: "$680, 7 households, ~25 s" and "27 attacks, $0 to anyone not owed, 1 we don't stop". Then "For cash programmes at Red Cross societies and NGOs", "The model proposes; the code disposes", firstlight.onrender.com, github.com/OR-6/firstlight, "PayPal sandbox: no real money moves", "Map data © OpenStreetMap contributors" |

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
