# Site Walk — offline site survey app

Pin stops on a site plan, add photos and notes at each stop, and share a PDF report. After the first install it runs with no internet at all. Surveys save on the device and, on Cloudflare hosting with sync, follow each person's sign-in.

## 1. Host it once (you, about 10 minutes)

The app is a folder of static files. It needs to live at an **https://** address, because phones only allow offline mode on secure sites. There's no server code and no database. Survey data never leaves the phones.

**Team sign-in (Cloudflare):** to host it so only Tangram staff and approved subcontractors can open it, follow `CLOUDFLARE-SETUP.md` instead of the options below.

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
   - **Zooming in:** pinch or use **+**. Sheets loaded from a PDF stay sharp all the way to 32×: once you zoom past the stored picture, the part of the plan on screen is redrawn from the PDF (it sharpens a moment after you stop moving). Sheets from an image, or loaded before v2.2.0, zoom to 8×. To make an older PDF sheet sharp, use **Survey settings → Replace this sheet** with the same PDF; its pins stay where they are.
   - **No plan:** there's no plan window. Tap **+ New stop** (bottom of the screen) at each spot and type the location name.
2. **Take photo** / **Add from library**, then fill in the location and notes. Everything saves as you type. Each new stop starts with a blank location; locations you've already used appear as quick-pick buttons.
   After **Take photo**, the new photo opens with a name box under it. Type a name (or leave it blank) and tap **Close**. To name or rename a photo later, tap it and use the same box (for example "Rack front"). The name shows on the thumbnail and under the photo in the report.
   To point something out in a photo, open it and tap **↗ Arrow**, then drag from where the arrow should start to the thing it points at (or just tap for a quick arrow). **Undo arrow** removes the last one. Arrows show in the report; the original photo is never altered.
   **Room dimensions** (optional): Width, Depth and Ceiling height boxes sit under Location. Dimensions are in feet: type a plain number such as `24`, or feet and inches such as `24' 6"`. Filled-in dimensions show in the stop list, the report's stop summary (a Room column appears when any stop has them), the Issues list and each stop's details.
   **Pin in the wrong spot?** Open the stop and tap **Move pin** (bottom of the stop), then tap the right spot on the plan. Photos, notes and everything else stay with the stop. To move it to another sheet, switch sheets with the tabs before you tap. **Cancel moving** at the bottom of the screen leaves it where it was. A stop with no pin shows **Place on plan** instead.
3. Tick **Issue** (next to **Add from library**) on any stop that's a problem. Its pin turns red, and the report lists it under **Issues**.
   On an iPad (or any large screen) held in landscape, the plan and **+ Drop pin** sit on the left and the list of stops on the right.
4. GPS is recorded with each stop when available. This works offline too, and you can turn it off in Survey settings.
5. **Build report (PDF)** builds the report. Each stop that has photos starts on a new page. Every pinned stop includes a close-up of the plan around its pin (adjust `SNIP_FRACTION` in `app.js` to show more or less of the sheet). Then tap **Share…** to send it to Mail, Teams, Files or AirDrop. If you're offline, save it to Files and send it later.
6. Once the report is shared, delete the survey (Survey settings → Delete survey) to free up space.

## Sync and sharing (Cloudflare hosting with sync turned on)

When the app is hosted on Cloudflare with sync set up (see `CLOUDFLARE-SETUP.md`, step 7), surveys follow your sign-in:

- **Your surveys on all your devices.** Everything still saves on the device first and works with no signal. Changes upload when there's a signal: when the app opens, when you go back to the Surveys list, and a few seconds after an edit. The line under **Surveys** shows the state (**Synced 10:41 AM**, **2 changes waiting**, **Offline**). **Sync now** forces it.
- **Private by default.** Only you see your surveys.
- **Public.** In **Survey settings**, tick **Public** to share a survey with the whole team, read-only. It appears for them under **Team surveys**. They can look through it and build the report but can't change it. Untick it to make it private again.
- **Same survey changed on two devices before they synced:** nothing is lost. The first device to sync keeps the survey, and the other device's version is saved as "… (copy from this device)".
- **Deleting** a synced survey deletes it on all your devices and in your account.
- **Automatic clean-up.** A survey is deleted everywhere 30 days after its last change. In the final week the Surveys screen shows a warning with **Keep 30 more days**, and the survey shows **Deletes in N days**. Build the report or export the survey file first if you need to keep it longer.

Hosted anywhere else (GitHub Pages, Netlify), the app works on the device only, as below.

## Moving a survey to another device

1. On the device that has the survey, open it and go to **Survey settings → Export survey file**. This packs the plan sheets, stops, photos, arrows, dimensions and notes into one `.sitewalk` file.
2. Tap **Share…** and AirDrop it, save it to Files, or email it. (**Save / open** saves it without the share sheet.)
3. On the other device, open Site Walk, tap **Import** on the Surveys screen and pick the file.
   - If that survey isn't on the device yet, it's added.
   - If it is, you choose **Replace** (the file overwrites the copy on this device) or **Keep both** (the file comes in as "… (copy)").

**Many surveys at once:** on the Surveys screen, **Export all surveys** packs every survey into its own `.sitewalk` file and hands them over in batches (up to 10 surveys or about 100 MB at a time; tap **Next batch** for the rest). Save them to Files, then on the other device tap **Import** and select all the files together. Surveys already on that device are skipped.

Without sync, finish a survey on one device before carrying on with it on the other. Otherwise edits made on both sides won't merge. A `.sitewalk` file can be imported any number of times, so it also works as a backup.

## Good to know

- **Data lives only on that phone.** If the app is deleted from the Home Screen, its surveys go with it. Share the report or export the survey file before you remove the app or switch phones.
- **Use the Home Screen icon, not a Safari tab.** iPhone can clear data for websites that haven't been opened in a while, but it doesn't do that for installed Home Screen apps.
- **Report header/footer:** Set by the `BRAND` line near the top of `app.js` (name, tagline and an optional web address). Edit them there.
- **Updating the app:** Replace the files on the host, then change `VERSION` at the top of `sw.js` (for example `sitewalk-1.0.1`). From v1.7.3 on, phones check for updates whenever the app is opened or brought back to the screen with a signal, and switch to the new version on their own (after you close any stop or photo you have open). Existing surveys are kept. The version number is shown at the bottom of the Surveys screen.

## Files

| File | Purpose |
|---|---|
| `index.html` | App screens and styling |
| `app.js` | App logic, on-phone storage, PDF report builder |
| `sw.js` | Offline support (caches the app on the phone) |
| `manifest.webmanifest`, `icons/` | Home Screen name and icon |
| `_worker.js` | Sync server (runs on Cloudflare Pages; ignored by other hosts) |
| `CLOUDFLARE-SETUP.md` | Hosting on Cloudflare Pages behind team sign-in (one-time email codes) |
| `vendor/` | PDF reader (pdf.js), PDF writer (jsPDF) and PDF page extractor (pdf-lib, for sharp zoom), bundled so nothing loads from the internet |
