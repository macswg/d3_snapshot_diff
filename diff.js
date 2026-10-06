/* Semantic diff for susan_summary v5 snapshots.
 *
 * Entities are matched by identity, never by array position: tracks by `id`,
 * layers by groupPath + name within their track, media by path (falling back to
 * name), cues by beat. A layer inserted at the top of a track therefore reads as
 * one addition, not "every layer below it changed" -- which is the whole reason
 * this exists instead of a text diff.
 */

// Beats are floats off the director; compare them with a tolerance so a capture
// that re-derives 128.00000001 doesn't report a change.
var EPSILON = 1e-6;

// Cue *identity* needs a far wider tolerance than EPSILON. Beats arrive as
// float32 and re-deriving one moves it much further than a rounding wobble: the
// same untouched cue read 0.000469 beats apart in two captures twenty minutes
// apart. 0.005 is bracketed by the corpus rather than guessed -- ten times the
// largest drift seen across every pair of real captures, and six times below
// the tightest genuine gap between two cues (0.033 beats, one frame at 30fps),
// so it can never merge two cues a director could tell apart.
var CUE_TOLERANCE = 0.005;

// Fields compared directly on an entity, in display order. Anything not listed
// is either structural (`layers`, `cues`) or derived (`layerCount`) and would
// only produce noise -- a layer added already reports itself.
var TRACK_FIELDS = ['lengthInSec', 'lengthInBeats', 'bpm', 'hasTimecode', 'fps',
                    'firstTimecodeBeat', ['trashed', 'in the trash']];
// A field is either a key, [key, display label] where the raw name would
// mislead, or [key, label, tolerance] where the default EPSILON is too tight.
// `trackCount` is the one that matters: at both snapshot and transport level it
// counts setlist membership, not tracks in the showfile.
var SNAPSHOT_FIELDS  = ['project', 'scope', 'activeTransport', 'transportCount',
                        ['trackCount', 'tracks in setlists']];
var TRANSPORT_FIELDS = ['setlist', ['trackCount', 'tracks in setlist'], 'error'];
// `name` is compared even though it is half the fallback key. Keyed by name it
// can never differ between two matched layers, so the entry costs nothing; keyed
// by a v7 id it is the only thing that reports a rename, which would otherwise
// match silently and print no news at all.
var LAYER_FIELDS = ['name', 'type', 'renderEnable', 'tStart', 'tEnd', 'bStart',
                    'bEnd', 'tcStart', 'tcEnd'];
var MEDIA_FIELDS = ['name', 'path', 'version', 'hasAudio', 'regionSet'];
// `t` is the cue's beat in seconds, so it carries the same float32 drift that
// CUE_TOLERANCE exists to absorb; comparing it at EPSILON would just move the
// phantom off the cue's identity and onto its fields. It still earns its place:
// a track whose bpm changed keeps every cue on its beat and moves all of them
// in seconds, and that is the one edit only `t` can report. `beat` is not
// listed because it is the identity -- a cue whose beat really moved is out of
// matching range and reads as a remove plus an add, which is what it is.
var CUE_FIELDS   = ['isSection', 'note', 'section', ['t', 't', CUE_TOLERANCE],
                    'timecode'];

function sameValue(a, b, tolerance) {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < (tolerance === undefined ? EPSILON : tolerance);
  }
  return a === b;
}

/* Whitespace a showfile name carries but HTML will not show.
 *
 * Layer names are whatever someone typed into Designer, and the corpus has four
 * that end in a space or a newline. Two of them sit in `999_vis`, where
 * `[TEXT] B` and `[TEXT] B\n` are two different layers: rendered raw they are
 * the same row, so removing one reads as a duplicate line and renaming one
 * reads as nothing at all. Trimming the name is the worse repair -- it collapses
 * two entities onto one label and hides the edit completely.
 *
 * Only labels are marked. Identity keeps the raw string: matching on a marked
 * name would make `B` and `B\n` differ by a whole symbol rather than by the one
 * character they actually differ by, turning every dirty name into an add
 * paired with a remove -- the exact failure the cue tolerance exists to avoid.
 */
var WS_MARK = { ' ': '\u2423', '\t': '\u21e5', '\n': '\u23ce', '\r': '\u23ce' };

function markRun(run) {
  var out = '', ch, i;
  for (i = 0; i < run.length; i++) {
    ch = run.charAt(i);
    // An unlisted whitespace character -- a non-breaking or hair space -- gets
    // its codepoint rather than a symbol. It is invisible but it is not a plain
    // space, and lending it the space symbol would name the wrong character.
    out += WS_MARK[ch] ||
           ('\\u' + ('000' + run.charCodeAt(i).toString(16)).slice(-4));
  }
  return out;
}

function showWhitespace(s) {
  if (typeof s !== 'string' || s === '') return s;
  return s.replace(/\s+/g, function (run, at) {
    // A single space between words is ordinary; marking those would make every
    // name unreadable. Mark a run only where HTML would swallow it: against
    // either end, doubled up, or carrying a tab or a newline.
    var atEdge = at === 0 || at + run.length === s.length;
    if (!atEdge && run === ' ') return run;
    return markRun(run);
  });
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
/* The environment the showfile was read in: the Designer build, and the
 * advanced project settings ("option switches").
 *
 * These flatten onto the snapshot node rather than earning a section. An
 * upgrade or a flipped switch is one line of news; a section of its own would
 * put the environment above the showfile edits below it, which is backwards --
 * you look at these captures to see what changed in the show.
 *
 * Fields the plugin reports as changed but which say nothing on their own
 * (branch, platform, tags) are left out: they move together with the version,
 * so listing them turns one upgrade into six lines.
 */
var BUILD_FIELDS = [['version', 'd3 build'], ['releaseType', 'licence'],
                    ['customRelease', 'custom release'],
                    ['osImage', 'OS image'],
                    ['renderStream', 'RenderStream']];

function buildChanges(a, b) {
  var ba = (a.system && a.system.build) || {},
      bb = (b.system && b.system.build) || {};
  return fieldChanges(ba, bb, BUILD_FIELDS);
}

/* Option switch changes for one scope, plus a note when the pair cannot answer.
 *
 * Two traps here, both of which produce a confidently wrong diff:
 *
 * `values: null` means the plugin could not read the file, NOT that no switches
 * are set. Diffing null against a real map would report all 125 switches as
 * removed -- the same mistake `trackIds: null` exists to prevent. So a null on
 * either side drops the whole scope and says so out loud.
 *
 * A switch missing from the file is at its *default*, which is not the same as
 * a value of "0" -- the file only holds what has been persisted. Missing stays
 * undefined so it renders as '—', rather than being filled in with a zero the
 * capture never claimed.
 */
function optionChanges(a, b, scope) {
  var sa = (a.system && a.system.options && a.system.options[scope]) || {},
      sb = (b.system && b.system.options && b.system.options[scope]) || {};
  if (!sa.values || !sb.values) {
    // "Neither capture could not read" was the old wording: a double negative
    // that says the opposite of what it means on every .d3 pair.
    var which = !sa.values ? (!sb.values ? 'Neither capture could' : 'The Before capture could not')
                           : 'The After capture could not';
    return { changes: [], note:
      which + ' read the ' + scope + ' option switches' +
      ((sa.error || sb.error) ? ' (' + (sa.error || sb.error) + ')' : '') +
      ', so a switch that was flipped between these two captures cannot be ' +
      'reported. An unread file is not an empty one.' };
  }

  var names = [], seen = {}, k;
  for (k in sa.values) if (!seen[k]) { seen[k] = 1; names.push(k); }
  for (k in sb.values) if (!seen[k]) { seen[k] = 1; names.push(k); }
  names.sort();

  var label = scope === 'machine' ? ' (machine)' : '';
  return { changes: fieldChanges(sa.values, sb.values, names.map(function (n) {
    return [n, n + label];
  })), note: null };
}

function fieldChanges(a, b, fields) {
  var out = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i], key = f, label = f, tol;
    if (f instanceof Array) { key = f[0]; label = f[1]; tol = f[2]; }
    if (!sameValue(a[key], b[key], tol)) out.push({ field: label, from: a[key], to: b[key] });
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

/* Layer identity, and why it is decided per pair rather than per layer.
 *
 * Before v7 a layer had nothing of its own to be known by, so the best key
 * available was groupPath + name -- which 814 of this show's 1935 layers share
 * with a sibling in the same track. On 2026-09-05 one track held three records
 * named `[VID] 250_seek_tvision_a_alpha_ll180`, two of them equal in every
 * field down to the media version. One disappeared 21 minutes later and no
 * amount of care with that key could say which, because the two were the same
 * string. v7 gives each layer an id from the director's resource UID that
 * survives a rename, a retime and a move between groups.
 *
 * Both sides must carry ids before either is keyed on one. A v7 capture keyed
 * against a v6 capture on id finds no match anywhere and reports every layer in
 * the show removed and re-added -- the loudest possible way to say nothing.
 * Every layer in the list must carry one too: a capture where the director
 * answered for some layers and not others would key half a track each way, and
 * the halves would never line up.
 */
function layersHaveIds(list) {
  var ls = list || [];
  if (!ls.length) return false;
  for (var i = 0; i < ls.length; i++) {
    if (typeof ls[i].id !== 'string' || ls[i].id === '') return false;
  }
  return true;
}

function layerIdKey(l) { return String(l.id); }

/* A label that can tell two layers apart when their names cannot.
 *
 * Matching by id answers *whether* a stacked duplicate was removed; it does not
 * answer *which*, because both print the same name. The id is appended only
 * where the name is genuinely ambiguous inside its track -- hanging `#40213` off
 * every layer in a 1,935-layer show would be noise on the 1,121 that never
 * needed it.
 *
 * What gets appended depends on where the id came from. A uid id is short and
 * says something the row does not: `#40406` appends cleanly. A derived id is the
 * opposite -- `Backdrops/Solo @0.00-10.00` opens with the very name the label
 * just printed, so appending it whole prints the name twice and buries the only
 * part that differs. For those, show the extents the derived id is built from,
 * read from the layer's own fields rather than parsed back out of the id: the
 * viewer has no business knowing the plugin's id format, and a layer name
 * containing " @" would defeat any attempt to split one.
 *
 * When the extents match too, the id is all that is left. Two layers agreeing on
 * group, name and extents are the 250_seek case with no UID to resolve it, and
 * the plugin's `~<n>` suffix buried in the id is the only thing dividing them.
 * Long and ugly beats two rows a reader cannot tell apart.
 */
function layerSpan(l) { return '@' + fmt(l.tStart) + '-' + fmt(l.tEnd); }

function layerLabeller(list) {
  var shared = Object.create(null), spans = Object.create(null), i, ls = list || [];
  function spanKey(l) { return layerKey(l) + ' ' + layerSpan(l); }
  for (i = 0; i < ls.length; i++) {
    shared[layerKey(ls[i])] = (shared[layerKey(ls[i])] || 0) + 1;
    spans[spanKey(ls[i])] = (spans[spanKey(ls[i])] || 0) + 1;
  }
  return function (l) {
    var base = showWhitespace(layerKey(l));
    if (shared[layerKey(l)] <= 1) return base;
    if (typeof l.id !== 'string' || l.id === '') return base;
    // Anything that is not explicitly a uid is treated as derived. An absent
    // idSource is the conservative case: extents distinguish either way, where
    // printing a name-shaped id twice never helps.
    if (l.idSource === 'uid') return base + ' (' + showWhitespace(l.id) + ')';
    if (spans[spanKey(l)] <= 1) return base + ' (' + layerSpan(l) + ')';
    return base + ' (' + showWhitespace(l.id) + ')';
  };
}
// Media identity is the path; two layers can hold clips with the same display
// name from different folders. Name is the fallback when path failed to read.
function mediaKey(m) { return m.path || m.name || ''; }

/* Cues match by proximity in beats rather than through matchBy.
 *
 * Every other entity here has a name or a path to be identified by. A cue has
 * only its position, and that position is not stable to the bit, so an exact
 * key is the wrong instrument: rounding the beat into a bucket only moves the
 * failure to the bucket edges, which is precisely where the drift that prompted
 * this landed. One untouched cue straddling 358.858 / 358.859 came back as an
 * add paired with a remove -- and had its note been edited in the same session,
 * that field change would have been thrown away with the pairing.
 *
 * The merge is greedy, which is safe only because CUE_TOLERANCE sits far below
 * the closest two cues ever get: at most one candidate is ever in range, so
 * there is no choice to get wrong. Cues sharing a beat pair in order of
 * appearance, the same way matchBy treats duplicate keys.
 */
function beatOf(c) { return c.beat || 0; }
function byBeat(x, y) { return beatOf(x) - beatOf(y); }

function matchCues(listA, listB) {
  // Sorted copies. The merge is only correct on sorted input, and while the
  // capture happens to write cues in beat order the schema does not promise it.
  // Copies because sorting the caller's array would reorder the snapshot the
  // media and transport reports read from.
  var a = (listA || []).slice().sort(byBeat);
  var b = (listB || []).slice().sort(byBeat);
  var added = [], removed = [], common = [];
  var i = 0, j = 0, gap;
  while (i < a.length && j < b.length) {
    gap = beatOf(b[j]) - beatOf(a[i]);
    if (Math.abs(gap) <= CUE_TOLERANCE) { common.push({ a: a[i], b: b[j] }); i++; j++; }
    else if (gap > 0) { removed.push(a[i]); i++; }
    else { added.push(b[j]); j++; }
  }
  while (i < a.length) removed.push(a[i++]);
  while (j < b.length) added.push(b[j++]);
  return { added: added, removed: removed, common: common };
}

function diffMedia(a, b) {
  var m = matchBy(a.media, b.media, mediaKey);
  var nodes = [];
  m.added.forEach(function (x) {
    nodes.push({ kind: 'added', entity: 'media',
                 label: 'media ' + showWhitespace(x.name || x.path),
                 detail: showWhitespace(x.path) });
  });
  m.removed.forEach(function (x) {
    nodes.push({ kind: 'removed', entity: 'media',
                 label: 'media ' + showWhitespace(x.name || x.path),
                 detail: showWhitespace(x.path) });
  });
  m.common.forEach(function (p) {
    var ch = fieldChanges(p.a, p.b, MEDIA_FIELDS);
    if (ch.length) {
      nodes.push({ kind: 'changed', entity: 'media',
                   label: 'media ' + showWhitespace(p.b.name || p.b.path), changes: ch });
    }
  });
  return nodes;
}

/* Which of a layer's playback flags a capture recorded: {enabled, muted}.
 *
 * Only a .d3 records them -- the plugin does not write either -- and the reader
 * writes each one for every layer or for none (`muted` is null throughout when
 * the director state was unreadable). So the question is asked of the capture,
 * not of each layer, and a flag is compared only when both captures recorded
 * it. Comparing a plugin capture's absent flag against a .d3's `true` would
 * report every layer in the show as changed -- the census mistake again.
 */
function layerFlags(snap) {
  var known = { enabled: false, muted: false };
  (snap.tracks || []).forEach(function (t) {
    (t.layers || []).forEach(function (l) {
      if (typeof l.enabled === 'boolean') known.enabled = true;
      if (typeof l.muted === 'boolean') known.muted = true;
    });
  });
  return known;
}

/* `index`, when given, collects every layer node this track produced under the
 * layer's id and its groupPath + name, so the keyframe diff can hang its
 * parameters on the row that already speaks for that layer rather than
 * printing the layer twice. Kept beside the nodes, never on them: the nodes are
 * what the export writes out. */
function indexLayer(index, l, node) {
  if (!index) return;
  if (typeof l.id === 'string' && l.id !== '') index.byId[l.id] = node;
  var k = layerKey(l);
  index.byKey[k] = k in index.byKey ? null : node;
}

function diffLayers(trackA, trackB, flags, index) {
  var useIds = layersHaveIds(trackA.layers) && layersHaveIds(trackB.layers);
  var m = matchBy(trackA.layers, trackB.layers, useIds ? layerIdKey : layerKey);
  var labelA = layerLabeller(trackA.layers), labelB = layerLabeller(trackB.layers);
  var nodes = [];
  m.added.forEach(function (l) {
    var n = { kind: 'added', entity: 'layer', label: 'layer ' + labelB(l), detail: l.type };
    indexLayer(index, l, n);
    nodes.push(n);
  });
  m.removed.forEach(function (l) {
    var n = { kind: 'removed', entity: 'layer', label: 'layer ' + labelA(l), detail: l.type };
    indexLayer(index, l, n);
    nodes.push(n);
  });
  m.common.forEach(function (p) {
    var ch = fieldChanges(p.a, p.b, LAYER_FIELDS);
    // groupPath is the other half of the fallback key, and it has the same blind
    // spot `name` does: keyed by id, a layer dragged into another group matches
    // and would report nothing. Compared whole, the way cue tags are, because it
    // is a list and a partial move is not a thing.
    var ga = (p.a.groupPath || []).join(' / '), gb = (p.b.groupPath || []).join(' / ');
    if (ga !== gb) {
      ch.push({ field: 'group', from: showWhitespace(ga), to: showWhitespace(gb) });
    }
    // Words rather than booleans: the page prints a boolean as yes/no, and
    // "disabled no -> yes" makes the reader translate a double negative.
    if (flags && flags.enabled && p.a.enabled !== p.b.enabled) {
      ch.push({ field: 'state', from: p.a.enabled ? 'enabled' : 'disabled',
                to: p.b.enabled ? 'enabled' : 'disabled' });
    }
    if (flags && flags.muted && p.a.muted !== p.b.muted) {
      ch.push({ field: 'mute', from: p.a.muted ? 'muted' : 'unmuted',
                to: p.b.muted ? 'muted' : 'unmuted' });
    }
    var kids = diffMedia(p.a, p.b);
    if (ch.length || kids.length) {
      var n = { kind: 'changed', entity: 'layer', label: 'layer ' + labelB(p.b),
                changes: ch, children: kids };
      indexLayer(index, p.b, n);
      nodes.push(n);
    }
  });
  return nodes;
}

function diffCues(trackA, trackB) {
  var m = matchCues(trackA.cues, trackB.cues);
  var nodes = [];
  function cueLabel(c) {
    return 'cue @ beat ' + fmt(c.beat) +
           (c.note ? ' "' + showWhitespace(c.note) + '"' : '');
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
function diffTracks(snapA, snapB, flags) {
  var showA = showfileTracks(snapA), showB = showfileTracks(snapB);
  var m = matchBy(snapA.tracks, snapB.tracks, function (t) { return t.id; });
  var nodes = [], membership = { added: 0, removed: 0 };
  // Track nodes by id and, per track, its layer nodes -- see indexLayer.
  var byId = Object.create(null), layerIndex = Object.create(null);
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
    var n = { kind: 'added', entity: 'track', label: 'track ' + showWhitespace(t.id),
              detail: showWhitespace(trackDetail(t)) };
    byId[String(t.id)] = n;
    nodes.push(n);
  });
  m.removed.forEach(function (t) {
    if (!(showB.known && !showB.set[String(t.id)])) { membership.removed++; return; }
    var n = { kind: 'removed', entity: 'track', label: 'track ' + showWhitespace(t.id),
              detail: showWhitespace(trackDetail(t)) };
    byId[String(t.id)] = n;
    nodes.push(n);
  });
  m.common.forEach(function (p) {
    var ch = fieldChanges(p.a, p.b, TRACK_FIELDS);
    var index = layerIndex[String(p.b.id)] = { byId: Object.create(null), byKey: Object.create(null) };
    var kids = diffCues(p.a, p.b).concat(diffLayers(p.a, p.b, flags, index));
    if (ch.length || kids.length) {
      var n = { kind: 'changed', entity: 'track', label: 'track ' + showWhitespace(p.b.id),
                detail: p.b.trashed ? 'in the trash' : null,
                changes: ch, children: kids };
      byId[String(p.b.id)] = n;
      nodes.push(n);
    }
  });
  return { nodes: nodes, membership: membership, showA: showA, showB: showB,
           byId: byId, layerIndex: layerIndex };
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
  m.added.forEach(function (t) {
    nodes.push({ kind: 'added', entity: 'transport',
                 label: 'transport ' + showWhitespace(t.name) });
  });
  m.removed.forEach(function (t) {
    nodes.push({ kind: 'removed', entity: 'transport',
                 label: 'transport ' + showWhitespace(t.name) });
  });
  m.common.forEach(function (p) {
    var ch = fieldChanges(p.a, p.b, TRANSPORT_FIELDS);
    // The running order of a setlist is showfile state: a reordered show is a
    // real change even when every track in it is untouched. It rides on the
    // node as `order` rather than as a field change, because it is a list and
    // the page renders it as one.
    var order = orderDiff(p.a.trackRefs, p.b.trackRefs);
    if (ch.length || order.counts.changed) {
      nodes.push({ kind: 'changed', entity: 'transport',
                   label: 'transport ' + showWhitespace(p.b.name),
                   changes: ch, order: order.counts.changed ? order : null });
    }
  });
  return nodes;
}

/* Top level. Returns {meta, nodes, counts, notes}.
 *
 * `keys` is optional: {a, b}, the extractor's keyframes document for each side
 * or null. Keyframes travel beside a snapshot rather than inside one, so they
 * are handed in separately; see diffKeyframes. */
function diffSnapshots(snapA, snapB, keys) {
  var nodes = [];

  var top = fieldChanges(snapA, snapB, SNAPSHOT_FIELDS);

  // The build and the switches ride on the snapshot node -- see buildChanges.
  var project = optionChanges(snapA, snapB, 'project');
  var machine = optionChanges(snapA, snapB, 'machine');
  top = top.concat(buildChanges(snapA, snapB), project.changes, machine.changes);

  if (top.length) nodes.push({ kind: 'changed', entity: 'snapshot', label: 'snapshot', changes: top });

  var flagsA = layerFlags(snapA), flagsB = layerFlags(snapB);
  var flags = { enabled: flagsA.enabled && flagsB.enabled, muted: flagsA.muted && flagsB.muted };
  var tracks = diffTracks(snapA, snapB, flags);
  nodes = nodes.concat(diffTransports(snapA, snapB));
  nodes = nodes.concat(tracks.nodes);

  // Say out loud what was held back, and why. A silently smaller tally is worse
  // than a noisy one: it reads as "nothing happened to the tracks" when what
  // actually happened is that the capture cannot tell.
  var notes = [];
  if (project.note) notes.push(project.note);
  if (machine.note) notes.push(machine.note);
  function noCensus(which, snap) {
    var why = snap.showfile && snap.showfile.error
      ? 'could not read the automatic setlist (' + snap.showfile.error + ')'
      : 'carries no census of the showfile';
    return ' The ' + which + ' capture ' + why + ', which is the only thing ' +
           'that lists every track in the show, so this pair cannot tell a ' +
           'showfile edit from a setlist edit.';
  }
  // Only when one side recorded the flags. Two plugin captures never do, and a
  // note on every such pair would be noise about a design decision, not news.
  [['enabled', 'disabled'], ['muted', 'muted']].forEach(function (f) {
    if (flagsA[f[0]] === flagsB[f[0]]) return;
    notes.push('The ' + (flagsA[f[0]] ? 'After' : 'Before') + ' capture did not record which ' +
               'layers are ' + f[1] + ' (only a .d3 does), so a change to that between ' +
               'these two captures cannot be reported.');
  });
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

  if (keys) {
    var kf = diffKeyframes(snapA, snapB, keys.a, keys.b, tracks);
    nodes = nodes.concat(kf.nodes);
    notes = notes.concat(kf.notes);
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
var ENTITY_ORDER = ['snapshot', 'transport', 'track', 'layer', 'cue', 'media', 'parameter', 'cdl'];

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
      // A parameter's key lines count once for the same reason: re-timing one
      // fade is one edit, however many keys it took.
      if (n.keys) {
        var kk = e + ' keys';
        if (!byField[kk]) byField[kk] = { entity: e, field: 'keys', count: 0 };
        byField[kk].count++;
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

/* The whole diff as one self-describing document, for a reader that is not
 * this page -- a script, or a model asked to explain what changed.
 *
 * The tree goes out whole and unfiltered, whatever the search box says: an
 * export that quietly honoured a forgotten query would hand someone half a
 * diff labelled as all of it.
 *
 * `about` carries the reading rules because the tree on its own misleads in
 * exactly the places this engine took a day to get right. A reader who is not
 * told that a setlist drop is not a deletion, or that a missing `from` is a
 * default rather than a null, will re-derive the wrong answer from correct
 * data. The notes ride along for the same reason the page shows them.
 *
 * `sources` is the caller's {a, b} file names; `generatedAt` is passed in so
 * the engine stays deterministic and the self-test can compare two runs.
 */
var EXPORT_FORMAT = 'd3-snapshot-diff/1';

var EXPORT_ABOUT = [
  'Semantic diff of two susan_summary captures of a disguise d3 showfile: before (A) and after (B).',
  'Each node in `changes` is {kind, entity, label, detail?, changes?, order?, children?}. kind is added (only in after), removed (only in before) or changed (in both, with differing fields). Unchanged entities are omitted.',
  'Nodes nest: a changed track holds its changed cues and layers; a changed layer holds its changed media. `counts` tallies every node at every depth.',
  'Entities are matched by identity, never by position: tracks by id, layers by v7 id when both captures carry one on every layer (otherwise group path + name), media by path, cues by beat within 0.005 beats.',
  'A field change is {field, from, to}. A missing `from` or `to` means that capture did not record the field -- for an option switch, it was at its default. That is not the same as null, which is a recorded empty value.',
  'Cue `tags` changes carry from/to as JSON strings of the whole tag list.',
  'Track added/removed means the showfile itself changed. A track that merely joined or left a setlist is reported as a running-order line on its transport instead, and `notes` says how many were held back that way.',
  'A transport `order` is a line diff of its setlist: entries are {kind: same|moved|added|removed, id: track id, a: 0-based position in before or null, b: 0-based position in after or null}.',
  'Labels mark whitespace a browser would swallow: a trailing space, a doubled space or an embedded newline shows as a visible symbol (␣ space, ⇥ tab, ⏎ newline, or a \\uXXXX codepoint for any other invisible). Field values stay raw, except a layer `group` change, which is marked like a label. Two labels differing only by such a mark are genuinely different entities.',
  'The snapshot node carries environment changes: the Designer build (`d3 build`) and project or machine option switches.',
  'A layer `state` change is enabled/disabled and a `mute` change is muted/unmuted. Only a capture read from a .d3 records either flag, so they are compared only when both captures recorded them, and `notes` says when one side did not.',
  'A `parameter` node is a layer parameter whose keyframes or set value changed, nested under its layer; it is present only when both sides had keyframes from a .d3 or an extractor _keyframes.json. Its `keys` block lists changed keys as {kind: moved|changed|added|removed, a, b}, each side {t, value, interpolation} with t in track seconds and choice values raw (their names are in that node `options` list); a `set value` change (a parameter set once and left) is already written by name, and `the default` means the file left the parameter out because it sat at its default. Keys are compared relative to the layer start when that explains more of them, so a moved layer reports its tStart, not every key; a `cdl` node is a CDL whose own values changed. `notes` says when a category (keyframes, set values, CDLs) could not be compared.',
  '`summary` is the same roll-up the page shows: per-entity tallies, the most-changed fields, and top-level nodes ranked by how much sits beneath them.'
];

function exportDiff(result, snapA, snapB, sources, generatedAt) {
  sources = sources || {};
  function side(snap, file) {
    var b = snap.system && snap.system.build;
    return { file: file || null, project: snap.project || null,
             capturedAt: snap.capturedAt || null,
             schemaVersion: snap.schemaVersion,
             build: (b && b.version) || null };
  }
  return {
    format: EXPORT_FORMAT,
    generatedAt: generatedAt || null,
    about: EXPORT_ABOUT,
    before: side(snapA, sources.a),
    after: side(snapB, sources.b),
    counts: result.counts,
    notes: result.notes || [],
    summary: summarize(result),
    changes: result.nodes
  };
}

/* One capture's media: every track it holds, and what each one loads, in the
 * order it plays. Nothing here is a comparison -- it answers "what is
 * programmed", which the diff deliberately never says.
 *
 * Returns {tracks:[{id, name, lengthInSec, bpm, trashed, items:[…]}],
 *          totals:{tracks, media, disabled, muted, stateKnown}}.
 *
 * `enabled` and `muted` come only from a .d3 -- the plugin does not write them --
 * so on a plugin capture both are null, `stateKnown` is false, and the counts
 * are 0 rather than claiming a show with nothing disabled. They are per media
 * row, the same unit as `media`, so the counts answer "how much of what is
 * loaded will not play".
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
        // Names and paths are marked here for the same reason diff labels are:
        // the page prints them and HTML eats a trailing space, so a clip named
        // with one is indistinguishable from the clip without. Nothing in this
        // report matches on them -- it compares nothing -- so there is no
        // identity to protect, only a tie-break sort, and a mark is as stable
        // between runs as the character it stands for.
        out.push({
          layer: showWhitespace(l.name),
          group: (l.groupPath || []).map(function (g) { return showWhitespace(g); }),
          type: l.type,
          renderEnable: l.renderEnable,
          enabled: nul(l.enabled), muted: nul(l.muted),
          tStart: nul(l.tStart), tEnd: nul(l.tEnd),
          name: showWhitespace(md.name), path: showWhitespace(md.path),
          version: md.version,
          hasAudio: md.hasAudio, regionSet: md.regionSet
        });
      });
    });
    return out.sort(byTime);
  }

  // `tracks` order is kept as the capture wrote it -- the plugin sorts by id, so
  // the report reads alphabetically and a track sits in the same place between
  // captures. There is no running order to preserve once setlists are out of it.
  var totals = { tracks: 0, media: 0, disabled: 0, muted: 0, stateKnown: false };
  var tracks = (snap.tracks || []).map(function (t) {
    var items = itemsOf(t);
    totals.tracks++;
    totals.media += items.length;
    items.forEach(function (it) {
      if (it.enabled !== null || it.muted !== null) totals.stateKnown = true;
      if (it.enabled === false) totals.disabled++;
      if (it.muted === true) totals.muted++;
    });
    // `id` keeps the raw string -- it is the track's identity and the page
    // keys rows on it. Only `name`, which is what a reader looks at, is marked.
    return { id: String(t.id), name: showWhitespace(t.name || String(t.id)),
             lengthInSec: nul(t.lengthInSec), bpm: nul(t.bpm),
             trashed: !!t.trashed, items: items };
  });

  return { tracks: tracks, totals: totals };
}

/* Every cue tag and note in one capture, by track and in playing order. A
 * sibling of mediaReport, flat for the same reason: what a cue says does not
 * depend on which setlist plays the track, so listing it once per transport
 * would repeat it without adding anything.
 *
 * Returns {tracks:[{id, name, lengthInSec, bpm, trashed, items:[CUE], bare}],
 *          totals:{tracks, cues, notes, tags, bare}}
 * where CUE = {beat, t, timecode, section, isSection, note, tags:[{type, text}]}.
 *
 * A cue carrying neither a tag nor a note is left out and counted in `bare`
 * instead. It is a position with nothing written on it, and a quarter of the
 * reference show's cues are that; listing them would bury the ones that say
 * something. Counting them keeps the omission visible, so a track that reads
 * empty is not mistaken for a track with no cues.
 */
function cueReport(snap) {
  snap = snap || {};

  function nul(v) { return v === undefined ? null : v; }

  // A null beat has no place on the timeline, so it goes last, as an unplaced
  // layer does in the media report. `t` breaks ties so two cues on one beat keep
  // a stable order between runs.
  function place(c) { return c.beat === null ? Infinity : c.beat; }
  function byPlace(x, y) {
    return place(x) - place(y) || (x.t === null ? 0 : x.t) - (y.t === null ? 0 : y.t);
  }

  var totals = { tracks: 0, cues: 0, notes: 0, tags: 0, bare: 0 };
  var tracks = (snap.tracks || []).map(function (t) {
    var items = [], bare = 0;
    (t.cues || []).forEach(function (c) {
      var tags = (c.tags || []).map(function (g) {
        // Marked like layer names: tag text is typed in Designer and printed
        // here, and a trailing space would otherwise vanish on the page.
        return { type: nul(g.type), text: showWhitespace(g.text === null || g.text === undefined
                                                         ? '' : String(g.text)) };
      });
      // An empty note is Designer's "no note", not a note of nothing.
      var note = c.note === null || c.note === undefined || c.note === ''
        ? null : showWhitespace(String(c.note));
      if (!tags.length && note === null) { bare++; return; }
      if (note !== null) totals.notes++;
      totals.tags += tags.length;
      items.push({ beat: nul(c.beat), t: nul(c.t), timecode: nul(c.timecode),
                   section: nul(c.section), isSection: !!c.isSection,
                   note: note, tags: tags });
    });
    items.sort(byPlace);
    totals.tracks++;
    totals.cues += items.length;
    totals.bare += bare;
    // `id` raw, `name` marked -- the same split as mediaReport, for the same
    // reason: the page keys rows on the id.
    return { id: String(t.id), name: showWhitespace(t.name || String(t.id)),
             lengthInSec: nul(t.lengthInSec), bpm: nul(t.bpm),
             trashed: !!t.trashed, items: items, bare: bare };
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
        return { id: id, name: showWhitespace(id), lengthInSec: null, bpm: null,
                 trashed: false, missing: true };
      }
      return { id: id, name: showWhitespace(t.name || id), lengthInSec: nul(t.lengthInSec),
               bpm: nul(t.bpm), trashed: !!t.trashed, missing: false };
    });
    totals.transports++;
    totals.tracks += tracks.length;
    return { name: showWhitespace(tr.name), setlist: showWhitespace(tr.setlist),
             error: nul(tr.error),
             trackCount: tracks.length, missingCount: missingCount,
             tracks: tracks };
  });

  return { transports: transports, totals: totals };
}

/* The environment a capture was read in: the Designer build and the option
 * switches. Single-snapshot, like the two reports above -- it describes one
 * capture, not a comparison.
 *
 * Returns {
 *   build: {version, error, fields:[{k,v}], flags:[string]} | null,
 *   project: SCOPE, machine: SCOPE,
 *   totals: {set, recorded}
 * } where SCOPE is
 *   {unread, source, error, set:[ROW], all:[ROW]}, ROW = {name, value, isDefault}.
 *
 * Two rules the plugin already enforces and the report must not undo:
 *   - `unread` (values === null) is "could not read the file", NOT an empty set.
 *     Merging the two would let a diff or a reader conclude no switches are set
 *     when the truth is unknown.
 *   - a switch is "set" only when its value is not "0"/"": the file records
 *     defaults too, so most of a project's ~125 sit at 0 and are noise until
 *     someone asks for all of them.
 */
function systemReport(snap) {
  snap = snap || {};
  var sys = snap.system || {};

  var build = null;
  var b = sys.build;
  if (b) {
    var fields = [];
    // Curated and ordered; nulls dropped. The version is the headline and is
    // kept separate, so it is not repeated here.
    [['releaseType', 'licence'], ['phase', 'phase'], ['branch', 'branch'],
     ['buildId', 'build id'], ['customRelease', 'custom release'],
     ['platform', 'platform'], ['osImage', 'OS image'],
     ['renderStream', 'RenderStream']].forEach(function (f) {
      var v = b[f[0]];
      if (v !== null && v !== undefined && v !== '') fields.push({ k: f[1], v: String(v) });
    });
    // Only the true flags: a false `beta` is noise, and the point of the row is
    // to make the unusual state stand out. `custom` is omitted because the
    // custom-release name already carries it.
    var flags = [];
    [['starter', 'Starter'], ['beta', 'beta'], ['rc', 'release candidate'],
     ['debugBuild', 'debug'], ['localPatches', 'local patches']].forEach(function (f) {
      if (b[f[0]]) flags.push(f[1]);
    });
    build = { version: b.version || null, error: b.error || null,
              fields: fields, flags: flags };
  }

  function scope(o) {
    o = o || {};
    if (o.values === null || o.values === undefined) {
      return { unread: true, source: o.source || null, error: o.error || null,
               set: [], all: [] };
    }
    var names = [], all = [], set = [];
    for (var k in o.values) names.push(k);
    names.sort();
    names.forEach(function (name) {
      var v = String(o.values[name]);
      var isDefault = v === '0' || v === '';
      var row = { name: name, value: v, isDefault: isDefault };
      all.push(row);
      if (!isDefault) set.push(row);
    });
    return { unread: false, source: o.source || null, error: null,
             set: set, all: all };
  }

  var opts = sys.options || {};
  var project = scope(opts.project);
  var machine = scope(opts.machine);

  return {
    build: build, project: project, machine: machine,
    totals: { set: project.set.length + machine.set.length,
              recorded: project.all.length + machine.all.length }
  };
}

/* Keyframes ----------------------------------------------------------------
 * One show's layer animation, read from the extractor's keyframes document
 * (`"format": "d3_keyframes"`), with the snapshot beside it for what the
 * keyframes file does not carry: cue markers, timecode and track length.
 *
 * Returns {columns:[{family, fields, keys}], tracks:[…], allTracks:[…], cdls:[…],
 *          totals:{tracks, layers, fields, keys, cdls, cdlLayers, statics},
 *          staticsKnown, notes:[…]},
 * or null when the document is not a keyframes file.
 *
 * Set values. From format 4 the extractor also writes `static` fields: one key,
 * no expression, not a CDL, at a value other than the default -- a parameter
 * that was set and left, which is a setting rather than animation. They are
 * split off onto `layer.statics` ({name, display, label, family, valueType,
 * value, default}) and kept out of everything else: the grid, its columns, the
 * timeline, the tally and the track span read exactly as they would without
 * them, since a one-key field moves nothing. `track.layers` keeps only layers
 * with an animated field and `track.setLayers` only layers with a static one;
 * one layer object can sit in both. `tracks` is the tracks with animation, as
 * before, and `allTracks` adds the tracks that hold settings only, in the
 * file's order, for the list's "set values". `staticsKnown` is false on a
 * format 3 file, which never wrote them -- the format, not a zero count, since a
 * format 4 show with nothing set is an answer and a format 3 file is silence.
 *
 * Nothing here compares two captures. The show holds ~5,700 keys on ~2,200
 * parameters, which no single list can show, so the report is shaped for three
 * views of it: a show-wide grid of tracks against kinds of parameter, a
 * timeline of one track, and the CDLs the show uses.
 */

// Grid columns. The show has about a hundred distinct parameter names, most on
// a handful of layers; nine named columns plus "other" keeps a row readable at
// a glance and still names every family that animates more than a few layers.
var KEYFRAME_COLUMNS = 9;
var KEYFRAMES_OTHER = 'other';
var CDL_VALUE_TYPE = 'CDL::RP';

/* Names for parameters that store a choice as a number, so a blend mode reads
 * `Screen` and not `8`. Copied from the option tables in Designer's Python API
 * reference (developer.disguise.one/python-api), never inferred from what a show
 * happens to use: a guessed name is worse than the number, because it looks
 * like an answer.
 *
 * Keyed by layer type, then by parameter name folded to lower case without
 * spaces or underscores -- the archive says `at end point` where the API says
 * `at_end_point`. `*` is for parameters on a shared base class (Module's
 * blendMode, ColourShift's RGB controlled) or documented with one table on every
 * class that has it (at_end_point). A type's own table wins over `*`, because
 * `mode` means a different list on nearly every module.
 *
 * Deliberately absent: `mode` on VariableVideoModule, the commonest video layer.
 * Its reference page lists no options, and VideoModule's table is a different
 * class's -- not its base -- so borrowing it would be the guess this table
 * exists to avoid. */
var OPTION_NAMES = {
  '*': {
    blendmode: ['Over', 'Alpha', 'Add', 'Multiply', 'Mask', 'Multiply-fade', 'Multiply-alpha',
                'Premult-Alpha', 'Screen', 'Overlay', 'Hard Light', 'Soft Light', 'Colour Burn',
                'Darken', 'Lighten', 'Difference', 'Exclusion', 'Colour Dodge', 'Hard Mix',
                'Over-alpha', 'Luma-Matte', 'Inv-Luma-Matte'],
    atendpoint: ['Loop', 'Ping-pong', 'Pause'],
    rgbcontrolled: ['Separate', 'Together']
  },
  BitmapModule: { scalemode: ['Fill and crop', 'Fill and stretch', 'Fit inside', 'Pixel-perfect'] },
  GradientModule: { interpolation: ['Linear', 'SmoothStep'], type: ['Linear', 'Radial'] },
  NoiseModule: { colour: ['Greyscale', 'Colour'], mode: ['Relative', 'Absolute'] },
  RenderStreamModule: { mode: ['Locked', 'Free-run', 'Normal', 'Paused'],
                        customeventtriggermode: ['On keyframe', 'On reset', 'On change'] },
  SceneAnimationModule: { mode: ['Locked', 'Normal'] },
  TextModule: { halignment: ['Left', 'Center', 'Right'], valignment: ['Top', 'Center', 'Bottom'] },
  TimecodeReadoutModule: { display: ['Incoming', 'Timeline', 'MTC Module', 'Section', 'Video',
                                     'TimeDebug', 'OutputDebug', 'System Time'] },
  VideoModule: { mode: ['Locked', 'Free-run', 'Normal'] },
  VideoTriggerModule: { triggermode: ['OnReset', 'OnChange'] }
};

// The option names for one parameter, or null. Only whole-number value types:
// a float that happens to land on 2 is a level, not a choice.
function optionNames(layerType, fieldName, valueType) {
  if (!/^(uint|int|ubyte)$/.test(valueType || '')) return null;
  var key = String(fieldName).toLowerCase().replace(/[\s_]/g, '');
  var own = OPTION_NAMES[layerType];
  if (own && Object.prototype.hasOwnProperty.call(own, key)) return own[key];
  return Object.prototype.hasOwnProperty.call(OPTION_NAMES['*'], key) ? OPTION_NAMES['*'][key] : null;
}

function keyframeFamily(name) {
  // A Notch or RenderStream parameter is named by attribute id, so every exposed
  // control is its own name. Counted apart, 307 of them would each be a column
  // of one; grouped, they are one kind of thing, the block's controls.
  if (String(name).indexOf('::Attributes::') >= 0) return 'Notch';
  // Vector parameters arrive split per component (scale.x, scale.y). The grid
  // asks what kind of thing moves, not along which axis.
  return String(name).split('.')[0];
}

/* ASC CDL, applied the way the spec writes it: slope, offset, clamp, power,
 * then saturation against Rec.709 luma, clamped. Only for a swatch -- Designer
 * grades in its working colour space with OCIO or ACES transforms around the
 * CDL, which the archive does not describe, so this shows the direction of a
 * grade (warmer, darker, flatter), not its exact look on the wall. */
function gradeRgb(cdl, rgb) {
  var out = [0, 0, 0], i, v;
  for (i = 0; i < 3; i++) {
    v = rgb[i] * cdl.slope[i] + cdl.offset[i];
    v = v < 0 ? 0 : (v > 1 ? 1 : v);
    out[i] = Math.pow(v, cdl.power[i]);
  }
  var luma = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
  for (i = 0; i < 3; i++) {
    v = luma + cdl.saturation * (out[i] - luma);
    out[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  return out;
}

function rgbHex(rgb) {
  return '#' + rgb.map(function (v) {
    return ('0' + Math.round(v * 255).toString(16)).slice(-2);
  }).join('');
}

function hsvRgb(h, s, v) {
  var i = Math.floor(h * 6), f = h * 6 - i;
  var p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

var GREY_STOPS = [0, 0.2, 0.4, 0.6, 0.8, 1];
var HUE_STOPS = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1];

/* Two ramps, not one colour. A grey ramp alone shows tint and contrast but can
 * never show saturation, since grey has none; the hue ramp is what makes a
 * saturation of 0.15 visibly drain. `mid` is the graded mid-grey, small enough
 * to fill a timeline segment a few pixels wide. */
function cdlSwatch(cdl) {
  if (!cdl || !cdl.slope || !cdl.power || !cdl.offset || typeof cdl.saturation !== 'number') {
    return null;
  }
  return {
    grey: GREY_STOPS.map(function (g) { return rgbHex(gradeRgb(cdl, [g, g, g])); }),
    hue: HUE_STOPS.map(function (h) { return rgbHex(gradeRgb(cdl, hsvRgb(h, 0.6, 0.75))); }),
    mid: rgbHex(gradeRgb(cdl, [0.45, 0.45, 0.45]))
  };
}

function isIdentityCdl(c) {
  function all(list, v) { return list.every(function (x) { return Math.abs(x - v) < EPSILON; }); }
  return !!c && all(c.slope, 1) && all(c.power, 1) && all(c.offset, 0) &&
         Math.abs(c.saturation - 1) < EPSILON;
}

/* A TC tag's HH:MM:SS:FF as seconds, counted the way the extractor and the
 * plugin count it: the label is a frame count on the nominal rate, and those
 * frames run at the real one (frames / 29.97), so 14:00:02:00 is 50,452.45 s,
 * not 50,402. Reading the label as wall-clock time put a key's timecode 50 s
 * away from the tcStart of the layer it sits on. */
function tcSeconds(text, fps) {
  var parts = String(text || '').replace(/^\s+|\s+$/g, '').split(/[:;.]/);
  if (parts.length !== 4 || !fps) return null;
  for (var i = 0; i < 4; i++) if (!/^\d+$/.test(parts[i])) return null;
  var nominal = Math.round(fps);
  return (((+parts[0]) * 60 + (+parts[1])) * 60 + (+parts[2])) * nominal / fps + (+parts[3]) / fps;
}

/* Timecode at `t` track seconds, counted on from the last cue at or before it
 * that carries one -- the same rule the extractor uses for a layer's tcStart,
 * so a key and the layer it sits on read on one clock. Null before the first
 * timecode, where the track has none. */
function timecodeAt(track, t) {
  if (!track || !track.anchors || !track.anchors.length || !track.fps || t === null) return null;
  var a = null;
  track.anchors.forEach(function (x) { if (x.t <= t + EPSILON) a = x; });
  if (!a) return null;
  var fps = track.fps, nominal = Math.round(fps);
  var total = a.sec + (t - a.t);
  var sign = total < 0 ? '-' : '';
  total = Math.abs(total);
  var whole = Math.floor(total), frames = Math.round((total - whole) * fps);
  if (frames >= nominal) { frames = 0; whole++; }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  return sign + two(Math.floor(whole / 3600)) + ':' + two(Math.floor(whole % 3600 / 60)) + ':' +
         two(whole % 60) + '.' + two(frames);
}

function keyframeReport(doc, snap) {
  if (!doc || doc.format !== 'd3_keyframes') return null;
  var notes = [];

  // Only a setlist's tracks are in a snapshot; the keyframes file covers the
  // whole show. A track with no snapshot record still draws, just without cue
  // markers or timecode, and says why.
  var snapTracks = {};
  ((snap && snap.tracks) || []).forEach(function (t) { snapTracks[String(t.id)] = t; });
  if (snap && (snap.project !== doc.project || snap.capturedAt !== doc.capturedAt)) {
    notes.push('The keyframes were read from ' + (doc.source || doc.project) + ' (' +
               doc.capturedAt + ') and the cue markers from a snapshot captured ' +
               snap.capturedAt + '. If the show changed in between, markers can sit ' +
               'off their keys.');
  }
  // Format 2 dropped any CDL set with a single key -- 433 of 435 graded layers
  // on the reference show -- so a v2 file's CDL lane is nearly empty, and silence
  // about why would read as "this show is barely graded".
  if ((doc.formatVersion || 0) < 3) {
    notes.push('This keyframes file is format ' + doc.formatVersion + ', which left out a ' +
               'CDL set with a single key: nearly every graded layer. Drop the .d3 itself, ' +
               'or re-export it from the extractor, to see them.');
  }

  var cdlTable = doc.cdls || {};
  var cdlUse = {};

  function numeric(f) {
    var nums = 0, other = 0;
    (f.keys || []).forEach(function (k) {
      if (typeof k.value === 'number') nums++;
      else if (k.value !== null && k.value !== undefined) other++;
    });
    if (typeof f['default'] === 'number') nums++;
    return nums > 0 && other === 0;
  }

  var familyFields = {}, familyKeys = {};
  var totals = { tracks: 0, layers: 0, fields: 0, keys: 0, cdls: 0, cdlLayers: 0, statics: 0 };

  var tracks = (doc.tracks || []).map(function (t) {
    var st = snapTracks[String(t.id)] || null;
    var fps = st && st.fps ? st.fps : null;
    var anchors = [];
    var cues = ((st && st.cues) || []).filter(function (c) {
      return typeof c.t === 'number';
    }).map(function (c) {
      // Anchored on the TC tag's own text, not on the cue's `timecode`: that is
      // already rounded to a frame, and counting on from a rounded anchor put
      // 8 of 873 layers a frame away from the tcStart the extractor wrote.
      var tag = (c.tags || []).filter(function (g) { return g.type === 'tc'; })[0];
      var sec = tag ? tcSeconds(tag.text, fps) : null;
      if (sec !== null) anchors.push({ t: c.t, sec: sec });
      return { t: c.t, isSection: !!c.isSection,
               note: c.note ? showWhitespace(String(c.note)) : null,
               tags: (c.tags || []).map(function (g) {
                 return { type: g.type, text: showWhitespace(String(g.text || '')) };
               }),
               timecode: c.timecode || null };
    });

    // The span to draw is where the layers and keys are, not 0 to the track's
    // length: a show track runs for an hour with its content in a 25-minute
    // stretch, and drawn whole that stretch got under half the width.
    var lo = Infinity, hi = -Infinity;
    var fams = {}, keyCount = 0, fieldCount = 0, cdlLayers = 0;

    var all = (t.layers || []).map(function (l) {
      var refs = [], lkeys = 0;
      // A layer holding settings only is in a format 4 file but draws nothing,
      // so it must not stretch the span the timeline fits to.
      var animated = (l.fields || []).filter(function (f) { return f.static !== true; });
      if (animated.length) {
        if (typeof l.tStart === 'number') lo = Math.min(lo, l.tStart);
        if (typeof l.tEnd === 'number') hi = Math.max(hi, l.tEnd);
      }
      var statics = (l.fields || []).filter(function (f) { return f.static === true; }).map(function (f) {
        var k = (f.keys || [])[0] || {};
        return { name: f.name, display: showWhitespace(f.label || f.name), label: f.label || null,
                 family: keyframeFamily(f.name), valueType: f.valueType || null,
                 options: optionNames(l.type, f.name, f.valueType),
                 value: k.value === undefined ? null : k.value,
                 'default': f['default'] === undefined ? null : f['default'] };
      });
      totals.statics += statics.length;
      var fields = animated.map(function (f) {
        var family = keyframeFamily(f.name);
        var isCdl = f.valueType === CDL_VALUE_TYPE;
        var num = !isCdl && numeric(f);
        var min = null, max = null;
        var keys = (f.keys || []).map(function (k) {
          if (typeof k.t === 'number') { lo = Math.min(lo, k.t); hi = Math.max(hi, k.t); }
          if (num && typeof k.value === 'number') {
            min = min === null ? k.value : Math.min(min, k.value);
            max = max === null ? k.value : Math.max(max, k.value);
          }
          if (isCdl && k.value && refs.indexOf(k.value) < 0) refs.push(k.value);
          return { t: k.t, value: k.value === undefined ? null : k.value,
                   interpolation: k.interpolation || null };
        });
        if (isCdl && typeof f['default'] === 'string' && refs.indexOf(f['default']) < 0) {
          refs.push(f['default']);
        }
        fams[family] = fams[family] || { fields: 0, keys: 0 };
        fams[family].fields++;
        fams[family].keys += keys.length;
        familyFields[family] = (familyFields[family] || 0) + 1;
        familyKeys[family] = (familyKeys[family] || 0) + keys.length;
        lkeys += keys.length;
        return {
          name: f.name,
          // A Notch control's name is an attribute id; its label is the name the
          // block exposes, which is what anyone looking for it would type.
          display: showWhitespace(f.label || f.name),
          label: f.label || null, family: family, valueType: f.valueType || null,
          numeric: num, isCdl: isCdl, expression: f.expression || null,
          options: optionNames(l.type, f.name, f.valueType),
          'default': f['default'] === undefined ? null : f['default'],
          keys: keys, min: min, max: max
        };
      });
      refs.forEach(function (r) {
        cdlUse[r] = cdlUse[r] || { layers: 0, tracks: [] };
        cdlUse[r].layers++;
        if (cdlUse[r].tracks.indexOf(String(t.id)) < 0) cdlUse[r].tracks.push(String(t.id));
      });
      if (refs.length) cdlLayers++;
      keyCount += lkeys;
      fieldCount += fields.length;
      return { id: l.id === undefined ? null : l.id, name: showWhitespace(l.name),
               rawName: l.name, group: (l.groupPath || []).map(showWhitespace),
               type: l.type || null, tStart: typeof l.tStart === 'number' ? l.tStart : null,
               tEnd: typeof l.tEnd === 'number' ? l.tEnd : null,
               notchBlock: l.notchBlock || null, keyCount: lkeys, cdls: refs, fields: fields,
               statics: statics };
    });
    var layers = all.filter(function (l) { return l.fields.length; });
    var setLayers = all.filter(function (l) { return l.statics.length; });

    if (lo === Infinity) {
      lo = 0;
      hi = st && typeof st.lengthInSec === 'number' ? st.lengthInSec : 1;
    }

    if (layers.length) totals.tracks++;
    totals.layers += layers.length;
    totals.fields += fieldCount;
    totals.keys += keyCount;
    totals.cdlLayers += cdlLayers;
    // `id` raw, `name` marked, as in the other reports: the page keys on the id.
    return { id: String(t.id), name: showWhitespace(t.name || String(t.id)),
             bpm: typeof t.bpm === 'number' ? t.bpm : null,
             lengthInSec: st && typeof st.lengthInSec === 'number' ? st.lengthInSec : null,
             start: lo, end: hi > lo ? hi : lo + 1,
             inSnapshot: !!st, trashed: !!(st && st.trashed), fps: fps,
             anchors: anchors, cues: cues, layers: layers, setLayers: setLayers,
             keyCount: keyCount, fieldCount: fieldCount, cdlLayers: cdlLayers, families: fams };
  });

  var allTracks = tracks;
  tracks = allTracks.filter(function (t) { return t.layers.length; });

  // Columns ranked by how many parameters animate, not by key count: one
  // brightness field with 96 keys is one busy fade, while 435 CDL fields is the
  // grade of the whole show. Name breaks ties so the grid is stable between runs.
  var ranked = Object.keys(familyFields).sort(function (a, b) {
    return familyFields[b] - familyFields[a] || (a < b ? -1 : a > b ? 1 : 0);
  });
  var named = ranked.slice(0, KEYFRAME_COLUMNS);
  var rest = ranked.slice(KEYFRAME_COLUMNS);
  var columns = named.map(function (f) {
    return { family: f, fields: familyFields[f], keys: familyKeys[f], members: [f] };
  });
  if (rest.length) {
    columns.push({
      family: KEYFRAMES_OTHER, members: rest,
      fields: rest.reduce(function (s, f) { return s + familyFields[f]; }, 0),
      keys: rest.reduce(function (s, f) { return s + familyKeys[f]; }, 0)
    });
  }
  allTracks.forEach(function (t) {
    t.cells = columns.map(function (c) {
      var cell = { fields: 0, keys: 0 };
      c.members.forEach(function (f) {
        if (t.families[f]) { cell.fields += t.families[f].fields; cell.keys += t.families[f].keys; }
      });
      return cell;
    });
  });

  var cdls = Object.keys(cdlUse).map(function (ref) {
    var c = cdlTable[ref];
    var rec = c ? {
      ref: ref, name: c.name, source: c.source, slope: c.slope, power: c.power,
      offset: c.offset, saturation: c.saturation, error: c.error || null
    } : {
      ref: ref, name: ref.split('/').pop().replace(/\.cc$/, ''),
      source: /^objects\/lutfile\//.test(ref) ? 'ccFile' : 'designer',
      slope: null, power: null, offset: null, saturation: null,
      error: 'values not in this keyframes file'
    };
    rec.swatch = rec.error ? null : cdlSwatch(rec);
    rec.identity = !rec.error && isIdentityCdl(rec);
    rec.layers = cdlUse[ref].layers;
    rec.tracks = cdlUse[ref].tracks;
    return rec;
  }).sort(function (a, b) {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : (a.ref < b.ref ? -1 : 1);
  });
  totals.cdls = cdls.length;

  return { project: doc.project || null, capturedAt: doc.capturedAt || null,
           source: doc.source || null, formatVersion: doc.formatVersion || null,
           columns: columns, tracks: tracks, allTracks: allTracks, cdls: cdls, totals: totals,
           staticsKnown: (doc.formatVersion || 0) >= 4, notes: notes };
}

/* Keyframe changes -----------------------------------------------------------
 * What programming changed between two keyframes documents: a key moved, a
 * value or interpolation changed, a key added or removed, an expression edited,
 * a set value changed, a CDL's own values changed. Parameters nest under the
 * layer and track they belong to, on the row the snapshot diff already drew
 * when there is one, so a layer reads once whatever changed on it.
 */

// Key identity, like a cue's, is proximity in time, and the number comes from
// the corpus. Key times are f64 and survive a save exactly; what moves them is
// the extractor rounding `t` and `tStart` to six places, so measured relative to
// the layer a key drifts by up to 1.0000008e-6 s -- just past EPSILON, which is
// why EPSILON cannot be used. Across the Sep 21 and Sep 26 saves of the
// reference show, 3,306 keys on 633 shared layers drifted by no more than that.
// 1e-5 is ten times it, and nine times below the tightest real spacing between
// two keys of one parameter (8.9e-5 s on a brightness fade in 360_pyramid), so
// the greedy merge below never has two candidates in range. Two keys sharing a
// time exactly (two in the reference show, a hard cut) pair in file order.
var KEY_TOLERANCE = 1e-5;

// A parameter with more changed keys than this opens folded on the page; the
// node's detail line says what is inside.
var KEY_FOLD = 12;

function keyFormat(doc) { return (doc && doc.formatVersion) || 0; }

// A choice reads by name, the number kept beside it -- the Keyframes tab's rule.
function valueText(v, opts) {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'number' && opts && opts[v] !== undefined) return opts[v] + ' (' + fmt(v) + ')';
  return v;
}

function keySide(k) {
  return { t: typeof k.t === 'number' ? k.t : null,
           value: k.value === undefined ? null : k.value,
           interpolation: k.interpolation || null };
}

/* Line-diff one parameter's keys -> {entries, counts}.
 *
 * Keys are placed at `t - off`, where `off` is the layer's start or 0 -- see
 * diffLayerKeys for which. A proximity merge pairs keys that did not move;
 * then, between two keys that stayed put, the keys that left and the keys that
 * arrived pair in order as one moved key each. A key dragged along the timeline
 * without passing a neighbour is one `moved` line, not a remove far from an add.
 * Pairing across a stationary key is refused, because that is no longer a drag
 * the keys can vouch for.
 */
function keyEntries(keysA, keysB, offA, offB) {
  function placed(list, off) {
    return (list || []).map(function (k, i) {
      return { k: k, at: (typeof k.t === 'number' ? k.t : 0) - off, i: i };
    }).sort(function (x, y) { return x.at - y.at || x.i - y.i; });
  }
  var a = placed(keysA, offA), b = placed(keysB, offB);
  var out = [], run = [], i = 0, j = 0, gap;

  function pair(x, y) {
    var ka = keySide(x.k), kb = keySide(y.k);
    var still = Math.abs(y.at - x.at) <= KEY_TOLERANCE;
    var edited = !sameValue(ka.value, kb.value) || ka.interpolation !== kb.interpolation;
    if (still && !edited) return;
    out.push({ kind: edited ? 'changed' : 'moved', a: ka, b: kb, at: y.at, d: y.at - x.at });
  }
  function flush() {
    var gone = run.filter(function (x) { return x.a; }), come = run.filter(function (x) { return x.b; });
    var n = Math.min(gone.length, come.length), k;
    for (k = 0; k < n; k++) pair(gone[k].a, come[k].b);
    for (k = n; k < gone.length; k++) out.push({ kind: 'removed', a: keySide(gone[k].a.k), b: null, at: gone[k].a.at });
    for (k = n; k < come.length; k++) out.push({ kind: 'added', a: null, b: keySide(come[k].b.k), at: come[k].b.at });
    run = [];
  }
  while (i < a.length && j < b.length) {
    gap = b[j].at - a[i].at;
    if (Math.abs(gap) <= KEY_TOLERANCE) { flush(); pair(a[i], b[j]); i++; j++; }
    else if (gap > 0) run.push({ a: a[i++] });
    else run.push({ b: b[j++] });
  }
  while (i < a.length) run.push({ a: a[i++] });
  while (j < b.length) run.push({ b: b[j++] });
  flush();

  out.sort(function (x, y) { return x.at - y.at; });
  var counts = { a: a.length, b: b.length, moved: 0, changed: 0, added: 0, removed: 0 };
  // The shift is measured on the same basis the keys were paired on. Taken from
  // the stored times instead, keys that rode a moved layer and then moved again
  // read as the sum of both: a key slid 240 s on a layer that also moved 240 s
  // said "moved by +480 s", double what anyone did to it.
  var shift = out.length > 1 && out.every(function (e) {
    return e.kind === 'moved' && Math.abs(e.d - out[0].d) <= KEY_TOLERANCE;
  }) ? out[0].d : null;
  out.forEach(function (e) { counts[e.kind]++; delete e.at; delete e.d; });
  counts.total = out.length;
  return { entries: out, counts: counts, shift: shift, onLayer: !!(offA || offB) };
}

/* "3 of 12 keys moved by +2.000 s" when one shift explains every line -- the
 * common case of a fade slid along as a whole -- otherwise the tally by kind. */
function keySummary(keys) {
  var c = keys.counts;
  var head = c.a === c.b ? plural(c.b, 'key') : c.a + ' → ' + plural(c.b, 'key');
  if (keys.shift !== null) {
    var d = keys.shift;
    return head + ' · ' + (c.total === c.b ? 'all' : c.total) + ' moved by ' +
           (d > 0 ? '+' : '') + fmt(d) + ' s' + (keys.onLayer ? ' on the layer' : '');
  }
  var bits = [];
  if (c.moved) bits.push(c.moved + ' moved');
  if (c.changed) bits.push(c.changed + ' changed');
  if (c.added) bits.push(c.added + ' added');
  if (c.removed) bits.push(c.removed + ' removed');
  return head + ' · ' + bits.join(', ');
}

/* One parameter on one layer -> a node, or null when nothing changed.
 *
 * A set value (`static`, format 4) is one key someone set and left, so only its
 * value is compared -- its key sits wherever the layer starts, and a layer moved
 * along the timeline has not changed its blend mode. A format 4 file leaves a
 * parameter out when it sits at its default, so a set value present on one side
 * only went to or came from the default, and says so; it is not an addition.
 */
function diffParameter(fa, fb, offA, offB, layerType) {
  var f = fb || fa;
  var opts = optionNames(layerType, f.name, f.valueType);
  var node = { kind: 'changed', entity: 'parameter',
               label: 'parameter ' + showWhitespace(f.label || f.name), changes: [] };
  if (opts) node.options = opts;
  function setValue(x) { return valueText(((x.keys || [])[0] || {}).value, opts); }
  function atDefault(x) {
    var d = x['default'];
    return (d === null || d === undefined ? '' : valueText(d, opts) + ', ') + 'the default';
  }
  function animated(x) {
    return 'animated, ' + plural((x.keys || []).length, 'key') + (x.expression ? ' + expression' : '');
  }

  if (!fa || !fb) {
    if (f.static === true) {
      node.changes.push({ field: 'set value', from: fa ? setValue(fa) : atDefault(fb),
                          to: fb ? setValue(fb) : atDefault(fa) });
      return node;
    }
    node.kind = fa ? 'removed' : 'added';
    node.detail = plural((f.keys || []).length, 'key') + (f.expression ? ' · expression' : '');
    return node;
  }

  if (fa.static === true || fb.static === true) {
    if (fa.static === true && fb.static === true) {
      var va = ((fa.keys || [])[0] || {}).value, vb = ((fb.keys || [])[0] || {}).value;
      if (sameValue(va, vb)) return null;
    }
    node.changes.push({ field: 'set value', from: fa.static === true ? setValue(fa) : animated(fa),
                        to: fb.static === true ? setValue(fb) : animated(fb) });
    return node;
  }

  if ((fa.expression || null) !== (fb.expression || null)) {
    node.changes.push({ field: 'expression', from: fa.expression || null, to: fb.expression || null });
  }
  var keys = keyEntries(fa.keys, fb.keys, offA, offB);
  if (keys.counts.total) {
    node.keys = keys;
    node.detail = keySummary(keys);
  }
  return node.changes.length || node.keys ? node : null;
}

/* One layer's parameters -> {nodes, lines}; `lines` is how many key lines and
 * field changes they print, the measure diffLayerKeys picks a time basis by.
 *
 * `keep` filters out the categories this pair cannot compare. */
function layerKeyNodes(la, lb, offA, offB, keep) {
  var fa = ((la && la.fields) || []).filter(keep), fb = ((lb && lb.fields) || []).filter(keep);
  // Fields are a list, not a map: a layer can carry two fields of one name
  // (two `dither` on a gradient in the reference show), and matchBy pairs those
  // in order rather than comparing both against the last.
  var m = matchBy(fa, fb, function (f) { return String(f.name); });
  var type = (lb || la).type, nodes = [], lines = 0;
  function add(n) {
    if (!n) return;
    nodes.push(n);
    lines += (n.keys ? n.keys.counts.total : 0) + n.changes.length + (n.kind === 'changed' ? 0 : 1);
  }
  m.common.forEach(function (p) { add(diffParameter(p.a, p.b, offA, offB, type)); });
  m.added.forEach(function (f) { add(diffParameter(null, f, offA, offB, type)); });
  m.removed.forEach(function (f) { add(diffParameter(f, null, offA, offB, type)); });
  return { nodes: nodes, lines: lines };
}

/* Key times are track seconds, and a layer dragged along the timeline takes its
 * keys with it. Compared as they stand, that one drag reports every key on the
 * layer as moved; the layer's tStart change already says it, once. So a layer
 * whose start moved is compared both ways -- keys measured from the layer's
 * start, and keys as they stand -- and whichever explains more of them wins.
 * Both happen: across the reference show's Sep 21 and Sep 26 saves, 425 keys on
 * moved layers followed their layer and 54 stayed where they were, which is a
 * layer trimmed at its head with the animation left in place. Choosing one rule
 * for all layers would misreport whichever kind it did not pick, key by key.
 */
function diffLayerKeys(la, lb, keep) {
  var sa = la && typeof la.tStart === 'number' ? la.tStart : null;
  var sb = lb && typeof lb.tStart === 'number' ? lb.tStart : null;
  var still = layerKeyNodes(la, lb, 0, 0, keep);
  if (sa === null || sb === null || Math.abs(sa - sb) <= KEY_TOLERANCE) return still.nodes;
  var along = layerKeyNodes(la, lb, sa, sb, keep);
  return along.lines <= still.lines ? along.nodes : still.nodes;
}

/* The two keyframes documents against each other, merged into the snapshot
 * diff's tree. Returns {nodes, notes}: `nodes` are the track nodes this had to
 * create plus any CDL nodes; parameters on a track or layer the snapshot diff
 * already reported are hung on that node in place.
 *
 * What a file cannot say is skipped rather than guessed, and `notes` says so.
 * A side with no keyframes at all is a plugin capture, not a show without
 * animation -- the census mistake once more, which would report every parameter
 * in the show as added. A format 2 file left out any CDL set with one key, which
 * is nearly every graded layer, so CDLs are only compared when both files are
 * format 3 or later; a file older than format 4 never wrote set values, so they
 * need format 4 on both sides. Two files of the same old format say nothing:
 * both lack the category, so nothing in the pair is being withheld.
 *
 * A layer whose keyframes are on one side only is compared against nothing only
 * when the other side's snapshot shows the layer still exists. The file lists
 * only layers with animation or a set value, so absence alone could mean the
 * layer went or that it is now at its defaults, and the first is the snapshot
 * diff's news to tell. Tracks off every setlist are in the keyframes files but
 * not in the snapshot, so a layer appearing on one of those is not reported --
 * the snapshot diff has the same blind spot there, and claiming an addition the
 * snapshot cannot confirm would be worse than saying nothing.
 */
function diffKeyframes(snapA, snapB, docA, docB, tracks) {
  if (docA && docA.format !== 'd3_keyframes') docA = null;
  if (docB && docB.format !== 'd3_keyframes') docB = null;
  var notes = [], out = [];
  if (!docA || !docB) {
    if (docA || docB) {
      notes.push('Only the ' + (docA ? 'Before' : 'After') + ' file carries keyframes (a .d3 or ' +
                 'an extractor _keyframes.json does; a snapshot .json does not), so changes to ' +
                 'animation, set values and CDLs between these two cannot be reported.');
    }
    return { nodes: out, notes: notes };
  }

  var fa = keyFormat(docA), fb = keyFormat(docB), low = Math.min(fa, fb);
  function older() { return fa < fb ? 'Before' : 'After'; }
  var cdlOk = low >= 3 || fa === fb, staticOk = low >= 4;
  if (!cdlOk) {
    notes.push('The ' + older() + ' keyframes are format ' + low + ', which left out a CDL set ' +
               'with a single key -- nearly every graded layer -- so grade changes cannot be ' +
               'reported. Drop the .d3 itself, or re-export it from the extractor, to compare them.');
  }
  if (!staticOk && fa !== fb) {
    notes.push('The ' + older() + ' keyframes are format ' + low + ', which does not record set ' +
               'values (a parameter set once and left, such as a blend mode or a mapping), so ' +
               'changes to them cannot be reported. Drop the .d3 itself, or re-export it from ' +
               'the extractor, to compare them.');
  }
  function keep(f) {
    if (f.static === true && !staticOk) return false;
    if (f.valueType === CDL_VALUE_TYPE && !cdlOk) return false;
    return true;
  }

  function snapTrack(snap, id) {
    var ts = (snap && snap.tracks) || [];
    for (var i = 0; i < ts.length; i++) if (String(ts[i].id) === id) return ts[i];
    return null;
  }
  // The snapshot's own record of a keyframes layer: by id, then by groupPath +
  // name where that is unique, for a capture whose ids are not the extractor's.
  function snapLayer(st, l) {
    if (!st) return null;
    var ls = st.layers || [], i, byKey = [];
    for (i = 0; i < ls.length; i++) {
      if (typeof l.id === 'string' && l.id !== '' && ls[i].id === l.id) return ls[i];
      if (layerKey(ls[i]) === layerKey(l)) byKey.push(ls[i]);
    }
    return byKey.length === 1 ? byKey[0] : null;
  }

  var tm = matchBy(docA.tracks, docB.tracks, function (t) { return String(t.id); });
  var pairs = tm.common.map(function (p) { return { a: p.a, b: p.b }; })
    .concat(tm.added.map(function (t) { return { a: null, b: t }; }))
    .concat(tm.removed.map(function (t) { return { a: t, b: null }; }));

  pairs.forEach(function (p) {
    var id = String((p.b || p.a).id);
    var trackNode = tracks.byId[id];
    // An added or removed track already says everything about its keyframes.
    if (trackNode && trackNode.kind !== 'changed') return;
    var stA = snapTrack(snapA, id), stB = snapTrack(snapB, id);
    var la = (p.a && p.a.layers) || [], lb = (p.b && p.b.layers) || [];
    var useIds = (!la.length || layersHaveIds(la)) && (!lb.length || layersHaveIds(lb));
    var m = matchBy(la, lb, useIds ? layerIdKey : layerKey);
    var index = tracks.layerIndex[id] || null;
    var labelSnap = layerLabeller(stB ? stB.layers : []);
    var labelKeys = layerLabeller(lb.length ? lb : la);
    var created = [];

    // Labelled the way the snapshot diff labels it when the snapshot holds the
    // layer, so a layer reads the same whichever kind of change put it here.
    function hang(l, kids) {
      if (!kids.length) return;
      var node = index && ((typeof l.id === 'string' && index.byId[l.id]) || index.byKey[layerKey(l)]);
      if (node && node.kind !== 'changed') return;
      if (!node) {
        var own = snapLayer(stB, l);
        node = { kind: 'changed', entity: 'layer',
                 label: 'layer ' + (own ? labelSnap(own) : labelKeys(l)),
                 changes: [], children: [] };
        created.push(node);
      }
      node.children = (node.children || []).concat(kids);
    }

    m.common.forEach(function (q) { hang(q.b, diffLayerKeys(q.a, q.b, keep)); });
    m.removed.forEach(function (l) {
      if (snapLayer(stB, l)) hang(l, diffLayerKeys(l, null, keep));
    });
    m.added.forEach(function (l) {
      if (snapLayer(stA, l)) hang(l, diffLayerKeys(null, l, keep));
    });

    if (!created.length) return;
    if (trackNode) {
      trackNode.children = (trackNode.children || []).concat(created);
    } else {
      trackNode = { kind: 'changed', entity: 'track', label: 'track ' + showWhitespace(id),
                    detail: stB && stB.trashed ? 'in the trash' : null,
                    changes: [], children: created };
      tracks.byId[id] = trackNode;
      out.push(trackNode);
    }
  });

  // A CDL is a resource many layers can name, so an edit to its own values is
  // one node, not one per layer that applies it. Only CDLs both files decoded:
  // a table holds just the CDLs some layer names, so one entering or leaving it
  // is the layers' news, already reported on them.
  if (cdlOk && low >= 3) {
    var ca = docA.cdls || {}, cb = docB.cdls || {};
    Object.keys(cb).sort().forEach(function (ref) {
      var x = ca[ref], y = cb[ref];
      if (!x || x.error || y.error) return;
      var ch = [];
      ['slope', 'power', 'offset'].forEach(function (k) {
        var p = x[k] || [], q = y[k] || [];
        var same = p.length === q.length && p.every(function (v, i) { return sameValue(v, q[i]); });
        if (!same) ch.push({ field: k, from: p.map(fmt).join(' '), to: q.map(fmt).join(' ') });
      });
      if (!sameValue(x.saturation, y.saturation)) {
        ch.push({ field: 'saturation', from: x.saturation, to: y.saturation });
      }
      if (ch.length) {
        out.push({ kind: 'changed', entity: 'cdl', label: 'cdl ' + showWhitespace(y.name || ref),
                   detail: ref, changes: ch });
      }
    });
  }
  return { nodes: out, notes: notes };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { diffSnapshots: diffSnapshots, summarize: summarize,
                     mediaReport: mediaReport, cueReport: cueReport,
                     transportReport: transportReport,
                     systemReport: systemReport, exportDiff: exportDiff,
                     keyframeReport: keyframeReport, timecodeAt: timecodeAt,
                     cdlSwatch: cdlSwatch, gradeRgb: gradeRgb,
                     matchBy: matchBy, orderDiff: orderDiff, fmt: fmt,
                     KEY_TOLERANCE: KEY_TOLERANCE, KEY_FOLD: KEY_FOLD };
}
