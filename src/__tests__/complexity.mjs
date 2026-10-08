import ava from 'ava';
import parser from '../index.js';

// Regression tests for the quadratic parsing of flat selectors: `.` and `#` are
// not word delimiters, so `.a.a.a...` reaches splitWord as a single word token
// carrying n class indexes. Three passes used to scan those index arrays
// linearly for every index, making the parse O(n^2):
//
//   1. uniqs(), deduplicating with filter + indexOf
//   2. the indices.forEach loop, calling hasClass.indexOf / hasId.indexOf
//   3. the Sass-interpolation filter, calling interpolations.indexOf
//
// Nesting depth is 0 for such a selector, so maxNestingDepth offers no
// protection. All three now use Set membership tests.

// Large enough that the quadratic passes dominate the parse, small enough to
// stay well inside ava's timeout under nyc instrumentation on every Node
// version in the test matrix.
const N = 30000;

// Wall-clock milliseconds since a process.hrtime() mark. The tuple form is
// used instead of process.hrtime.bigint() so this runs on every Node version
// in the test matrix.
function elapsedMs (start) {
    const diff = process.hrtime(start);
    return diff[0] * 1e3 + diff[1] / 1e6;
}

// Fastest of a few runs, to shrug off GC pauses and scheduling noise.
function fastest (input) {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
        const start = process.hrtime();
        parser().astSync(input);
        best = Math.min(best, elapsedMs(start));
    }
    return best;
}

// Compare the hostile payload (one word token holding N indexes) against a
// benign control of the same repeated atom, space separated, which forces the
// same amount of real parsing work spread over N word tokens. Deriving the
// budget from a measurement taken on the same machine keeps this stable across
// CI runners and under coverage instrumentation, where an absolute time budget
// or a raw input-scaling ratio would not be.
//
// The control does strictly more work than the payload once parsing is linear,
// so a healthy ratio sits below 1. It reached 4-8 while the passes were
// quadratic. The threshold sits well clear of both.
function costRatio (hostileInput, benignInput) {
    const hostile = fastest(hostileInput);
    const benign = fastest(benignInput);
    return hostile / Math.max(benign, 1);
}

for (const [label, atom] of [
    ['flat class selectors', '.a'],
    ['flat id selectors', '#a'],
    ['repeated Sass interpolations', '#{a}'],
]) {
    ava(`${label} parse in time proportional to their size`, (t) => {
        const ratio = costRatio(atom.repeat(N), `${atom} `.repeat(N));
        t.true(
            ratio < 2,
            `parsing "${atom}" repeated ${N} times as one token cost ${ratio.toFixed(1)}x the same atoms parsed separately, which suggests a super-linear pass`
        );
    });
}

// The @keyframes percentage check (`/^\d+\.\d+%$/`) only depends on the whole
// word, yet used to run once per dot. A long leading run of digits makes every
// one of those regex tests scan it, so the payload below was quadratic too.
ava('flat class selectors after a long numeric tag parse in time proportional to their size', (t) => {
    const count = N / 2;
    const prefix = '1'.repeat(count);
    const ratio = costRatio(
        prefix + '.1'.repeat(count),
        prefix + ' ' + '.1 '.repeat(count)
    );
    t.true(
        ratio < 2,
        `parsing "${count} digits + .1 repeated ${count} times" as one token cost ${ratio.toFixed(1)}x the same atoms parsed separately, which suggests a super-linear pass`
    );
});

ava('a large flat selector still produces one node per class', (t) => {
    const tree = parser().astSync('.a'.repeat(20000));
    const nodes = tree.first.nodes;
    t.is(nodes.length, 20000);
    t.true(nodes.every((node) => node.type === 'class' && node.value === 'a'));
});

ava('a numeric tag followed by classes still splits into tag and class nodes', (t) => {
    t.deepEqual(
        parser()
            .astSync('12.a.b')
            .first.nodes.map((node) => [node.type, node.value]),
        [
            ['tag', '12'],
            ['class', 'a'],
            ['class', 'b'],
        ]
    );
});

ava('a @keyframes percentage is still kept as a single tag', (t) => {
    const nodes = parser().astSync('12.5%').first.nodes;
    t.is(nodes.length, 1);
    t.is(nodes[0].type, 'tag');
    t.is(nodes[0].value, '12.5%');
});

// The leading 0 pushed into the index list collides with hasClass[0] or
// hasId[0] whenever the word starts with `.` or `#`, so the deduplication in
// uniqs() is load-bearing: dropping it emits a spurious first node covering the
// whole word. These pin that down.
ava('deduplication keeps a leading class from being emitted twice', (t) => {
    t.deepEqual(
        parser()
            .astSync('.a.b')
            .first.nodes.map((node) => [node.type, node.value]),
        [
            ['class', 'a'],
            ['class', 'b'],
        ]
    );
});

ava('deduplication keeps a leading id from being emitted twice', (t) => {
    t.deepEqual(
        parser()
            .astSync('#x.y')
            .first.nodes.map((node) => [node.type, node.value]),
        [
            ['id', 'x'],
            ['class', 'y'],
        ]
    );
});

ava('a single leading class is emitted once', (t) => {
    const nodes = parser().astSync('.a').first.nodes;
    t.is(nodes.length, 1);
    t.is(nodes[0].type, 'class');
});
