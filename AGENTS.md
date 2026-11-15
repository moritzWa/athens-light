# Local app delivery

Moritz gave standing approval on 2026-11-15 for routine local rebuilds,
installation, and restarts of Athens Light after requested fixes. Do not ask
for approval again on every iteration, including when the local install uses
a release-mode build. This does not authorize publishing or distributing releases.

Run the relevant tests first. Close the app gracefully so pending edits can
save, preserve open document paths, install the verified build, and reopen those
documents. Verify the running executable matches the new build. Never use a
user document as a test fixture or discard unsaved work. If saving fails or a
restart would lose work, stop and resolve that risk rather than forcing a quit.
