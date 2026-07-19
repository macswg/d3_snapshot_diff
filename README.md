# Showfile snapshot diff

Visual diff for two `susan_summary` snapshot logs — what changed in the showfile
between one capture and the next.

![The viewer comparing two captures](screenshot.png)

## Use it

Open `index.html` in a browser. Pick a **Before** and an **After** (click or
drag), and read the tree. That's the whole thing — no build step, no server, no
dependencies.

**Choose folder…** does it in one step: point it at a captures directory and it
loads the two most recent snapshots, previous into Before and latest into After.
Order comes from the timestamp at the head of the filename
(`2026-07-18_20-17-27_…`), falling back to the file's own date for names without
one — the toolbar says how many were ordered that way.

## Reading the output

| sigil | meaning |
|-------|---------|
| `+`   | present in After, not Before |
| `−`   | present in Before, not After |
| `~`   | present in both, with changed fields |

Changes nest: a changed track lists its changed cues and layers, and a changed
layer lists its changed media. Unchanged entities are omitted entirely — the
tally in the toolbar counts every node in the tree, including nested ones.

## Logs on a shared drive

Point Google Drive Desktop at the shared logs folder and pick files from that
local path.

There is deliberately no Drive API integration. It would need OAuth, client
credentials and a server to hold them — a build step and a deployment, for the
sole benefit of not clicking a file. If a browser-side Drive picker ever
genuinely matters, that is the moment to reconsider, not before.

## Semantic, not textual

Entities are matched by **identity, never array position**:

| entity    | identity                               |
|-----------|----------------------------------------|
| track     | `id`                                   |
| layer     | `groupPath` + `name`, within its track |
| media     | `path` (falls back to `name`)          |
| cue       | `beat`                                 |
| transport | `name`                                 |

A layer inserted at the top of a track is therefore **one addition**, not "every
layer below it moved". That is the whole reason this exists instead of `diff`.

Consequences worth knowing:

- **Tracks shared between setlists diff once.** Schema v4 stores each track once
  in a top-level `tracks` array with transports holding `trackRefs`; a track on
  two setlists produces one node, not one per referencing transport.
- **A reordered setlist is a real change.** `trackRefs` order is compared as
  running order, so a reshuffled show reports even when no track in it was
  touched.
- **Media swaps read as remove + add**, not `path: old → new`, because media
  identity *is* the path. A different clip is a different resource, not an
  edited one.
- **Derived counters are not compared.** `layerCount` on a track and
  `trackCount` on a transport follow from the structure; comparing them as well
  would report every structural edit twice. (`trackCount` *is* compared at
  transport level, where it summarises a `trackRefs` change usefully.)
- **Floats compare with a 1e-6 tolerance.** Beats and times are re-derived
  through the director each capture, so a position that comes back as
  `60.0000000001` is the same position, not an edit.

## Schema

Reads **v4 only**, and refuses anything else at load with a message naming the
version. A v1 log has a top-level `transport` with tracks inline rather than
referenced, so identity matching cannot line up — rendering it anyway would
produce a confident all-changed diff, which is worse than refusing.

Bump the check in `index.html` alongside `SCHEMA_VERSION` in the plugin's
`snapshot.py`, and add any new comparable fields to the field lists at the top
of `diff.js`.

## Layout

```
index.html        UI, rendering and file loading. All the CSS.
diff.js           The engine. No DOM access — usable from node.
tools/selftest.js Regression checks against real captures.
```

`diff.js` exports `diffSnapshots(a, b)` under CommonJS as well as defining it
globally for the page, which is why the self-test can `require` it directly.

`diffSnapshots` returns:

```js
{
  meta:   { a: {capturedAt, project, version}, b: {…} },
  counts: { added, removed, changed },
  nodes:  [ { kind, label, detail?, changes?: [{field, from, to}], children?: [] } ]
}
```

## Tests

```
node tools/selftest.js [path/to/logs]
```

Defaults to `../d3plg_susan_summary/example_logs`. It needs at least two `.json`
captures there and compares the first against the last.

The cases run against **real captures rather than hand-written fixtures**,
because the fields that actually break are the ones nobody thinks to fake — null
timecode on a track with no TC tag, empty `media` arrays on a layer with no clip
assigned, tracks shared across transports. Each check corresponds to a claim
made above: identity, positional independence, shared-track dedup, float
tolerance, derived counters, running order.

## Known gaps

- The diff is changed-only. Unchanged entities are never emitted, so there is no
  way to show surrounding context the way `diff -U` does.
- Only two snapshots at a time. A folder-wide timeline ("show me this project
  across the week") would need a different UI and is not built.
