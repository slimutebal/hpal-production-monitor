// Calculate page (V2.4 Phase 2 -- Blend Calculator; compact mobile input
// grid revision). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md.
//
// Phase 2 implements Blend mode ONLY. "Jumlah Unit" here means DT/loads
// ACTUALLY USED -- a fully approved, unambiguous meaning, unlike
// Recommendation mode's still-blocked Gate A semantics (architecture doc
// Section 13.1). This module renders NO Recommendation tab, Target Ni,
// tolerance, Hopper Pattern, Unit/Tonnage Ratio recommendation, USE/
// LIMIT/STOP, or Recovery UI -- those all remain gated behind Gate A and
// later phases (Section 40).
//
// INPUT MODEL: a compact CSS-Grid table (PILE | NI | DT | t/DT | remove)
// replaces the earlier one-pile-per-card layout, and there is no more
// "+ Add Pile" button -- the grid always keeps exactly ONE trailing blank
// row. Typing into any field of that trailing row appends a fresh blank
// row after it (see buildPileRow()'s own 'input' handler); the trailing
// blank row itself is excluded from validation/calculation and never
// shows a remove control. This is a pure UI/interaction revision -- the
// weighted-Ni math (blend-calculator.js), validation rules
// (calculate-validation.js), ore classification (js/shared/
// ore-classification.js), and the FULL_ACCESS guard below are all
// byte-for-byte unchanged from the prior card-based layout.
//
// DOM CONSTRUCTION: everything here is built via document.createElement()/
// appendChild()/replaceChildren(), never innerHTML template strings --
// same convention report-page.js/settings-page.js already use for their
// own repeatable rows (buildPersonRow(), buildQueueRow()), just applied
// to this page's entire tree (shell included) rather than only its rows.
//
// Built once into #page-calculate and never rebuilt on route change
// (report-page.js/settings-page.js's "build markup once" convention).
// Session state (entered pile rows, the last computed result) lives in
// this module's own top-level variables, not localStorage (architecture
// doc Section 23/34) -- it survives Calculate -> Monitor -> Calculate
// navigation because the page DOM/module is never destroyed, and is
// intentionally lost on a real reload/PWA restart.
//
// PURE/DOM SEPARATION: all actual math (classifyOre, calculatePileTonnage,
// calculateWeightedBlend) and validation (validatePiles, isRowBlank) live
// in js/shared/ore-classification.js, ./blend-calculator.js, and
// ./calculate-validation.js -- none of those import DOM, router, i18n, or
// localStorage. This file is the one DOM-touching layer: it parses raw
// input strings, calls the pure functions, and formats/localizes the
// result for display.
import { t, onLocaleChange } from '../../i18n/i18n.js';
import { navigateTo } from '../../router.js';
import { hasFullAccess, requestFullAccessAttention } from '../../services/license-service.js';
import { fmtTon, fmtRit } from '../report/report-utils.js';
import { classifyOre } from '../../shared/ore-classification.js';
import { calculatePileTonnage, calculateWeightedBlend } from './blend-calculator.js';
import { validatePiles, toNumericPile, isRowBlank } from './calculate-validation.js';

const ORE_CLASSES = ['HGLO', 'MGLO', 'LGLO'];
const EM_DASH = '—';

let page = null;
let els = null;

// Session state (in-memory only -- see header comment). pileRows holds
// the RAW string values a text input hands back (never coerced to number
// until an explicit Calculate Blend press validates and converts them).
// INVARIANT maintained throughout this file: pileRows[pileRows.length-1]
// (the trailing row) is always blank (isRowBlank() true) except for the
// single instant inside a field's own 'input' handler between updating
// its value and appending the next blank row.
let pileRows = [];
let pileErrors = null; // null, or an array parallel to the ACTIVE (non-trailing-blank) rows -- see handleCalculateBlend()
let blendErrorKey = null; // null, or an i18n key
let lastResult = null; // null, or the ok:true result from calculateWeightedBlend()
let rowSeq = 0;

export function initCalculatePage() {
  page = document.getElementById('page-calculate');
  if (!page) return;

  pileRows = [createBlankPileRow()];
  pileErrors = null;
  blendErrorKey = null;
  lastResult = null;

  els = buildShell();
  page.replaceChildren(els.shell);
  updateStaticLabels();
  renderGridBody();
  renderBlendError();

  onLocaleChange(handleLocaleChange);
}

function handleLocaleChange() {
  updateStaticLabels();
  // Everything below is dynamic (interpolated numbers/derived badges), so
  // it is rebuilt straight from the current pileRows/pileErrors/
  // blendErrorKey/lastResult STATE, never from the outgoing DOM -- entered
  // values and any currently-shown result/errors survive the locale
  // switch unchanged (architecture doc Section 23's "switching language
  // must not erase inputs").
  renderGridBody();
  renderBlendError();
  renderResult();
}

function createBlankPileRow() {
  rowSeq += 1;
  return { key: rowSeq, pileId: '', contractor: '', ni: '', units: '', tonnesPerUnit: '' };
}

// Pops any (normally at most one) trailing blank row(s), then pushes
// exactly one fresh blank row -- restores the trailing-blank-row
// invariant after a structural change (Remove Pile). Never leaves zero
// rows: even removing the very last active row still ends with exactly
// one blank row.
function ensureExactlyOneTrailingBlankRow() {
  while (pileRows.length > 0 && isRowBlank(pileRows[pileRows.length - 1])) {
    pileRows.pop();
  }
  pileRows.push(createBlankPileRow());
}

/* ============================================================
   SHELL -- built once, direct references kept for every static label so
   a locale change can update them in place without rebuilding the whole
   page (updateStaticLabels() below).
============================================================ */
function buildShell() {
  const shell = document.createElement('div');
  shell.className = 'calculate-shell';
  shell.id = 'calculate-shell';

  const header = document.createElement('header');
  header.className = 'calculate-header';

  const title = document.createElement('h1');
  title.className = 'calculate-title';

  const subtitle = document.createElement('p');
  subtitle.className = 'calculate-subtitle';

  header.appendChild(title);
  header.appendChild(subtitle);
  shell.appendChild(header);

  const blendSectionLabel = document.createElement('h2');
  blendSectionLabel.className = 'calculate-section-label';
  shell.appendChild(blendSectionLabel);

  const grid = document.createElement('div');
  grid.className = 'calculate-grid';
  grid.id = 'calculate-grid';
  grid.setAttribute('role', 'table');

  const gridHeader = buildGridHeaderRow();
  grid.appendChild(gridHeader.row);

  const gridBody = document.createElement('div');
  gridBody.className = 'calculate-grid-body';
  gridBody.id = 'calculate-grid-body';
  gridBody.setAttribute('role', 'rowgroup');
  grid.appendChild(gridBody);

  shell.appendChild(grid);

  const blendError = document.createElement('p');
  blendError.className = 'calculate-blend-error';
  blendError.id = 'calculate-blend-error';
  blendError.setAttribute('role', 'alert');
  blendError.hidden = true;
  shell.appendChild(blendError);

  const calcBtnRow = document.createElement('div');
  calcBtnRow.className = 'calculate-btn-row';
  const calculateBtn = document.createElement('button');
  calculateBtn.type = 'button';
  calculateBtn.className = 'calculate-btn calculate-btn-primary calculate-calculate-btn';
  calculateBtn.id = 'calculate-calculate-btn';
  calculateBtn.addEventListener('click', handleCalculateBlend);
  calcBtnRow.appendChild(calculateBtn);
  shell.appendChild(calcBtnRow);

  const result = document.createElement('div');
  result.className = 'calculate-result';
  result.id = 'calculate-result';
  result.hidden = true;
  shell.appendChild(result);

  return {
    shell, title, subtitle, blendSectionLabel, gridBody, blendError, calculateBtn, result,
    gridHeaderCells: gridHeader.cells,
  };
}

// Short mobile headers (PILE / NI / DT / t/DT) -- deliberately NOT the
// full field wording (which stays reserved for each input's aria-label,
// see buildPileRow() below). Column widths mirror the requested
// proportions (PILE 38% / NI 17% / DT 14% / t/DT 20% / action 11%) via
// matching `fr` tracks in calculate.css.
function buildGridHeaderRow() {
  const row = document.createElement('div');
  row.className = 'calculate-grid-row calculate-grid-row--header';
  row.setAttribute('role', 'row');

  const cells = {
    pile: buildHeaderCell('calculate-grid-cell--pile'),
    ni: buildHeaderCell('calculate-grid-cell--ni'),
    dt: buildHeaderCell('calculate-grid-cell--dt'),
    tpu: buildHeaderCell('calculate-grid-cell--tpu'),
    action: buildHeaderCell('calculate-grid-cell--action'),
  };
  Object.values(cells).forEach((cell) => row.appendChild(cell));

  return { row, cells };
}

function buildHeaderCell(extraClass) {
  const cell = document.createElement('span');
  cell.className = `calculate-grid-cell ${extraClass}`;
  cell.setAttribute('role', 'columnheader');
  return cell;
}

function updateStaticLabels() {
  els.title.textContent = t('calculate.title');
  els.subtitle.textContent = t('calculate.blend.subtitle');
  els.blendSectionLabel.textContent = t('calculate.blend.title');
  els.calculateBtn.textContent = t('calculate.blend.calculate');
  els.gridHeaderCells.pile.textContent = t('calculate.grid.headerPile');
  els.gridHeaderCells.ni.textContent = t('calculate.grid.headerNi');
  els.gridHeaderCells.dt.textContent = t('calculate.grid.headerDt');
  els.gridHeaderCells.tpu.textContent = t('calculate.grid.headerTonnesPerUnit');
}

/* ============================================================
   GRID BODY -- one compact row per pile, plus the always-present trailing
   blank row. Rebuilt in full on Remove Pile, a locale change, and a
   Calculate Blend press (never mid-keystroke -- each field's own 'input'
   listener patches just that row's derived badge/tonnage in place, and
   the one-row trailing-append is a targeted appendChild(), never a full
   rebuild -- see buildPileRow() below for why that matters for focus).
============================================================ */
function renderGridBody() {
  els.gridBody.replaceChildren(...pileRows.map((row, index) => buildPileRow(row, index)));
}

function buildPileRow(row, index) {
  const err = pileErrors && index < pileErrors.length ? pileErrors[index] : null;
  const isTrailingBlank = index === pileRows.length - 1 && isRowBlank(row);

  const rowEl = document.createElement('div');
  rowEl.className = 'calculate-grid-row';
  rowEl.setAttribute('role', 'row');
  rowEl.dataset.rowIndex = String(index);

  // PILE cell: Pile ID input on its own line, then a second line pairing
  // the Contractor input with the read-only ore-class badge (this task's
  // Contractor revision -- Contractor stays inside the PILE cell rather
  // than adding a new wide column, architecture doc Section 12.1/32.1).
  const pileCell = document.createElement('div');
  pileCell.className = 'calculate-grid-cell calculate-grid-cell--pile';
  const pileInput = document.createElement('input');
  pileInput.type = 'text';
  pileInput.className = 'calculate-cell-input';
  pileInput.dataset.field = 'pileId';
  pileInput.value = row.pileId;
  pileInput.setAttribute('aria-label', t('calculate.fields.pileId'));
  pileInput.setAttribute('enterkeyhint', 'next');
  pileCell.appendChild(pileInput);

  const sourceRow = document.createElement('div');
  sourceRow.className = 'calculate-grid-cell__source-row';
  const contractorInput = document.createElement('input');
  contractorInput.type = 'text';
  contractorInput.className = 'calculate-cell-input calculate-cell-input--contractor';
  contractorInput.dataset.field = 'contractor';
  contractorInput.value = row.contractor;
  contractorInput.setAttribute('aria-label', t('calculate.fields.contractor'));
  contractorInput.setAttribute('autocomplete', 'off');
  contractorInput.setAttribute('enterkeyhint', 'next');
  sourceRow.appendChild(contractorInput);
  const badge = document.createElement('span');
  badge.className = 'calculate-grid-cell__badge';
  badge.textContent = classifyOre(parseFiniteNumber(row.ni)) || '';
  sourceRow.appendChild(badge);
  pileCell.appendChild(sourceRow);

  rowEl.appendChild(pileCell);

  // NI cell.
  const niCell = document.createElement('div');
  niCell.className = 'calculate-grid-cell calculate-grid-cell--ni';
  const niInput = document.createElement('input');
  niInput.type = 'text';
  niInput.setAttribute('inputmode', 'decimal');
  niInput.setAttribute('enterkeyhint', 'next');
  niInput.className = 'calculate-cell-input';
  niInput.dataset.field = 'ni';
  niInput.value = row.ni;
  niInput.setAttribute('aria-label', t('calculate.fields.ni'));
  niCell.appendChild(niInput);
  rowEl.appendChild(niCell);

  // DT cell (Jumlah Unit -- Blend mode's fully-approved "DT actually used"
  // meaning, unrelated to Recommendation's still-blocked Gate A semantics).
  const dtCell = document.createElement('div');
  dtCell.className = 'calculate-grid-cell calculate-grid-cell--dt';
  const dtInput = document.createElement('input');
  dtInput.type = 'text';
  dtInput.setAttribute('inputmode', 'numeric');
  dtInput.setAttribute('enterkeyhint', 'next');
  dtInput.className = 'calculate-cell-input';
  dtInput.dataset.field = 'units';
  dtInput.value = row.units;
  dtInput.setAttribute('aria-label', t('calculate.fields.units'));
  dtCell.appendChild(dtInput);
  rowEl.appendChild(dtCell);

  // t/DT cell: Tonase/Unit input, with the read-only Calculated Tonnage
  // directly underneath (never its own column either).
  const tpuCell = document.createElement('div');
  tpuCell.className = 'calculate-grid-cell calculate-grid-cell--tpu';
  const tpuInput = document.createElement('input');
  tpuInput.type = 'text';
  tpuInput.setAttribute('inputmode', 'decimal');
  tpuInput.setAttribute('enterkeyhint', 'done');
  tpuInput.className = 'calculate-cell-input';
  tpuInput.dataset.field = 'tonnesPerUnit';
  tpuInput.value = row.tonnesPerUnit;
  tpuInput.setAttribute('aria-label', t('calculate.fields.tonnesPerUnit'));
  tpuCell.appendChild(tpuInput);
  const tonnageEl = document.createElement('span');
  tonnageEl.className = 'calculate-grid-cell__tonnage';
  tonnageEl.textContent = formatLiveTonnage(row);
  tpuCell.appendChild(tonnageEl);
  rowEl.appendChild(tpuCell);

  // Action cell: compact "x" remove control, never the large "Hapus"/
  // "Remove" button the earlier card layout used. Absent entirely for the
  // trailing blank row -- the simplest way to guarantee removal can never
  // violate the one-trailing-blank-row invariant is to never offer it on
  // that one row in the first place.
  const actionCell = document.createElement('div');
  actionCell.className = 'calculate-grid-cell calculate-grid-cell--action';
  if (!isTrailingBlank) {
    actionCell.appendChild(buildRemoveButton(index));
  }
  rowEl.appendChild(actionCell);

  // Row-level error line -- ONE compact line combining every field error
  // for this row, never four separate per-field paragraphs (which would
  // defeat the compact grid's purpose). Contributes zero visible height
  // when the row has no error. The trailing blank row is excluded from
  // validation entirely (handleCalculateBlend()), so `err` is always null
  // for it and this line never renders for it.
  const errorLine = document.createElement('p');
  errorLine.className = 'calculate-row-error';
  const errorKeys = err ? [err.pileId, err.contractor, err.ni, err.units, err.tonnesPerUnit].filter(Boolean) : [];
  if (errorKeys.length) {
    errorLine.textContent = errorKeys.map((key) => t(key)).join(' · ');
  } else {
    errorLine.hidden = true;
  }
  rowEl.appendChild(errorLine);
  markInvalid(pileInput, err && err.pileId);
  markInvalid(contractorInput, err && err.contractor, 'calculate-cell-input--contractor');
  markInvalid(niInput, err && err.ni);
  markInvalid(dtInput, err && err.units);
  markInvalid(tpuInput, err && err.tonnesPerUnit);

  // Wired last, now that direct references to this row's own derived
  // display elements exist -- an 'input' event patches ONLY badge/
  // tonnageEl in place, never a full renderGridBody() rebuild, so typing
  // in one field never loses focus or disturbs any other row.
  [
    { input: pileInput, field: 'pileId' },
    { input: contractorInput, field: 'contractor' },
    { input: niInput, field: 'ni' },
    { input: dtInput, field: 'units' },
    { input: tpuInput, field: 'tonnesPerUnit' },
  ].forEach(({ input, field }) => {
    input.addEventListener('input', () => {
      pileRows[index][field] = input.value;
      badge.textContent = classifyOre(parseFiniteNumber(pileRows[index].ni)) || '';
      tonnageEl.textContent = formatLiveTonnage(pileRows[index]);

      // TRAILING-ROW AUTO-APPEND: as soon as the row that is CURRENTLY
      // the trailing row stops being blank, append exactly one fresh
      // blank row after it. `index === pileRows.length - 1` is only ever
      // true for the one row that is currently trailing, and once the
      // push below runs, that is no longer true for THIS row on any
      // subsequent edit (a newer row now occupies the last position) --
      // so this fires exactly once per blank-to-active transition, never
      // accumulating extra blank rows. A targeted appendChild() only,
      // never renderGridBody(), so every other row's DOM (and this row's
      // own focused input) is left completely untouched.
      if (index === pileRows.length - 1 && !isRowBlank(pileRows[index])) {
        const newRow = createBlankPileRow();
        pileRows.push(newRow);
        els.gridBody.appendChild(buildPileRow(newRow, pileRows.length - 1));
        // This row is no longer the trailing blank row -- reveal its own
        // remove control now, in place, without rebuilding anything.
        if (actionCell.children.length === 0) actionCell.appendChild(buildRemoveButton(index));
      }
    });
  });

  return rowEl;
}

function buildRemoveButton(index) {
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'calculate-remove-btn calculate-remove-pile-btn';
  removeBtn.textContent = '×';
  removeBtn.setAttribute('aria-label', t('common.remove'));
  removeBtn.addEventListener('click', () => handleRemovePile(index));
  return removeBtn;
}

// `extraClass` preserves a field-specific modifier (e.g. Contractor's
// compact `--contractor` sizing class) that a blind className overwrite
// would otherwise strip whenever that field goes invalid.
function markInvalid(input, errorKey, extraClass) {
  const classes = ['calculate-cell-input'];
  if (extraClass) classes.push(extraClass);
  if (errorKey) classes.push('calculate-cell-input--invalid');
  input.className = classes.join(' ');
  if (errorKey) {
    input.setAttribute('aria-invalid', 'true');
  } else {
    input.removeAttribute('aria-invalid');
  }
}

// Lightweight "is this presentable yet" check for the live badge/tonnage
// preview ONLY -- distinct from calculate-validation.js's authoritative
// rules (which alone govern whether Calculate Blend may proceed). A pile
// with an out-of-range or still-incomplete value simply shows an empty/em
// dash display here rather than a validation error, until the user
// presses Calculate Blend.
function parseFiniteNumber(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function formatLiveTonnage(row) {
  const units = parseFiniteNumber(row.units);
  const tonnesPerUnit = parseFiniteNumber(row.tonnesPerUnit);
  if (units === null || tonnesPerUnit === null) return EM_DASH;
  return `${fmtTon(calculatePileTonnage(units, tonnesPerUnit))} t`;
}

/* ============================================================
   REMOVE PILE. Restores the trailing-blank-row invariant, clears any
   previous errors/result (the row set just changed structurally, so a
   stale error pointing at a now-shifted row, or a result computed from a
   composition that no longer exists, must never linger), and rebuilds
   the grid in full (Remove is a discrete click, not continuous typing, so
   losing focus here is fine).
============================================================ */
function handleRemovePile(index) {
  pileRows.splice(index, 1);
  ensureExactlyOneTrailingBlankRow();
  resetErrorsAndResult();
  renderGridBody();
  renderBlendError();
  renderResult();
}

function resetErrorsAndResult() {
  pileErrors = null;
  blendErrorKey = null;
  lastResult = null;
}

/* ============================================================
   CALCULATE BLEND -- the one explicit, guarded action. Recalculation is
   never automatic/live; only this button press produces (or replaces)
   the authoritative Blend Result. The trailing blank row is excluded
   from both validation and calculation -- it is an input affordance, not
   an active pile.
============================================================ */
function handleCalculateBlend() {
  // Action-boundary guard (architecture doc Section 10) -- MUST run
  // before any validation/calculation touches pileRows. Under
  // MONITOR_ONLY this redirects to Settings and requests License
  // attention, and no calculation of any kind executes.
  if (!requireFullAccessForCalculateAction()) return;

  const trailingIsBlank = pileRows.length > 0 && isRowBlank(pileRows[pileRows.length - 1]);
  const activeRows = trailingIsBlank ? pileRows.slice(0, -1) : pileRows;

  const { pileErrors: errors, blendError, valid } = validatePiles(activeRows);
  pileErrors = errors;
  blendErrorKey = blendError;

  if (!valid) {
    lastResult = null;
    renderGridBody();
    renderBlendError();
    renderResult();
    return;
  }

  const result = calculateWeightedBlend(activeRows.map(toNumericPile));

  if (!result.ok) {
    // Defense in depth only -- validatePiles() above already rejects a
    // zero-total-tonnage blend, so this should be unreachable, but
    // calculateWeightedBlend()'s own "never silently return Ni = 0" rule
    // must hold even if called in isolation.
    blendErrorKey = 'calculate.validation.noPositiveTonnage';
    lastResult = null;
    renderGridBody();
    renderBlendError();
    renderResult();
    return;
  }

  pileErrors = null;
  blendErrorKey = null;
  lastResult = result;
  renderGridBody();
  renderBlendError();
  renderResult();
}

function renderBlendError() {
  if (!blendErrorKey) {
    els.blendError.hidden = true;
    els.blendError.textContent = '';
    return;
  }
  els.blendError.hidden = false;
  els.blendError.textContent = t(blendErrorKey);
}

/* ============================================================
   BLEND RESULT -- Final Ni / Total DT / Total Tonnage first, then the
   class breakdown (HGLO/MGLO/LGLO totals + Higher Grade), then the Pile
   Breakdown as a collapsed-by-default <details> disclosure (it repeats
   information already visible in the input grid above, so it is no
   longer an always-visible list). Informational totals only -- no Hopper
   Pattern, no Unit/Tonnage Ratio recommendation, no USE/LIMIT/STOP.
   Rebuilt in full every time (Calculate press, Remove Pile clearing it,
   or a locale change) -- never a stale partial update.
============================================================ */
function renderResult() {
  if (!lastResult) {
    els.result.hidden = true;
    els.result.replaceChildren();
    return;
  }
  els.result.hidden = false;
  els.result.replaceChildren(...buildResultChildren(lastResult));
}

function buildResultChildren(result) {
  const nodes = [];

  const title = document.createElement('h2');
  title.className = 'calculate-section-label';
  title.textContent = t('calculate.result.title');
  nodes.push(title);

  const summary = document.createElement('div');
  summary.className = 'calculate-result-summary';
  summary.appendChild(buildSummaryItem('calculate.result.finalNi', `${result.weightedNi.toFixed(3)}%`, 'calculate-final-ni'));
  summary.appendChild(buildSummaryItem('calculate.result.totalUnits', fmtRit(result.totalUnits), 'calculate-total-units'));
  summary.appendChild(buildSummaryItem('calculate.result.totalTonnage', `${fmtTon(result.totalTonnage)} t`, 'calculate-total-tonnage'));
  nodes.push(summary);

  const classBreakdownTitle = document.createElement('h3');
  classBreakdownTitle.className = 'calculate-subsection-label';
  classBreakdownTitle.textContent = t('calculate.result.classBreakdown');
  nodes.push(classBreakdownTitle);

  const classBreakdown = document.createElement('div');
  classBreakdown.className = 'calculate-class-breakdown';
  ORE_CLASSES.forEach((cls) => classBreakdown.appendChild(buildClassRow(cls, result.classes[cls], false)));
  classBreakdown.appendChild(buildClassRow(t('calculate.result.higherGrade'), result.higherGrade, true));
  nodes.push(classBreakdown);

  const pileDetails = document.createElement('details');
  pileDetails.className = 'calculate-pile-breakdown-details';
  const pileSummary = document.createElement('summary');
  pileSummary.textContent = t('calculate.result.pileBreakdown');
  pileDetails.appendChild(pileSummary);
  const pileBreakdown = document.createElement('div');
  pileBreakdown.className = 'calculate-pile-breakdown';
  result.piles.forEach((pile) => pileBreakdown.appendChild(buildPileBreakdownRow(pile)));
  pileDetails.appendChild(pileBreakdown);
  nodes.push(pileDetails);

  return nodes;
}

function buildSummaryItem(labelKey, valueText, extraClass) {
  const item = document.createElement('div');
  item.className = `calculate-result-summary__item${extraClass ? ` ${extraClass}` : ''}`;
  const label = document.createElement('span');
  label.textContent = t(labelKey);
  const value = document.createElement('strong');
  value.textContent = valueText;
  item.appendChild(label);
  item.appendChild(value);
  return item;
}

function buildPileBreakdownRow(pile) {
  const row = document.createElement('div');
  row.className = 'calculate-breakdown-row calculate-pile-breakdown-row';

  const main = document.createElement('div');
  main.className = 'calculate-breakdown-row__main';
  const idEl = document.createElement('span');
  idEl.className = 'calculate-breakdown-row__id';
  idEl.textContent = pile.pileId;
  main.appendChild(idEl);
  row.appendChild(main);

  // Contractor · Ore Class -- compact source line (this task's revision,
  // architecture doc Section 13). Metadata only, no bearing on the totals
  // shown below it.
  const sourceLine = document.createElement('div');
  sourceLine.className = 'calculate-breakdown-row__source-line';
  const contractorEl = document.createElement('span');
  contractorEl.className = 'calculate-breakdown-row__contractor';
  contractorEl.textContent = pile.contractor;
  const badgeEl = document.createElement('span');
  badgeEl.className = 'calculate-breakdown-row__badge';
  badgeEl.textContent = pile.oreClass || EM_DASH;
  sourceLine.appendChild(contractorEl);
  sourceLine.appendChild(badgeEl);
  row.appendChild(sourceLine);

  const metaTop = document.createElement('div');
  metaTop.className = 'calculate-breakdown-row__meta';
  metaTop.appendChild(buildMetaSpan(`${t('calculate.fields.ni')}: ${pile.ni.toFixed(3)}%`));
  metaTop.appendChild(buildMetaSpan(`${t('calculate.fields.units')}: ${fmtRit(pile.units)}`));
  metaTop.appendChild(buildMetaSpan(`${t('calculate.fields.tonnesPerUnit')}: ${fmtTon(pile.tonnesPerUnit)} t`));
  row.appendChild(metaTop);

  const metaBottom = document.createElement('div');
  metaBottom.className = 'calculate-breakdown-row__meta';
  metaBottom.appendChild(buildMetaSpan(`${t('calculate.fields.calculatedTonnage')}: ${fmtTon(pile.tonnage)} t`));
  metaBottom.appendChild(buildMetaSpan(`${t('calculate.result.tonnageShare')}: ${(pile.tonnageShare * 100).toFixed(1)}%`));
  row.appendChild(metaBottom);

  return row;
}

function buildClassRow(label, totals, isHigherGrade) {
  const row = document.createElement('div');
  row.className = `calculate-breakdown-row calculate-class-breakdown-row${isHigherGrade ? ' calculate-breakdown-row--emphasis calculate-higher-grade-row' : ''}`;

  const main = document.createElement('div');
  main.className = 'calculate-breakdown-row__main';
  const idEl = document.createElement('span');
  idEl.className = 'calculate-breakdown-row__id';
  idEl.textContent = label;
  main.appendChild(idEl);
  row.appendChild(main);

  const meta = document.createElement('div');
  meta.className = 'calculate-breakdown-row__meta';
  meta.appendChild(buildMetaSpan(`${t('calculate.fields.units')}: ${fmtRit(totals.units)}`));
  meta.appendChild(buildMetaSpan(`${t('calculate.result.tonnageLabel')}: ${fmtTon(totals.tonnage)} t`));
  row.appendChild(meta);

  return row;
}

function buildMetaSpan(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

// Action-boundary guard for Calculate actions (architecture doc Section
// 10) -- mirrors report-page.js's own private requireFullAccessForReportAction()
// byte-for-byte in structure and behavior. Exported (unlike Report's
// private version) so tests can call it directly, and because it is also
// the one guard handleCalculateBlend() above calls before doing anything
// else. Bootstrap (initCalculatePage()) never calls this -- opening the
// app under MONITOR_ONLY must not itself redirect to Settings; only an
// actual gated action or the route guard may do that.
export function requireFullAccessForCalculateAction() {
  if (hasFullAccess()) return true;
  navigateTo('settings');
  requestFullAccessAttention('calculate-action');
  return false;
}
