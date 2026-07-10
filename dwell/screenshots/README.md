# Screenshots

Source captures for `make store-assets` (tools/gen-store-assets.mjs): the
sponsored line in real chat UIs. Recapture these with the DWELL extension
installed when convenient — the current three are carried over from the
pre-rebrand product (the overlay chip is brand-neutral).

The generator's `-dwell` screenshot set doesn't wait for a recapture: it
erases the old sponsor bar from these captures and composites the current
token pill (inject.css + ads.js) in its place — see DWELL_SHOTS in
tools/gen-store-assets.mjs, where the old bar's measured bbox per capture
lives. If you recapture these files, re-measure those bboxes.
