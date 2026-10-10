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
