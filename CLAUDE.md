# Working in this repo

Read `README.md` first — it documents behaviour and, more importantly, *why*
each behaviour was chosen. This file is the short version plus the things that
are easy to get wrong.

## What this is

A browser viewer for `susan_summary` v5 JSON snapshots of a disguise d3
showfile. Three tabs: a semantic diff of two captures, a media inventory of one,
and a per-transport view of one.

No build step, no dependencies, no server. `index.html` opened from disk works
identically to the hosted copy. That constraint is load-bearing — do not
introduce a bundler, a framework, or an npm dependency.

## Layout

```
index.html        UI, all three tabs, rendering and file loading. All the CSS.
diff.js           The engine. No DOM access — usable from node.
tools/selftest.js Regression checks against real captures.
tools/deploy.sh   Version bump, commit, push, wait for Pages.
```

`diff.js` exports four entry points under CommonJS and as page globals:
`diffSnapshots(a, b)`, `summarize(result)`, `mediaReport(snap)`,
`transportReport(snap)`.

## House style, which is not negotiable

- **ES5 only.** `var`, `function`, no arrows, no `const`/`let`, no template
  literals, no `Array.prototype.flat`. It runs from `file://` with no transpiler.
- **Comments explain why, never what.** The existing ones name the bug being
  avoided or the alternative that was rejected. `// loop over tracks` is noise;
  `// tStart is null on a layer the director could not place, so sorting it as 0
  would claim a position the capture does not have` is the standard.
- **`diff.js` never touches the DOM.** The self-test requires it.
- Everything from a snapshot goes through `esc()` before it lands in an HTML
  string. Track names and media paths come from a showfile and are not trusted.
- Do not hand-edit the `#ver` span in the footer. `tools/deploy.sh` rewrites it.

## The distinctions that took a day to get right

Reversing any of these will look like a simplification and will be a regression.

1. **A setlist edit is not a track deletion.** The top-level `tracks` array is
   only the union of what the loaded setlists reference. Dropping songs from a
   setlist removes them from the capture; reading that as deletion produced 68
   phantom removals from a pair of captures three minutes apart. Track add and
   remove mean the *showfile*, answered against `showfile.trackIds`.
2. **`trackIds: null` is not `[]`.** Null means the plugin could not read the
   census; empty means the show has no tracks. Conflating them reports every
   track as deleted.
3. **The media report is flat; transport info is grouped.** A track on three
   setlists is listed once in the inventory (what is programmed does not depend
   on who plays it) and three times in transport info (what a transport plays is
   the question). Grouping the inventory by transport made its media total
   2,931 for a show holding 1,734.
4. **Ids come from the resource path.** Before v5 they were display names
   disambiguated in capture order, so the same show could hand out different ids
   on two runs. Never reintroduce order-dependent identity.
5. **Running order is a list, not a string.** `node.order` carries one entry per
   track from an LCS pass; a reshuffle reads as moves, not as N removals paired
   with N additions.

## Tests

```
node tools/selftest.js /path/to/captures
```

Cases run against **real captures, not fixtures** — the fields that break are
the ones nobody thinks to fake. Fixtures appear only where the corpus cannot
express the state (a census that failed, a dangling trackRef, a trashed track).

**Point `LOGS` at real v5 captures when deploying.** Two tests silently stopped
testing anything when the census field landed, and only failed once the suite
ran against real v5 files. `deploy.sh` warns and deploys anyway when it finds no
logs, so an empty `LOGS` folder means the gate is not a gate.

## Deploying

```
tools/deploy.sh minor "commit message"
LOGS=/path/to/captures tools/deploy.sh "…"     # gate on the selftest
```

Pushing IS the deploy — Pages serves `main` at the root. The script polls the
live page until it serves the new version, because the build API lags the CDN.

## The other half

The plugin that writes these captures is a separate repo,
`d3plg_susan_summary`. **The two ship together.** This viewer reads v5 only and
refuses anything else, so a schema change means releasing both. See that repo's
`CLAUDE.md` for the capture side.
