const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function testFiles(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? testFiles(filename) : /\.test\.[cm]?js$/.test(entry.name) ? [filename] : [];
  });
}
// These historical suites use demo HTML/JSON fixtures absent from this repo.
// Keep them available explicitly; never copy customer fixtures into CI.
const fixtureSuites = new Set([
  "backlink-port-and-radius-order.test.js",
  "bottom-local-wrap-order.test.js",
  "circular-arc-intersection-regression.test.js",
  "cjm-baggage-backlink-radius.test.js",
  "cjm-fare-self-loop-slots.test.js",
  "cjm-v0-backlink-radius.test.js",
  "cross-band-left-leg-clearance.test.js",
  "desktop-right-radii.test.js",
  "forward-local-circular-near-bottom.test.js",
  "regression-bottom-schedule-search-overlap.test.js",
  "regression-top-baseoffset-and-bundle-order.test.js",
  "right-leg-minlen.test.js",
  "sort-invariants.test.js"
]);
const legacy = process.argv.includes('--legacy');
const files = testFiles(path.join(__dirname, '..', 'test'))
  .filter(filename => fixtureSuites.has(path.basename(filename)) === legacy).sort();
if (!files.length) throw new Error('No test files found');
console.log(`Running ${files.length} ${legacy ? 'fixture-dependent' : 'self-contained'} test suites`);
// Pass actual filenames: Node 20 does not expand quoted glob arguments.
const result = spawnSync(process.execPath, ['--test', ...files], {stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
