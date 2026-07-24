/* Semantic diff for susan_summary v5 snapshots.
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
                    'firstTimecodeBeat', ['trashed', 'in the trash']];
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
 * from a setlist, not that they deleted it. Answering "was it deleted" needs a
 * census of the whole show, and v5 captures one: `showfile.trackIds`, read off
 * the automatic setlist resource directly, whatever the transports are loaded
 * with.
 *
 * `trackIds` is null, never empty, when the plugin could not read that
 * resource -- an empty show and an unreadable one are not the same answer. In
 * that case fall back to a transport that happens to be sitting on `automatic`,
 * whose trackRefs are the same census by a less reliable route.
 *
 * Returns {known, set}. `known` false means this capture cannot speak for the
 * showfile at all, so absence proves nothing and no deletion may be claimed.
 */
function showfileTracks(snap) {
  var set = Object.create(null), known = false, i;
  var census = snap.showfile && snap.showfile.trackIds;
  if (census) {
    for (i = 0; i < census.length; i++) set[String(census[i])] = true;
    return { known: true, set: set };
  }
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
  // A track in the trash is still played if a setlist references it, which is
  // worth saying on every row it appears on -- it never shows up in the census,
  // so nothing else in the output would give it away.
  function trackDetail(t) {
    var bits = [t.layerCount + ' layers'];
    if (t.trashed) bits.push('in the trash');
    return bits.join(' · ');
  }
  m.added.forEach(function (t) {
    // Genuinely new only if Before censused the showfile and this was not in it.
    if (!(showA.known && !showA.set[String(t.id)])) { membership.added++; return; }
    nodes.push({ kind: 'added', entity: 'track', label: 'track ' + t.id,
                 detail: trackDetail(t) });
  });
  m.removed.forEach(function (t) {
    if (!(showB.known && !showB.set[String(t.id)])) { membership.removed++; return; }
    nodes.push({ kind: 'removed', entity: 'track', label: 'track ' + t.id,
                 detail: trackDetail(t) });
  });
  m.common.forEach(function (p) {
    var ch = fieldChanges(p.a, p.b, TRACK_FIELDS);
    var kids = diffCues(p.a, p.b).concat(diffLayers(p.a, p.b));
    if (ch.length || kids.length) {
      nodes.push({ kind: 'changed', entity: 'track', label: 'track ' + p.b.id,
                   detail: p.b.trashed ? 'in the trash' : null,
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
  function noCensus(which, snap) {
    var why = snap.showfile && snap.showfile.error
      ? 'could not read the automatic setlist (' + snap.showfile.error + ')'
      : 'carries no census of the showfile';
    return ' The ' + which + ' capture ' + why + ', which is the only thing ' +
           'that lists every track in the show, so this pair cannot tell a ' +
           'showfile edit from a setlist edit.';
  }
  if (tracks.membership.removed) {
    notes.push('Not counted as deletions: ' + plural(tracks.membership.removed, 'track') +
               ' that left the capture by dropping off a setlist.' +
               (tracks.showB.known ? '' : noCensus('After', snapB)));
  }
  if (tracks.membership.added) {
    notes.push('Not counted as additions: ' + plural(tracks.membership.added, 'track') +
               ' that entered the capture by joining a setlist.' +
               (tracks.showA.known ? '' : noCensus('Before', snapA)));
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

/* One capture's media: every track it holds, and what each one loads, in the
 * order it plays. Nothing here is a comparison -- it answers "what is
 * programmed", which the diff deliberately never says.
 *
 * Returns {tracks:[{id, name, lengthInSec, bpm, trashed, items:[…]}],
 *          totals:{tracks, media}}.
 *
 * Deliberately flat. Grouping by transport meant a track on three setlists was
 * listed three times and its media counted three times, so a 1,734-media show
 * reported 2,931 -- an inventory whose total is not the inventory. What each
 * transport has loaded is a real question, just a different one; it is
 * `transportReport` below.
 */
function mediaReport(snap) {
  snap = snap || {};

  // tStart is null on a layer the director could not place. Sorting those as 0
  // would file them ahead of everything on the timeline, claiming a position
  // the capture does not have; they go last. Layer then media name break ties
  // so two clips starting on the same frame don't swap between runs.
  function byTime(x, y) {
    if (x.tStart === null && y.tStart !== null) return 1;
    if (y.tStart === null && x.tStart !== null) return -1;
    if (x.tStart !== null && x.tStart !== y.tStart) return x.tStart - y.tStart;
    return String(x.layer).localeCompare(String(y.layer)) ||
           String(x.name).localeCompare(String(y.name));
  }

  function nul(v) { return v === undefined ? null : v; }

  function itemsOf(track) {
    var out = [];
    (track.layers || []).forEach(function (l) {
      // One row per media, not per layer: a layer holding five clips is five
      // things loaded, and a layer holding none is nothing to load and so
      // contributes no row at all.
      (l.media || []).forEach(function (md) {
        out.push({
          layer: l.name, group: l.groupPath || [], type: l.type,
          renderEnable: l.renderEnable,
          tStart: nul(l.tStart), tEnd: nul(l.tEnd),
          name: md.name, path: md.path, version: md.version,
          hasAudio: md.hasAudio, regionSet: md.regionSet
        });
      });
    });
    return out.sort(byTime);
  }

  // `tracks` order is kept as the capture wrote it -- the plugin sorts by id, so
  // the report reads alphabetically and a track sits in the same place between
  // captures. There is no running order to preserve once setlists are out of it.
  var totals = { tracks: 0, media: 0 };
  var tracks = (snap.tracks || []).map(function (t) {
    var items = itemsOf(t);
    totals.tracks++;
    totals.media += items.length;
    return { id: String(t.id), name: t.name || String(t.id),
             lengthInSec: nul(t.lengthInSec), bpm: nul(t.bpm),
             trashed: !!t.trashed, items: items };
  });

  return { tracks: tracks, totals: totals };
}

/* What each transport has loaded: its setlist and the tracks on it, in running
 * order. The other half of what the media report used to conflate -- there the
 * question is "what is programmed", here it is "what is this transport playing",
 * and the same track legitimately appears under every setlist that holds it.
 *
 * Returns {transports:[{name, setlist, error, trackCount, missingCount,
 *                       tracks:[{id, name, lengthInSec, bpm, trashed, missing}]}],
 *          totals:{transports, tracks}}.
 *
 * No media. A setlist is a running order, and 1,700 clip rows underneath one is
 * what made the combined view unreadable.
 */
function transportReport(snap) {
  snap = snap || {};

  // Index once rather than scanning per ref: 4 transports over 127 tracks is
  // small, but the automatic setlist alone is 126 refs and this is the same
  // quadratic shape the media report avoids. First id wins -- ids are unique in
  // practice, and a capture that repeats one must report rather than throw.
  var byId = Object.create(null);
  (snap.tracks || []).forEach(function (t) {
    var k = String(t.id);
    if (!(k in byId)) byId[k] = t;
  });

  function nul(v) { return v === undefined ? null : v; }

  var totals = { transports: 0, tracks: 0 };
  var transports = (snap.transports || []).map(function (tr) {
    var missingCount = 0;
    // trackRefs order IS the running order. Never sorted -- the order is the
    // information, which is the whole reason to look at a setlist.
    var tracks = (tr.trackRefs || []).map(function (ref) {
      var id = String(ref), t = byId[id];
      // A setlist naming a track the capture does not hold is a real fault in
      // the show, so it is reported rather than dropped.
      if (!t) {
        missingCount++;
        return { id: id, name: id, lengthInSec: null, bpm: null,
                 trashed: false, missing: true };
      }
      return { id: id, name: t.name || id, lengthInSec: nul(t.lengthInSec),
               bpm: nul(t.bpm), trashed: !!t.trashed, missing: false };
    });
    totals.transports++;
    totals.tracks += tracks.length;
    return { name: tr.name, setlist: tr.setlist, error: nul(tr.error),
             trackCount: tracks.length, missingCount: missingCount,
             tracks: tracks };
  });

  return { transports: transports, totals: totals };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { diffSnapshots: diffSnapshots, summarize: summarize,
                     mediaReport: mediaReport, transportReport: transportReport,
                     matchBy: matchBy, orderDiff: orderDiff, fmt: fmt };
}
