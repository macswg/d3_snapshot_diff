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

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

/* Compare a field set across two entities -> [{field, from, to}]. */
function fieldChanges(a, b, fields) {
  var out = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (!sameValue(a[f], b[f])) out.push({ field: f, from: a[f], to: b[f] });
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

function diffTracks(snapA, snapB) {
  var m = matchBy(snapA.tracks, snapB.tracks, function (t) { return t.id; });
  var nodes = [];
  m.added.forEach(function (t) {
    nodes.push({ kind: 'added', entity: 'track', label: 'track ' + t.id,
                 detail: t.layerCount + ' layers' });
  });
  m.removed.forEach(function (t) {
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
  return nodes;
}

function diffTransports(snapA, snapB) {
  var m = matchBy(snapA.transports, snapB.transports,
                  function (t, i) { return t.name || ('#' + i); });
  var nodes = [];
  m.added.forEach(function (t) { nodes.push({ kind: 'added', entity: 'transport', label: 'transport ' + t.name }); });
  m.removed.forEach(function (t) { nodes.push({ kind: 'removed', entity: 'transport', label: 'transport ' + t.name }); });
  m.common.forEach(function (p) {
    var ch = fieldChanges(p.a, p.b, ['setlist', 'trackCount', 'error']);
    // The running order of a setlist is showfile state: a reordered show is a
    // real change even when every track in it is untouched.
    var ra = (p.a.trackRefs || []).join(' > '), rb = (p.b.trackRefs || []).join(' > ');
    if (ra !== rb) ch.push({ field: 'running order', from: ra, to: rb });
    if (ch.length) nodes.push({ kind: 'changed', entity: 'transport', label: 'transport ' + p.b.name, changes: ch });
  });
  return nodes;
}

/* Top level. Returns {meta, nodes, counts}. */
function diffSnapshots(snapA, snapB) {
  var nodes = [];

  var top = fieldChanges(snapA, snapB, ['project', 'scope', 'activeTransport',
                                        'transportCount', 'trackCount']);
  if (top.length) nodes.push({ kind: 'changed', entity: 'snapshot', label: 'snapshot', changes: top });

  nodes = nodes.concat(diffTransports(snapA, snapB));
  nodes = nodes.concat(diffTracks(snapA, snapB));

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
    counts: counts
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
  function weigh(n) {
    var c = 1;
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
                     matchBy: matchBy, fmt: fmt };
}
