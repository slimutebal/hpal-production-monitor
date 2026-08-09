// number-input.js tests (V2.4.1 Bug A -- locale-aware decimal input). See
// this task's Sections 6/9/31/34.
//
// Run with Node's built-in test runner:
//
//   node --test tests/number-input.test.mjs
//
// PURE MODULE: no DOM, no navigator, no i18n -- see number-input.js's own
// header comment. formatDecimalForLocale() tests below always pass an
// explicit locale string (never rely on the CI host's own locale, this
// task's Section 34).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseDecimalInput, formatDecimalForLocale } from '../js/pages/calculate/number-input.js';

describe('parseDecimalInput() -- required examples (this task Section 6)', () => {
  test('"1.15" -> 1.15', () => {
    assert.equal(parseDecimalInput('1.15'), 1.15);
  });
  test('"1,15" -> 1.15', () => {
    assert.equal(parseDecimalInput('1,15'), 1.15);
  });
  test('"0.010" -> 0.01', () => {
    assert.equal(parseDecimalInput('0.010'), 0.01);
  });
  test('"0,010" -> 0.01', () => {
    assert.equal(parseDecimalInput('0,010'), 0.01);
  });
  test('"45" -> 45', () => {
    assert.equal(parseDecimalInput('45'), 45);
  });
});

describe('parseDecimalInput() -- accepted/equivalent examples (this task Section 5)', () => {
  test('"1" -> 1', () => {
    assert.equal(parseDecimalInput('1'), 1);
  });
  test('"45.5" -> 45.5', () => {
    assert.equal(parseDecimalInput('45.5'), 45.5);
  });
  test('"45,5" -> 45.5', () => {
    assert.equal(parseDecimalInput('45,5'), 45.5);
  });
  test('1.15 == 1,15', () => {
    assert.equal(parseDecimalInput('1.15'), parseDecimalInput('1,15'));
  });
  test('0.010 == 0,010', () => {
    assert.equal(parseDecimalInput('0.010'), parseDecimalInput('0,010'));
  });
  test('45.5 == 45,5', () => {
    assert.equal(parseDecimalInput('45.5'), parseDecimalInput('45,5'));
  });
});

describe('parseDecimalInput() -- "1,234" is decimal 1.234, NEVER a thousands separator (this task Section 5)', () => {
  test('"1,234" -> 1.234, not 1234', () => {
    assert.equal(parseDecimalInput('1,234'), 1.234);
  });
});

describe('parseDecimalInput() -- required rejects (this task Sections 6/31)', () => {
  const rejects = ['', 'abc', '1,2,3', '1.2.3', '1,2.3', '1.2,3'];
  rejects.forEach((raw) => {
    test(`${JSON.stringify(raw)} -> null (rejected, never partially parsed)`, () => {
      assert.equal(parseDecimalInput(raw), null);
    });
  });

  test('whitespace-only is rejected', () => {
    assert.equal(parseDecimalInput('   '), null);
  });
  test('a bare sign/separator with no digits is rejected', () => {
    assert.equal(parseDecimalInput('-'), null);
    assert.equal(parseDecimalInput('.'), null);
    assert.equal(parseDecimalInput(','), null);
  });
  test('null/undefined/non-string, non-number input is rejected, never throws', () => {
    assert.equal(parseDecimalInput(null), null);
    assert.equal(parseDecimalInput(undefined), null);
    assert.equal(parseDecimalInput({}), null);
    assert.equal(parseDecimalInput([]), null);
  });
});

describe('parseDecimalInput() -- pasted/whitespace-padded values (this task Section 3)', () => {
  test('leading/trailing whitespace is trimmed before parsing', () => {
    assert.equal(parseDecimalInput('  1.15  '), 1.15);
    assert.equal(parseDecimalInput('  1,15  '), 1.15);
  });
});

describe('parseDecimalInput() -- never NaN, never a garbage-suffix parseFloat() result (this task Section 6)', () => {
  test('a numeric prefix followed by garbage is rejected outright, not truncated to the numeric part', () => {
    assert.equal(parseDecimalInput('1.15xyz'), null);
    assert.equal(parseDecimalInput('1.15 kg'), null);
  });
  test('the function never returns NaN for any input -- always a finite number or null', () => {
    const samples = ['1.15', '1,15', 'abc', '', '1,2,3', '-', Infinity, NaN, null, undefined, {}];
    samples.forEach((raw) => {
      const result = parseDecimalInput(raw);
      assert.ok(result === null || Number.isFinite(result), `unexpected non-finite, non-null result for ${JSON.stringify(raw)}`);
    });
  });
});

describe('parseDecimalInput() -- already-numeric input pass-through (existing pure-engine call convention)', () => {
  test('a finite number is returned as-is', () => {
    assert.equal(parseDecimalInput(1.15), 1.15);
    assert.equal(parseDecimalInput(0), 0);
    assert.equal(parseDecimalInput(-1.2), -1.2);
  });
  test('Infinity/NaN numbers are rejected (null), matching the original Number.isFinite() gate they replace', () => {
    assert.equal(parseDecimalInput(Infinity), null);
    assert.equal(parseDecimalInput(-Infinity), null);
    assert.equal(parseDecimalInput(NaN), null);
  });
});

describe('formatDecimalForLocale() -- device-locale default Tolerance display (this task Sections 9/30/34)', () => {
  test('id-ID formats 0.010 as "0,010" (comma decimal, no grouping, 3 fraction digits)', () => {
    assert.equal(formatDecimalForLocale(0.01, 'id-ID'), '0,010');
  });
  test('en-US formats 0.010 as "0.010"', () => {
    assert.equal(formatDecimalForLocale(0.01, 'en-US'), '0.010');
  });
  test('both id-ID and en-US formatted output round-trips back to the exact same 0.01 via parseDecimalInput()', () => {
    assert.equal(parseDecimalInput(formatDecimalForLocale(0.01, 'id-ID')), 0.01);
    assert.equal(parseDecimalInput(formatDecimalForLocale(0.01, 'en-US')), 0.01);
  });
  test('useGrouping is false -- a large value never gets a thousands separator', () => {
    assert.equal(formatDecimalForLocale(1234, 'en-US'), '1234.000');
    assert.equal(formatDecimalForLocale(1234, 'id-ID'), '1234,000');
  });
  test('exactly 3 fraction digits regardless of trailing zeros', () => {
    assert.equal(formatDecimalForLocale(1, 'en-US'), '1.000');
    assert.equal(formatDecimalForLocale(1.5, 'en-US'), '1.500');
  });
  test('safe fallback to a literal "." when Intl is unavailable, never throws', () => {
    const realIntl = globalThis.Intl;
    try {
      // @ts-ignore -- deliberately breaking Intl to exercise the fallback path
      globalThis.Intl = undefined;
      assert.equal(formatDecimalForLocale(0.01, 'id-ID'), '0.010');
    } finally {
      globalThis.Intl = realIntl;
    }
  });
});
