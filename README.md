# Extended follow list

A single-purpose, client-side tool that builds a *follows-of-follows* ("extended network")
list for Nostr and publishes it as one or more public NIP-51 `kind 30000` lists, so a client
that can read a people list as a feed gets a curated discovery feed without a firehose.

It was written to reproduce the "extended feed" that the Android client Wisp had (archived
Nov 2026) inside a client that only supports NIP-51 lists — in practice Amethyst, using its
**All User Follows** filter.

* No backend, no accounts, no analytics, no third-party scripts or assets: the only network
  requests are to the relays you list.
* **No private keys.** Signing goes through a NIP-07 browser signer (Alby, nos2x, …).
* Everything runs in the browser: relay queries are made by the visitor's own WebSocket
  connections, direct to the relays.

## Files

| file | purpose |
|---|---|
| `index.html` | UI, warning, FAQ |
| `sign-list.js` | all logic: fetch, count, sign, publish, audit |
| `styles.css` | styling |
| `_headers` | Cloudflare Pages security headers incl. CSP |
| `robots.txt` | allows search engines to index the page |
| `README.md` | this file |

## Run locally

```bash
python3 -m http.server 8000 --bind 127.0.0.1
# open http://localhost:8000/
```

`--bind 127.0.0.1` keeps the directory off your LAN. Serve over http rather than opening
`file://`: browsers block extension injection on file URLs, so `window.nostr` will be absent.

## Deploy (Cloudflare Pages)

There is no build step: this folder is the finished site. Pages applies `_headers`, gives you
HTTPS and a `*.pages.dev` hostname for free.

### Option A — drag and drop (no Git, no Node)

1. Open <https://dash.cloudflare.com/> → **Workers & Pages** → **Create** → **Pages** →
   **Upload assets**.
2. Name the project, for example `extended-follow-list` (it becomes
   `extended-follow-list.pages.dev`).
3. Drag **this folder** (or a zip of its contents) into the upload box. The upload must have
   `index.html` at its top level — drag the folder itself, not its parent. `README.md` is
   harmless if included.
4. Select **Deploy site**, then verify the security headers:

   ```powershell
   curl.exe -I https://extended-follow-list.pages.dev/
   ```

   You should see `content-security-policy`, `x-content-type-options`, `referrer-policy` and
   `permissions-policy`. If not, the file is not named exactly `_headers` or is not at the top
   level of the upload.
5. Optional: **Custom domains** → add your domain. If the zone is on the same account,
   Pages creates the DNS record.

Re-deploy by uploading again. Every deployment is kept and can be rolled back.

### Option B — Git integration

Push this folder to GitHub or GitLab, then Pages → **Connect to Git**. Choose **no
framework**, leave **Build command** blank, and set **Build output directory** to `/` (the
repository root, where `index.html` lives). Pushes to the production branch deploy; other
branches get preview URLs.

> The file must be named `_headers`, with no extension. `_headers.txt` is ignored and the
> security headers silently disappear. The meta CSP in `index.html` is a fallback for hosts
> that do not support headers; note that `frame-ancestors` can only be set by a header, never
> by meta.

Do not enable Cloudflare Web Analytics or inject other scripts: the CSP blocks them, and they
would contradict the "no analytics" claim.

## How it works

1. `getPublicKey()` from the browser signer — no npub typing, no mismatch.
2. Fetch your `kind 3`; the newest copy across relays is your follow set `F`.
3. Fetch your `kind 10000` mute list and exclude those pubkeys.
4. Fetch `kind 3` for everyone in `F`, in filters of 200 authors, to each relay; stop per
   relay on `EOSE` or after a timeout.
5. Count **distinct** followers per candidate. Only the newest `kind 3` per author is used,
   so a relay serving an old copy cannot count one person twice; duplicate `p` tags inside
   one event are ignored.
6. Keep candidates with `count >= threshold`, drop you / your follows / muted, sort by count,
   cap at `max members`.
7. Split into chunks of `chunk size` (default 700) and publish each as
   `d=extended`, `d=extended-2`, … — signed with the signer, one event per chunk. With
   **retire old chunks** checked (the default), list addresses left over from an earlier,
   longer run are overwritten with an empty list so clients stop reading people you dropped.
8. The **audit** box reports, per relay: the total member count across all chunks
   (`d=extended`, `d=extended-2`, …), whether a given pubkey is a member, and the newest
   copy's timestamp — plus that pubkey's mutual-follow count, profile, relay list and
   newest note.

## Two hard limits you cannot configure away

**~700 members per list.** A relay will not store an event above ~64 KB and each `p` tag is
~72 bytes. 1000 tags ≈ 72 KB and will be rejected by most relays (primal and snort accept it;
nos.lol and nostr.mom do not). Never raise `chunk size` much above 700 — the tool caps it at
800 and skips anything still over ~64 KB. Split instead.

**Follow-list coverage.** Counts are computed from the follow lists actually fetched. Fewer
relays, or relays that time out, means lower counts and fewer qualified people. This is why
the same graph can yield different lists on different days.

**Relay trust.** The page cannot verify schnorr signatures without shipping a crypto library,
so it trusts the events the relays return. A malicious relay could serve a forged follow list
and skew the result. Use relays you trust; the audit shows what each one serves.

## Using the result in Amethyst

- Read **All User Follows** — contact list ∪ all your people lists, deduplicated. That is the
  one feed. Selecting a single list shows only that chunk.
- **Force-stop the app after publishing**: lists load at startup.
- **Do not edit the lists inside the app.** Any in-app edit republishes from what the app last
  read, which can collapse a chunk back into one over-size event.
- To silence someone in the extended half, **mute** them (kind 10000) rather than editing a
  list: Amethyst hides them and the next run excludes them automatically.

## FAQ

**Relays disagree on member count / timestamp.** A publish was too large for some relays.
Republish at `chunk size` 700 and check the audit until every relay agrees.

**I shrank the list but the app still shows dropped people.** Old chunks (`extended-3`, …)
are still published. Keep **retire old chunks** checked and republish: surplus addresses are
overwritten with an empty list. Lists published under a different `d` base are a separate
family and are not touched; delete those manually. Force-stop the app afterwards.

**A person I expect is missing.** In order of likelihood: below `threshold`; cut by
`max members`; already followed (candidates exclude first-degree follows); muted; or a relay
serving an older, shorter copy. Use the audit box to separate these.

**Nothing appears in the app.** Force-stop first. Then check the publish log for `OK false`.
The list must be stored on relays your client reads your own account data from (your NIP-65
write relays), not merely on relays you happen to query here.

**Are members private?** No. Public `p` tags only. Clients offering "private members" encrypt
them into the event content; this tool does not.

**Do I need to review the candidates?** No, but blind publishing keeps predictable noise:
accounts everyone follows, bought followers, and dead keys with no profile. Cheapest filter is
a higher threshold.

## Privacy

- The list is **public and permanent-ish**. It reveals who you consider adjacent to your graph.
- Relays see the queries (and your IP), exactly as any client would.
- The hosted page sees nothing: there is no server code, no logging, no storage.
- The CSP forbids any external script, style, image or connect origin other than `wss:`.
  The only relays contacted are the ones in the **Relays** box; there is no hardcoded relay.

## Not affiliated

Unofficial tool. Not affiliated with Amethyst, Wisp, or any relay operator. Verify by reading
`sign-list.js` — it is the whole implementation.
