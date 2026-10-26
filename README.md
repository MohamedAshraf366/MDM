# MDM
MDM - Mohamed Download Manager for Windows

<img width="930" height="494" alt="image" src="https://github.com/user-attachments/assets/dde6db8b-a93f-460c-9336-4d2326d89226" />

A fast, local-first download manager for Windows 10/11, built with Electron, React, and TypeScript.

Link: https://mdm-download-manager-mohamed-ashraf.vercel.app/

Overview
MDM is an original, local-first alternative to tools like IDM. It splits downloads across up to eight connections, resumes interrupted transfers from checkpoints, and keeps everything — downloads, queues, rules, settings, and history — in a local SQLite database. No account, no cloud sync, no telemetry.

Key Features
⚡ Fast, resilient transfers
8 segmented connections

Resume / checkpoint recovery

Retries with backoff, redirects, cookies, proxies

Speed limits

FTP support

SHA-256 / SHA-1 / MD5 checksum verification

🗂️ Queues and automation
Priority queues with concurrency limits

Pause / resume, startup recovery

Recurring schedules

Category rules, destination rules, duplicate handling

Site rules (auto / ask / ignore)

🌐 Browser integration
Chrome, Edge, and Firefox MV3 extensions

Automatic pairing over a token-protected loopback bridge

Download capture, context-menu handoff

Notifications and video-quality overlays

🎬 Media downloads
YouTube quality selection, audio-only formats

FFmpeg muxing

Unencrypted HLS VOD

Basic static DASH

⚠️ Intentionally unsupported: DRM, live streams, paywalls, and members-only content.

🖥️ Desktop experience
Light/dark themes

Tray integration, native notifications, taskbar progress

Activity logs

🔒 Privacy and security
Renderer isolation, no Node integration

Localhost-only browser bridge with bearer-token authentication

Encrypted proxy credentials and bridge token

TLS validation by default

No auto-launching of downloaded executables

Run from Source
Requirements: Windows 10/11 x64, Node.js 24+, npm 11+, Git, Git LFS

bash
git lfs install
git clone <repo>
cd idm
git lfs pull
npm install
npm run dev
Useful commands
Command	Purpose
npm run verify	Typecheck + lint + tests + production build
npm run test	Vitest suite
npm run smoke	End-to-end Electron smoke test
npm run package	Build release/MDM-Setup-2.4.exe
npm run package:portable	Build portable executable
Download
Get the latest Windows build, Chrome/Edge extension, and Firefox extension from:

👉 https://mdm-download-manager-mohamed-ashraf.vercel.app/
