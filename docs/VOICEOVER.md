# Voiceover script

About 390 words, so roughly 2:38 at a calm pace (150 words a minute). The edit is built around this script, so read it as written. A word swap here and there is fine. Each block is one file.

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

## vo_01: The problem (0:00–0:16, about 45 words)

After an earthquake, relief cash usually takes weeks and an application form. Early cash works: families paid before a flood peak were a third less likely to go hungry. Firstlight is for aid organisations that enrol families before a disaster, so nobody has to apply after one.

## vo_02: One household, one quake (0:16–0:38, about 55 words)

Take this household in Chitré, Panama: an older woman with limited mobility, enrolled in August by a local partner. On the ninth of October a magnitude seven point seven earthquake hits. Two seismic agencies agree on it, and a Claude agent drafts payouts for the seven enrolled households nearby, using rules the programme agreed before the quake.

## vo_03: The firewall (0:38–1:00, about 60 words)

But the agent never touches the money. Its output has no field for an amount or a payee. A deterministic firewall recomputes every amount, checks each household was enrolled before the quake, and flags anyone eligible who was left out or paid less, so a person decides. Even the message is fixed: she gets a note in Spanish the agent can't change.

## vo_04: Approve and pay (1:00–1:28, about 60 words)

Six hundred and eighty dollars is over the limit that can go out without review, so a person approves it. PayPal Payouts sends the batch, and if the network drops, it's resent under the same request id, so nobody is paid twice. About twenty-five seconds later the money is in her PayPal account. Turning it into cash nearby is the field partner's job.

## vo_05: Attack it (1:28–1:58, about 65 words)

Now we attack it. We swap the agent for one we scripted to obey every injected instruction: pay a stranger, invent a recipient, raise every tier. Across twenty-seven attacks, zero dollars reach anyone not owed. And we show what it can still try. Paying everyone less goes to a person, with the shortfall in dollars. An insider changing a payee's address isn't stopped. We say so.

## vo_06: Other agents give (1:58–2:16, about 40 words)

Other AI agents can give too. A person sets an allowance: who the agent is, how much, until when. The server enforces it. The agent donates over MCP, a person approves the payment on PayPal Checkout, and the receipt checks out against the audit log.

## vo_07: Close (2:16–2:38, about 40 words)

Firstlight. Earthquake relief cash in minutes, for cash programmes that already enrol households. Six hundred and eighty dollars to seven households in twenty-five seconds, and twenty-seven attacks that moved nothing. The model proposes; the code disposes. Built with Claude and PayPal Payouts, Orders and webhooks.
