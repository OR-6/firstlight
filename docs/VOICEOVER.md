# Voiceover script

About 400 words, so roughly 2:42 at a calm pace (150 words a minute; with 2 s title and end cards, keep the edit under 2:55). The edit is built around this script, so read it as written. A word swap here and there is fine. Each block is one file.

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

## vo_01: Cold open and the problem (0:00–0:20, about 55 words)

That's earthquake relief landing in seven families' accounts, and none of them filled in a form. After Nepal's 2015 earthquake, emergency cash took more than two months to start arriving. Early cash works: in Bangladesh, families paid before a flood were thirty-six percent less likely to go a day without eating. It's for aid organisations that enrol families before a disaster, and it pays through PayPal.

## vo_02: One household, one quake (0:20–0:44, about 62 words)

Take this household in Chitré, Panama: a woman with limited mobility, enrolled in August. On the ninth of October a magnitude seven point seven earthquake hits. Two seismic agencies agree, and an AI agent drafts payouts for the seven households nearby, using rules the programme agreed in advance. It also flags two towns where people died, for a person to check.

## vo_03: The firewall (0:44–1:06, about 58 words)

But the agent never touches the money. Its output has no field for an amount or a payee. A deterministic firewall recomputes every amount and flags anyone eligible who was left out or paid less. Even the message is fixed: she gets a note in Spanish, naming her partner and its help line.

## vo_04: Approve and pay (1:06–1:32, about 58 words)

Anything over three hundred dollars needs review, so a person approves it. PayPal Payouts sends the batch. Within half a minute the money is in her PayPal account, and the batch is checked against PayPal's own record. In her account is a note in Spanish naming the partner who enrolled her.

## vo_05: Attack it (1:32–2:02, about 68 words)

Now we attack it. We swap the agent for one we scripted to obey every injected instruction. Across twenty-seven attacks, zero dollars reach anyone not owed. Talk it into paying less, and the shortfall goes to a person, with the firewall's own full plan one click away. One thing it doesn't stop, and we say so: an insider changing a payee's address.

## vo_06: Other agents give (2:02–2:24, about 55 words)

Other AI agents can give too. An agent can ask, but only a person can pay, and only up to the limit that person set. Ask for fifty and the server refuses. Five goes through once a person approves it on PayPal, and the receipt is confirmed by PayPal itself. Other agents can even dry-run their plans against the firewall.

## vo_07: Close (2:24–2:44, about 50 words)

Firstlight. Earthquake relief cash in minutes, no application needed. Six hundred and eighty dollars to seven households in under a minute, and twenty-seven attacks that sent nothing to anyone not owed. The model proposes; the code disposes. Built on PayPal Payouts, Orders, verified webhooks and PayPal's MCP server, hosted on Render.
