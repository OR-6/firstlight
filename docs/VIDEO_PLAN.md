# Demo video plan

The video is built from footage of the real app and your voiceover (script in [VOICEOVER.md](VOICEOVER.md)). We capture the footage from the app, you record the voice, and the two are edited together and rendered.

## Rules this video must meet

| Rule (Devpost) | How |
|---|---|
| Under 3:00 | Target about 2:38; the script is timed at 150 words a minute |
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
| 1 | 0:00–0:16 | vo_01 | **Still** `/` zoomed on the map (epicentre, rings, households). **Still** the Chitré household card on a phone-width capture showing "mobility impaired" | Title card (2 s): "Firstlight / Earthquake relief cash in minutes, no application needed / AI agent + PayPal Payouts". Slow push-in on the map. Lower third: "Early cash: 36% less likely to go a day without eating (WFP, Bangladesh 2020)" |
| 2 | 0:16–0:38 | vo_02 | **Clip** `/` after reset, clicking **Run assessment** (`--record 12000`). **Still** the event card ("EMSC agrees"). **Still** the How it works rules sentence (pre-agreed trigger and payment rules) | Lower third: "Synthetic test household, PayPal sandbox". The board lights stage by stage (real recording). Zoom onto "USGS and EMSC agree", then the agent summary line "7 of 8 households in the plan" |
| 3 | 0:38–1:00 | vo_03 | **Still** the rule drawer for the Chitré household. **Still** the "Message PayPal sends" box. **Still** from a residual run: an R12 warning naming a left-out household and its dollar shortfall | Highlight box walks the checks: enrolled before the quake, tier by distance +1 uplift, amount from the table, nobody left out. 2 s cut to the R12 warning "would get $X less". Then the fixed Spanish note, subtitled. Callout: "The agent's draft is never sent" |
| 4 | 1:00–1:28 | vo_04 | **Clip** Approve form → **Send $680.00 in payouts** → Payouts until items show SUCCESS (`--record 45000`, cut to ~8 s with a "+25 s" timer chip). **Still** Audit showing the `paypal.webhook` entries. **Still** (taken after you log in) the sandbox personal account's activity with the payment and the Spanish note | Split screen: Payouts on the left, the recipient's PayPal account on the right, the **same PayPal batch or transaction id highlighted on both**. Timer counts 0 → ~25 s |
| 5 | 1:28–1:58 | vo_05 | **Still** the compromised agent's raw plan JSON (attacker email, rcp_99, every tier A) next to its verdict. **Clip** `/redteam` → Compromised agent (`--record 6000`). **Still** the residual table | Big number: "$0.00 reached anyone not entitled to it". Then the residual table: highlight "Pay everyone the minimum: needs a person, $400 shortfall" and the red "Insider swaps a payee address: Not stopped" row |
| 6 | 1:58–2:16 | vo_06 | **Clip** `/agents`: create an allowance ("Assistant", $5, 24 h). **Clip** a real AI assistant (any MCP client) with Firstlight added at `/mcp`: asked to give $50, it gets `ALLOWANCE_EXCEEDED`; then $5 goes through. **Still** (after you log in) the PayPal sandbox approval page. **Still** the receipt "Verified", with its capture id next to the same id in the buyer's PayPal activity | Four quick beats: allowance, refusal over the cap, PayPal approval, verified receipt |
| 7 | 2:16–2:38 | vo_07 | **Still** terminal: `npm test` (all passed). Cards only after that | End slate with three big numbers: "$680, 7 households, ~25 s" and "27 attacks, $0 redirected". Then the green sign board: "The model proposes; the code disposes", firstlight.onrender.com, github.com/OR-6/firstlight, "PayPal sandbox: no real money moves", "Map data © OpenStreetMap contributors" |

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
