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

var LOGS = process.argv[2] ||
  path.join(__dirname, '..', '..', 'd3plg_susan_summary', 'example_logs');

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

/* A capture whose first transport censuses the showfile. Track add/delete is
 * only answerable against an `automatic` setlist -- it is the one that holds
 * every track in the show -- so the cases below build that state explicitly
 * rather than hoping the corpus happens to have it. */
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

function withCensus(snap) {
  var copy = JSON.parse(JSON.stringify(snap));
  copy.transports[0].setlist = 'automatic';
  copy.transports[0].trackRefs = copy.tracks.map(function (t) { return t.id; });
  copy.transports[0].trackCount = copy.transports[0].trackRefs.length;
  return copy;
}

var files = fs.readdirSync(LOGS).filter(function (f) { return /\.json$/.test(f); }).sort();
if (files.length < 2) {
  console.error('need at least two .json snapshots in ' + LOGS);
  process.exit(1);
}
var A = JSON.parse(fs.readFileSync(path.join(LOGS, files[0]), 'utf8'));
var B = JSON.parse(fs.readFileSync(path.join(LOGS, files[files.length - 1]), 'utf8'));

console.log('logs: ' + LOGS);
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
// each setlist plays rather than only what changed.
var trashRep = diff.mediaReport(trashB);
check('the media report carries the flag through to every setlist listing it',
      trashRep.transports.every(function (tp) {
        return tp.tracks.every(function (t) {
          return t.missing || typeof t.trashed === 'boolean';
        });
      }));
check('and it marks the trashed track specifically',
      (function () {
        var id = String(trashB.tracks[0].id), seen = 0, flagged = 0;
        trashRep.transports.forEach(function (tp) {
          tp.tracks.forEach(function (t) {
            if (t.id !== id) return;
            seen++;
            if (t.trashed) flagged++;
          });
        });
        return seen > 0 && seen === flagged;
      })());

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
 * about completeness and order: every setlist, every clip, in playing order. */
var rep = diff.mediaReport(A);
check('every transport in the capture is reported',
      rep.transports.length === A.transports.length,
      rep.transports.length + ' vs ' + A.transports.length);
// An automatic setlist is the census of the showfile, and the temptation is to
// drop it as redundant -- every track on it recurs on some named setlist. That
// would leave the only complete inventory out of the inventory.
var autoRep = diff.mediaReport(census);
check('a transport on the automatic setlist is reported, not filtered out',
      autoRep.transports.filter(function (t) { return t.setlist === 'automatic'; }).length === 1,
      JSON.stringify(autoRep.transports.map(function (t) { return t.setlist; })));

check('tracks come back in trackRefs order, not sorted',
      rep.transports.every(function (t, i) {
        return t.tracks.map(function (k) { return k.id; }).join('|') ===
               (A.transports[i].trackRefs || []).map(String).join('|');
      }),
      JSON.stringify(rep.transports[0].tracks.slice(0, 3).map(function (k) { return k.id; })));

// "The order they appear in the timeline". A null tStart has no position, so it
// sorts last rather than to the front as a numeric 0 would put it.
var timed = [];
rep.transports.forEach(function (t) { t.tracks.forEach(function (k) { timed.push(k.items); }); });
check('items are ordered by tStart with nulls last',
      timed.every(function (items) {
        var sawNull = false;
        return items.every(function (it, i) {
          if (it.tStart === null) { sawNull = true; return true; }
          if (sawNull) return false;                       // a time after a null
          return i === 0 || items[i - 1].tStart <= it.tStart;
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
shaped.layerCount = st.layers.length;
shaped.transports = [{ name: 'only', setlist: 'shaped', trackRefs: [st.id], trackCount: 1 }];
var sh = diff.mediaReport(shaped).transports[0].tracks[0];
check('a layer with no media contributes no rows, a layer with two contributes two',
      sh.items.length === 3 &&
      sh.items.filter(function (i) { return i.layer === 'AA empty'; }).length === 0 &&
      sh.items.filter(function (i) { return i.layer === 'BB pair'; }).length === 2,
      JSON.stringify(sh.items.map(function (i) { return i.layer + ':' + i.name; })));
check('the unplaced layer sorts last despite naming first',
      sh.items[2].layer === 'CC unplaced' && sh.items[2].tStart === null,
      JSON.stringify(sh.items.map(function (i) { return i.layer + '@' + i.tStart; })));

// A setlist can name a track that is not in the capture. The corpus has no such
// ref, so it is built: silently dropping it hides a real fault in the show.
var dangling = JSON.parse(JSON.stringify(shaped));
dangling.transports[0].trackRefs = ['no_such_track_id'];
var dg = diff.mediaReport(dangling).transports[0].tracks[0];
check('a dangling trackRef reports missing rather than throwing',
      dg.missing === true && dg.id === 'no_such_track_id' &&
      dg.name === 'no_such_track_id' && dg.items.length === 0,
      JSON.stringify(dg));
check('a track that is present carries no missing flag',
      rep.transports[0].tracks.every(function (k) { return !('missing' in k); }));

check('totals add up to what is in the tree',
      rep.totals.transports === rep.transports.length &&
      rep.totals.tracks === rep.transports.reduce(function (n, t) { return n + t.tracks.length; }, 0) &&
      rep.totals.media === rep.transports.reduce(function (n, t) {
        return n + t.tracks.reduce(function (m, k) { return m + k.items.length; }, 0);
      }, 0),
      JSON.stringify(rep.totals));
check('trackCount and mediaCount match the rows actually listed',
      rep.transports.every(function (t) {
        return t.trackCount === t.tracks.length &&
               t.mediaCount === t.tracks.reduce(function (m, k) { return m + k.items.length; }, 0);
      }));

// This report is per-setlist, so a track on two of them is listed under both
// and its media counted twice -- the opposite of the diff, where a shared track
// deliberately reports once.
if (sharedId) {
  var dup = diff.mediaReport(census).transports.filter(function (t) {
    return t.tracks.some(function (k) { return k.id === sharedId; });
  });
  check('a shared track is listed under every transport that references it',
        dup.length > 1, dup.length + ' transports list ' + sharedId);
}

check('a snapshot with no transports returns empty structures',
      (function () {
        var e = diff.mediaReport({ tracks: A.tracks });
        return e.transports.length === 0 && e.totals.transports === 0 &&
               e.totals.tracks === 0 && e.totals.media === 0;
      })());
check('a transport with no trackRefs returns an empty track list',
      (function () {
        var e = diff.mediaReport({ transports: [{ name: 'x', setlist: 'y' }], tracks: null });
        return e.transports.length === 1 && e.transports[0].tracks.length === 0 &&
               e.transports[0].trackCount === 0 && e.transports[0].mediaCount === 0;
      })());
check('an entirely empty snapshot does not throw',
      (function () { return diff.mediaReport({}).totals.transports === 0; })());

console.log('\n' + (failures ? failures + ' failing' : 'all passing'));
process.exit(failures ? 1 : 0);
