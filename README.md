# MDM
MDM - Mohamed Download Manager for Windows
<img width="930" height="494" alt="image" src="https://github.com/user-attachments/assets/dde6db8b-a93f-460c-9336-4d2326d89226" />

A fast, local-first download manager for Windows 10/11 with 8-connection segmented transfers, Chrome/Edge/Firefox capture, queues, schedules, site rules, checksums, and HLS/DASH/YouTube downloads.
Homepage: https://mdm-download-manager-mohamed-ashraf.vercel.app/
Suggested topics: download-manager electron react typescript windows hls dash yt-dlp browser-extension local-first idm-alternative
Full description:
MDM — Mohamed Download Manager is an original, local-first download manager for Windows built with Electron, React, and TypeScript. It splits downloads across up to eight connections, resumes interrupted transfers from checkpoints, and keeps all downloads, queues, rules, settings, and history in a local SQLite database — no account, cloud sync, or telemetry.

The Chrome, Edge, and Firefox extension hands downloads to the desktop app over a token-protected loopback bridge. MDM also supports FTP, unencrypted HLS VOD, basic static DASH, and YouTube/media pages through bundled yt-dlp and FFmpeg.
Features
Fast, resilient transfers — 8 segmented connections, resume/checkpoint recovery, retries with backoff, redirects, cookies, proxies, speed limits, FTP, and SHA-256/SHA-1/MD5 verification.
Queues and automation — priority queues, concurrency limits, pause/resume, startup recovery, recurring schedules, category rules, destination rules, duplicate handling, and site rules (auto / ask / ignore).
Browser integration — Chrome/Edge/Firefox MV3 extensions, automatic pairing, download capture, context-menu handoff, notifications, and video-quality overlays.
Media downloads — YouTube quality selection, audio-only formats, FFmpeg muxing, HLS VOD, and basic static DASH. DRM, live streams, paywalls, and members-only content are intentionally unsupported.
Desktop experience — light/dark themes, tray integration, native notifications, taskbar progress, and activity logs.
Privacy and security — renderer isolation, no Node integration, localhost-only browser bridge with bearer-token authentication, encrypted proxy credentials/bridge token, TLS validation by default, and no auto-launching of downloaded executables.
Run from source
Requirements: Windows 10/11 x64, Node.js 24+, npm 11+, Git, Git LFS.
git lfs install
git clone <repository-url>
cd idm
git lfs pull
npm install
npm run dev
Useful commands:
npm run verify          # typecheck + lint + tests + production build
npm run test            # Vitest suite
npm run smoke           # end-to-end Electron smoke test
npm run package         # build release/MDM-Setup-2.4.exe
npm run package:portable
Download the live version
Users can download the latest Windows build, Chrome/Edge extension, and Firefox extension from:
https://mdm-download-manager-mohamed-ashraf.vercel.app/
