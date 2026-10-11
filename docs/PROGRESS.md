## Change of direction
- Supabase dropped. Storage = user's Google Drive; engine = plugin; GitHub = code + Actions release builds; BRAT installs on mobile.

## Step A (in progress)
- Plugin `drive-vault-sync`: Google device-flow sign-in (TVs and Limited Input client, scope drive.file), folder creation, AES-GCM encrypted connection code (PBKDF2 600k).
- Open question: does drive.file let device 2 see device 1's folder? (test with a second device)
- Google app is in Testing mode: keys last 7 days. Publishing needs resolving later.
- Next: Step B (initial backup/download with collision protection).

## Step B (v0.2.0)
- Manual "Scan, review, start" backup (device -> Drive) and download (Drive -> device). Never overwrites or deletes.
- Files over 5 MB are skipped for now (resumable upload comes later). Hidden/unsafe/Google-Docs items are skipped.
- Tested against a simulated Drive only; real Drive behaviour (esp. drive.file visibility across devices) still to confirm.
- Next: Step C (automatic two-way sync, change feed, conflict copies).

## v0.2.1
- Connection code format DVS2 (integrity check separates "incomplete code" from "wrong passphrase"); old DVS1 codes still open.
- Settings read the code/passphrase fields at click time (no stale state), Show/hide passphrase, self-test when a code is created, result shown next to the buttons.
- Next: confirm second-device download scan lists the files; then Step C (automatic sync).

## v0.3.0: automatic sync (Step C)
- Background two-way sync while Obsidian is open: timer (30 s desktop / 60 s mobile), local edits (5 s debounce), app resume, back online.
- Drive change feed = cheap "anything new?" check; full comparison on change, on first run, and every 10 min as a safety net.
- Three-way comparison against the last-synced state. Drive version keeps the name in a conflict; local version is kept as "(conflict <device> <time>)". Edit beats delete. Deletes go to trash (Drive trash / Obsidian .trash).
- Everything lives inside the one Drive vault folder, mirroring the vault's folders.
- Tested against a simulated Drive with 3 devices (conflicts, deletes, folders, crash recovery, offline, hostile names, corrupted downloads). Real Drive still to be confirmed (esp. change feed with drive.file).
- Not yet: files over 5 MB (resumable upload), rename detection (a rename syncs as delete + create), E2E encryption, publishing the Google app (7-day key expiry).
