/* The web app and the iOS app share these files. Staves/Resources/ holds the originals.
 *   node scripts/sync.js          copy them into web/assets/
 *   node scripts/sync.js --check  fail if the copies differ (used by CI) */
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const shared = [
  ['Staves/Resources/engine.js', 'web/assets/engine.js'],
  ['Staves/Resources/abcjs-basic-min.js', 'web/assets/abcjs-basic-min.js'],
  ['Staves/Resources/ABCJS-LICENSE.md', 'web/assets/ABCJS-LICENSE.md'],
  ['Tests/First-light.mid', 'web/assets/First-light.mid']
];
const check = process.argv.includes('--check');
let stale = 0;
for (const [from, to] of shared) {
  const source = fs.readFileSync(path.join(root, from)), target = path.join(root, to);
  if (fs.existsSync(target) && source.equals(fs.readFileSync(target))) continue;
  if (check) { console.error(`Out of date: ${to} (run "npm run sync")`); stale++; }
  else { fs.writeFileSync(target, source); console.log(`Updated ${to}`); }
}
if (stale) process.exit(1);
console.log(check ? 'Shared files are in sync.' : 'Done.');
