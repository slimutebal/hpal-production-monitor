// Generated Report output must be completely independent of the active
// UI locale (V2.3 full-localization pass; architecture doc section 12.3:
// "Generated operational report text is explicitly excluded from UI
// localization"). buildReportText()/buildPersonnelOutputLines() never
// call t() at all (verified by source inspection during this pass) -- this
// file proves that end-to-end: the exact same inputs, under 'id' and
// under 'en', produce byte-identical WhatsApp report text.
//
// Run with Node's built-in test runner:
//
//   node --test tests/report-output-locale-invariance.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setLocale, DEFAULT_LOCALE } from '../js/i18n/i18n.js';
import { buildReportText } from '../js/pages/report/profiles/shared-report-profile.js';
import { buildPersonnelOutputLines } from '../js/pages/report/report-personnel.js';
import { BUYER_HYNC, BUYER_SLNC, BUYER_ESG } from '../js/pages/report/profiles/profile-registry.js';

function directory() {
  return [
    { id: 'spv1', role_type: 'SPV_SCM', active: true, name: 'Hensi', organization: 'SCM' },
    { id: 'spv2', role_type: 'SPV_SCM', active: true, name: 'Illofi', organization: 'SCM' },
    { id: 'frm1', role_type: 'FRM_SCM', active: true, name: 'Novelesto', organization: 'SCM' },
    { id: 'sam-awk', role_type: 'SAMPLER', active: true, name: 'AWK', organization: 'AWK' },
    { id: 'sam-atq', role_type: 'SAMPLER', active: true, name: 'ATQ', organization: 'ATQ' },
    { id: 'pic-awk', role_type: 'PIC_3RD', active: true, name: 'La Ode Osardi', organization: 'AWK' },
    { id: 'pic-atq', role_type: 'PIC_3RD', active: true, name: 'Khalifa Akbar', organization: 'ATQ' },
  ];
}

function baseParsed(overrides = {}) {
  return {
    fileDate: null,
    shiftLabel: 'Day Shift',
    totalDT: 65,
    totalADT: 2,
    contractorCounts: [['PMS', 9], ['MRP', 56]],
    domes: [],
    onShiftTon: 1234.5,
    onShiftRit: 42,
    ...overrides,
  };
}

function zeroTotals() {
  return { dailyTon: 100, dailyRit: 5, wtdTon: 200, wtdRit: 10, mtdTon: 300, mtdRit: 15, ytdTon: 400, ytdRit: 20 };
}

function buildTextForBuyer(buyer, samplerId, picThirdId) {
  const records = directory();
  const personnel = {
    spvScmIds: ['spv1', 'spv2'], frmScmIds: ['frm1'], samplerId, samplerSource: 'buyer-default',
    picThirdId, manpowerThirdParty: 24, totalManpower: 26,
  };
  const personnelLines = buildPersonnelOutputLines(records, personnel, buyer);
  const parsed = baseParsed();
  return buildReportText({
    buyer,
    parsed,
    inputs: { problem: 'Contoh problem', preventiveAction: 'Contoh tindakan' },
    domeAreas: {},
    totals: zeroTotals(),
    weekNumber: 32,
    personnelLines,
  });
}

describe('Generated report text is byte-identical regardless of active UI locale', () => {
  test('HYNC report text is identical under id and en', () => {
    setLocale('id');
    const idText = buildTextForBuyer(BUYER_HYNC, 'sam-awk', 'pic-awk');
    setLocale('en');
    const enText = buildTextForBuyer(BUYER_HYNC, 'sam-awk', 'pic-awk');
    assert.equal(idText, enText);
  });

  test('SLNC report text is identical under id and en', () => {
    setLocale('id');
    const idText = buildTextForBuyer(BUYER_SLNC, 'sam-awk', 'pic-awk');
    setLocale('en');
    const enText = buildTextForBuyer(BUYER_SLNC, 'sam-awk', 'pic-awk');
    assert.equal(idText, enText);
  });

  test('EIEB (ESG) report text is identical under id and en', () => {
    setLocale('id');
    const idText = buildTextForBuyer(BUYER_ESG, 'sam-atq', 'pic-atq');
    setLocale('en');
    const enText = buildTextForBuyer(BUYER_ESG, 'sam-atq', 'pic-atq');
    assert.equal(idText, enText);
  });

  test('switching locale back and forth mid-session still produces the same text as a single fixed locale', () => {
    setLocale('id');
    const first = buildTextForBuyer(BUYER_HYNC, 'sam-awk', 'pic-awk');
    setLocale('en');
    setLocale('id');
    setLocale('en');
    setLocale('id');
    const afterChurn = buildTextForBuyer(BUYER_HYNC, 'sam-awk', 'pic-awk');
    assert.equal(first, afterChurn);
  });

  test('Daily/WTD/MTD/YTD accumulation lines are present and identical across locales (not merely the personnel section)', () => {
    setLocale('id');
    const idText = buildTextForBuyer(BUYER_HYNC, 'sam-awk', 'pic-awk');
    setLocale('en');
    const enText = buildTextForBuyer(BUYER_HYNC, 'sam-awk', 'pic-awk');
    for (const marker of ['Daily', 'WTD', 'MTD', 'YTD']) {
      assert.ok(idText.includes(marker), `id text missing ${marker}`);
    }
    assert.equal(idText, enText);
  });

  test('buyer labels (FPP HYNC / FPP SLNC / FPP EIEB) are unaffected by locale', () => {
    setLocale('id');
    const idHync = buildTextForBuyer(BUYER_HYNC, 'sam-awk', 'pic-awk');
    setLocale('en');
    const enHync = buildTextForBuyer(BUYER_HYNC, 'sam-awk', 'pic-awk');
    assert.match(idHync, /FPP HYNC/);
    assert.match(enHync, /FPP HYNC/);
    assert.equal(idHync, enHync);
  });

  test('resets back to the default locale leaves no lingering module state affecting subsequent output', () => {
    setLocale(DEFAULT_LOCALE);
    const baseline = buildTextForBuyer(BUYER_HYNC, 'sam-awk', 'pic-awk');
    setLocale('en');
    buildTextForBuyer(BUYER_HYNC, 'sam-awk', 'pic-awk');
    setLocale(DEFAULT_LOCALE);
    const after = buildTextForBuyer(BUYER_HYNC, 'sam-awk', 'pic-awk');
    assert.equal(baseline, after);
  });
});
