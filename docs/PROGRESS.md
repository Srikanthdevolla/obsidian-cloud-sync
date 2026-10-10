## Change of direction
- Supabase dropped. Storage = user's Google Drive; engine = plugin; GitHub = code + Actions release builds; BRAT installs on mobile.

## Step A (in progress)
- Plugin `drive-vault-sync`: Google device-flow sign-in (TVs and Limited Input client, scope drive.file), folder creation, AES-GCM encrypted connection code (PBKDF2 600k).
- Open question: does drive.file let device 2 see device 1's folder? (test with a second device)
- Google app is in Testing mode: keys last 7 days. Publishing needs resolving later.
- Next: Step B (initial backup/download with collision protection).
