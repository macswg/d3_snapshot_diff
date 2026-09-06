/* Self-test for the diff engine. No framework, no dependencies:
 *   node tools/selftest.js [path/to/logs]
 *
 * Defaults to the example_logs folder in the plugin repo next door. Every case
 * runs against a real v4 capture rather than a hand-written fixture, because
 * the fields that actually break are the ones nobody thinks to fake -- null
 * timecode, empty media arrays, tracks shared between transports.
 */
var fs = require('fs');
var path = require('path');
var diff = require('../diff.js');

/* Candidate corpora, first that exists wins. The plugin repo next door is the
 * portable answer; the show machine is where captures actually accumulate. A
 * default that does not resolve is worse than no default at all -- deploy.sh
 * warns and ships anyway when the folder is missing, so a dead path silently
 * turns the gate off, which is the failure this list exists to prevent. */
/* Machine-specific corpora go in tools/logs.local, one path per line, which is
 * gitignored and tried first. Nothing identifying belongs in the list below:
 * this repo is public, and the path to a folder of captures names a client, a
 * shared drive and an email address before it names a single capture. */
function localCandidates() {
  try {
    return fs.readFileSync(path.join(__dirname, 'logs.local'), 'utf8')
      .split('\n')
      .map(function (l) { return l.replace(/^\s+|\s+$/g, ''); })
      .filter(function (l) { return l && l.charAt(0) !== '#'; });
  } catch (e) { return []; }
}

var LOG_CANDIDATES = localCandidates().concat([
  path.join(__dirname, '..', '..', 'd3plg_susan_summary', 'example_logs')
]);
// A candidate counts only if it actually holds captures, and its immediate
// subfolders are searched too: an archive gets filed into `old_schema/` the day
// a new schema lands, and a default that resolves to the now-empty parent is the
// dead-path failure this list exists to prevent, wearing a different hat.
function capturesIn(dir) {
  try {
    return fs.readdirSync(dir).filter(function (f) {
      return /\.json$/.test(f) && fs.statSync(path.join(dir, f)).size > 0;
    }).length;
  } catch (e) { return 0; }
}
/* A folder holding exactly one capture is the dangerous case, not the empty one.
 * The v6 archive lives in old_schema/ and new captures land in the parent beside
 * it, so the morning the first v7 capture appears the parent holds one file --
 * too few to diff, so resolution falls through to the archive and the suite
 * passes without ever reading the v7 file it exists to check. Empty folders are
 * skipped in silence; a folder skipped while holding captures says so. */
var skipped = [];

function resolveLogs(dir) {
  if (!fs.existsSync(dir)) return null;
  var here = capturesIn(dir);
  if (here >= 2) return dir;
  if (here) skipped.push(dir + ' (' + here + ')');
  var subs = [];
  try {
    subs = fs.readdirSync(dir).map(function (f) { return path.join(dir, f); })
             .filter(function (f) { return fs.statSync(f).isDirectory(); }).sort();
  } catch (e) { return null; }
  for (var i = 0; i < subs.length; i++) {
    var n = capturesIn(subs[i]);
    if (n >= 2) return subs[i];
    if (n) skipped.push(subs[i] + ' (' + n + ')');
  }
  return null;
}

// An explicit path is resolved the same way a candidate is. deploy.sh passes one,
// so letting argv skip the subfolder search would leave the deploy gate with the
// hole the search exists to close -- and the NOTE below keeps it honest about
// where it actually ended up.
var LOGS = null, given = process.argv[2];
if (given) {
  LOGS = resolveLogs(given);
  if (!LOGS) {
    console.error('no folder with two or more captures at ' + given);
    skipped.forEach(function (d) { console.error('  saw ' + d + ', too few to diff'); });
    process.exit(1);
  }
} else {
  for (var cand = 0; cand < LOG_CANDIDATES.length; cand++) {
    LOGS = resolveLogs(LOG_CANDIDATES[cand]);
    if (LOGS) break;
  }
  if (!LOGS) {
    console.error('no captures found. Pass a folder: node tools/selftest.js /path/to/logs');
    console.error('looked in:\n  ' + LOG_CANDIDATES.join('\n  '));
    process.exit(1);
  }
}

var failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); return; }
  failures++;
  console.log('  FAIL ' + name + (detail ? '\n         ' + detail : ''));
}

function findings(nodes) {         // flatten the tree to "kind label" strings
  var out = [];
  (function walk(list) {
    list.forEach(function (n) {
      out.push(n.kind + ' ' + n.label);
      if (n.children) walk(n.children);
    });
  })(nodes);
  return out;
}
function nodeAt(nodes, label) {
  var hit = null;
  (function walk(list) {
    list.forEach(function (n) {
      if (n.label === label) hit = n;
      if (n.children) walk(n.children);
    });
  })(nodes);
  return hit;
}
function changedFields(nodes, label) {
  var hit = nodeAt(nodes, label);
  return hit ? (hit.changes || []).map(function (c) { return c.field; }) : null;
}

/* A v5 capture: the census is a field the plugin writes from the automatic
 * setlist resource, not something inferred from what a transport happens to be
 * loaded with. `ids` null models the plugin failing to read that resource. */
function withShowfile(snap, ids, error) {
  var copy = JSON.parse(JSON.stringify(snap));
  copy.showfile = {
    source: 'objects/setlist/automatic.apx',
    trackIds: ids,
    trackCount: ids ? ids.length : null,
    error: error || null
  };
  return copy;
}

/* No transport sitting on the automatic setlist, so the census field is the only
 * thing that can speak for the showfile. The corpus capture happens to have one
 * loaded, which would quietly satisfy the fallback and hide what is being
 * tested. */
function withoutAutomatic(snap) {
  var copy = JSON.parse(JSON.stringify(snap));
  copy.transports.forEach(function (tr) {
    if (tr.setlist === 'automatic') tr.setlist = 'some_named_setlist';
  });
  return copy;
}

/* A capture whose first transport censuses the showfile the pre-v5 way, by
 * having an `automatic` setlist loaded. Built explicitly rather than hoped for:
 * whether a corpus capture has one loaded is exactly the accident v5 removed. */
function withCensus(snap) {
  var copy = JSON.parse(JSON.stringify(snap));
  copy.transports[0].setlist = 'automatic';
  copy.transports[0].trackRefs = copy.tracks.map(function (t) { return t.id; });
  copy.transports[0].trackCount = copy.transports[0].trackRefs.length;
  // Null the census, or it answers first and this fixture tests nothing it
  // claims to: a real v5 capture carries one, so an automatic transport bolted
  // on beside it is never consulted. What is left is the fallback path, which
  // is what these cases are actually for.
  copy.showfile = {
    source: 'objects/setlist/automatic.apx',
    trackIds: null, trackCount: null, error: 'fixture: census unavailable'
  };
  return copy;
}

// Zero-byte files are skipped, not parsed. The plugin leaves one behind when a
// capture is interrupted -- there is one in the moose corpus -- and JSON.parse
// on it throws, taking the whole suite down before a single case runs.
var files = fs.readdirSync(LOGS).filter(function (f) {
  return /\.json$/.test(f) && fs.statSync(path.join(LOGS, f)).size > 0;
}).sort();
if (files.length < 2) {
  console.error('need at least two .json snapshots in ' + LOGS);
  process.exit(1);
}
var A = JSON.parse(fs.readFileSync(path.join(LOGS, files[0]), 'utf8'));
var B = JSON.parse(fs.readFileSync(path.join(LOGS, files[files.length - 1]), 'utf8'));

console.log('logs: ' + LOGS + '  (' + files.length + ' captures)');
skipped.forEach(function (d) {
  console.log('NOTE: skipped ' + d + ' -- needs two captures to diff. ' +
              'Nothing in it is being tested.');
});
console.log(files[0] + '  ->  ' + files[files.length - 1] + '\n');

console.log('identity');
var same = diff.diffSnapshots(A, JSON.parse(JSON.stringify(A)));
check('a snapshot against itself reports nothing',
      same.nodes.length === 0, JSON.stringify(same.counts));

console.log('\nrepeated layers (duplicate identity keys)');
// One clip placed several times down a track gives several layers sharing
// groupPath + name. Keyed into a plain map that is last-write-wins, so every
// placement compared against the same one and all but the first reported a
// bogus tStart/tEnd change -- a snapshot diffed against a copy of itself came
// back with hundreds of changes. Built explicitly rather than trusted to the
// corpus: the capture this suite defaults to has no repeats, which is why the
// identity check above passed while the bug was live.
var repeated = JSON.parse(JSON.stringify(A));
var rt = repeated.tracks.filter(function (t) { return (t.layers || []).length; })[0];
if (!rt) {
  check('a track with layers exists to test against', false);
} else {
  var proto = rt.layers[0];
  for (var r = 0; r < 3; r++) {
    var copy = JSON.parse(JSON.stringify(proto));
    copy.tStart = 100 + r * 10; copy.tEnd = copy.tStart + 5;
    copy.bStart = copy.tStart;  copy.bEnd = copy.tEnd;
    rt.layers.push(copy);       // same name + groupPath, different position
  }
  rt.layerCount = rt.layers.length;
  var rep = diff.diffSnapshots(repeated, JSON.parse(JSON.stringify(repeated)));
  check('repeated layers against a copy of themselves report nothing',
        rep.nodes.length === 0,
        JSON.stringify(rep.counts) + ' :: ' + findings(rep.nodes).slice(0, 4).join(' | '));

  // The pairing must be by occurrence, so a repeat that moves is a change on
  // that one placement -- not a remove + add, and not a cascade onto its twins.
  var moved = JSON.parse(JSON.stringify(repeated));
  var mt = moved.tracks.filter(function (t) { return t.id === rt.id; })[0];
  mt.layers[mt.layers.length - 1].tStart += 7;
  var mv = diff.diffSnapshots(repeated, moved);
  check('moving one of several identical layers changes only that one',
        mv.counts.added === 0 && mv.counts.removed === 0 && mv.counts.changed === 2,
        JSON.stringify(mv.counts) + ' :: ' + findings(mv.nodes).join(' | '));
}

console.log('\nreal capture pair');
var real = diff.diffSnapshots(A, B);
check('reports some difference', real.nodes.length > 0);
check('every node carries a label',
      findings(real.nodes).every(function (s) { return !/\s$/.test(s); }));

console.log('\nshared tracks (the v4 trackRefs case)');
// A track on two setlists is stored once and referenced twice. It must diff
// once too -- reporting it per transport is what schema v4 exists to avoid.
var added = findings(real.nodes).filter(function (s) { return /^added track /.test(s); });
check('an added track is reported once, not per referencing transport',
      added.length === new Set(added).size, added.join(' | '));

console.log('\npositional independence');
// Insert a layer at index 0 of the first track that has any. A position-based
// diff would call every layer below it changed; identity matching must not.
var mutated = JSON.parse(JSON.stringify(A));
var target = mutated.tracks.filter(function (t) { return (t.layers || []).length; })[0];
if (!target) {
  check('a track with layers exists to test against', false);
} else {
  target.layers.unshift({
    name: 'ZZ Inserted', type: 'VideoModule', groupPath: [], renderEnable: true,
    tStart: 0, tEnd: 1, bStart: 0, bEnd: 1, tcStart: null, tcEnd: null, media: []
  });
  target.layerCount = target.layers.length;
  var ins = diff.diffSnapshots(A, mutated);
  check('inserting at the top is one addition, no cascade',
        ins.counts.added === 1 && ins.counts.removed === 0,
        JSON.stringify(ins.counts) + ' :: ' + findings(ins.nodes).join(' | '));
}

console.log('\ndeletion');
// Mirror of the insertion case. Dropping the top layer must be one removal,
// not a cascade down the rest of the track.
if (!target) {
  check('a track with layers exists to test against', false);
} else {
  var dropped = JSON.parse(JSON.stringify(A));
  var dt = dropped.tracks.filter(function (t) { return t.id === target.id; })[0];
  var goneLayer = dt.layers.shift();
  dt.layerCount = dt.layers.length;
  var del = diff.diffSnapshots(A, dropped);
  check('removing the top layer is one removal, no cascade',
        del.counts.removed === 1 && del.counts.added === 0,
        JSON.stringify(del.counts) + ' :: ' + findings(del.nodes).join(' | '));
  var goneKey = (goneLayer.groupPath || []).concat([goneLayer.name]).join(' / ');
  check('the removal names the layer that went',
        findings(del.nodes).indexOf('removed layer ' + goneKey) !== -1,
        findings(del.nodes).join(' | '));
}

// The shared-track case in reverse: a track referenced by two transports is
// stored once, so deleting it must report once -- not per referencing setlist.
// Both sides census the showfile, so the deletion is answerable at all.
var census = withCensus(A);
var refCount = {};
census.transports.forEach(function (tr) {
  (tr.trackRefs || []).forEach(function (id) { refCount[id] = (refCount[id] || 0) + 1; });
});
var sharedId = Object.keys(refCount).filter(function (id) { return refCount[id] > 1; })[0];
if (!sharedId) {
  console.log('  skip a track shared by two transports (none in this capture)');
} else {
  var cut = JSON.parse(JSON.stringify(census));
  cut.tracks = cut.tracks.filter(function (t) { return String(t.id) !== sharedId; });
  cut.transports.forEach(function (tr) {
    tr.trackRefs = (tr.trackRefs || []).filter(function (id) { return String(id) !== sharedId; });
  });
  var gone = findings(diff.diffSnapshots(census, cut).nodes)
    .filter(function (s) { return /^removed track /.test(s); });
  check('a removed shared track is reported once, not per referencing transport',
        gone.length === 1, gone.join(' | '));
}

console.log('\nsetlist membership vs the showfile');
/* The case this whole distinction exists for. Dropping songs from a setlist
 * takes them out of the capture entirely -- the top-level `tracks` array is
 * only the union of what the setlists reference -- and that used to report as
 * a wall of track deletions. It is a transport edit, and nothing else. */
var trimmed = JSON.parse(JSON.stringify(census));
var dropIds = census.transports[0].trackRefs.slice(0, 3).map(String);
trimmed.transports.forEach(function (tr) {
  tr.trackRefs = (tr.trackRefs || []).filter(function (id) { return dropIds.indexOf(String(id)) === -1; });
  tr.trackCount = tr.trackRefs.length;
});
trimmed.transports[0].setlist = 'a_named_setlist';   // no longer the census
trimmed.tracks = trimmed.tracks.filter(function (t) { return dropIds.indexOf(String(t.id)) === -1; });
trimmed.trackCount = trimmed.tracks.length;
var trim = diff.diffSnapshots(census, trimmed);
check('tracks dropped from a setlist are not reported as deletions',
      trim.counts.removed === 0 && trim.counts.added === 0,
      JSON.stringify(trim.counts) + ' :: ' + findings(trim.nodes).slice(0, 4).join(' | '));
check('the diff says out loud that it withheld them',
      (trim.notes || []).length === 1 && /3 tracks/.test(trim.notes[0]),
      JSON.stringify(trim.notes));
check('they are reported as running-order removals on the transport instead',
      (nodeAt(trim.nodes, 'transport ' + census.transports[0].name).order || {}).counts.removed === 3,
      JSON.stringify(findings(trim.nodes)));

// The other half: with a census on both sides, a track really leaving the
// showfile is still a deletion. Suppressing that would trade one wrong answer
// for another.
var deleted = JSON.parse(JSON.stringify(census));
var goneId = String(census.tracks[0].id);
deleted.tracks = deleted.tracks.filter(function (t) { return String(t.id) !== goneId; });
deleted.transports.forEach(function (tr) {
  tr.trackRefs = (tr.trackRefs || []).filter(function (id) { return String(id) !== goneId; });
});
check('a track deleted from the showfile is still reported as a deletion',
      findings(diff.diffSnapshots(census, deleted).nodes)
        .indexOf('removed track ' + goneId) !== -1,
      findings(diff.diffSnapshots(census, deleted).nodes).slice(0, 4).join(' | '));

console.log('\nthe v5 showfile census');
/* v5 stops the census being an accident. The plugin reads the automatic setlist
 * resource directly, so a capture answers "is this track in the show" whatever
 * the transports are loaded with -- which is the case the whole distinction
 * above kept having to decline. */
var allIds = A.tracks.map(function (t) { return String(t.id); });
var v5 = withShowfile(A, allIds);
var v5cut = withShowfile(A, allIds.slice(1));      // one track really left the show
v5cut.tracks = v5cut.tracks.filter(function (t) { return String(t.id) !== allIds[0]; });
v5cut.transports.forEach(function (tr) {
  tr.trackRefs = (tr.trackRefs || []).filter(function (id) { return String(id) !== allIds[0]; });
});
var cen = diff.diffSnapshots(v5, v5cut);
check('a track dropped from the census is a deletion, with no automatic transport in sight',
      findings(cen.nodes).indexOf('removed track ' + allIds[0]) !== -1,
      JSON.stringify(cen.counts) + ' :: ' + findings(cen.nodes).slice(0, 3).join(' | '));
check('and the diff withholds nothing, so it says nothing',
      (cen.notes || []).length === 0, JSON.stringify(cen.notes));

// The mirror: still on the census, just off every setlist. Not a deletion.
var v5drop = withShowfile(A, allIds);
v5drop.tracks = v5drop.tracks.filter(function (t) { return String(t.id) !== allIds[0]; });
v5drop.transports.forEach(function (tr) {
  tr.trackRefs = (tr.trackRefs || []).filter(function (id) { return String(id) !== allIds[0]; });
});
check('a track still in the census but off every setlist is not a deletion',
      diff.diffSnapshots(v5, v5drop).counts.removed === 0,
      JSON.stringify(diff.diffSnapshots(v5, v5drop).counts));

// trackIds null is "could not read", not "the show is empty" -- the difference
// between declining to answer and answering that everything was deleted.
var v5err = withShowfile(withoutAutomatic(A), null, 'resource not found');
v5err.tracks = v5err.tracks.filter(function (t) { return String(t.id) !== allIds[0]; });
v5err.transports.forEach(function (tr) {
  tr.trackRefs = (tr.trackRefs || []).filter(function (id) { return String(id) !== allIds[0]; });
});
var errDiff = diff.diffSnapshots(v5, v5err);
check('a null census is declined, not read as an empty showfile',
      errDiff.counts.removed === 0 && (errDiff.notes || []).length === 1,
      JSON.stringify(errDiff.counts) + ' :: ' + JSON.stringify(errDiff.notes));
check('the note quotes why the census was unreadable',
      /resource not found/.test((errDiff.notes || [])[0] || ''),
      JSON.stringify(errDiff.notes));

// An empty show is a real answer, and the opposite one. Counted over track
// nodes rather than counts.removed, which also carries the four transports that
// went with it.
var emptied = findings(diff.diffSnapshots(v5, withShowfile({ transports: [], tracks: [] }, [])).nodes)
  .filter(function (s) { return /^removed track /.test(s); });
check('an empty census really does mean every track left the show',
      emptied.length === A.tracks.length,
      emptied.length + ' of ' + A.tracks.length);

// The fallback still earns its keep: census unreadable, but a transport happens
// to be sitting on automatic, which is the same list by a worse route.
var v5fb = withShowfile(withCensus(A), null, 'resource not found');
check('a null census falls back to a transport on the automatic setlist',
      diff.diffSnapshots(v5fb, v5fb).nodes.length === 0 &&
      (function () {
        var cut = JSON.parse(JSON.stringify(v5fb));
        var gone = String(cut.tracks[0].id);
        cut.tracks = cut.tracks.filter(function (t) { return String(t.id) !== gone; });
        cut.transports.forEach(function (tr) {
          tr.trackRefs = (tr.trackRefs || []).filter(function (id) { return String(id) !== gone; });
        });
        return findings(diff.diffSnapshots(v5fb, cut).nodes).indexOf('removed track ' + gone) !== -1;
      })());

console.log('\ntracks in the trash');
/* d3 keeps a deleted track under trash/, and a setlist can go on referencing it
 * -- the live session that prompted v5 had exactly one. It plays like any other
 * song and never appears in the census, so nothing in the output gives it away
 * unless the capture says so. */
var trashA = withShowfile(A, allIds);
trashA.tracks[0].trashed = false;
var trashB = JSON.parse(JSON.stringify(trashA));
trashB.tracks[0].trashed = true;
check('a track moving to the trash is a reported change',
      (changedFields(diff.diffSnapshots(trashA, trashB).nodes,
                     'track ' + trashA.tracks[0].id) || []).indexOf('in the trash') !== -1,
      JSON.stringify(changedFields(diff.diffSnapshots(trashA, trashB).nodes,
                                   'track ' + trashA.tracks[0].id)));
check('a changed track already in the trash says so on its row',
      nodeAt(diff.diffSnapshots(trashB, (function () {
        var c = JSON.parse(JSON.stringify(trashB));
        c.tracks[0].bpm = (c.tracks[0].bpm || 60) + 1;
        return c;
      })()).nodes, 'track ' + trashB.tracks[0].id).detail === 'in the trash');
// The media report is where someone would actually notice, since it lists what
// is programmed rather than only what changed.
var trashRep = diff.mediaReport(trashB);
check('the media report carries the flag on every track',
      trashRep.tracks.every(function (t) { return typeof t.trashed === 'boolean'; }));
// Exactly the trashed tracks and no others. Not "one": a real capture already
// carries a trashed track of its own, and asserting a count rather than the set
// makes the case pass or fail on the corpus rather than on the code.
check('and it marks exactly the tracks that are in the trash',
      trashRep.tracks.filter(function (t) { return t.trashed; })
        .map(function (t) { return t.id; }).sort().join('|') ===
      trashB.tracks.filter(function (t) { return t.trashed; })
        .map(function (t) { return String(t.id); }).sort().join('|'),
      JSON.stringify(trashRep.tracks.filter(function (t) { return t.trashed; })
        .map(function (t) { return t.id; })));

console.log('\ntrackCount is setlist membership');
// Both counters follow the setlists, not the show. Labelling them `trackCount`
// invited exactly the reading this release exists to correct.
var fewer = JSON.parse(JSON.stringify(A));
fewer.trackCount = A.trackCount - 1;
fewer.transports[0].trackCount = A.transports[0].trackCount - 1;
var lbl = diff.diffSnapshots(A, fewer);
check('the snapshot counter says "tracks in setlists"',
      (changedFields(lbl.nodes, 'snapshot') || []).indexOf('tracks in setlists') !== -1,
      JSON.stringify(changedFields(lbl.nodes, 'snapshot')));
check('the transport counter says "tracks in setlist"',
      (changedFields(lbl.nodes, 'transport ' + A.transports[0].name) || [])
        .indexOf('tracks in setlist') !== -1,
      JSON.stringify(changedFields(lbl.nodes, 'transport ' + A.transports[0].name)));

console.log('\nfloat tolerance');
// Re-derived beats come back off the director as floats; a capture that yields
// 60.0000000001 is the same position, not an edit.
var jitter = JSON.parse(JSON.stringify(A));
jitter.tracks.forEach(function (t) {
  (t.layers || []).forEach(function (l) {
    if (typeof l.bEnd === 'number') l.bEnd += 1e-9;
  });
});
check('sub-epsilon float drift is not a change',
      diff.diffSnapshots(A, jitter).nodes.length === 0);

console.log('\ncue identity through float drift');
/* Cue beats arrive as float32 and a capture that re-derives one moves it far
 * beyond EPSILON: the same untouched cue read 0.000469 beats apart in two moose
 * captures twenty minutes apart. The old key rounded the beat to a milli-beat,
 * so that drift straddled a bucket edge and the cue reported as an add paired
 * with a remove. These cases pin the tolerance from both sides -- drift must be
 * absorbed, and a real move must still register. */
var DRIFT = 0.000469;          // the largest drift measured across the corpus
var GAP   = 0.033203;          // the tightest genuine cue spacing in the corpus

function trackWithCues(snap) {
  return (snap.tracks || []).filter(function (t) { return (t.cues || []).length > 1; })[0];
}
function withCueBeats(snap, tid, fn) {
  var copy = JSON.parse(JSON.stringify(snap));
  copy.tracks.forEach(function (t) { if (t.id === tid) fn(t); });
  return copy;
}
function cueNodes(nodes) {
  var out = [];
  (function walk(list) {
    list.forEach(function (n) {
      if (n.entity === 'cue') out.push(n);
      if (n.children) walk(n.children);
    });
  })(nodes);
  return out;
}

var ct = trackWithCues(A);
if (!ct) {
  check('a track with cues exists to test against', false);
} else {
  // Drift moves `t` in lockstep with `beat` -- they are the same quantity in
  // different units -- so a fix that only widened the match would relocate the
  // phantom from the cue's identity onto its `t` field. Both must stay quiet.
  var drifted = withCueBeats(A, ct.id, function (t) {
    t.cues.forEach(function (c) { c.beat += DRIFT; if (typeof c.t === 'number') c.t += DRIFT; });
  });
  var dres = diff.diffSnapshots(A, drifted);
  check('float32 beat drift is not an add + remove pair',
        cueNodes(dres.nodes).length === 0,
        JSON.stringify(dres.counts) + ' :: ' +
        cueNodes(dres.nodes).slice(0, 3).map(function (n) { return n.kind + ' ' + n.label; }).join(' | '));

  // The regression that matters. An edited note on a cue that also drifted used
  // to vanish: the pairing failed, so there was nothing left to compare, and
  // the change surfaced as an unexplained add beside an unexplained remove.
  var renamed = withCueBeats(A, ct.id, function (t) {
    t.cues[0].beat += DRIFT;
    if (typeof t.cues[0].t === 'number') t.cues[0].t += DRIFT;
    t.cues[0].note = 'edited in the same session';
  });
  var rnodes = cueNodes(diff.diffSnapshots(A, renamed).nodes);
  check('a note edited on a drifting cue reports as a note change',
        rnodes.length === 1 && rnodes[0].kind === 'changed' &&
        (rnodes[0].changes || []).map(function (c) { return c.field; }).join() === 'note',
        JSON.stringify(rnodes.map(function (n) { return n.kind + ' ' + JSON.stringify(n.changes); })));

  // The other side of the bracket: the tolerance must not swallow a real edit.
  // A cue dragged by a beat is a different position, not the same one blurred.
  var moved1 = withCueBeats(A, ct.id, function (t) { t.cues[0].beat += 1; t.cues[0].t += 1; });
  var mnodes = cueNodes(diff.diffSnapshots(A, moved1).nodes);
  check('a cue moved a whole beat reads as a remove plus an add',
        mnodes.length === 2 &&
        mnodes.filter(function (n) { return n.kind === 'added'; }).length === 1 &&
        mnodes.filter(function (n) { return n.kind === 'removed'; }).length === 1,
        JSON.stringify(mnodes.map(function (n) { return n.kind; })));

  // Two cues one frame apart are the closest the corpus ever puts them. The
  // greedy merge is only sound while the tolerance stays well under this gap,
  // so a widening that looked harmless would start fusing distinct cues here.
  var tight = withCueBeats(A, ct.id, function (t) {
    var extra = JSON.parse(JSON.stringify(t.cues[0]));
    extra.beat = t.cues[0].beat + GAP;
    if (typeof extra.t === 'number') extra.t = t.cues[0].t + GAP;
    extra.note = 'one frame later';
    t.cues.push(extra);
  });
  check('two cues one frame apart survive a diff against themselves',
        cueNodes(diff.diffSnapshots(tight, JSON.parse(JSON.stringify(tight))).nodes).length === 0);

  // Sorting is what makes the merge correct, so it has to happen on a copy --
  // the media and transport tabs read the same arrays out of the same snapshot.
  var scrambled = withCueBeats(A, ct.id, function (t) { t.cues.reverse(); });
  var st = trackWithCues(scrambled);
  var beforeOrder = (scrambled.tracks.filter(function (t) { return t.id === ct.id; })[0].cues)
                      .map(function (c) { return c.beat; }).join();
  var sres = diff.diffSnapshots(scrambled, A);
  check('cues written out of beat order still match',
        cueNodes(sres.nodes).length === 0, JSON.stringify(sres.counts));
  check('matching does not reorder the caller\'s cue array',
        (scrambled.tracks.filter(function (t) { return t.id === ct.id; })[0].cues)
          .map(function (c) { return c.beat; }).join() === beforeOrder);
  if (!st) check('scrambled fixture kept its cues', false);
}

console.log('\ninvisible whitespace in showfile names');
/* Layer names are whatever was typed into Designer, and this corpus has four
 * that end in a space or a newline. Rendered raw, HTML swallows the difference:
 * `999_vis` holds both `[TEXT] B` and `[TEXT] B\n`, so removing one printed a
 * line identical to the one that stayed. Marking is the conservative repair --
 * trimming would fuse the two entities onto a single label and lose the edit. */
function layerLabels(nodes) {
  return findings(nodes).filter(function (f) { return /^\w+ layer /.test(f); });
}
function withLayerName(snap, name) {
  var copy = JSON.parse(JSON.stringify(snap));
  var t = copy.tracks.filter(function (x) { return (x.layers || []).length; })[0];
  if (t) t.layers[0].name = name;
  return copy;
}
// The base name is clean, so the renamed side is the only one that should come
// back marked -- and the two lines must not read the same.
var wsBase = withLayerName(A, 'pro be');
var MARKS = /[\u2423\u21e5\u23ce]/;

[['\u0020pro be', 'a leading space'],
 ['pro be\u0020', 'a trailing space'],
 ['pro be\n', 'a trailing newline'],
 ['pro be\t', 'a trailing tab'],
 ['pro  be', 'a doubled inner space']].forEach(function (c) {
  var got = layerLabels(diff.diffSnapshots(wsBase, withLayerName(A, c[0])).nodes);
  var dirty = got.filter(function (f) { return MARKS.test(f); });
  var clean = got.filter(function (f) { return !MARKS.test(f); });
  check(c[1] + ' is marked, not swallowed',
        got.length === 2 && dirty.length === 1 && clean.length === 1 &&
        dirty[0] !== clean[0], got.join(' | '));
});

// A single space between words is ordinary. Marking those would put a symbol
// between every word of every layer name in the show.
check('an ordinary inner space is left alone',
      layerLabels(diff.diffSnapshots(wsBase, withLayerName(A, 'other name')).nodes)
        .every(function (f) { return !MARKS.test(f); }));

// Invisible but not a space: lending it the space symbol would name the wrong
// character, so an unlisted whitespace codepoint is printed as its code.
check('a non-breaking space is named by codepoint, not shown as a space',
      layerLabels(diff.diffSnapshots(wsBase, withLayerName(A, 'pro be\u00a0')).nodes)
        .some(function (f) { return /\\u00a0/.test(f) && !MARKS.test(f); }));

/* The line that must not be crossed. Marking is a display concern; identity
 * stays raw. Keyed on a marked name, `B` and `B\n` would differ by a symbol
 * instead of by the one character they actually differ by -- which is the same
 * class of mistake as matching cues on an exact beat. */
var twoLayers = JSON.parse(JSON.stringify(A));
var wt = twoLayers.tracks.filter(function (t) { return (t.layers || []).length; })[0];
if (!wt) {
  check('a track with layers exists to test against', false);
} else {
  var twin = JSON.parse(JSON.stringify(wt.layers[0]));
  wt.layers[0].name = '[TEXT] B';
  twin.name = '[TEXT] B\n';
  wt.layers.push(twin);
  wt.layerCount = wt.layers.length;
  check('two names differing only by whitespace stay two entities',
        diff.diffSnapshots(twoLayers, JSON.parse(JSON.stringify(twoLayers))).nodes.length === 0);

  // ...and they must print as two distinguishable lines, which is the whole point.
  var dropped = JSON.parse(JSON.stringify(twoLayers));
  dropped.tracks.filter(function (t) { return t.id === wt.id; })[0].layers.pop();
  var dl = layerLabels(diff.diffSnapshots(twoLayers, dropped).nodes);
  check('removing one of them names which one went',
        dl.length === 1 && /\u23ce/.test(dl[0]), dl.join(' | '));
}

// The single-snapshot tabs print the same showfile strings and had the same
// blind spot: the corpus holds a clip whose filename *begins* with a space, and
// a layer with a doubled one, neither of which the diff ever surfaced because
// neither layer changed. These reports compare nothing, so there is no identity
// to protect here -- only the track `id`, which the page keys rows on.
var wsMedia = JSON.parse(JSON.stringify(A));
var wmt = wsMedia.tracks.filter(function (t) { return (t.layers || []).length; })[0];
if (!wmt || !(wmt.layers[0].media || []).length) {
  check('a track with media exists to test against', false);
} else {
  wmt.name = 'dirty name\n';
  wmt.layers[0].name = 'dirty layer ';
  wmt.layers[0].groupPath = ['dirty group '];
  wmt.layers[0].media[0].name = ' dirty.mov';
  wmt.layers[0].media[0].path = '/a/one two.mov ';
  var mrep = diff.mediaReport(wsMedia);
  var mrow = mrep.tracks.filter(function (t) { return t.id === String(wmt.id); })[0];
  // Found by name, never by index: the report sorts items by start time, so the
  // layer mutated above is not the one that lands first.
  var mit = mrow.items.filter(function (i) { return /^dirty layer/.test(i.layer); })[0];
  check('the media inventory marks the track, layer, group, media and path',
        mit && /\u23ce$/.test(mrow.name) && /\u2423$/.test(mit.layer) &&
        /\u2423$/.test(mit.group[0]) &&
        /^\u2423/.test(mit.name) && /\u2423$/.test(mit.path),
        JSON.stringify(mit ? [mrow.name, mit.layer, mit.group[0], mit.name, mit.path]
                           : 'no row for the mutated layer'));
  // The rule is "mark what HTML swallows", not "mark every space". A path with
  // an ordinary space inside it renders exactly as it reads, so marking it
  // would only make a legible name harder to read.
  check('a single space inside a path is left readable',
        mit && mit.path.indexOf('one two.mov') !== -1, mit && mit.path);
  check('the track id stays raw, because the page keys rows on it',
        mrow.id === String(wmt.id) && !/[\u2423\u21e5\u23ce]/.test(mrow.id), mrow.id);
  // Marking is cosmetic and must not move a count.
  check('marking does not change the inventory totals',
        mrep.totals.media === diff.mediaReport(A).totals.media &&
        mrep.totals.tracks === diff.mediaReport(A).totals.tracks,
        JSON.stringify(mrep.totals));
}

var wsTr = JSON.parse(JSON.stringify(A));
if (!(wsTr.transports || []).length) {
  check('a transport exists to test against', false);
} else {
  wsTr.transports[0].setlist = 'dirty setlist ';
  wsTr.transports[0].name = 'dirty transport ';
  var ref = (wsTr.transports[0].trackRefs || [])[0];
  wsTr.tracks.forEach(function (t) { if (String(t.id) === String(ref)) t.name = 'dirty track '; });
  var trep = diff.transportReport(wsTr).transports[0];
  check('transport info marks the transport, its setlist and its track names',
        /\u2423$/.test(trep.name) && /\u2423$/.test(trep.setlist) &&
        (!ref || /\u2423$/.test(trep.tracks[0].name)),
        JSON.stringify([trep.name, trep.setlist, trep.tracks[0] && trep.tracks[0].name]));
  check('and leaves the track id it resolves refs against alone',
        !ref || trep.tracks[0].id === String(ref),
        trep.tracks[0] && trep.tracks[0].id);
}

console.log('\nderived counters');
// layerCount is derived from `layers`. Comparing it as well would report every
// structural edit twice, so it must not appear as a field change.
check('layerCount is not compared as a field',
      target ? (changedFields(diff.diffSnapshots(A, mutated).nodes,
                              'track ' + target.id) || []).indexOf('layerCount') === -1
             : false);

console.log('\nsummary');
// The summary drives the panel on the page, so it must not invent or lose
// nodes: every node in the tree belongs to exactly one entity bucket.
var sum = diff.summarize(real);
var bucketed = sum.entities.reduce(function (n, e) { return n + e.total; }, 0);
check('every node lands in exactly one entity bucket',
      bucketed === findings(real.nodes).length,
      bucketed + ' bucketed vs ' + findings(real.nodes).length + ' nodes');
check('entity tallies add up to the headline counts',
      sum.entities.reduce(function (n, e) { return n + e.added; }, 0) === real.counts.added &&
      sum.entities.reduce(function (n, e) { return n + e.removed; }, 0) === real.counts.removed &&
      sum.entities.reduce(function (n, e) { return n + e.changed; }, 0) === real.counts.changed);
check('fields are ranked most-changed first',
      sum.fields.every(function (f, i) { return i === 0 || sum.fields[i - 1].count >= f.count; }),
      JSON.stringify(sum.fields.slice(0, 3)));
check('hotspots are ranked and cover the top-level nodes',
      sum.hotspots.length === real.nodes.length &&
      sum.hotspots.every(function (h, i) { return i === 0 || sum.hotspots[i - 1].count >= h.count; }));
check('an empty diff summarises to nothing rather than throwing',
      (function () {
        var e = diff.summarize(diff.diffSnapshots(A, JSON.parse(JSON.stringify(A))));
        return e.entities.length === 0 && e.fields.length === 0 && e.hotspots.length === 0;
      })());

console.log('\nrunning order');
var reordered = JSON.parse(JSON.stringify(A));
reordered.transports[0].trackRefs = reordered.transports[0].trackRefs.slice().reverse();
var ro = diff.diffSnapshots(A, reordered);
var roNode = nodeAt(ro.nodes, 'transport ' + A.transports[0].name);
check('a reordered setlist is a change even when no track is touched',
      !!(roNode && roNode.order && roNode.order.counts.changed),
      JSON.stringify(findings(ro.nodes)));
// A reshuffle is moves, not deletions and re-additions: the same tracks are on
// the setlist afterwards, and a hundred +/- pairs would say otherwise.
check('a reshuffle reads as moves, not as remove + add',
      roNode.order.counts.added === 0 && roNode.order.counts.removed === 0 &&
      roNode.order.counts.moved > 0,
      JSON.stringify(roNode.order.counts));
check('every running-order line names a track and both its positions',
      roNode.order.entries.every(function (e) {
        return e.id && (e.a !== null || e.b !== null) &&
               (e.kind !== 'moved' || (e.a !== null && e.b !== null));
      }));

// One track pushed to the end of an otherwise untouched setlist. The line diff
// must localise that -- an implementation that resynchronises badly reports the
// whole tail as moved, which is the "huge changes" this replaced.
var nudged = JSON.parse(JSON.stringify(A));
var refs = nudged.transports[0].trackRefs;
if (refs.length > 3) {
  refs.push(refs.shift());
  var nd = nodeAt(diff.diffSnapshots(A, nudged).nodes, 'transport ' + A.transports[0].name);
  check('moving one track reports one moved line, not a cascade',
        nd.order.counts.moved === 1 && nd.order.counts.same === refs.length - 1,
        JSON.stringify(nd.order.counts));
}

console.log('\nmedia report');
/* The report reads one capture rather than comparing two, so the claims are
 * about completeness and order: every track, every clip, in playing order. */
var rep = diff.mediaReport(A);
check('every track in the capture is reported exactly once',
      rep.tracks.length === A.tracks.length &&
      new Set(rep.tracks.map(function (t) { return t.id; })).size === A.tracks.length,
      rep.tracks.length + ' vs ' + A.tracks.length);
check('tracks keep the order the capture wrote them in',
      rep.tracks.map(function (t) { return t.id; }).join('|') ===
      A.tracks.map(function (t) { return String(t.id); }).join('|'));

// The whole reason transports came out. A track on three setlists used to be
// listed three times and its media counted three times, so the total was not
// the inventory it claimed to be.
var sharedRep = diff.mediaReport(census);
check('a track on several setlists is listed once, not once per setlist',
      sharedRep.tracks.filter(function (t) { return t.id === String(census.tracks[0].id); }).length === 1);
check('total media equals the media actually in the capture, counted once',
      rep.totals.media === (function () {
        var n = 0;
        A.tracks.forEach(function (t) {
          (t.layers || []).forEach(function (l) { n += (l.media || []).length; });
        });
        return n;
      })(),
      String(rep.totals.media));

// "The order they appear in the timeline". A null tStart has no position, so it
// sorts last rather than to the front as a numeric 0 would put it.
check('items are ordered by tStart with nulls last',
      rep.tracks.every(function (k) {
        var sawNull = false;
        return k.items.every(function (it, i) {
          if (it.tStart === null) { sawNull = true; return true; }
          if (sawNull) return false;                       // a time after a null
          return i === 0 || k.items[i - 1].tStart <= it.tStart;
        });
      }));

// One row per media, never per layer: a layer with no clip assigned loads
// nothing and must not appear, and a layer with two loads two.
var shaped = JSON.parse(JSON.stringify(A));
var st = shaped.tracks.filter(function (t) { return (t.layers || []).length; })[0];
st.layers = [
  { name: 'AA empty', type: 'VideoModule', groupPath: [], renderEnable: true,
    tStart: 0, tEnd: 1, bStart: 0, bEnd: 1, tcStart: null, tcEnd: null, media: [] },
  { name: 'BB pair', type: 'VideoModule', groupPath: [], renderEnable: true,
    tStart: 5, tEnd: 9, bStart: 0, bEnd: 1, tcStart: null, tcEnd: null,
    media: [{ name: 'one.mov', path: '/a/one.mov', version: 1, hasAudio: false, regionSet: null },
            { name: 'two.mov', path: '/a/two.mov', version: 1, hasAudio: false, regionSet: null }] },
  { name: 'CC unplaced', type: 'VideoModule', groupPath: [], renderEnable: true,
    tStart: null, tEnd: null, bStart: 0, bEnd: 1, tcStart: null, tcEnd: null,
    media: [{ name: 'zzz.mov', path: '/a/zzz.mov', version: 1, hasAudio: false, regionSet: null }] }
];
var sh = diff.mediaReport({ tracks: [st] }).tracks[0];
check('a layer with no media contributes no rows, a layer with two contributes two',
      sh.items.length === 3 &&
      sh.items.filter(function (i) { return i.layer === 'AA empty'; }).length === 0 &&
      sh.items.filter(function (i) { return i.layer === 'BB pair'; }).length === 2,
      JSON.stringify(sh.items.map(function (i) { return i.layer + ':' + i.name; })));
check('the unplaced layer sorts last despite naming first',
      sh.items[2].layer === 'CC unplaced' && sh.items[2].tStart === null,
      JSON.stringify(sh.items.map(function (i) { return i.layer + '@' + i.tStart; })));

check('totals add up to what is in the tree',
      rep.totals.tracks === rep.tracks.length &&
      rep.totals.media === rep.tracks.reduce(function (n, k) { return n + k.items.length; }, 0),
      JSON.stringify(rep.totals));

// Setlists are the diff tab's business. The report must not care what is
// loaded -- stripping every transport changes nothing about what is programmed.
check('the report ignores transports entirely',
      JSON.stringify(diff.mediaReport({ tracks: A.tracks })) === JSON.stringify(rep));

check('a snapshot with no tracks returns empty structures',
      (function () {
        var e = diff.mediaReport({ transports: A.transports });
        return e.tracks.length === 0 && e.totals.tracks === 0 && e.totals.media === 0;
      })());
check('an entirely empty snapshot does not throw',
      (function () { return diff.mediaReport({}).totals.tracks === 0; })());

console.log('\ntransport info');
/* The other half of what the media report used to conflate. Here the same track
 * legitimately appears under every setlist holding it -- the question is what a
 * transport is playing, not what exists. */
var trep = diff.transportReport(A);
check('every transport is reported, in the capture\'s order',
      trep.transports.map(function (t) { return t.name; }).join('|') ===
      A.transports.map(function (t) { return t.name; }).join('|'),
      JSON.stringify(trep.transports.map(function (t) { return t.name; })));
check('tracks are in running order, never sorted',
      trep.transports.every(function (t, i) {
        return t.tracks.map(function (k) { return k.id; }).join('|') ===
               (A.transports[i].trackRefs || []).map(String).join('|');
      }),
      JSON.stringify(trep.transports[0].tracks.slice(0, 3).map(function (k) { return k.id; })));
check('a transport on the automatic setlist is reported, not filtered out',
      diff.transportReport(census).transports
        .filter(function (t) { return t.setlist === 'automatic'; }).length === 1);
// A track on two setlists appears under both -- the opposite of the media
// report, and correct here for the opposite reason.
// Against `census`, not A: sharedId is defined as a track two of *census's*
// transports reference, and A on its own may reference it only once.
if (sharedId) {
  check('a shared track is listed under every transport that references it',
        diff.transportReport(census).transports.filter(function (t) {
          return t.tracks.some(function (k) { return k.id === sharedId; });
        }).length > 1);
}
check('counts match the rows actually listed',
      trep.transports.every(function (t) {
        return t.trackCount === t.tracks.length &&
               t.missingCount === t.tracks.filter(function (k) { return k.missing; }).length;
      }) &&
      trep.totals.transports === trep.transports.length &&
      trep.totals.tracks === trep.transports.reduce(function (n, t) { return n + t.tracks.length; }, 0),
      JSON.stringify(trep.totals));

// A setlist naming a track the capture does not hold is a fault in the show.
// Dropping it silently would hide exactly the thing worth seeing.
var dangling = JSON.parse(JSON.stringify(A));
dangling.transports = [{ name: 'only', setlist: 'x', trackRefs: ['no_such_track_id'], trackCount: 1 }];
var dg = diff.transportReport(dangling).transports[0];
check('a dangling trackRef is reported as missing rather than dropped or thrown on',
      dg.tracks.length === 1 && dg.tracks[0].missing === true &&
      dg.tracks[0].id === 'no_such_track_id' && dg.missingCount === 1,
      JSON.stringify(dg));
check('a track that is present carries missing false',
      trep.transports[0].tracks.every(function (k) { return k.missing === false; }));

// No media, deliberately: a setlist is a running order, and 1,700 clip rows
// under one is what made the combined view unreadable.
check('no media rides along on a transport listing',
      trep.transports.every(function (t) {
        return t.tracks.every(function (k) { return !('items' in k) && !('media' in k); });
      }));

check('the trashed flag survives into the running order',
      diff.transportReport(trashB).transports.some(function (t) {
        return t.tracks.some(function (k) { return k.trashed; });
      }));

check('a snapshot with no transports returns empty structures',
      (function () {
        var e = diff.transportReport({ tracks: A.tracks });
        return e.transports.length === 0 && e.totals.transports === 0 && e.totals.tracks === 0;
      })());
check('a transport with no trackRefs returns an empty track list',
      (function () {
        var e = diff.transportReport({ transports: [{ name: 'x', setlist: 'y' }], tracks: null });
        return e.transports.length === 1 && e.transports[0].tracks.length === 0 &&
               e.transports[0].trackCount === 0;
      })());
check('an entirely empty snapshot does not throw',
      (function () { return diff.transportReport({}).totals.transports === 0; })());

console.log('\nthe v6 system block');
/* The build and the option switches. Mutations off the real corpus rather than
 * hand-built captures: the switch map is 125 real entries, and the case that
 * matters is what happens to the other 124 when one of them moves. */
function withOptions(snap, scope, mutate) {
  var copy = JSON.parse(JSON.stringify(snap));
  mutate(copy.system.options[scope]);
  return copy;
}
var snapshotFields = function (nodes) { return changedFields(nodes, 'snapshot') || []; };

check('a capture that read its switches reports them, and the corpus really has some',
      A.system.options.project.values &&
      Object.keys(A.system.options.project.values).length > 100,
      Object.keys((A.system.options.project || {}).values || {}).length + ' switches');

var flipped = withOptions(A, 'project', function (s) {
  s.values.useLegacySLCRegionTag = s.values.useLegacySLCRegionTag === '1' ? '0' : '1';
});
var flipDiff = diff.diffSnapshots(A, flipped);
check('a flipped switch is one line, not a re-report of every switch beside it',
      snapshotFields(flipDiff.nodes).join(',') === 'useLegacySLCRegionTag',
      JSON.stringify(snapshotFields(flipDiff.nodes)));
check('and it earns no section of its own',
      flipDiff.nodes.length === 1 && flipDiff.nodes[0].entity === 'snapshot',
      findings(flipDiff.nodes).join(' | '));

// The whole reason values is nullable. Reading null as {} would diff 125
// switches against nothing and report every one of them as removed -- the
// showfile-census mistake, wearing a different hat.
var unread = withOptions(A, 'project', function (s) {
  s.values = null; s.error = 'options.bin unreadable';
});
var unreadDiff = diff.diffSnapshots(A, unread);
check('an unread switch file is declined, not read as no switches set',
      snapshotFields(unreadDiff.nodes).length === 0,
      JSON.stringify(snapshotFields(unreadDiff.nodes)).slice(0, 200));
check('and the diff says out loud that it withheld them',
      (unreadDiff.notes || []).filter(function (n) {
        return /option switches/.test(n);
      }).length === 1, JSON.stringify(unreadDiff.notes));
check('the note quotes why the file was unreadable',
      /options\.bin unreadable/.test((unreadDiff.notes || []).join(' ')),
      JSON.stringify(unreadDiff.notes));

// A switch the file never mentions is at its default. Filling it in with "0"
// would invent a value the capture never claimed, and would hide the day a
// Designer release changes what that default is.
var added = withOptions(A, 'project', function (s) { s.values.aBrandNewSwitch = '1'; });
var addedChange = (nodeAt(diff.diffSnapshots(A, added).nodes, 'snapshot').changes || [])[0];
check('a switch that appears reads as absent-before, not as zero-before',
      addedChange && addedChange.field === 'aBrandNewSwitch' &&
      addedChange.from === undefined && addedChange.to === '1',
      JSON.stringify(addedChange));

// Machine settings override project settings, so they cannot share a namespace:
// the same switch name can legitimately hold different values at each scope.
var machined = withOptions(A, 'machine', function (s) { s.values.telnetConsolePort = '10002'; });
check('a machine switch is labelled as one, so it cannot be mistaken for the project',
      snapshotFields(diff.diffSnapshots(A, machined).nodes)
        .join(',') === 'telnetConsolePort (machine)',
      JSON.stringify(snapshotFields(diff.diffSnapshots(A, machined).nodes)));

var upgraded = JSON.parse(JSON.stringify(A));
upgraded.system.build.version = 'r34.0.0, rev 260000';
check('a Designer upgrade is reported as one build line',
      snapshotFields(diff.diffSnapshots(A, upgraded).nodes).join(',') === 'd3 build',
      JSON.stringify(snapshotFields(diff.diffSnapshots(A, upgraded).nodes)));

check('two captures off the same build and switches report neither',
      snapshotFields(diff.diffSnapshots(A, JSON.parse(JSON.stringify(A))).nodes).length === 0);

console.log('\nthe system report (single-snapshot tab)');
/* One capture, not a comparison -- the same shape mediaReport and
 * transportReport take. The report is what the System tab renders. */
var sysrep = diff.systemReport(A);
check('the build surfaces the version and drops null fields',
      sysrep.build && sysrep.build.version &&
      sysrep.build.fields.every(function (f) { return f.v !== null && f.v !== ''; }),
      JSON.stringify(sysrep.build && sysrep.build.version));

// The compaction the tab depends on: set is the handful someone changed, all is
// everything the file holds. A default-valued switch is in `all`, never `set`.
check('set is the non-default switches, all is every recorded one',
      sysrep.project.set.length > 0 &&
      sysrep.project.all.length > sysrep.project.set.length &&
      sysrep.project.set.every(function (s) { return !s.isDefault; }),
      sysrep.project.set.length + ' set of ' + sysrep.project.all.length);

check('a switch at 0 is marked default, so the tab can dim it rather than drop it',
      (function () {
        var zero = sysrep.project.all.filter(function (s) { return s.value === '0'; });
        return zero.length > 0 && zero.every(function (s) { return s.isDefault; });
      })());

// The null-vs-empty rule, at the report layer this time: unread must not read
// as "no switches", or the tab would quietly claim a default state it never saw.
var unreadSys = diff.systemReport(withOptions(A, 'project', function (s) {
  s.values = null; s.error = 'options.bin unreadable';
}));
check('an unread switch file reports unread, not an empty set',
      unreadSys.project.unread === true && unreadSys.project.all.length === 0 &&
      /unreadable/.test(unreadSys.project.error || ''),
      JSON.stringify({ unread: unreadSys.project.unread, err: unreadSys.project.error }));

check('the source path rides along so the tab can name the file it read',
      /options\.bin$/.test(sysrep.project.source || ''), sysrep.project.source);

check('a capture with no system block does not throw and reports no build',
      (function () {
        var e = diff.systemReport({ tracks: [] });
        return e.build === null && e.project.all.length === 0 && e.totals.set === 0;
      })());

console.log('\n' + (failures ? failures + ' failing' : 'all passing'));
process.exit(failures ? 1 : 0);
