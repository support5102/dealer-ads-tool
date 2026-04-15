const fs = require('fs');
const vm = require('vm');
const csvSrc = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'csv-utils.js'), 'utf8');
const ctx = {};
vm.runInNewContext(csvSrc, ctx);
const { blankAdsRow, buildAdsCSV } = ctx;

const D = 'SRQ Auto';
const url = 'https://www.srqauto.com/buses-for-sale-in-bradenton-fl';
const wheelchairUrl = 'https://www.srqauto.com/buses-for-sale-in-bradenton-fl';
const lat = 27.336434, lng = -82.530653, rad = 25;
const rows = [];

function CR(name, budget) {
  const r = blankAdsRow();
  r['Campaign'] = name; r['Campaign Type'] = 'Search'; r['Networks'] = 'Google search';
  r['Budget name'] = budget || 'Main'; r['Budget'] = '50'; r['Budget type'] = 'Daily';
  r['EU political ads'] = "Doesn't have EU political ads"; r['Standard conversion goals'] = 'Account-level';
  r['Customer acquisition'] = 'Bid equally'; r['Languages'] = 'en';
  r['Bid Strategy Type'] = 'Manual CPC'; r['Enhanced CPC'] = 'Disabled';
  r['Broad match keywords'] = 'Off'; r['Ad rotation'] = 'Optimize for clicks';
  r['Targeting method'] = 'Location of presence'; r['Exclusion method'] = 'Location of presence';
  r['Audience targeting'] = 'Audience segments'; r['Flexible Reach'] = 'Audience segments';
  r['AI Max'] = 'Disabled'; r['Text customization'] = 'Disabled'; r['Final URL expansion'] = 'Disabled';
  r['Image enhancement'] = 'Disabled'; r['Image generation'] = 'Disabled';
  r['Landing page images'] = 'Disabled'; r['Video enhancement'] = 'Disabled';
  r['Brand guidelines'] = 'Disabled'; r['Campaign Status'] = 'Enabled';
  r['Start Date'] = '2026-04-15';
  return r;
}

function AG(camp, ag, cpc) {
  const r = blankAdsRow();
  r['Campaign'] = camp; r['Ad Group'] = ag; r['Max CPC'] = String(cpc);
  r['Languages'] = 'All'; r['Audience targeting'] = 'Audience segments';
  r['Flexible Reach'] = 'Audience segments;Genders;Ages;Parental status;Household incomes';
  r['Max CPM'] = '0.01'; r['Target CPV'] = '0.01'; r['Target CPM'] = '0.01';
  r['Optimized targeting'] = 'Disabled'; r['Strict age and gender targeting'] = 'Disabled';
  r['Search term matching'] = 'Enabled'; r['Ad Group Type'] = 'Standard';
  r['Campaign Status'] = 'Enabled'; r['Ad Group Status'] = 'Enabled';
  return r;
}

function KW(camp, ag, kw, type) {
  const r = blankAdsRow();
  r['Campaign'] = camp; r['Ad Group'] = ag; r['Keyword'] = kw; r['Criterion Type'] = type;
  if (!type.startsWith('Negative')) {
    r['Campaign Status'] = 'Enabled'; r['Ad Group Status'] = 'Enabled'; r['Status'] = 'Enabled';
  }
  return r;
}

function AD(camp, ag, hl, ds, p1, p2, finalUrl) {
  const r = blankAdsRow();
  r['Campaign'] = camp; r['Ad Group'] = ag;
  for (let i = 0; i < Math.min(hl.length, 15); i++) {
    r['Headline ' + (i+1)] = hl[i].slice(0, 30);
    r['Headline ' + (i+1) + ' position'] = '-';
  }
  for (let i = 0; i < Math.min(ds.length, 4); i++) {
    r['Description ' + (i+1)] = ds[i].slice(0, 90);
    r['Description ' + (i+1) + ' position'] = '-';
  }
  r['Path 1'] = (p1 || '').slice(0, 15); r['Path 2'] = (p2 || '').slice(0, 15);
  r['Final URL'] = finalUrl; r['Ad type'] = 'Responsive search ad';
  r['Campaign Status'] = 'Enabled'; r['Ad Group Status'] = 'Enabled'; r['Status'] = 'Enabled';
  return r;
}

function LOC(camp) {
  const r = blankAdsRow();
  r['Campaign'] = camp;
  r['Location'] = '(' + rad + 'mi:' + lat.toFixed(6) + ':' + lng.toFixed(6) + ')';
  r['Radius'] = String(rad); r['Unit'] = 'mi';
  r['Campaign Status'] = 'Enabled'; r['Status'] = 'Enabled';
  rows.push(r);
}

// ── Campaign: SRQ Auto - Shuttle Buses ──
const camp = 'SRQ Auto - Shuttle Buses';
rows.push(CR(camp, 'Main'));
LOC(camp);

// General shuttle bus headlines
const sHL = [
  'SRQ Auto',
  'Shuttle Buses For Sale',
  'Used Shuttle Buses',
  'Passenger Buses In Stock',
  'Commercial Shuttle Buses',
  'Great Prices & Selection',
  'Financing Available',
  'Bradenton, FL',
  'Shuttle Bus Dealer',
  'Quality Used Buses',
  'Many Buses To Choose From',
  'Shop Our Full Inventory',
  'View Our Bus Selection',
  'Proudly Serving Bradenton',
  'Call Us Today',
];

// Wheelchair shuttle headlines
const wHL = [
  'SRQ Auto',
  'Wheelchair Shuttle Buses',
  'ADA Accessible Buses',
  'Wheelchair Lift Buses',
  'ADA Shuttle Bus For Sale',
  'Wheelchair Ready Buses',
  'Great Prices & Selection',
  'Financing Available',
  'Bradenton, FL',
  'ADA Compliant Buses',
  'Wheelchair Equipped Buses',
  'Accessible Transport',
  'Shop Our Full Inventory',
  'Proudly Serving Bradenton',
  'Call Us Today',
];

const sDS = [
  'Browse Our Used Shuttle Bus Inventory. Great Prices On Passenger & Commercial Buses!',
  'Visit SRQ Auto For Quality Used Shuttle Buses. Financing Available!',
  'Huge Selection Of Shuttle Buses In Stock. Schedule Your Visit Today!',
  'Proudly Serving Bradenton & Surrounding Areas. Quality Commercial Vehicles!',
];

const wDS = [
  'ADA Accessible Wheelchair Shuttle Buses For Sale. Great Prices & Selection!',
  'Wheelchair Lift Equipped Shuttle Buses In Stock. Financing Available!',
  'Quality Used Wheelchair Accessible Buses. Schedule Your Visit Today!',
  'Proudly Serving Bradenton & Surrounding Areas. ADA Compliant Buses In Stock!',
];

// Ad groups
const groups = [
  // General shuttle buses
  ['SD: Shuttle Bus For Sale', ['Shuttle Bus For Sale', 'Shuttle Buses For Sale'], ['Wheelchair', 'ADA', 'Accessible'], 'Shuttle', 'Bus', sHL, sDS, url],
  ['SD: Used Shuttle Bus', ['Used Shuttle Bus', 'Used Shuttle Bus For Sale'], ['Wheelchair', 'ADA', 'Accessible'], 'Used', 'Shuttle-Bus', sHL, sDS, url],
  ['SD: Shuttle Bus', ['Shuttle Bus', 'Shuttle Bus Near Me'], ['Wheelchair', 'ADA', 'Accessible', 'For Sale'], 'Shuttle', 'Bus', sHL, sDS, url],
  ['SD: Passenger Bus', ['Passenger Bus For Sale', 'Used Passenger Bus'], ['Wheelchair', 'ADA', 'Shuttle'], 'Passenger', 'Bus', sHL, sDS, url],
  ['SD: Passenger Van For Sale', ['Passenger Van For Sale', 'Used Passenger Van'], ['Wheelchair', 'ADA', 'Shuttle'], 'Passenger', 'Van', sHL, sDS, url],
  ['SD: 15 Passenger Bus', ['15 Passenger Bus For Sale', '15 Passenger Bus'], ['Wheelchair', 'ADA'], '15-Passenger', 'Bus', sHL, sDS, url],
  ['SD: 12 Passenger Bus', ['12 Passenger Bus For Sale', '12 Passenger Bus'], ['Wheelchair', 'ADA'], '12-Passenger', 'Bus', sHL, sDS, url],
  ['SD: Shuttle Bus Dealer', ['Shuttle Bus Dealer', 'Shuttle Bus Dealer Near Me'], ['Wheelchair', 'ADA'], 'Shuttle-Bus', 'Dealer', sHL, sDS, url],
  ['SD: Commercial Bus', ['Commercial Bus For Sale', 'Used Commercial Bus'], ['Wheelchair', 'ADA', 'Shuttle'], 'Commercial', 'Bus', sHL, sDS, url],
  ['SD: Church Bus', ['Church Bus For Sale', 'Used Church Bus'], ['Wheelchair', 'ADA'], 'Church', 'Bus', sHL, sDS, url],
  // Wheelchair / ADA shuttle buses
  ['SD: Wheelchair Bus', ['Wheelchair Bus For Sale', 'Wheelchair Bus'], ['Church'], 'Wheelchair', 'Bus', wHL, wDS, wheelchairUrl],
  ['SD: Wheelchair Shuttle Bus', ['Wheelchair Shuttle Bus', 'Wheelchair Shuttle Bus For Sale'], ['Church'], 'Wheelchair', 'Shuttle', wHL, wDS, wheelchairUrl],
  ['SD: ADA Shuttle Bus', ['ADA Shuttle Bus For Sale', 'ADA Shuttle Bus'], ['Church'], 'ADA', 'Shuttle-Bus', wHL, wDS, wheelchairUrl],
  ['SD: ADA Bus For Sale', ['ADA Bus For Sale', 'ADA Accessible Bus'], ['Church', 'Shuttle'], 'ADA', 'Bus', wHL, wDS, wheelchairUrl],
  ['SD: Wheelchair Van', ['Wheelchair Accessible Van', 'Wheelchair Van For Sale'], ['Church', 'Shuttle'], 'Wheelchair', 'Van', wHL, wDS, wheelchairUrl],
  ['SD: Wheelchair Lift Bus', ['Wheelchair Lift Bus', 'Bus With Wheelchair Lift'], ['Church'], 'Wheelchair', 'Lift-Bus', wHL, wDS, wheelchairUrl],
  ['SD: Handicap Bus', ['Handicap Bus For Sale', 'Handicap Accessible Bus'], ['Church', 'Shuttle'], 'Handicap', 'Bus', wHL, wDS, wheelchairUrl],
  ['SD: Accessible Bus', ['Accessible Bus For Sale', 'Accessible Shuttle Bus'], ['Church'], 'Accessible', 'Bus', wHL, wDS, wheelchairUrl],
];

groups.forEach(g => {
  const [agName, kws, negs, p1, p2, hl, ds, finalUrl] = g;
  rows.push(AG(camp, agName, 9));
  negs.forEach(n => rows.push(KW(camp, agName, n, 'Negative Phrase')));
  kws.forEach(k => {
    rows.push(KW(camp, agName, k, 'Exact'));
    rows.push(KW(camp, agName, k, 'Phrase'));
  });
  rows.push(AD(camp, agName, hl, ds, p1, p2, finalUrl));
});

// Output
const csv = buildAdsCSV(rows);
fs.writeFileSync('C:/Users/bprev/Desktop/SRQ_Auto_Shuttle_Buses.csv', '\ufeff' + csv, 'utf16le');

// Verify
const adRows = rows.filter(r => r['Ad type'] === 'Responsive search ad');
const pinned = adRows.filter(r => { for(let i=1;i<=15;i++){const v=(r['Headline '+i+' position']||'').trim();if(v&&v!=='-')return true;}return false; });
const posKws = rows.filter(r => r['Keyword'] && r['Criterion Type'] && !r['Criterion Type'].startsWith('Negative'));
const kwsWithCpc = posKws.filter(r => r['Max CPC'] && r['Max CPC'].trim() !== '');
let mh=0,md=0;
adRows.forEach(r=>{for(let i=1;i<=15;i++){const h=(r['Headline '+i]||'');if(h.length>mh)mh=h.length;}for(let i=1;i<=4;i++){const d=(r['Description '+i]||'');if(d.length>md)md=d.length;}});

console.log('=== SRQ AUTO - SHUTTLE BUSES ===');
console.log('Campaign: ' + camp);
console.log('Ad Groups: ' + groups.length + ' (10 general + 8 wheelchair/ADA)');
console.log('Positive Keywords: ' + posKws.length);
console.log('RSA Ads: ' + adRows.length);
console.log('Pinned Ads: ' + pinned.length + (pinned.length ? ' FAIL' : ' OK'));
console.log('Keywords with CPC: ' + kwsWithCpc.length + (kwsWithCpc.length ? ' FAIL' : ' OK'));
console.log('Max headline: ' + mh + (mh > 30 ? ' FAIL' : ' OK'));
console.log('Max description: ' + md + (md > 90 ? ' FAIL' : ' OK'));
console.log('Total rows: ' + rows.length);
console.log('Saved: SRQ_Auto_Shuttle_Buses.csv');
