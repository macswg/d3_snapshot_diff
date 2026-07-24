/* Semantic diff for susan_summary v4 snapshots.
 *
 * Entities are matched by identity, never by array position: tracks by `id`,
 * layers by groupPath + name within their track, media by path (falling back to
 * name), cues by beat. A layer inserted at the top of a track therefore reads as
 * one addition, not "every layer below it changed" -- which is the whole reason
 * this exists instead of a text diff.
 */

// Fields compared directly on an entity, in display order. Anything not listed
// is either structural (`layers`, `cues`) or derived (`layerCount`) and would
// only produce noise -- a layer added already reports itself.
var TRACK_FIELDS = ['lengthInSec', 'lengthInBeats', 'bpm', 'hasTimecode', 'fps',
                    'firstTimecodeBeat'];
// A field is either a key, or [key, display label] where the raw name would
// mislead. `trackCount` is the one that matters: at both snapshot and transport
// level it counts setlist membership, not tracks in the showfile.
var SNAPSHOT_FIELDS  = ['project', 'scope', 'activeTransport', 'transportCount',
                        ['trackCount', 'tracks in setlists']];
var TRANSPORT_FIELDS = ['setlist', ['trackCount', 'tracks in setlist'], 'error'];
var LAYER_FIELDS = ['type', 'renderEnable', 'tStart', 'tEnd', 'bStart', 'bEnd',
                    'tcStart', 'tcEnd'];
var MEDIA_FIELDS = ['name', 'path', 'version', 'hasAudio', 'regionSet'];
var CUE_FIELDS   = ['isSection', 'note', 'section', 't', 'timecode'];

// Beats are floats off the director; compare them with a tolerance so a capture
// that re-derives 128.00000001 doesn't report a change.
var EPSILON = 1e-6;

function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < EPSILON;
  return a === b;
}

function plural(n, one) { return n + ' ' + one + (n === 1 ? '' : 's'); }

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

/* Compare a field set across two entities -> [{field, from, to}].
 * An entry may be `key` or `[key, label]`; `field` carries the label, since it
 * is what the page prints, ranks and searches on. */
function fieldChanges(a, b, fields) {
  var out = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i], key = f, label = f;
    if (f instanceof Array) { key = f[0]; label = f[1]; }
    if (!sameValue(a[key], b[key])) out.push({ field: label, from: a[key], to: b[key] });
  }
  return out;
}

/* Match two lists by a key function.
 * Returns {added, removed, common:[{key, a, b}]} preserving the order items
 * appear in, `b` first -- the newer snapshot is the one being read.
 *
 * Keys are NOT assumed unique. A key identifies a *group*, and the nth member
 * of a group in A pairs with the nth in B. One clip placed ten times down a
 * track is ten layers sharing `groupPath + name`; keying them into a plain map
 * is last-write-wins, so all ten placements in B would compare against the same
 * single placement in A and nine would report a bogus tStart/tEnd change --
 * which is exactly what a snapshot diffed against a copy of itself showed.
 *
 * Within a group the pairing is by order of appearance, so a repeated layer
 * that moves still reads as a change rather than remove + add. Across groups
 * identity still rules: an insertion never shifts unrelated entities.
 */
function matchBy(listA, listB, keyOf) {
  listA = listA || [];
  listB = listB || [];

  // Occurrence-qualified keys: the 2nd "x" becomes "x#2", so equal keys line up
  // pairwise instead of collapsing. Prototype-less maps keep an entity actually
  // named "constructor" from colliding with Object.prototype.
  function qualify(list) {
    var seen = Object.create(null), keys = [], i, base, n;
    for (i = 0; i < list.length; i++) {
      base = keyOf(list[i], i);
      n = seen[base] = (seen[base] || 0) + 1;
      keys.push(n === 1 ? base : base + '#' + n);
    }
    return keys;
  }

  var keysA = qualify(listA), keysB = qualify(listB);
  var mapA = Object.create(null), mapB = Object.create(null), i;
  for (i = 0; i < listA.length; i++) mapA[keysA[i]] = listA[i];
  for (i = 0; i < listB.length; i++) mapB[keysB[i]] = listB[i];

  var common = [], added = [], removed = [];
  for (i = 0; i < listB.length; i++) {
    if (keysB[i] in mapA) common.push({ key: keysB[i], a: mapA[keysB[i]], b: listB[i] });
    else added.push(listB[i]);
  }
  for (i = 0; i < listA.length; i++) {
    if (!(keysA[i] in mapB)) removed.push(listA[i]);
  }
  return { added: added, removed: removed, common: common };
}

function layerKey(l) { return (l.groupPath || []).concat([l.name]).join(' / '); }
// Media identity is the path; two layers can hold clips with the same display
// name from different folders. Name is the fallback when path failed to read.
function mediaKey(m) { return m.path || m.name || ''; }
function cueKey(c) { return String(Math.round((c.beat || 0) * 1000)); }

function diffMedia(a, b) {
  var m = matchBy(a.media, b.media, mediaKey);
  var nodes = [];
  m.added.forEach(function (x) {
    nodes.push({ kind: 'added', entity: 'media', label: 'media ' + (x.name || x.path), detail: x.path });
  });
  m.removed.forEach(function (x) {
    nodes.push({ kind: 'removed', entity: 'media', label: 'media ' + (x.name || x.path), detail: x.path });
  });
  m.common.forEach(function (p) {
    var ch = fieldChanges(p.a, p.b, MEDIA_FIELDS);
    if (ch.length) {
      nodes.push({ kind: 'changed', entity: 'media', label: 'media ' + (p.b.name || p.b.path), changes: ch });
    }
  });
  return nodes;
}

function diffLayers(trackA, trackB) {
  var m = matchBy(trackA.layers, trackB.layers, layerKey);
  var nodes = [];
  m.added.forEach(function (l) {
    nodes.push({ kind: 'added', entity: 'layer', label: 'layer ' + layerKey(l), detail: l.type });
  });
  m.removed.forEach(function (l) {
    nodes.push({ kind: 'removed', entity: 'layer', label: 'layer ' + layerKey(l), detail: l.type });
  });
  m.common.forEach(function (p) {
    var ch = fieldChanges(p.a, p.b, LAYER_FIELDS);
    var kids = diffMedia(p.a, p.b);
    if (ch.length || kids.length) {
      nodes.push({ kind: 'changed', entity: 'layer', label: 'layer ' + layerKey(p.b),
                   changes: ch, children: kids });
    }
  });
  return nodes;
}

function diffCues(trackA, trackB) {
  var m = matchBy(trackA.cues, trackB.cues, cueKey);
  var nodes = [];
  function cueLabel(c) {
    return 'cue @ beat ' + fmt(c.beat) + (c.note ? ' "' + c.note + '"' : '');
  }
  m.added.forEach(function (c) { nodes.push({ kind: 'added', entity: 'cue', label: cueLabel(c) }); });
  m.removed.forEach(function (c) { nodes.push({ kind: 'removed', entity: 'cue', label: cueLabel(c) }); });
  m.common.forEach(function (p) {
    var ch = fieldChanges(p.a, p.b, CUE_FIELDS);
    // Tags are a small list of {type,text}; compare them as a whole.
    var ta = JSON.stringify(p.a.tags || []), tb = JSON.stringify(p.b.tags || []);
    if (ta !== tb) ch.push({ field: 'tags', from: ta, to: tb });
    if (ch.length) nodes.push({ kind: 'changed', entity: 'cue', label: cueLabel(p.b), changes: ch });
  });
  return nodes;
}

/* What the capture can say about the showfile's track list.
 *
 * The top-level `tracks` array is only the union of what the setlists
 * reference, so a track vanishing from it usually means someone dropped a song
 * from a setlist, not that they deleted it. The one transport that does census
 * the showfile is an `automatic` setlist, which holds every track in the show;
 * when a capture has one, its trackRefs ARE the showfile.
 *
 * Returns {known, set}. `known` false means this capture had no automatic
 * transport, so absence proves nothing and no deletion may be claimed from it.
 */
function showfileTracks(snap) {
  var set = Object.create(null), known = false;
  (snap.transports || []).forEach(function (t) {
    if (t.setlist !== 'automatic') return;
    known = true;
    (t.trackRefs || []).forEach(function (r) { set[String(r)] = true; });
  });
  return { known: known, set: set };
}

/* Returns {nodes, membership:{added, removed}}.
 *
 * `membership` counts tracks that entered or left the capture without the
 * showfile being shown to have changed -- someone edited a setlist, or the
 * other capture has no automatic transport to check against. Those are
 * reported under the transport as running-order lines instead, so that an
 * added or removed track in the tree always means the showfile itself.
 */
function diffTracks(snapA, snapB) {
  var showA = showfileTracks(snapA), showB = showfileTracks(snapB);
  var m = matchBy(snapA.tracks, snapB.tracks, function (t) { return t.id; });
  var nodes = [], membership = { added: 0, removed: 0 };
  m.added.forEach(function (t) {
    // Genuinely new only if Before censused the showfile and this was not in it.
    if (!(showA.known && !showA.set[String(t.id)])) { membership.added++; return; }
    nodes.push({ kind: 'added', entity: 'track', label: 'track ' + t.id,
                 detail: t.layerCount + ' layers' });
  });
  m.removed.forEach(function (t) {
    if (!(showB.known && !showB.set[String(t.id)])) { membership.removed++; return; }
    nodes.push({ kind: 'removed', entity: 'track', label: 'track ' + t.id,
                 detail: t.layerCount + ' layers' });
  });
  m.common.forEach(function (p) {
    var ch = fieldChanges(p.a, p.b, TRACK_FIELDS);
    var kids = diffCues(p.a, p.b).concat(diffLayers(p.a, p.b));
    if (ch.length || kids.length) {
      nodes.push({ kind: 'changed', entity: 'track', label: 'track ' + p.b.id,
                   changes: ch, children: kids });
    }
  });
  return { nodes: nodes, membership: membership, showA: showA, showB: showB };
}

/* Line-diff two running orders -> {entries, counts}.
 *
 * A setlist runs to a hundred-odd entries, so the old rendering -- both orders
 * joined with " > " into one before/after pair of strings -- was unreadable
 * exactly when it mattered. Here each track gets its own entry, tagged with
 * where it sat on each side, so the page can print it a line at a time.
 *
 * Longest common subsequence, then a move-pairing pass: a track that is on both
 * setlists but off the common subsequence has been reshuffled, not deleted and
 * re-added, and reads as one `moved` line rather than a − and a + far apart.
 */
function orderDiff(listA, listB) {
  var a = (listA || []).map(String), b = (listB || []).map(String);
  var n = a.length, m = b.length, w = m + 1, dp = [], i, j;

  for (i = 0; i < (n + 1) * w; i++) dp[i] = 0;
  for (i = n - 1; i >= 0; i--) {
    for (j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }

  var out = [];
  i = 0; j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', id: a[i], a: i, b: j }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { out.push({ kind: 'removed', id: a[i], a: i, b: null }); i++; }
    else { out.push({ kind: 'added', id: b[j], a: null, b: j }); j++; }
  }
  while (i < n) { out.push({ kind: 'removed', id: a[i], a: i, b: null }); i++; }
  while (j < m) { out.push({ kind: 'added', id: b[j], a: null, b: j }); j++; }

  var addedAt = Object.create(null), drop = Object.create(null);
  out.forEach(function (e, k) {
    if (e.kind === 'added') (addedAt[e.id] = addedAt[e.id] || []).push(k);
  });
  out.forEach(function (e) {
    if (e.kind !== 'removed') return;
    var q = addedAt[e.id];
    if (!q || !q.length) return;
    var k = q.shift();
    e.kind = 'moved'; e.b = out[k].b; drop[k] = true;
  });
  out = out.filter(function (e, k) { return !drop[k]; });

  var counts = { same: 0, moved: 0, added: 0, removed: 0 };
  out.forEach(function (e) { counts[e.kind]++; });
  counts.a = n; counts.b = m;
  counts.changed = counts.moved + counts.added + counts.removed;
  return { entries: out, counts: counts };
}

function diffTransports(snapA, snapB) {
  var m = matchBy(snapA.transports, snapB.transports,
                  function (t, i) { return t.name || ('#' + i); });
  var nodes = [];
  m.added.forEach(function (t) { nodes.push({ kind: 'added', entity: 'transport', label: 'transport ' + t.name }); });
  m.removed.forEach(function (t) { nodes.push({ kind: 'removed', entity: 'transport', label: 'transport ' + t.name }); });
  m.common.forEach(function (p) {
    var ch = fieldChanges(p.a, p.b, TRANSPORT_FIELDS);
    // The running order of a setlist is showfile state: a reordered show is a
    // real change even when every track in it is untouched. It rides on the
    // node as `order` rather than as a field change, because it is a list and
    // the page renders it as one.
    var order = orderDiff(p.a.trackRefs, p.b.trackRefs);
    if (ch.length || order.counts.changed) {
      nodes.push({ kind: 'changed', entity: 'transport', label: 'transport ' + p.b.name,
                   changes: ch, order: order.counts.changed ? order : null });
    }
  });
  return nodes;
}

/* Top level. Returns {meta, nodes, counts, notes}. */
function diffSnapshots(snapA, snapB) {
  var nodes = [];

  var top = fieldChanges(snapA, snapB, SNAPSHOT_FIELDS);
  if (top.length) nodes.push({ kind: 'changed', entity: 'snapshot', label: 'snapshot', changes: top });

  var tracks = diffTracks(snapA, snapB);
  nodes = nodes.concat(diffTransports(snapA, snapB));
  nodes = nodes.concat(tracks.nodes);

  // Say out loud what was held back, and why. A silently smaller tally is worse
  // than a noisy one: it reads as "nothing happened to the tracks" when what
  // actually happened is that the capture cannot tell.
  var notes = [];
  function noCensus(which) {
    return ' The ' + which + ' capture has no transport on the automatic setlist, ' +
           'which is the only one that lists every track in the show, so this ' +
           'pair cannot tell a showfile edit from a setlist edit.';
  }
  if (tracks.membership.removed) {
    notes.push('Not counted as deletions: ' + plural(tracks.membership.removed, 'track') +
               ' that left the capture by dropping off a setlist.' +
               (tracks.showB.known ? '' : noCensus('After')));
  }
  if (tracks.membership.added) {
    notes.push('Not counted as additions: ' + plural(tracks.membership.added, 'track') +
               ' that entered the capture by joining a setlist.' +
               (tracks.showA.known ? '' : noCensus('Before')));
  }

  var counts = { added: 0, removed: 0, changed: 0 };
  (function walk(list) {
    list.forEach(function (n) {
      counts[n.kind]++;
      if (n.children) walk(n.children);
    });
  })(nodes);

  return {
    meta: {
      a: { capturedAt: snapA.capturedAt, project: snapA.project, version: snapA.schemaVersion },
      b: { capturedAt: snapB.capturedAt, project: snapB.project, version: snapB.schemaVersion }
    },
    nodes: nodes,
    counts: counts,
    notes: notes
  };
}

/* Roll a diff up into something readable at a glance.
 *
 * A real pair of captures runs to hundreds of nodes, and the raw tally
 * (added/removed/changed) does not distinguish "someone recut two songs" from
 * "every clip's media version was re-scanned". The field ranking is what
 * separates them: 205 changes that are all `media version` is a re-link, not
 * editorial work.
 *
 * Returns {entities, fields, hotspots}, all pre-sorted for display.
 */
var ENTITY_ORDER = ['snapshot', 'transport', 'track', 'layer', 'cue', 'media'];

function summarize(result) {
  var byEntity = {}, byField = {};

  (function walk(list) {
    list.forEach(function (n) {
      var e = n.entity || 'other';
      if (!byEntity[e]) byEntity[e] = { entity: e, added: 0, removed: 0, changed: 0, total: 0 };
      byEntity[e][n.kind]++;
      byEntity[e].total++;
      (n.changes || []).forEach(function (c) {
        var k = e + ' ' + c.field;   // entity names carry no spaces, so this cannot collide
        if (!byField[k]) byField[k] = { entity: e, field: c.field, count: 0 };
        byField[k].count++;
      });
      // A running order counts once, not once per line: a reshuffled setlist is
      // one edit, and letting its hundred lines into the ranking would bury
      // every other field under it.
      if (n.order) {
        var ko = e + ' running order';
        if (!byField[ko]) byField[ko] = { entity: e, field: 'running order', count: 0 };
        byField[ko].count++;
      }
      if (n.children) walk(n.children);
    });
  })(result.nodes);

  var entities = Object.keys(byEntity).map(function (k) { return byEntity[k]; })
    .sort(function (a, b) {
      var ia = ENTITY_ORDER.indexOf(a.entity), ib = ENTITY_ORDER.indexOf(b.entity);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

  var fields = Object.keys(byField).map(function (k) { return byField[k]; })
    .sort(function (a, b) { return b.count - a.count || a.field.localeCompare(b.field); });

  // Weight of a top-level node = everything reported beneath it, so a track
  // with one recut layer does not outrank one with forty.
  // Running-order lines weigh here even though they are not nodes: a setlist
  // that lost a hundred tracks is the most affected thing in the diff, and
  // ranking it at 1 next to a track with one retimed layer is just wrong.
  function weigh(n) {
    var c = 1 + (n.order ? n.order.counts.changed : 0);
    (n.children || []).forEach(function (k) { c += weigh(k); });
    return c;
  }
  var hotspots = result.nodes.map(function (n) {
    return { label: n.label, kind: n.kind, entity: n.entity || 'other', count: weigh(n) };
  }).sort(function (a, b) { return b.count - a.count; });

  return { entities: entities, fields: fields, hotspots: hotspots };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { diffSnapshots: diffSnapshots, summarize: summarize,
                     matchBy: matchBy, orderDiff: orderDiff, fmt: fmt };
}
