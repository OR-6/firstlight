# Voiceover script

About 385 words, so roughly 2:35 at a calm pace (150 words a minute). The edit is built around this script, so read it as written. A word swap here and there is fine. Each block is one file.

## How to record

- **Where:** a small, soft room (a wardrobe full of clothes is ideal). No fan, no fridge hum. Phone in flight mode.
- **Mic:** any USB mic, or your phone's voice memo app held about 20 cm from your mouth, slightly off to the side so your breath doesn't hit it.
- **Files:** one file per block, named `vo_01.wav` … `vo_07.wav` (m4a or mp3 is fine too). Leave about one second of silence before and after each take.
- **Retakes:** if you stumble, pause, then read the whole sentence again. The best take gets picked in the edit, so don't stop the recording.
- **Delivery:**
  - Talk to one person, not an audience.
  - Slightly slower than feels natural.
  - Smile on the first and last block.
  - Numbers: say "six hundred and eighty dollars", "twenty-seven".
- **Room tone:** record 5 seconds of silence in the same room as `room_tone.wav`. It's used to smooth the cuts.

## vo_01: Opening (0:00–0:12, about 30 words)

This is household 04 in Chitré, Panama. In August a local aid partner enrolled them: their home, their language, and that someone there has limited mobility. Then, on the ninth of October, a magnitude seven point seven earthquake hit.

## vo_02: Confirmed, assessed (0:12–0:35, about 60 words)

They don't have to apply for anything. Firstlight sees two seismic agencies, USGS and EMSC, agree on the quake. A Claude agent reads their reports and drafts who should get what: seven enrolled households, a tier by distance from the epicentre, and one tier up for household 04. Everyone it plans for is someone the aid partner already knows.

## vo_03: The firewall (0:35–1:00, about 65 words)

But the agent never touches the money. Its output has no field for an amount or a payee. A deterministic firewall recomputes every amount, checks the household was enrolled before the quake, checks that nobody eligible was left out, and shows its working. Even the message is fixed: household 04 gets a note in Spanish that the agent can't change, so a hijacked agent can't phish anyone.

## vo_04: Approve and pay (1:00–1:30, about 60 words)

Six hundred and eighty dollars is over the limit that can go out without review, so a person approves it. One click, and PayPal Payouts sends the batch. About thirty seconds later every payment has landed. Here it is in a sandbox account, with the note in Spanish. Every step is written to a hash-chained audit log anyone can verify.

## vo_05: Attack it (1:30–2:00, about 70 words)

Now we attack it. We replace the agent with one that obeys every injected instruction: pay a stranger, invent a recipient, raise every tier. Zero dollars reach anyone not owed, across twenty-seven attacks. We also show what a hijacked agent can still try, like paying people less, which goes to a person. And the one thing Firstlight doesn't stop: an insider changing a payee's address. We say so, on the page.

## vo_06: Other agents give (2:00–2:22, about 55 words)

Other AI agents can fund the pool too, but only within an allowance a person set: who the agent is, how much, until when. The agent donates over MCP, a person approves the payment on PayPal, and the agent checks its receipt against the audit log itself. Real permission from a real person, enforced by the server.

## vo_07: Close (2:22–2:35, about 25 words)

Firstlight. Earthquake relief cash in minutes, no application needed. The model proposes; the code disposes. Built with Claude and PayPal, and live in the sandbox today.
