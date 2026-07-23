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
function changedFields(nodes, label) {
  var hit = null;
  (function walk(list) {
    list.forEach(function (n) {
      if (n.label === label) hit = n;
      if (n.children) walk(n.children);
    });
  })(nodes);
  return hit ? (hit.changes || []).map(function (c) { return c.field; }) : null;
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
var refCount = {};
A.transports.forEach(function (tr) {
  (tr.trackRefs || []).forEach(function (id) { refCount[id] = (refCount[id] || 0) + 1; });
});
var sharedId = Object.keys(refCount).filter(function (id) { return refCount[id] > 1; })[0];
if (!sharedId) {
  console.log('  skip a track shared by two transports (none in this capture)');
} else {
  var cut = JSON.parse(JSON.stringify(A));
  cut.tracks = cut.tracks.filter(function (t) { return String(t.id) !== sharedId; });
  cut.transports.forEach(function (tr) {
    tr.trackRefs = (tr.trackRefs || []).filter(function (id) { return String(id) !== sharedId; });
  });
  var gone = findings(diff.diffSnapshots(A, cut).nodes)
    .filter(function (s) { return /^removed track /.test(s); });
  check('a removed shared track is reported once, not per referencing transport',
        gone.length === 1, gone.join(' | '));
}

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

console.log('\nrunning order');
var reordered = JSON.parse(JSON.stringify(A));
reordered.transports[0].trackRefs = reordered.transports[0].trackRefs.slice().reverse();
var ro = diff.diffSnapshots(A, reordered);
check('a reordered setlist is a change even when no track is touched',
      (changedFields(ro.nodes, 'transport ' + A.transports[0].name) || [])
        .indexOf('running order') !== -1,
      JSON.stringify(findings(ro.nodes)));

console.log('\n' + (failures ? failures + ' failing' : 'all passing'));
process.exit(failures ? 1 : 0);
