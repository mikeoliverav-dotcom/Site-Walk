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

1. **+ New survey** → name the site → choose **I have a plan** or **No plan**.
   - **With a plan:** **Load plan** (a PDF or an image). For a multi-page PDF, tap every sheet your walk covers, then **Add**. Then tap **+ Drop pin** (the big button at the bottom of the screen) and tap where you're standing on the plan.
   - **Several sheets:** tabs above the plan switch between sheets, and each pin goes on the sheet you're looking at. **+ Sheet** adds another sheet any time. Rename or remove sheets under Survey settings → Plan sheets. Stop numbers run continuously across all sheets, and tapping a stop in the list jumps to its sheet.
   - **No plan:** there's no plan window. Tap **+ New stop** (bottom of the screen) at each spot and type the location name.
2. **Take photo** / **Add from library**, then fill in the location and notes. Everything saves as you type. Each new stop starts with a blank location; locations you've already used appear as quick-pick buttons.
   After **Take photo**, the new photo opens with a name box under it. Type a name (or leave it blank) and tap **Close**. To name or rename a photo later, tap it and use the same box (for example "Rack front"). The name shows on the thumbnail and under the photo in the report.
   To point something out in a photo, open it and tap **↗ Arrow**, then drag from where the arrow should start to the thing it points at (or just tap for a quick arrow). **Undo arrow** removes the last one. Arrows show in the report; the original photo is never altered.
3. Tick **Issue** on any stop that's a problem. Its pin turns red, and the report lists it under **Issues**.
   On an iPad (or any large screen) held in landscape, the plan and **+ Drop pin** sit on the left and the list of stops on the right.
4. GPS is recorded with each stop when available. This works offline too, and you can turn it off in Survey settings.
5. **Build report (PDF)** builds the report. Every pinned stop includes a close-up of the plan around its pin (adjust `SNIP_FRACTION` in `app.js` to show more or less of the sheet). Then tap **Share…** to send it to Mail, Teams, Files or AirDrop. If you're offline, save it to Files and send it later.
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
