# Resuming BillNest Work on Your Personal Laptop

This zip contains the full BillNest project **minus** things that are huge and
regenerate automatically (`node_modules`, build output, the old installer).
Follow these steps in order.

## 1. Prerequisites to install on the personal laptop

- **Node.js 20 LTS** (or newer) — https://nodejs.org
- **Git** (optional, only if you want version control) — https://git-scm.com
- **Android Studio** (latest) — https://developer.android.com/studio
  - This is the key difference vs the office laptop: Android Studio bundles
    its own JDK + Android SDK + Gradle, and a personal laptop normally has
    **no corporate EDR/antivirus blocking Java agents**, which is exactly
    what stopped us on the office machine. Just installing Android Studio
    and opening the `android` folder should let Gradle run normally.

## 2. Unzip and install dependencies

```powershell
# unzip BillNest-transfer.zip somewhere, e.g. C:\Dev\hotel-billing-software
cd C:\Dev\hotel-billing-software
npm install
```

## 3. Re-apply the installer EPERM patch (desktop app only)

This is only needed if you later run `npm run dist` / `npm run build:win` to
build the Windows installer `.exe`. `npm install` wipes it, so it must be
manually re-applied every time you install fresh:

- File: `node_modules\app-builder-lib\out\util\electronGet.js`
- Find the function `extractArchive()` — it ends with a bare
  `await fs.rename(tmpDir, dir)` (or similar).
- Wrap it in a retry loop (8 attempts, 500ms * attempt backoff, only retrying
  on `EPERM`/`EBUSY`). Full details + exact original bug are documented in
  `TROUBLESHOOTING.md` → **Issue #11**.
- (Optional but recommended long-term: install `patch-package` so this
  survives `npm install` automatically. Not set up yet.)

This step is **not required** for the Android APK path — only for building
the Windows desktop installer.

## 4. Run/verify the desktop app still works

```powershell
npm run electron:dev
```

Should launch the Electron app. Run the test suites too:

```powershell
npm run test:all   # runs both the desktop logic tests and the 35 mobile webApi tests
```

## 5. Resume the Android APK build

The `android/` folder is already a fully scaffolded Capacitor project
(`capacitor.config.json` + `android/`). What's left:

```powershell
npm run build          # builds the web assets into dist/
npx cap sync android   # copies dist/ + webApi.js into the android project
```

Then **open the `android` folder directly in Android Studio** (File → Open),
let it finish indexing/Gradle sync (first time takes a while — downloads
Gradle + SDK automatically), then:

- Build → Build Bundle(s)/APK(s) → Build APK(s)
- Or from a terminal inside Android Studio's "Terminal" tab:
  ```
  gradlew.bat assembleDebug
  ```
- The debug APK will land at `android\app\build\outputs\apk\debug\app-debug.apk`

If Gradle asks to download a specific Gradle version, let it — a personal
laptop has no cert/proxy interception issues either, so this should be much
simpler than the office-laptop path.

## 6. Sideload the APK onto your phone

- Copy `app-debug.apk` to the phone (USB, email to yourself, cloud drive).
- On the phone: Settings → allow "Install unknown apps" for the app you use
  to open the file (Files app / Chrome / etc.).
- Tap the APK to install.
- This build is fully self-contained (webview + `webApi.js` + localStorage) —
  no server or Wi-Fi connection to the office laptop needed. It is a
  standalone demo copy, not synced with the desktop app's data.

## 7. What's already done (don't redo)

- `src/mobile/webApi.js` — fully bug-fixed and tested (35/35 passing via
  `npm run test:webapi`). Do not need to touch this unless adding features.
- `capacitor.config.json` + `android/` — already scaffolded, don't re-run
  `npx cap add android` (it would ask to overwrite).
- `.github/workflows/build-apk.yml` — a ready-made GitHub Actions workflow
  that builds the APK on a hosted Ubuntu runner with no EDR issues at all,
  **if** you ever get this project onto a GitHub repo that allows repo
  creation (the office GitHub account is an Enterprise-Managed account that
  blocks it — a personal, non-EMU GitHub account would work fine). This is
  the easiest long-term path if you have/create one.
- **Zomato/Swiggy/MMT online-ordering integration (desktop only, polling
  model)** — Settings → "Online Ordering & Channel Integrations" lets you
  enable each platform + save Partner ID/API Key (off by default, does
  nothing until you enable + configure it). Once enabled, the app polls
  every ~8s for new orders/bookings and shows them via a bell icon in the
  topbar with Accept/Reject buttons — accepting creates a real bill (food)
  or room booking (MMT) tagged with the platform name. **The adapters in
  `electron/integrations/adapters/*.cjs` are placeholders** (clearly marked
  "REPLACE ME") — once you get real Zomato/Swiggy/MMT partner API docs,
  only those 3 files need updating (base URLs, auth headers, field names);
  the polling engine, UI, and bill/booking creation logic don't need to
  change. **See `INTEGRATIONS-API-SETUP.md` for the exact step-by-step guide
  on plugging in real Zomato/Swiggy/MMT API credentials/endpoints once you
  get partner approval** — it's written specifically for that future moment.
  Use the "🧪 Simulate Test Order" button next to each enabled
  platform to test the whole flow (bell → dropdown → accept → bill) without
  needing real API access yet. Mobile app doesn't have this feature (desktop
  only) — the bell/settings UI self-hides gracefully there.

## 8. Getting future updates from the office PC (git patch method)

The office network blocks GitHub for personal/non-corporate accounts (only
its own Enterprise-Managed GitHub org is allowed), so pushing to a personal
GitHub repo from there isn't possible. Instead, use this git-patch method —
it only needs a small plain-text file, no large zip transfer required:

**On the office PC (done for you already once, repeat for future changes):**
```powershell
cd hotel-billing-software
git add -A
git commit -m "describe the change"
git format-patch -1 HEAD --stdout > billnest-changes.patch
```
This produces a small `.patch` text file (tens of KB, not MB) containing
only what changed — easy to email/OneDrive/chat to yourself.

**On this personal laptop, to apply it:**
```powershell
cd C:\path\to\hotel-billing-software     # wherever you extracted the project
git apply billnest-changes.patch
```
- Requires Git for Windows installed here (https://git-scm.com/download/win).
- `git apply` does **not** require this folder to already be a git repo —
  it just needs the files to match the same starting point the patch was
  made from (true here since both copies came from the same source).
- After applying, run `npm run dev` (or rebuild the APK) to pick up the
  changes, same as usual.
- If you want proper version history going forward, you can instead run
  `git init` once here, commit the current state, then use `git am
  billnest-changes.patch` for future patches (creates a real commit instead
  of just modifying files).

## 9. Reference docs already in this zip

- `TROUBLESHOOTING.md` — all 12 issues hit so far and their fixes/causes.
- `INSTALL-GUIDE.md` — end-user setup guide for the Windows installer.
- `TEST-PLAN.md` — manual test plan for the desktop app.
- `README.md` — project overview.
