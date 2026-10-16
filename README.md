# Site Walk — offline site survey app

Pin stops on a site plan, add photos and notes at each stop, and share a PDF report. After the first install it runs with no internet at all. Each person's surveys stay on their own phone.

## 1. Host it once (you, about 10 minutes)

The app is a folder of static files. It needs to live at an **https://** address, because phones only allow offline mode on secure sites. There's no server code and no database. Survey data never leaves the phones.

**Option A — Netlify (easiest)**
1. Unzip this folder.
2. Sign up for a free account at netlify.com, then open **Add new site → Deploy manually**.
3. Drag the unzipped `sitewalk-app` folder onto the page.
4. Netlify gives you an address like `https://something.netlify.app`. You can rename the site under Site settings.

**Option B — GitHub Pages**
1. Create a repository (it can be private if your GitHub plan supports private Pages), and upload the *contents* of this folder.
2. Go to Settings → Pages → Deploy from branch → `main` / root.
3. Your address is `https://<account>.github.io/<repo>/`.

**Option C — any other web host**
Any web server that serves static files over HTTPS works. Copy the folder contents to it.

## 2. Install on each phone (each person, 1 minute, needs a signal)

**iPhone:** Open the address in **Safari**, tap **Share**, then **Add to Home Screen**. Always open the app from that icon.
**Android:** Open the address in **Chrome** and tap **Install app**, or use the ⋮ menu → **Add to Home screen**.

Wait until the top-right label says **Ready offline**. From then on it works with no signal.

## 3. On site

1. **+ New survey** → name the site → **Load plan** (a PDF or an image; for a multi-sheet PDF, tap the sheet you want).
2. **+ Drop pin** → tap where you're standing on the plan.
3. **Take photo** / **Add from library**, then fill in the zone and notes. Everything saves as you type. The zone carries over to the next pin.
4. GPS is recorded with each stop when available. This works offline too, and you can turn it off in Survey settings.
5. **Build report (PDF)** → **Share…** to Mail, Teams, Files or AirDrop. If you're offline, save it to Files and send it later.
6. Once the report is shared, delete the survey (Survey settings → Delete survey) to free up space.

## Good to know

- **Data lives only on that phone.** If the app is deleted from the Home Screen, its surveys go with it. Share the report before you remove the app or switch phones.
- **Use the Home Screen icon, not a Safari tab.** iPhone can clear data for websites that haven't been opened in a while, but it doesn't do that for installed Home Screen apps.
- **Report header/footer:** Set by the `BRAND` line near the top of `app.js` (name, tagline and an optional web address). Edit them there.
- **Updating the app:** Replace the files on the host, then change `VERSION` at the top of `sw.js` (for example `sitewalk-1.0.1`). Phones pick up the update the next time they open the app with a signal, and existing surveys are kept.

## Files

| File | Purpose |
|---|---|
| `index.html` | App screens and styling |
| `app.js` | App logic, on-phone storage, PDF report builder |
| `sw.js` | Offline support (caches the app on the phone) |
| `manifest.webmanifest`, `icons/` | Home Screen name and icon |
| `vendor/` | PDF reader (pdf.js) and PDF writer (jsPDF), bundled so nothing loads from the internet |
