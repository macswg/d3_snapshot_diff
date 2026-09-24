# Working in this repo

Read `README.md` first — it documents behaviour and, more importantly, *why*
each behaviour was chosen. This file is the short version plus the things that
are easy to get wrong.

## What this is

A browser viewer for disguise d3 showfiles: a `.d3` project archive, or a
`susan_summary` v6 or v7 JSON snapshot. Drop one to analyze it, two to diff
them, or choose a folder of `susan_summary` exports to diff the latest pair.
Five tabs: a semantic diff of two captures, and a media inventory, a list of
cue tags and notes, a per-transport view and a system view of one. Every tab carries a header line
naming the Designer build each capture came from.

No build step, no dependencies, no server. `index.html` opened from disk works
identically to the hosted copy. That constraint is load-bearing — do not
introduce a bundler, a framework, or an npm dependency.

## Layout

```
index.html        UI, every tab, rendering and file loading. All the CSS.
diff.js           The engine. No DOM access — usable from node.
vendor/d3extract.js  .d3 reader. Verbatim copy from d3_proj_analyzer.
tools/selftest.js Regression checks against real captures.
tools/deploy.sh   Version bump, commit, push, wait for Pages.
```

`diff.js` exports its entry points under CommonJS and as page globals:
`diffSnapshots(a, b)`, `summarize(result)`, `mediaReport(snap)`, `cueReport(snap)`,
`transportReport(snap)`, `systemReport(snap)`, and
`exportDiff(result, a, b, names, generatedAt)` behind the Export JSON button.
The export's `about` list is its reading rules for a model or script; when one
of the distinctions below changes, that list changes with it.

## House style, which is not negotiable

- **ES5 only.** `var`, `function`, no arrows, no `const`/`let`, no template
  literals, no `Array.prototype.flat`. It runs from `file://` with no transpiler.
- **Comments explain why, never what.** The existing ones name the bug being
  avoided or the alternative that was rejected. `// loop over tracks` is noise;
  `// tStart is null on a layer the director could not place, so sorting it as 0
  would claim a position the capture does not have` is the standard.
- **`diff.js` never touches the DOM.** The self-test requires it.
- **`vendor/d3extract.js` is not ours.** It is a byte-for-byte copy of
  `../d3_proj_analyzer/d3extract.js`, exempt from the ES5 rule, and the
  self-test fails on drift. Change it upstream and `cp` it over. Never edit it
  here.
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
6. **`options.values: null` is not `{}`**, and this is the census mistake
   wearing a different hat. Null means the plugin could not read the option
   switches; empty means none are set. Diffing null against a real map reports
   all 125 switches as removed, so a null on either side drops the scope and
   earns a note.
7. **An option switch the file omits is at its default, not `0`.** The file
   holds only persisted switches. Filling the other ~200 in with zeros invents
   values the capture never claimed, and hides the release where a default
   changes.
8. **The build is a header line, not a section.** It qualifies everything below
   it, so it belongs on the Before/After slots where every tab can see it.
   Giving it a section would put the environment above the showfile edits, which
   is backwards — you open these captures to see what changed in the show.
9. **A cue is matched by proximity, not by a key.** Beats are float32 and a
   re-derived one drifts 0.000469 — far past `EPSILON`. Any exact key, including
   a rounded bucket, just relocates the failure to its edges: one untouched cue
   straddling 358.858/358.859 reported as an add plus a remove, and an edit to
   its note would have been thrown away with the pairing. `CUE_TOLERANCE` is
   0.005 because the corpus brackets it there — 10x the largest drift measured,
   6x below the tightest real cue spacing (0.033 beats, a frame at 30fps). The
   greedy merge in `matchCues` is only sound while that gap holds, so widening
   the tolerance is not a free knob. `t` is compared at the same tolerance; it
   is the same quantity in seconds.
10. **A label marks whitespace the browser would swallow; identity does not.**
    Layer names come from Designer and the corpus has four ending in a space or
    a newline — `999_vis` holds `[TEXT] B` and `[TEXT] B\n` as separate layers,
    which rendered raw are the same row, so removing one printed a duplicate.
    `showWhitespace()` marks only edge, doubled and non-space runs, so ordinary
    single spaces stay readable, and unlisted invisibles get their codepoint
    rather than borrowing `␣`. Trimming looks tidier and is a regression: it
    collapses two entities onto one label. Marking the *key* is the same
    regression from the other side — it would make `B` and `B\n` differ by a
    symbol instead of by one character and split every dirty name into an add
    plus a remove. Both single-snapshot reports mark too, and they catch more
    than the diff can: they describe every row, so a dirty name on a layer
    nobody edited still shows. Their track `id` stays raw — the page keys rows
    on it.
11. **A layer is keyed by its v7 `id`, but only when both captures have one.**
    Before v7 a layer had no identity of its own and the best key available was
    `groupPath` + `name`, which 881 of this show's 2031 layers share with a
    sibling -- 43%, re-measured on real v7 captures and unchanged; one track
    held three records named `[VID] 250_seek_tvision_a_alpha_ll180`,
    two equal in every field down to the media version. Keying a v7 capture
    against a v6 one on `id` matches nothing and reports the whole show removed
    and re-added — 1811 findings against 1786 layers, verified by deliberately
    breaking the guard. `layersHaveIds` therefore demands ids on *every* layer of
    *both* sides before either is used. Because the id becomes the key, `name`
    and `group` must be compared as fields or a rename and a move between groups
    match silently; and the id is appended to a label only where a sibling shares
    the name, because decorating all 1935 is noise on the 1121 that never needed
    it. What is appended keys off `idSource`: a `uid` id goes in whole, a
    `derived` one opens with the name the label just printed so its extents go
    in instead — read from the layer's own fields, never parsed out of the id,
    because the viewer must not learn the plugin's id format. `derived` ids are
    not move-stable (groupPath is baked in), so a move reads as remove plus add
    on those; the asymmetry with `uid` is deliberate on both sides.
12. **Media and transport info need one snapshot, not two.** They read After
    when there is one and Before otherwise (`reportSource` in `index.html`), so
    a single capture is enough to look at the show you have. Preferring After is
    what keeps the answer stable as files arrive instead of switching which
    capture the tab describes. The tally says `from Before` only when it read
    Before — After is the documented default, and labelling it every time is
    noise, while silence on the surprising case would let someone attribute the
    numbers to the wrong capture. Gating these tabs on both slots, as the diff
    must be, blanks a tab that already has everything it needs.

13. **A `.d3` goes through JSON before it reaches the diff.** `readArchive` in
    `index.html` writes the extractor's snapshot with `D3Extract.toJson` and
    parses it back. Handing over the object as built looks like a saved step
    and is two bugs. Its `uid` is a `BigInt`, which `JSON.stringify` throws on.
    Its keys are in construction order, so cue tags compared as strings differ
    from a capture's sorted ones: 543 phantom changes on the reference show. The
    round-trip also makes a dropped archive identical to the file the extractor
    page downloads.

## Tests

```
node tools/selftest.js /path/to/captures
```

Cases run against **real captures, not fixtures** — the fields that break are
the ones nobody thinks to fake. Fixtures appear only where the corpus cannot
express the state (a census that failed, a dangling trackRef, a trashed track).

**A fixture must state its schema, never inherit the corpus's.** When the corpus
went from v6 to v7, five whitespace cases began asserting an add-plus-remove that
a keyed diff correctly no longer produces, and the mixed-pair case started
comparing real uids against synthesised ones — seven failures, none of them a
fault in the engine. `asV6()` and `asV7()` exist so a case says which shape it
means. The real-capture v7 cases are guarded the other way: on a v6 corpus they
print that they did not run, because silent passes measuring nothing is how the
census field disarmed two cases once already.

Run with no argument and the suite resolves its own corpus from `LOG_CANDIDATES`
in `tools/selftest.js` — anything listed in the gitignored `tools/logs.local`,
one path per line, then the plugin repo next door — and exits rather than testing
nothing. **Machine-specific paths belong in `logs.local`, never in the list.**
This repo is public, and the path to a capture folder names a client, a shared
drive and an email address before it names a single capture. The `.d3` cases
look for an archive in the same folders and in
`../d3_proj_analyzer/d3 project to analyze example/`, and print a NOTE when
there is none. Zero-byte files are skipped: an interrupted capture leaves one
behind, and parsing it takes down the suite before a case runs. `tools/deploy.sh` still uses its own `LOGS` default and
warns rather than resolving that list.

Resolution looks one level down and needs **two** captures before it accepts a
folder, because the v6 archive sits in `old_schema/` while new captures land in
the parent beside it. **A folder holding exactly one capture is the dangerous
case, not the empty one**: the morning the first v7 capture appears, the parent
holds one file, resolution falls through to the archive, and the suite passes
green without ever reading the v7 file it exists to check. So an empty folder is
skipped in silence and a folder skipped *while holding captures* prints a NOTE
naming it. An explicit path argument is resolved the same way — `deploy.sh`
passes one, and letting argv skip the search would leave the deploy gate with the
hole the search closes.

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
`d3plg_susan_summary`. **The two ship together.** This viewer reads v6 and v7 and
refuses anything else, so a schema change means releasing both. v7 adds `uid`,
`id` and `idSource` to every layer and touches nothing else, which is the only
reason two versions load at once; a change with any other shape gets one version,
not two.

**One invariant is agreed across the two repos and written down in both.** A
layer must keep `tStart` and `tEnd` on its record, even though a derived `id`
already encodes them. The viewer reads those fields directly and never parses the
id string, so the plugin is free to change the derived id format without touching
anything here — and must not drop the extents as redundant, which is exactly how
this would get broken by someone tidying up two versions from now. The parse the
contract avoids is not hypothetical: this show has layer names carrying trailing
spaces and embedded newlines, and one containing `" @"` would defeat any attempt
to split an id on it. See that repo's
`CLAUDE.md` for the capture side.
