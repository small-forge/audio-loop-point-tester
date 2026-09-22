# Audio Loop Point Tester RC2 checklist

## Production analytics configuration

Create `.env.production` from `.env.production.example` and set:

```text
VITE_UMAMI_WEBSITE_ID=<production Umami website id>
VITE_PRODUCTION_DOMAIN=<production hostname only, e.g. example.com>
```

The production hostname is used both by Umami `data-domains` and the app-side custom-event guard. Do not include a protocol or path.

## Install / build

```bash
npm install
npm run build
```

A successful build must create `dist/index.html` and one or more files under `dist/assets/`.
Keep the generated `package-lock.json` with the release source after the first successful install.

## Production preview

```bash
npm run preview -- --host 127.0.0.1
```

The preview host must not send production analytics because it does not match `VITE_PRODUCTION_DOMAIN`.

## Release smoke test

1. First load shows the file picker/drop zone and the "Files stay in your browser. No upload. No login." notice.
2. Drop a valid WAV; waveform appears and duration/current time are shown.
3. Drag loop start and end handles; values preview during drag and commit on release.
4. Play; confirm repeated playback inside the enabled loop.
5. Use Start/End ±0.01 and ±0.10 controls; values and playback follow the committed range.
6. Pause and resume.
7. Disable Loop, then enable it again; Start/End remain unchanged.
8. Select a different MP3; old playback/waveform/loop state is replaced.
9. Try an unsupported or damaged file; an error is shown and a subsequent valid WAV/MP3 recovers normally.
10. Resize the page and confirm waveform handles/cursor remain aligned.
11. On the production domain, verify Umami receives automatic pageviews and only these custom event names: `audio_loaded`, `loop_created`, `loop_played`, `loop_adjusted`, `audio_load_error`.
12. Verify localhost/preview activity is absent from the production Umami website.

## External gates

- [ ] `.env.production` contains the production Umami website ID and hostname
- [ ] `npm install` succeeds and creates `package-lock.json`
- [ ] `npm run build` succeeds
- [ ] production `dist/` runs via `npm run preview`
- [ ] native Google Chrome smoke test passes
- [ ] native Microsoft Edge smoke test passes
- [ ] speaker/headphone listening confirms no unacceptable click/gap at loop repeat and loop-point changes
- [ ] Umami Cloud receives automatic production pageviews
- [ ] Umami Cloud receives the five approved custom events with only approved properties
- [ ] localhost/preview traffic does not appear in production analytics

## Cloudflare Pages deployment

- Production branch: `main`
- Build command: `npm run build`
- Output directory: `dist`
- Node: `22.16.0` via `.node-version`
- Build-time variables:
  - `VITE_UMAMI_WEBSITE_ID=<Umami website UUID>`
  - `VITE_PRODUCTION_DOMAIN=<project>.pages.dev` (hostname only; no scheme/path)
- Keep `.env.production.example` committed. Do not commit actual `.env*` files.
- No Cloudflare Pages Functions or Cloudflare-specific runtime code is required.
