// Load csv-utils (browser script, no module.exports)
const fs = require('fs');
const vm = require('vm');
const csvSrc = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'csv-utils.js'), 'utf8');
const ctx = { ADS_COLS: null, blankAdsRow: null, buildAdsCSV: null };
vm.runInNewContext(csvSrc, ctx);
const { blankAdsRow, buildAdsCSV } = ctx;
const D = 'Bob Weaver Collision', city = 'Pottsville', st = 'PA';
const url = 'https://bobweavercollision.com/', lat = 40.6856, lng = -76.1955, rad = 40;
const rows = [];

function CR(n) {
  const r = blankAdsRow(); r.Campaign = n; r['Campaign Type'] = 'Search'; r.Networks = 'Google search';
  r['Budget name'] = 'Main'; r.Budget = '59'; r['Budget type'] = 'Daily';
  r['EU political ads'] = "Doesn't have EU political ads"; r['Standard conversion goals'] = 'Account-level';
  r['Customer acquisition'] = 'Bid equally'; r.Languages = 'en'; r['Bid Strategy Type'] = 'Manual CPC';
  r['Enhanced CPC'] = 'Disabled'; r['Broad match keywords'] = 'Off'; r['Ad rotation'] = 'Optimize for clicks';
  r['Targeting method'] = 'Location of presence'; r['Exclusion method'] = 'Location of presence';
  r['AI Max'] = 'Disabled'; r['Text customization'] = 'Disabled'; r['Final URL expansion'] = 'Disabled';
  r['Image enhancement'] = 'Disabled'; r['Image generation'] = 'Disabled';
  r['Landing page images'] = 'Disabled'; r['Video enhancement'] = 'Disabled';
  r['Brand guidelines'] = 'Disabled'; r['Campaign Status'] = 'Enabled'; r['Start Date'] = '2026-04-14';
  r['Ad Schedule'] = '(Monday[08:00-18:00]);(Tuesday[08:00-18:00]);(Wednesday[08:00-18:00]);(Thursday[08:00-18:00]);(Friday[08:00-18:00]);(Saturday[08:00-14:00])';
  return r;
}

function AG(c, a, cpc) {
  const r = blankAdsRow(); r.Campaign = c; r['Ad Group'] = a; r['Max CPC'] = String(cpc);
  r.Languages = 'All'; r['Audience targeting'] = 'Audience segments';
  r['Flexible Reach'] = 'Audience segments;Genders;Ages;Parental status;Household incomes';
  r['Max CPM'] = '0.01'; r['Target CPV'] = '0.01'; r['Target CPM'] = '0.01';
  r['Optimized targeting'] = 'Disabled'; r['Strict age and gender targeting'] = 'Disabled';
  r['Search term matching'] = 'Enabled'; r['Ad Group Type'] = 'Standard';
  r['Campaign Status'] = 'Enabled'; r['Ad Group Status'] = 'Enabled';
  return r;
}

function KW(c, a, k, t) {
  const r = blankAdsRow(); r.Campaign = c; r['Ad Group'] = a; r.Keyword = k; r['Criterion Type'] = t;
  if (!t.startsWith('Negative')) { r['Campaign Status'] = 'Enabled'; r['Ad Group Status'] = 'Enabled'; r.Status = 'Enabled'; }
  return r;
}

function AD(c, a, hl, ds, p1, p2) {
  const r = blankAdsRow(); r.Campaign = c; r['Ad Group'] = a;
  for (let i = 0; i < Math.min(hl.length, 15); i++) { r['Headline ' + (i+1)] = hl[i].slice(0, 30); r['Headline ' + (i+1) + ' position'] = '-'; }
  for (let i = 0; i < Math.min(ds.length, 4); i++) { r['Description ' + (i+1)] = ds[i].slice(0, 90); r['Description ' + (i+1) + ' position'] = '-'; }
  r['Path 1'] = (p1 || '').slice(0, 15); r['Path 2'] = (p2 || '').slice(0, 15); r['Final URL'] = url;
  r['Ad type'] = 'Responsive search ad'; r['Campaign Status'] = 'Enabled'; r['Ad Group Status'] = 'Enabled'; r.Status = 'Enabled';
  return r;
}

function LOC(c) {
  const r = blankAdsRow(); r.Campaign = c;
  r.Location = '(' + rad + 'mi:' + lat.toFixed(6) + ':' + lng.toFixed(6) + ')';
  r.Radius = String(rad); r.Unit = 'mi'; r['Campaign Status'] = 'Enabled'; r.Status = 'Enabled';
  rows.push(r);
}

// ── Service Headlines & Descriptions ──
const sHL = [
  'Bob Weaver Collision', 'Collision Repair Experts', 'Auto Body Shop Pottsville',
  'Free Estimates Available', 'Insurance Claims Welcome', 'Quality Collision Repair',
  'Certified Body Shop', 'Expert Auto Body Work', 'Pottsville, PA',
  'Dent & Paint Repair', 'Fast Turnaround Times', 'All Makes & Models',
  'Professional Results', 'Serving Schuylkill County', 'Call Us Today'
];
const sDS = [
  'Professional Collision Repair & Auto Body Services. Free Estimates. Call Today!',
  'Expert Auto Body Shop Serving Pottsville & Schuylkill County. All Insurance Accepted!',
  'Quality Collision Repair, Dent Removal & Paint Services. Fast Turnaround Times!',
  'Proudly Serving Pottsville, PA & Surrounding Areas. Visit Bob Weaver Collision!'
];

// ── Services Campaign (consolidated) ──
const svc = D + ' - Services';
rows.push(CR(svc));
LOC(svc);

const gs = [
  ['SD: Collision Repair', ['Collision Repair', 'Collision Repair Near Me'], ['Body Shop', 'Dent', 'Paint'], 'Collision', 'Repair'],
  ['SD: Collision Center', ['Collision Center', 'Collision Center Near Me'], ['Body Shop', 'Dent'], 'Collision', 'Center'],
  ['SD: Collision Pottsville', ['Collision Repair Pottsville', 'Collision Repair Pottsville PA'], ['Body Shop', 'Dent', 'Paint'], 'Collision', 'Pottsville'],
  ['SD: Body Shop', ['Body Shop', 'Body Shop Near Me'], ['Collision', 'Dent', 'Paint'], 'Body-Shop', ''],
  ['SD: Auto Body Shop', ['Auto Body Shop', 'Auto Body Shop Near Me'], ['Collision', 'Dent'], 'Auto-Body', 'Shop'],
  ['SD: Auto Body Repair', ['Auto Body Repair', 'Auto Body Repair Near Me'], ['Collision', 'Dent', 'Paint'], 'Auto-Body', 'Repair'],
  ['SD: Body Shop Pottsville', ['Body Shop Pottsville', 'Auto Body Shop Pottsville'], ['Collision', 'Dent'], 'Body-Shop', 'Pottsville'],
  ['SD: Auto Paint Repair', ['Auto Paint Repair', 'Car Paint Repair Near Me'], ['Collision', 'Dent', 'Body Shop'], 'Paint', 'Repair'],
  ['SD: Paint Scratch Repair', ['Paint Scratch Repair', 'Paint Scratch Repair Near Me'], ['Collision', 'Dent', 'Body Shop'], 'Paint', 'Scratch'],
  ['SD: Dent Repair', ['Dent Repair', 'Dent Repair Near Me'], ['Collision', 'Body Shop', 'Paint'], 'Dent', 'Repair'],
  ['SD: Paintless Dent Repair', ['Paintless Dent Repair', 'PDR Near Me'], ['Collision', 'Body Shop', 'Paint'], 'Dent', 'PDR'],
  ['SD: Hail Damage Repair', ['Hail Damage Repair', 'Hail Damage Repair Near Me'], ['Collision', 'Body Shop'], 'Hail', 'Repair'],
  ['SD: Dent Removal', ['Dent Removal', 'Door Ding Repair'], ['Collision', 'Body Shop', 'Paint'], 'Dent', 'Removal'],
];

gs.forEach(g => {
  rows.push(AG(svc, g[0], 9));
  g[2].forEach(n => rows.push(KW(svc, g[0], n, 'Negative Phrase')));
  g[1].forEach(k => { rows.push(KW(svc, g[0], k, 'Exact')); rows.push(KW(svc, g[0], k, 'Phrase')); });
  rows.push(AD(svc, g[0], sHL, sDS, g[3], g[4]));
});

// ── Brand Campaign ──
const bCamp = D + ' - Brand';
rows.push(CR(bCamp));
LOC(bCamp);

const bHL = [
  'Bob Weaver Collision', 'Visit Bob Weaver Collision', 'Proudly Serving Pottsville',
  'Bob Weaver - Pottsville', 'Free Estimates Available', 'Insurance Claims Welcome',
  'Quality Collision Repair', 'Certified Body Shop', 'Expert Auto Body Work',
  'Fast Turnaround Times', 'All Makes & Models', 'Professional Results',
  'Serving Schuylkill County', 'Call Us Today', 'Trusted Local Body Shop'
];
const bDS = [
  'Bob Weaver Collision - Professional Auto Body & Collision Repair in Pottsville!',
  'Trusted Collision Repair Serving Pottsville & Surrounding Areas. Free Estimates!',
  'Expert Auto Body, Dent Repair & Paint Services. All Insurance Accepted!',
  'Proudly Serving Pottsville, PA & Schuylkill County. Call Bob Weaver Collision!'
];

rows.push(AG(bCamp, 'SDB: Bob Weaver Collision', 3));
['Bob Weaver Collision', 'Bob Weaver Auto Body', 'Bob Weaver Body Shop', 'Bob Weaver Collision Center'].forEach(k => {
  rows.push(KW(bCamp, 'SDB: Bob Weaver Collision', k, 'Exact'));
  rows.push(KW(bCamp, 'SDB: Bob Weaver Collision', k, 'Phrase'));
});
rows.push(AD(bCamp, 'SDB: Bob Weaver Collision', bHL, bDS, 'Bob-Weaver', 'Collision'));

// ── Output ──
const csv = buildAdsCSV(rows);
require('fs').writeFileSync('C:/Users/bprev/Desktop/Bob_Weaver_Collision_Restructured.csv', '\ufeff' + csv, 'utf16le');

// Stats
console.log('=== BOB WEAVER COLLISION - RESTRUCTURED ===');
console.log('Campaigns: 2 (Services + Brand)');
console.log('Ad Groups: ' + (gs.length + 1));
console.log('Total rows: ' + rows.length);

let mh = 0, md = 0;
rows.filter(r => r['Ad type'] === 'Responsive search ad').forEach(r => {
  for (let i = 1; i <= 15; i++) { const h = (r['Headline ' + i] || ''); if (h.length > mh) mh = h.length; }
  for (let i = 1; i <= 4; i++) { const d = (r['Description ' + i] || ''); if (d.length > md) md = d.length; }
});
console.log('Max headline: ' + mh + (mh > 30 ? ' FAIL' : ' OK'));
console.log('Max description: ' + md + (md > 90 ? ' FAIL' : ' OK'));
console.log('Brand CPC: $3 | Service CPC: $9');
console.log('Saved: Bob_Weaver_Collision_Restructured.csv');
