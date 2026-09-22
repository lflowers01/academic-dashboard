# Academic Dashboard Assignment Sync

This local Chrome extension reads dated assignments from signed-in Labflow, Macmillan Achieve, and Pearson MyLab course pages. It sends only assignment titles, deadlines, completion status and course/assignment URLs to `http://localhost:4321`. It does not read or store passwords, cookies, answers or grade values.

After setup it syncs when Chrome starts, every three hours, and when **Sync now** is clicked. If a site is signed out or Labflow is idle-locked, unlock/sign in on the course tab and click **Sync now** again. Pearson must be on its **Homework and Tests** list; the extension opens that page automatically when your Pearson session is active.

## Install and connect courses

1. Start the Academic Dashboard and let its first Brightspace refresh finish.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this `chrome-extension` folder.
3. Open a Labflow, Achieve, or Pearson course page where its assignment list is available.
4. Click the extension icon, then **Use current tab** beside that provider.
5. Choose the matching Brightspace course by name. Repeat for any other providers you use.
6. Click **Sync now**. The extension saves these mappings in Chrome and enables External assignments in the dashboard.

No Codex or Claude installation is needed. Each user configures only their own courses; the repository contains no student-specific course URLs or IDs.
