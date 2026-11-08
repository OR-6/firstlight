# Voiceover script

About 390 words, so roughly 2:36 at a calm pace (150 words a minute); with 2 s title and end cards the edit is about 2:40. These block times are the single source: VIDEO_PLAN.md and SUBMISSION.md §8 use the same ones. The edit is built around this script, so read it as written. A word swap here and there is fine. Each block is one file.

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

## vo_01: Cold open and the problem (0:00–0:18, 50 words)

That's earthquake relief landing in her PayPal account, and she never filled in a form. After Nepal's 2015 quake, emergency cash took more than two months. Firstlight is for aid groups that enrol families before a disaster, and it pays them through PayPal within minutes of the quake being confirmed.

## vo_02: One household, one quake (0:18–0:42, 61 words)

Take this household in Chitré, Panama: a woman with limited mobility, enrolled in August. On the ninth of October a magnitude seven point seven earthquake hits. Two seismic agencies agree, and an AI agent drafts payouts for the seven households nearby, using rules the programme agreed in advance. It also flags two towns where people died, for a person to check.

## vo_03: Ceilings and a floor (0:42–1:02, 60 words)

But the agent never touches the money. Its output has no field for an amount or a payee. A deterministic firewall recomputes every amount, and it catches the opposite attack too: anyone eligible left out or paid less goes to a person. Even the message is fixed: she gets a note in Spanish naming her partner and its help line.

## vo_04: Approve and pay (1:02–1:24, 43 words)

Anything over three hundred dollars needs review, so a person approves it. PayPal Payouts sends the batch. Within half a minute the money is in her PayPal account, and the same transaction id shows on our Payouts page and in her PayPal activity.

## vo_05: Attack it (1:24–1:52, 62 words)

Now we attack it. We swap the agent for one we scripted to obey every injected instruction. Across twenty-seven attacks, zero dollars reach anyone not owed. Talk it into paying less, and the shortfall goes to a person, with the firewall's own full plan one click away. One thing it doesn't stop, and we say so: an insider changing a payee's address.

## vo_06: Other agents give (1:52–2:10, 50 words)

Other AI agents can give too. An agent can ask, but only a person can pay, and only up to the limit that person set. Ask for fifty and the server refuses. Five goes through once a person approves it on PayPal, and the receipt is confirmed by PayPal itself.

## vo_07: Close (2:10–2:34, 65 words)

Every step is in an audit log anyone can verify, and every batch matches PayPal's own record. Firstlight: earthquake relief cash in minutes, no application needed. Seven households paid within half a minute of approval, and twenty-seven attacks that sent nothing to anyone not owed. The model proposes; the code disposes. Built on PayPal Payouts, Orders, verified webhooks and PayPal's MCP server, hosted on Render.
