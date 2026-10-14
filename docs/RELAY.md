# Reach your Mac from anywhere: the Sutra relay

When your phone and your Mac are on the same Wi-Fi, the phone talks to Sutra on the Mac directly. Once you leave
the house, it can't find the Mac anymore. The **relay** fixes that. It's a tiny service you run on **your own**
Cloudflare account. The Mac keeps one connection open to it, and your phone reaches the Mac through it from any
network: mobile data, a café, the office.

Setting it up takes about five minutes, and you only do it once.

## Is it private?

Yes. Sutra doesn't run the relay for you; it lives on your own Cloudflare account.

- **The relay only passes along encrypted messages.** Your phone and Mac set up their encryption keys when you
  pair them, and those keys never leave the two devices. Transcripts, audio, notes and keys never reach the relay
  in readable form. All it handles is sealed data it can't open or alter. If anything is tampered with on the way,
  the phone or Mac notices and drops the connection.
- **Only your Mac can sit behind it.** The Mac proves itself with a secret that only you know (the "host secret").
  Anyone else who finds the address can, at most, knock on the door. They can't pair without the one-time code
  shown on your Mac's screen.
- The relay never logs message contents, and it stores nothing except a counter that numbers the connections.

## What does it cost?

For one person with a phone or two, the relay normally stays inside **Cloudflare's free plan**, so it costs
nothing. It only does work while your phone is actually talking to the Mac. While nothing is happening it hibernates,
and the Mac's occasional "still there?" ping is a few hundred tiny messages a day. That's typical, not guaranteed:
Cloudflare sets the limits and can change them, so check their pricing page if you use it heavily. The free plan
never bills you: if a daily limit is ever reached, the relay simply stops answering until the next day.

## Set it up

You'll need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and a copy of this repository.

1. **Install Node.js** (version 22 or newer) from [nodejs.org](https://nodejs.org). To check, open Terminal and
   run `node --version`.
2. **Install the relay's tools.** In Terminal, from the folder you downloaded Sutra into:

   ```bash
   cd infra/sutra-relay
   npm install
   ```

3. **Sign in to Cloudflare.** This opens your browser; click **Allow**.

   ```bash
   npx wrangler login
   ```

4. **Choose a host secret.** This is the password your Mac uses with the relay. Generate a strong one and copy it
   somewhere safe, such as your password manager:

   ```bash
   openssl rand -base64 32
   ```

   Then store it in Cloudflare. Paste the secret when asked (nothing shows on screen as you paste, which is normal):

   ```bash
   npx wrangler secret put HOST_SECRET
   ```

   If wrangler says the Worker doesn't exist yet and offers to create it, answer **yes**.

5. **Deploy the relay:**

   ```bash
   npx wrangler deploy
   ```

   At the end it prints an address like `https://sutra-relay.<your-account>.workers.dev`. Copy it.

   The first time, Cloudflare may ask you to pick a `workers.dev` subdomain. Follow the link it shows, pick a name,
   then run `npx wrangler deploy` again.

6. **Tell Sutra on your Mac.** Open **Settings → Phones → Reach from anywhere**. Paste the address from step 5 and
   the same host secret from step 4, then save. Within a few seconds Sutra shows that it's connected.

7. **Pair your phone** (or pair it again if it was paired before the relay existed). The pairing code now includes
   the relay, so the phone can use it whenever the Mac isn't on the same Wi-Fi.

To check the relay is up, open its address in a browser. You should see
`{"ok":true,"service":"sutra-relay",...}`.

### Updating or removing it

- **Update:** after you pull a newer Sutra, run `npx wrangler deploy` again in `infra/sutra-relay`. Your secret is
  kept.
- **New secret:** run `npx wrangler secret put HOST_SECRET` again, then enter the new secret on the Mac.
- **Remove:** run `npx wrangler delete`, then turn off **Reach from anywhere** on the Mac.

## Troubleshooting

**The Mac says the secret was rejected (401).** The secret on the Mac doesn't match the one stored in Cloudflare.
It may have been copied with a missing character or an extra space, or `wrangler secret put` was skipped. Run
`npx wrangler secret put HOST_SECRET` again and paste the same value into Sutra. You can test it from Terminal
(replace both parts):

```bash
curl -i -H "Authorization: Bearer YOUR_SECRET" https://sutra-relay.YOUR-ACCOUNT.workers.dev/host/test
```

`426 Upgrade Required` means the secret is right, and `401 Unauthorized` means it isn't.

**The phone says "Mac offline".** The phone reached the relay, but your Mac isn't connected to it right now. Usually
the Mac is asleep, Sutra is closed, or the Mac has no internet. Open Sutra on the Mac, and keep it awake while you're
away if you want to use it from your phone. In the relay's own terms, the phone is let in and immediately closed
with code **4004** "mac offline".

**It works at home but not at work or school.** Some corporate or school networks block or inspect WebSocket
connections, or don't allow brand-new web addresses. A freshly deployed `workers.dev` address can be blocked for the
first hour or so while filters classify it. Try mobile data on the phone. If the *Mac* is the one on a locked-down
network, ask IT whether `*.workers.dev` is allowed, or set up a custom domain for the Worker in Cloudflare.

**"Too many" (4029).** One Mac accepts up to 32 phone connections through the relay at once. Real use comes nowhere
near that, so this usually means an app stuck reconnecting. Force-quit Sutra on the phone and open it again.

**Still stuck?** Run `npx wrangler tail` in `infra/sutra-relay` to watch the relay's activity live while you try to
connect. It shows connections and errors, never message contents.

## How it works (for developers)

Code is in `infra/sutra-relay/`. The wire format is `frontend/src/shared/pairing/relayFrames.ts`, which the relay
imports directly, so there is a single definition shared with the Mac.

- **Routes** (`src/routing.ts`, `src/worker.ts`):
  - `GET /` returns health JSON `{ ok, service, version }`.
  - `GET /host/<hostId>` is the Mac's single WebSocket. It needs `Authorization: Bearer <HOST_SECRET>`, which is
    checked by comparing SHA-256 digests in constant time (`src/auth.ts`). A wrong or missing secret gets 401 and a
    non-upgrade request gets 426, in that order.
  - `GET /phone/<hostId>` is a phone's WebSocket, with no authentication at the relay.
  - A `hostId` is 1–64 characters of `[A-Za-z0-9_-]`; anything else gets 400. Unknown paths get 404.
- **One Durable Object per Mac** (`idFromName(hostId)`, `src/relay.ts`) uses the WebSocket Hibernation API.
  Sockets are tagged `host`, or `phone` plus `phone:<stream>`. The only state kept in memory is the next stream id,
  which is also persisted in storage, so ids are never reused after hibernation or eviction. Everything else lives
  in socket attachments. The logic is in `src/hub.ts`, written against a small interface so tests run in plain Node.
- **Framing:** every phone becomes a numbered stream (u32, never 0) on the Mac's socket. A frame is
  `op (u8) ‖ stream (u32 BE) ‖ payload`.

  | Event | What the relay does |
  |---|---|
  | Phone connects | Sends `OPEN(stream)` to the Mac. |
  | Phone text / binary | Forwards it as `TEXT(stream, utf8)` / `BIN(stream, bytes)`. |
  | Mac sends `TEXT` / `BIN(stream)` | Delivers it to that phone as a text / binary message. |
  | Mac sends `CLOSE(stream, code, reason)` | Closes that phone with that code. |
  | Phone closes | Sends `CLOSE(stream, code, reason)` to the Mac. |
  | Mac sends `PING(0)` | Answers `PONG(0)` with the same payload. |
  | Malformed host frame | Drops it: short frames, unknown ops, text messages, invalid UTF-8 in `TEXT`, unknown streams. |

- **Close codes** the relay uses:
  - **4004** "mac offline": no Mac is connected, or it disconnected. The phone is accepted and closed rather than
    refused with an HTTP error, so a browser WebSocket sees the code instead of an anonymous 1006.
  - **4009** "replaced": a newer Mac connection took over. The old connection's phones are closed with 4004.
  - **4029** "too many": the Mac already has `RELAY_MAX_STREAMS` (32) phones.
  - **1009** "too big": a message was larger than `RELAY_MAX_PAYLOAD` (900 KiB). The relay closes the stream and
    tells the Mac.
- **Tests:** `npm test` runs unit tests against fakes of the Durable Object APIs. `npm run e2e` starts
  `wrangler dev` and drives the full flow over real WebSockets with Node's built-in WebSocket. Under `wrangler dev`,
  a close that the relay starts reaches a Node client only after about 10 s, because Node waits for a TCP shutdown
  that the local proxy delays. A close started by the client arrives immediately.
- **Typecheck:** `npm run typecheck`.

The design follows ViewCode's Quick connect relay (`infra/viewcode-relay`, MIT; see `THIRD_PARTY_NOTICES.md`). It is
simpler because Sutra only needs WebSockets, with no HTTP multiplexing.
