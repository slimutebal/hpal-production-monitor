// Calculate page (V2.4 Phase 4.1 -- unified continuous workflow revision).
// See docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md.
//
// OWNER-REQUESTED UX CORRECTION (this task): the earlier BLEND |
// RECOMMENDATION mode-tab model is REJECTED. Calculate is now ONE
// continuous page, top to bottom:
//
//   1. Live Blend summary (sticky: Ni Akhir / Total DT / Total Tonase)
//   2. Shared source input grid (unchanged column layout)
//   3. Recommendation controls (Target Ni / Tolerance)
//   4. Recommendation result
//
// There is no mode switch and no explicit "Hitung Blend" button anymore.
// The Blend summary recomputes automatically from whichever source rows
// are currently COMPLETE (all five fields individually valid) every time
// a field changes -- see recomputeLiveBlend()/getCompleteRows() below.
// Recommendation remains an explicit, FULL_ACCESS-guarded action (Hitung
// Rekomendasi), and uses the exact same complete-row selection.
//
// SHARED SOURCE GRID: Blend and Recommendation read the SAME pileRows --
// there is only one source-entry form. "DT" means loads actually used for
// the live Blend summary and physical reusable fleet for Recommendation;
// the grid's column layout/trailing-blank-row behavior is unchanged.
//
// COMPOSITE DUPLICATE IDENTITY (this task's revision): the same Pile ID
// may now appear more than once as long as Contractor differs (e.g.
// "L30/MRP" and "L30/TII" are distinct sources) -- see
// calculate-validation.js's normalizeSourceIdentity()/validatePileId().
//
// STALE-RESULT INVALIDATION: any source field edit, Target Ni edit, or
// Tolerance edit clears an existing Recommendation result immediately
// (clearRecommendationResult()) -- an old result is never left on screen
// looking like it still matches the current inputs.
//
// DOM CONSTRUCTION: everything here is built via document.createElement()/
// appendChild()/replaceChildren(), never innerHTML template strings.
// Built once into #page-calculate and never rebuilt on route change.
// Session state lives in this module's own top-level variables, not
// localStorage -- it survives Calculate -> Monitor -> Calculate
// navigation and is intentionally lost on a real reload/PWA restart.
//
// PURE/DOM SEPARATION: all actual math/search/ranking/validation live in
// js/shared/ore-classification.js, ./blend-calculator.js,
// ./calculate-validation.js, ./blending-recommendation.js,
// ./recommendation-ranking.js, and ./fleet-allocation.js -- none of those
// import DOM, router, i18n, or localStorage. This file is the one
// DOM-touching layer: it parses raw input strings, calls the pure
// functions, and formats/localizes the result for display.
import { t, onLocaleChange } from '../../i18n/i18n.js';
import { navigateTo } from '../../router.js';
import { hasFullAccess, requestFullAccessAttention } from '../../services/license-service.js';
import { fmtTon, fmtRit } from '../report/report-utils.js';
import { classifyOre } from '../../shared/ore-classification.js';
import { calculatePileTonnage, calculateWeightedBlend } from './blend-calculator.js';
import { validatePiles, toNumericPile, isRowBlank } from './calculate-validation.js';
import { findBlendRecommendations, DEFAULT_RECOMMENDATION_TOLERANCE } from './blending-recommendation.js';
import { deriveOperationalHopperPattern } from './hopper-pattern.js';
import { deriveRecommendationActions, MATERIAL_ACTION_USE, MATERIAL_ACTION_LIMIT, MATERIAL_ACTION_STOP } from './recommendation-actions.js';
import { calculateRequiredNewDomeNi, findQualifyingSources } from './planned-blend-recovery.js';

const ORE_CLASSES = ['HGLO', 'MGLO', 'LGLO'];
const EM_DASH = '—';
const HIGHER_GRADE_CLASSES = new Set(['HGLO', 'MGLO']);

let page = null;
let els = null;

// Session state (in-memory only -- see header comment). pileRows holds
// the RAW string values a text input hands back. INVARIANT maintained
// throughout this file: pileRows[pileRows.length-1] (the trailing row) is
// always blank (isRowBlank() true) except for the single instant inside a
// field's own 'input' handler between updating its value and appending
// the next blank row.
let pileRows = [];
// Parallel to pileRows -- one entry per row, holding direct DOM references
// (inputs/badge/tonnage/error line) so a live recompute can PATCH each
// row's validation display in place (markInvalid/error text) without a
// full grid rebuild, which would steal focus away from whichever field
// the user is mid-keystroke in. Reset (and rebuilt) only on a genuine
// structural change (Remove Pile, locale change) via renderGridBody().
let rowRefs = [];
let pileErrors = null; // per-row field errors (incl. duplicate check), recomputed on every source edit -- shared by the live Blend summary AND Recommendation's complete-row selection
let lastResult = null; // live Blend result (calculateWeightedBlend() over COMPLETE rows only), or null
let partialRowCount = 0; // count of non-blank rows currently excluded from the live summary/Recommendation because at least one field is invalid
let rowSeq = 0;

let targetNiRaw = '';
let toleranceRaw = '';
let recommendationFieldErrors = null; // null, or { targetNi, tolerance, fleet } i18n keys
let recommendationEngineErrorKey = null; // null, or an i18n key (SEARCH_SPACE_TOO_LARGE / NO_FEASIBLE_CANDIDATE / no complete sources)
let lastRecommendationResult = null; // null, or the ok:true result from findBlendRecommendations()

// Planned Blend Recovery (V2.4 Phase 6) -- only ever meaningful while
// lastRecommendationResult.status === 'TARGET_NOT_ACHIEVABLE' (this
// task's Section 2). Reset to this exact blank state every time a FRESH
// Recommendation is calculated or cleared (resetRecoveryState() below),
// so a Recovery answer/scenario from a previous, now-irrelevant
// Recommendation is never carried over (this task's Section 20 "no stale
// baseline"). `recoveryEls` holds direct DOM references into the
// Recovery section's OWN subtree (parallel to `rowRefs` for grid rows)
// so editing Added DT/Tonnes-per-DT can patch just the Recovery result
// in place -- this task's Section 19 requires that edit to clear ONLY
// the Recovery result, never the whole Recommendation/Material/Fleet
// Actions -- without needing a full buildRecommendationResultChildren()
// rebuild. Always null whenever no Recovery section is currently
// rendered.
let recoveryAddedDtRaw = '';
let recoveryTonnesPerDtRaw = '';
let recoveryFieldErrors = null; // null, or { addedUnitsError, tonnesPerUnitError } i18n keys
let recoveryResult = null; // null, or the ok:true result from calculateRequiredNewDomeNi()
let recoveryEls = null;

export function initCalculatePage() {
  page = document.getElementById('page-calculate');
  if (!page) return;

  pileRows = [createBlankPileRow()];
  rowRefs = [];
  pileErrors = null;
  lastResult = null;
  partialRowCount = 0;
  targetNiRaw = '';
  // Seeded from the pure engine's own exported default -- never a second
  // hardcoded "0.010" business constant here.
  toleranceRaw = DEFAULT_RECOMMENDATION_TOLERANCE.toFixed(3);
  recommendationFieldErrors = null;
  recommendationEngineErrorKey = null;
  lastRecommendationResult = null;

  els = buildShell();
  page.replaceChildren(els.shell);
  updateStaticLabels();
  renderGridBody();
  recomputeLiveBlend();
  renderRecommendationFieldError();
  renderRecommendationEngineError();
  renderRecommendationResult();

  onLocaleChange(handleLocaleChange);
}

function handleLocaleChange() {
  updateStaticLabels();
  // A locale change is a discrete event, not continuous typing, so a full
  // grid rebuild (fresh rowRefs) is fine here -- it never happens
  // mid-keystroke, unlike recomputeLiveBlend()'s per-field patching.
  renderGridBody();
  renderLiveBlendDisplay(); // re-render summary/partial-info/class-breakdown/row-errors from EXISTING state, never recomputing business logic
  renderRecommendationFieldError();
  renderRecommendationEngineError();
  renderRecommendationResult();
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

  // STICKY LIVE BLEND SUMMARY (this task's Section 6/7) -- Ni Akhir /
  // Total DT / Total Tonase, recomputed automatically as source rows
  // change (recomputeLiveBlend() below), no explicit action. Hidden until
  // at least one complete source row exists.
  const blendSummary = document.createElement('div');
  blendSummary.className = 'calculate-blend-summary';
  blendSummary.id = 'calculate-blend-summary';
  blendSummary.hidden = true;
  shell.appendChild(blendSummary);

  // Small, non-blocking informational count of excluded incomplete rows
  // (this task's Section 5) -- never a large warning banner.
  const partialRowInfo = document.createElement('p');
  partialRowInfo.className = 'calculate-partial-row-info';
  partialRowInfo.hidden = true;
  shell.appendChild(partialRowInfo);

  // SHARED SOURCE GRID -- identical column layout to Phase 2.1/4
  // (PILE | NI | DT | t/DT | action); used for both the live Blend
  // summary and Recommendation, never duplicated.
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

  // Class breakdown (HGLO/MGLO/LGLO/Higher Grade) -- compact, collapsed-
  // by-default secondary Blend detail (this task's Section 17). The old
  // duplicated "HASIL BLEND" summary-card section and per-pile breakdown
  // are gone entirely -- the sticky summary above is now the one
  // authoritative Blend result, and the grid itself already shows each
  // row's own live Ni/DT/t-DT/tonnage.
  const classBreakdownDetails = document.createElement('details');
  classBreakdownDetails.className = 'calculate-class-breakdown-details';
  classBreakdownDetails.hidden = true;
  const classBreakdownSummary = document.createElement('summary');
  classBreakdownDetails.appendChild(classBreakdownSummary);
  const classBreakdown = document.createElement('div');
  classBreakdown.className = 'calculate-class-breakdown';
  classBreakdownDetails.appendChild(classBreakdown);
  shell.appendChild(classBreakdownDetails);

  // ---- RECOMMENDATION SECTION -- always visible, no mode switch -------
  const recommendationSectionLabel = document.createElement('h2');
  recommendationSectionLabel.className = 'calculate-section-label';
  shell.appendChild(recommendationSectionLabel);

  // Compact DT-meaning hint (Recommendation's DT = physical reusable
  // fleet, distinct from the live Blend summary's "loads actually used")
  // -- shown once here, never repeated per grid row, and never changes
  // the "DT" column label itself.
  const dtHint = document.createElement('p');
  dtHint.className = 'calculate-recommendation-hint';
  shell.appendChild(dtHint);

  const controls = document.createElement('div');
  controls.className = 'calculate-recommendation-controls';
  const targetField = buildRecommendationField('targetNi', 'decimal');
  const toleranceField = buildRecommendationField('tolerance', 'decimal');
  controls.appendChild(targetField.field);
  controls.appendChild(toleranceField.field);
  shell.appendChild(controls);

  const recommendationFieldError = document.createElement('p');
  recommendationFieldError.className = 'calculate-recommendation-field-error';
  recommendationFieldError.setAttribute('role', 'alert');
  recommendationFieldError.hidden = true;
  shell.appendChild(recommendationFieldError);

  const recCalcBtnRow = document.createElement('div');
  recCalcBtnRow.className = 'calculate-btn-row';
  const recommendationCalculateBtn = document.createElement('button');
  recommendationCalculateBtn.type = 'button';
  recommendationCalculateBtn.className = 'calculate-btn calculate-btn-primary calculate-calculate-recommendation-btn';
  recommendationCalculateBtn.addEventListener('click', handleCalculateRecommendation);
  recCalcBtnRow.appendChild(recommendationCalculateBtn);
  shell.appendChild(recCalcBtnRow);

  const recommendationEngineError = document.createElement('p');
  recommendationEngineError.className = 'calculate-recommendation-error';
  recommendationEngineError.setAttribute('role', 'alert');
  recommendationEngineError.hidden = true;
  shell.appendChild(recommendationEngineError);

  const recommendationResult = document.createElement('div');
  recommendationResult.className = 'calculate-recommendation-result';
  recommendationResult.hidden = true;
  shell.appendChild(recommendationResult);

  return {
    shell, title, subtitle, blendSectionLabel, blendSummary, partialRowInfo,
    gridBody, gridHeaderCells: gridHeader.cells,
    classBreakdownDetails, classBreakdownSummary, classBreakdown,
    recommendationSectionLabel, dtHint,
    targetNiInput: targetField.input,
    targetNiLabel: targetField.label,
    toleranceInput: toleranceField.input,
    toleranceLabel: toleranceField.label,
    recommendationFieldError,
    recommendationCalculateBtn,
    recommendationEngineError,
    recommendationResult,
  };
}

// Target Ni / Tolerance are plain decimal text inputs (never live-
// calculated into a Recommendation result -- see
// handleCalculateRecommendation()). Editing either one clears any existing
// Recommendation result immediately (this task's Section 15).
function buildRecommendationField(fieldName, inputMode) {
  const field = document.createElement('div');
  field.className = 'calculate-recommendation-field';

  const label = document.createElement('label');
  label.className = 'calculate-recommendation-field__label';

  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('inputmode', inputMode);
  input.setAttribute('enterkeyhint', fieldName === 'targetNi' ? 'next' : 'done');
  input.dataset.field = fieldName;
  input.className = 'calculate-recommendation-input';
  input.value = fieldName === 'targetNi' ? targetNiRaw : toleranceRaw;
  input.addEventListener('input', () => {
    if (fieldName === 'targetNi') targetNiRaw = input.value;
    else toleranceRaw = input.value;
    clearRecommendationResult();
  });

  field.appendChild(label);
  field.appendChild(input);
  return { field, label, input };
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
  els.gridHeaderCells.pile.textContent = t('calculate.grid.headerPile');
  els.gridHeaderCells.ni.textContent = t('calculate.grid.headerNi');
  els.gridHeaderCells.dt.textContent = t('calculate.grid.headerDt');
  els.gridHeaderCells.tpu.textContent = t('calculate.grid.headerTonnesPerUnit');

  els.classBreakdownSummary.textContent = t('calculate.result.classBreakdown');

  els.recommendationSectionLabel.textContent = t('calculate.recommendation.title');
  els.dtHint.textContent = t('calculate.recommendation.dtHint');
  els.targetNiLabel.textContent = t('calculate.recommendation.targetNi');
  els.toleranceLabel.textContent = t('calculate.recommendation.tolerance');
  els.targetNiInput.setAttribute('aria-label', t('calculate.recommendation.targetNi'));
  els.toleranceInput.setAttribute('aria-label', t('calculate.recommendation.tolerance'));
  els.recommendationCalculateBtn.textContent = t('calculate.recommendation.calculate');
}

/* ============================================================
   GRID BODY -- one compact row per pile, plus the always-present trailing
   blank row. Rebuilt in full on Remove Pile and a locale change (never
   mid-keystroke -- each field's own 'input' listener patches just that
   row's derived badge/tonnage/validation display in place via
   recomputeLiveBlend(), and the one-row trailing-append is a targeted
   appendChild(), never a full rebuild -- see buildPileRow() below for why
   that matters for focus).
============================================================ */
function renderGridBody() {
  rowRefs = [];
  els.gridBody.replaceChildren(...pileRows.map((row, index) => buildPileRow(row, index)));
}

function buildPileRow(row, index) {
  const isTrailingBlank = index === pileRows.length - 1 && isRowBlank(row);

  const rowEl = document.createElement('div');
  rowEl.className = 'calculate-grid-row';
  rowEl.setAttribute('role', 'row');
  rowEl.dataset.rowIndex = String(index);

  // PILE cell: Pile ID input on its own line, then a second line pairing
  // the Contractor input with the read-only ore-class badge. Subtle
  // placeholders on both inputs remain (Section 8 of this task -- kept
  // exactly as Phase 4 introduced them).
  const pileCell = document.createElement('div');
  pileCell.className = 'calculate-grid-cell calculate-grid-cell--pile';
  const pileInput = document.createElement('input');
  pileInput.type = 'text';
  pileInput.className = 'calculate-cell-input';
  pileInput.dataset.field = 'pileId';
  pileInput.value = row.pileId;
  pileInput.setAttribute('aria-label', t('calculate.fields.pileId'));
  pileInput.setAttribute('placeholder', t('calculate.fields.pileId'));
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
  contractorInput.setAttribute('placeholder', t('calculate.fields.contractor'));
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

  // DT cell. Meaning depends on which section is reading it (live Blend
  // summary: loads actually used; Recommendation: physical reusable fleet
  // assigned) -- the label stays "DT" either way (this task's Section 6);
  // the explanatory hint lives once in the Recommendation section instead
  // of on every row.
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

  // Action cell: compact "x" remove control, absent entirely for the
  // trailing blank row.
  const actionCell = document.createElement('div');
  actionCell.className = 'calculate-grid-cell calculate-grid-cell--action';
  if (!isTrailingBlank) {
    actionCell.appendChild(buildRemoveButton(index));
  }
  rowEl.appendChild(actionCell);

  // Row-level error line -- ONE compact line combining every field error
  // for this row. Its actual content is applied by refreshRowValidationUI()
  // below (called once construction finishes AND on every later live
  // recompute), never set inline here, so there is a single place that
  // ever writes this row's validation display.
  const errorLine = document.createElement('p');
  errorLine.className = 'calculate-row-error';
  errorLine.hidden = true;
  rowEl.appendChild(errorLine);

  rowRefs[index] = { pileInput, contractorInput, niInput, dtInput, tpuInput, errorLine };
  refreshRowValidationUI(index);

  // Wired last, now that direct references to this row's own derived
  // display elements exist -- an 'input' event patches ONLY badge/
  // tonnageEl/this row's own validation display in place, never a full
  // renderGridBody() rebuild, so typing in one field never loses focus or
  // disturbs any other row.
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
      // blank row after it (targeted appendChild(), never a full
      // rebuild -- registers its own rowRefs entry via buildPileRow()).
      if (index === pileRows.length - 1 && !isRowBlank(pileRows[index])) {
        const newRow = createBlankPileRow();
        pileRows.push(newRow);
        els.gridBody.appendChild(buildPileRow(newRow, pileRows.length - 1));
        if (actionCell.children.length === 0) actionCell.appendChild(buildRemoveButton(index));
      }

      // LIVE RECOMPUTE (this task's Section 3/4) -- every source edit
      // recomputes the Blend summary from whichever rows are now complete
      // and clears any existing Recommendation result (Section 15).
      recomputeLiveBlend();
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
// would otherwise strip whenever that field goes invalid. `baseClass`
// lets Target Ni/Tolerance -- which use a different base input class than
// the grid cells -- share this same helper.
function markInvalid(input, errorKey, extraClass, baseClass = 'calculate-cell-input') {
  const classes = [baseClass];
  if (extraClass) classes.push(extraClass);
  if (errorKey) classes.push(`${baseClass}--invalid`);
  input.className = classes.join(' ');
  if (errorKey) {
    input.setAttribute('aria-invalid', 'true');
  } else {
    input.removeAttribute('aria-invalid');
  }
}

// Applies pileErrors[index] to one row's DOM via its stored rowRefs --
// the SINGLE place that ever writes a row's invalid-marking/error-line
// display, whether at initial construction (buildPileRow()) or a later
// live recompute (refreshAllRowValidationUI()).
function refreshRowValidationUI(index) {
  const refs = rowRefs[index];
  if (!refs) return;
  const err = pileErrors && index < pileErrors.length ? pileErrors[index] : null;

  markInvalid(refs.pileInput, err && err.pileId);
  markInvalid(refs.contractorInput, err && err.contractor, 'calculate-cell-input--contractor');
  markInvalid(refs.niInput, err && err.ni);
  markInvalid(refs.dtInput, err && err.units);
  markInvalid(refs.tpuInput, err && err.tonnesPerUnit);

  const errorKeys = err ? [err.pileId, err.contractor, err.ni, err.units, err.tonnesPerUnit].filter(Boolean) : [];
  if (errorKeys.length) {
    refs.errorLine.hidden = false;
    refs.errorLine.textContent = errorKeys.map((key) => t(key)).join(' · ');
  } else {
    refs.errorLine.hidden = true;
    refs.errorLine.textContent = '';
  }
}

function refreshAllRowValidationUI() {
  pileRows.forEach((_, index) => refreshRowValidationUI(index));
}

// Lightweight "is this presentable yet" check for the live badge/tonnage
// preview ONLY -- distinct from calculate-validation.js's authoritative
// rules. A pile with an out-of-range or still-incomplete value simply
// shows an empty/em dash display here rather than a validation error.
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
   REMOVE PILE. Restores the trailing-blank-row invariant, rebuilds the
   grid in full (Remove is a discrete click, not continuous typing, so
   losing focus here is fine), then recomputes the live Blend summary
   (which also clears any stale Recommendation result -- Section 15) from
   the new row set.
============================================================ */
function handleRemovePile(index) {
  pileRows.splice(index, 1);
  ensureExactlyOneTrailingBlankRow();
  renderGridBody();
  recomputeLiveBlend();
}

/* ============================================================
   LIVE BLEND SUMMARY (this task's Section 3/4/6) -- the pure engine
   (validatePiles()/calculateWeightedBlend()) is completely unchanged;
   only WHEN it runs and WHICH rows it sees are new. A row is "complete"
   when validatePiles() finds no error on ANY of its five fields
   (including the composite Pile ID + Contractor duplicate check, so a
   duplicate row is correctly excluded from the summary rather than
   silently double-counted). Never gated behind an explicit action.
============================================================ */
function recomputeLiveBlend() {
  const trailingIsBlank = pileRows.length > 0 && isRowBlank(pileRows[pileRows.length - 1]);
  const consideredRows = trailingIsBlank ? pileRows.slice(0, -1) : pileRows;

  const { pileErrors: errors } = validatePiles(consideredRows);
  pileErrors = errors;

  const completeRows = getCompleteRows();
  partialRowCount = consideredRows.length - completeRows.length;

  if (completeRows.length === 0) {
    lastResult = null;
  } else {
    const result = calculateWeightedBlend(completeRows.map(toNumericPile));
    lastResult = result.ok ? result : null;
  }

  renderLiveBlendDisplay();
  clearRecommendationResult();
}

// Single source of truth for "which rows currently count" -- used
// identically by the live Blend summary (above) and by Recommendation
// (handleCalculateRecommendation() below), so both sections are always
// looking at the exact same row set (this task's Section 12: "use the
// same complete-row selection rule transparently"). Reads the CURRENT
// pileErrors state rather than re-validating, so it is always consistent
// with whatever the grid is currently displaying.
function getCompleteRows() {
  const trailingIsBlank = pileRows.length > 0 && isRowBlank(pileRows[pileRows.length - 1]);
  const consideredRows = trailingIsBlank ? pileRows.slice(0, -1) : pileRows;
  return consideredRows.filter((row, i) => {
    const err = pileErrors && i < pileErrors.length ? pileErrors[i] : null;
    return err && !err.pileId && !err.contractor && !err.ni && !err.units && !err.tonnesPerUnit;
  });
}

// Pure re-render from CURRENT state (pileErrors/lastResult/
// partialRowCount) -- never recomputes anything itself. Called both after
// a genuine recompute (recomputeLiveBlend()) and after a locale change
// (handleLocaleChange(), where the underlying numbers must not change).
function renderLiveBlendDisplay() {
  refreshAllRowValidationUI();
  renderBlendSummary();
  renderPartialRowInfo();
  renderClassBreakdown();
}

function renderBlendSummary() {
  if (!lastResult) {
    els.blendSummary.hidden = true;
    els.blendSummary.replaceChildren();
    return;
  }
  els.blendSummary.hidden = false;
  els.blendSummary.replaceChildren(
    buildSummaryItem('calculate.result.finalNi', `${lastResult.weightedNi.toFixed(3)}%`, 'calculate-final-ni'),
    buildSummaryItem('calculate.result.totalUnits', fmtRit(lastResult.totalUnits), 'calculate-total-units'),
    buildSummaryItem('calculate.result.totalTonnage', `${fmtTon(lastResult.totalTonnage)} t`, 'calculate-total-tonnage'),
  );
}

// Small, non-blocking informational count (this task's Section 5) --
// naturally pluralized (EN only; Indonesian does not mark plural).
function renderPartialRowInfo() {
  if (partialRowCount <= 0) {
    els.partialRowInfo.hidden = true;
    els.partialRowInfo.textContent = '';
    return;
  }
  els.partialRowInfo.hidden = false;
  const key = partialRowCount === 1 ? 'calculate.blend.incompleteRowsOne' : 'calculate.blend.incompleteRowsOther';
  els.partialRowInfo.textContent = t(key, { count: partialRowCount });
}

// Compact, collapsed-by-default secondary Blend detail (this task's
// Section 17) -- HGLO/MGLO/LGLO/Higher Grade totals only, never a
// recommendation. Hidden entirely (not merely collapsed-empty) when there
// is no current live Blend result.
function renderClassBreakdown() {
  if (!lastResult) {
    els.classBreakdownDetails.hidden = true;
    els.classBreakdown.replaceChildren();
    return;
  }
  els.classBreakdownDetails.hidden = false;
  els.classBreakdown.replaceChildren(
    ...ORE_CLASSES.map((cls) => buildClassRow(cls, lastResult.classes[cls], false)),
    buildClassRow(t('calculate.result.higherGrade'), lastResult.higherGrade, true),
  );
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

/* ============================================================
   CALCULATE RECOMMENDATION -- the one remaining explicit, guarded action
   on this page. Uses getCompleteRows() -- the exact same complete-row
   selection the live Blend summary uses (this task's Section 12) -- so a
   still-incomplete row never blocks calculating from the other complete
   sources. If ZERO complete rows exist, Recommendation does not run.
============================================================ */
function handleCalculateRecommendation() {
  if (!requireFullAccessForCalculateAction()) return;

  // Every fresh Recommendation calculation starts Recovery from a clean
  // slate (this task's Section 20 "no stale baseline") -- whatever was
  // typed/computed for a previous, now-irrelevant Recommendation must
  // never silently carry over, even if the new one also turns out to be
  // TARGET_NOT_ACHIEVABLE.
  resetRecoveryState();

  const completeRows = getCompleteRows();

  if (completeRows.length === 0) {
    lastRecommendationResult = null;
    recommendationFieldErrors = null;
    recommendationEngineErrorKey = 'calculate.recommendation.noCompleteSources';
    renderRecommendationFieldError();
    renderRecommendationEngineError();
    renderRecommendationResult();
    return;
  }

  const result = findBlendRecommendations({
    targetNi: targetNiRaw,
    tolerance: toleranceRaw,
    sources: completeRows,
  });

  if (!result.ok) {
    lastRecommendationResult = null;
    if (result.error === 'INVALID_INPUT') {
      // completeRows are already individually field-valid AND mutually
      // duplicate-free by construction (getCompleteRows() only includes
      // rows validatePiles() already passed, and a duplicate pair can
      // never both pass that check -- the later occurrence is always
      // flagged), so the only way INVALID_INPUT can still fire here is an
      // invalid Target Ni/Tolerance, or every complete row having exactly
      // 0 DT (a zero fleet total) -- never a fresh per-row field error.
      recommendationFieldErrors = { targetNi: result.targetError, tolerance: result.toleranceError, fleet: result.fleetError };
      recommendationEngineErrorKey = null;
    } else {
      // SEARCH_SPACE_TOO_LARGE / NO_FEASIBLE_CANDIDATE -- an explicit,
      // localized inline state, never an alert()/console-only/silent
      // failure, and never presented as if it were a valid recommendation.
      recommendationFieldErrors = null;
      recommendationEngineErrorKey = result.error === 'SEARCH_SPACE_TOO_LARGE'
        ? 'calculate.recommendation.searchSpaceTooLarge'
        : 'calculate.recommendation.noFeasibleCandidate';
    }
    renderRecommendationFieldError();
    renderRecommendationEngineError();
    renderRecommendationResult();
    return;
  }

  recommendationFieldErrors = null;
  recommendationEngineErrorKey = null;
  lastRecommendationResult = result;
  renderRecommendationFieldError();
  renderRecommendationEngineError();
  renderRecommendationResult();
}

// Clears any existing Recommendation result/error state (this task's
// Section 15) -- called on every source-row edit, Remove Pile (via
// recomputeLiveBlend()), and every Target Ni/Tolerance edit, so a stale
// result is never left on screen looking like it still matches the
// current inputs. No-ops (and skips re-rendering) when there is nothing
// to clear. Planned Blend Recovery (V2.4 Phase 6, this task's Section 19)
// disappears at the exact same time -- it only ever exists as a subtree
// of the Recommendation result this function is about to hide/clear.
function clearRecommendationResult() {
  if (!lastRecommendationResult && !recommendationFieldErrors && !recommendationEngineErrorKey) return;
  lastRecommendationResult = null;
  recommendationFieldErrors = null;
  recommendationEngineErrorKey = null;
  resetRecoveryState();
  renderRecommendationFieldError();
  renderRecommendationEngineError();
  renderRecommendationResult();
}

function renderRecommendationFieldError() {
  const errs = recommendationFieldErrors;
  markInvalid(els.targetNiInput, errs && errs.targetNi, null, 'calculate-recommendation-input');
  markInvalid(els.toleranceInput, errs && errs.tolerance, null, 'calculate-recommendation-input');

  const messages = errs ? [errs.targetNi, errs.tolerance, errs.fleet].filter(Boolean) : [];
  if (messages.length) {
    els.recommendationFieldError.hidden = false;
    els.recommendationFieldError.textContent = messages.map((key) => t(key)).join(' · ');
  } else {
    els.recommendationFieldError.hidden = true;
    els.recommendationFieldError.textContent = '';
  }
}

function renderRecommendationEngineError() {
  if (!recommendationEngineErrorKey) {
    els.recommendationEngineError.hidden = true;
    els.recommendationEngineError.textContent = '';
    return;
  }
  els.recommendationEngineError.hidden = false;
  els.recommendationEngineError.textContent = t(recommendationEngineErrorKey);
}

/* ============================================================
   RECOMMENDATION RESULT -- rendering order: (1) target/tolerance status,
   (2) Hopper Pattern (most visually prominent), (3+4) Estimated Ni +
   Fleet Utilization, (5) Hopper Sequence, (6) Unit/Tonnage Ratio,
   (7) source/fleet breakdown (collapsed), (8) same-Contractor relocation
   detail. No Material Action (USE/LIMIT/STOP) vocabulary anywhere.
   Rebuilt in full every time -- never a stale partial update. Unchanged
   from Phase 4 (this revision only changes WHICH rows feed it).
============================================================ */
function renderRecommendationResult() {
  if (!lastRecommendationResult) {
    els.recommendationResult.hidden = true;
    els.recommendationResult.replaceChildren();
    return;
  }
  els.recommendationResult.hidden = false;
  els.recommendationResult.replaceChildren(...buildRecommendationResultChildren(lastRecommendationResult));
}

function buildRecommendationResultChildren(result) {
  const { candidate } = result;
  const nodes = [];

  // OPERATIONAL HOPPER PATTERN (V2.4 Phase 6.1 -- Owner correction:
  // "PHYSICAL FLEET ALLOCATION != HOPPER LOAD PATTERN"). Derived ONCE here
  // from the already-selected `candidate`, then used everywhere the
  // prominent "what should the operator actually feed" numbers are shown
  // (the Hopper Pattern card itself, the Hopper Sequence, the within-
  // tolerance status-card Estimated Ni/Deviation, and the summary strip's
  // Estimasi Akhir Ni) -- this task's Section 12: "the main operator-facing
  // Estimated Final Ni must correspond to the displayed Hopper Pattern",
  // never a second, confusingly-different primary value. `candidate`
  // itself (unitRatio/estimatedNi/totalActiveUnits/relocations/etc.) is
  // NEVER overwritten or hidden -- it stays exactly as before for Fleet
  // Utilization, the Ratios row (physical Unit Ratio, deliberately kept
  // separate/secondary), Material/Fleet Actions, and Planned Blend
  // Recovery (this task's Sections 10/13/22).
  const hopperPattern = deriveOperationalHopperPattern({ candidate, targetNi: result.targetNi, tolerance: result.tolerance });

  nodes.push(buildRecommendationStatusCard(result, hopperPattern));
  nodes.push(buildHopperPatternCard(hopperPattern));

  const summary = document.createElement('div');
  summary.className = 'calculate-recommendation-summary';
  summary.appendChild(buildSummaryItem('calculate.recommendation.estimatedNi', `${hopperPattern.estimatedNi.toFixed(3)}%`, 'calculate-recommendation-estimated-ni'));
  summary.appendChild(buildSummaryItem('calculate.recommendation.fleetUtilization', `${fmtRit(candidate.totalActiveUnits)} / ${fmtRit(candidate.totalFleetUnits)} DT`, 'calculate-recommendation-fleet-utilization'));
  nodes.push(summary);

  const utilizationPct = document.createElement('p');
  utilizationPct.className = 'calculate-recommendation-utilization-pct';
  utilizationPct.textContent = `${(candidate.fleetUtilization * 100).toFixed(1)}%`;
  nodes.push(utilizationPct);

  // Hopper Sequence only renders when a per-pile simplified allocation is
  // UNAMBIGUOUS -- never a decorative/incorrect expansion of a multi-
  // source-per-class candidate. When ambiguous, the source breakdown
  // below already shows active units per source.
  const sequenceEntries = buildHopperSequenceEntries(candidate, hopperPattern);
  if (sequenceEntries) {
    nodes.push(buildHopperSequenceCard(sequenceEntries));
  }

  // Ratios row deliberately stays on candidate.unitRatio/tonnageRatio --
  // the PHYSICAL active-fleet ratio (this task's Section 10:
  // "physicalFleetRatio: 5:14 and hopperPattern: 1:3 must be
  // representable simultaneously"). It is visually secondary to the
  // Hopper Pattern card above it, so showing both here is engineering
  // detail, not a confusing duplicate primary value.
  nodes.push(buildRatiosRow(candidate));
  nodes.push(buildSourceBreakdownDetails(candidate));

  // PENYESUAIAN FLEET -> AKSI FLEET -> AKSI MATERIAL (this task's Section
  // 16/18-20): relocation/fleet-planning detail comes first, then what
  // each physical DT should do, then material interpretation last -- this
  // matches the field workflow order, not an arbitrary listing.
  if (candidate.relocations.length > 0) {
    nodes.push(buildRelocationSection(candidate));
  }

  // MATERIAL ACTIONS / FLEET ACTIONS (V2.4 Phase 5) -- always derived
  // fresh from THIS `result` (the already-selected primary Recommendation
  // candidate), never cached separately, and NEVER re-derived from
  // `hopperPattern` -- see recommendation-actions.js's own header comment
  // for the hard "derived after selection, never circular" rule this
  // maintains, and this task's Section 13: Material/Fleet Actions keep
  // their Phase 5 semantics unchanged regardless of how Hopper Pattern is
  // now displayed. Fleet Actions renders BEFORE Material Actions (this
  // task's Section 16 order correction).
  const actions = deriveRecommendationActions(result);
  nodes.push(buildFleetActionsSection(actions));
  nodes.push(buildMaterialActionsSection(actions));

  // PLANNED BLEND RECOVERY (V2.4 Phase 6) -- rendered LAST, after every
  // existing Recommendation detail and Material/Fleet Actions (this task's
  // Section 21), and only while the target is unreachable (this task's
  // Section 2). resetRecoveryState() already guarantees recoveryEls is
  // null whenever this branch is not taken (called from both
  // handleCalculateRecommendation() and clearRecommendationResult() before
  // this function ever runs).
  if (result.status === 'TARGET_NOT_ACHIEVABLE') {
    nodes.push(buildRecoverySection(result));
  }

  return nodes;
}

function buildRecommendationStatusCard(result, hopperPattern) {
  const isOk = result.status === 'OK';

  const card = document.createElement('div');
  card.className = `calculate-recommendation-status ${isOk ? 'calculate-recommendation-status--within' : 'calculate-recommendation-status--not-achievable'}`;

  // Status is never color-only -- a check/cross glyph plus the localized
  // status word both carry the meaning.
  const badge = document.createElement('div');
  badge.className = 'calculate-recommendation-status__badge';
  badge.textContent = isOk ? `✓ ${t('calculate.recommendation.withinTolerance')}` : `✕ ${t('calculate.recommendation.targetNotAchievable')}`;
  card.appendChild(badge);

  const rows = document.createElement('div');
  rows.className = 'calculate-recommendation-status__rows';
  rows.appendChild(buildStatusRow('calculate.recommendation.targetNi', `${result.targetNi.toFixed(3)}%`));
  rows.appendChild(buildStatusRow('calculate.recommendation.tolerance', `±${result.tolerance.toFixed(3)}%`));

  if (isOk) {
    // Uses hopperPattern (this task's Section 12), never candidate directly
    // -- this is the SAME Estimated Ni/Deviation the Hopper Pattern card
    // below is telling the operator to execute, so there is only ever one
    // "Estimasi Akhir Ni" concept on screen for a within-tolerance result.
    rows.appendChild(buildStatusRow('calculate.recommendation.estimatedNi', `${hopperPattern.estimatedNi.toFixed(3)}%`));
    rows.appendChild(buildStatusRow('calculate.recommendation.deviation', formatSignedNi(hopperPattern.deviation)));
    const rangeLow = (result.targetNi - result.tolerance).toFixed(3);
    const rangeHigh = (result.targetNi + result.tolerance).toFixed(3);
    rows.appendChild(buildStatusRow('calculate.recommendation.toleranceRange', `${rangeLow} – ${rangeHigh}%`));
  } else {
    // Target Not Achievable -- Best Attainable Ni/Gap stay based on the
    // selected PHYSICAL candidate (result.bestAttainableNi/result.gap),
    // never on hopperPattern (this task's Section 13/22: the achievability
    // verdict and the Material/Fleet Action + Recovery baseline it feeds
    // must never be silently swapped for a small-pattern number). NEVER
    // presented as though it were a within-tolerance result.
    rows.appendChild(buildStatusRow('calculate.recommendation.bestAttainable', `${result.bestAttainableNi.toFixed(3)}%`));
    rows.appendChild(buildStatusRow('calculate.recommendation.gap', formatSignedNi(result.gap)));
  }

  card.appendChild(rows);
  return card;
}

function buildStatusRow(labelKey, valueText) {
  const row = document.createElement('div');
  row.className = 'calculate-recommendation-status__row';
  const label = document.createElement('span');
  label.textContent = t(labelKey);
  const value = document.createElement('strong');
  value.textContent = valueText;
  row.appendChild(label);
  row.appendChild(value);
  return row;
}

function formatSignedNi(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
}

// HOPPER PATTERN -- the most visually prominent Recommendation result.
// Uses the OPERATIONAL hopperPattern (hopper-pattern.js's
// deriveOperationalHopperPattern(), this task's Part A) -- deliberately
// NEVER candidate.unitRatio (the physical active-fleet ratio) directly,
// since a physical allocation like 5:14 does not automatically mean the
// field feed instruction should be "5 : 14" (Owner correction: "PHYSICAL
// FLEET ALLOCATION != HOPPER LOAD PATTERN"). The feed-ratio hint directly
// below it exists specifically so `1 : 2` is never misread as "exactly 1
// physical truck : 2 physical trucks" -- doubly true now that the pattern
// can legitimately differ from the truck count.
function buildHopperPatternCard(hopperPattern) {
  const card = document.createElement('div');
  card.className = 'calculate-hopper-pattern';

  const label = document.createElement('div');
  label.className = 'calculate-hopper-pattern__label';
  label.textContent = t('calculate.recommendation.hopperPattern');
  card.appendChild(label);

  const ratio = document.createElement('div');
  ratio.className = 'calculate-hopper-pattern__ratio';
  ratio.textContent = `${fmtRit(hopperPattern.higherLoads)} : ${fmtRit(hopperPattern.lgloLoads)}`;
  card.appendChild(ratio);

  const groups = document.createElement('div');
  groups.className = 'calculate-hopper-pattern__groups';
  groups.appendChild(buildHopperGroupLabel(t('calculate.result.higherGrade'), hopperPattern.higherLoads));
  groups.appendChild(buildHopperGroupLabel(t('calculate.recommendation.lglo'), hopperPattern.lgloLoads));
  card.appendChild(groups);

  const repeat = document.createElement('div');
  repeat.className = 'calculate-hopper-pattern__repeat';
  repeat.textContent = `↻ ${t('calculate.recommendation.repeat')}`;
  card.appendChild(repeat);

  const hint = document.createElement('p');
  hint.className = 'calculate-recommendation-feed-hint';
  hint.textContent = t('calculate.recommendation.feedRatioHint');
  card.appendChild(hint);

  return card;
}

function buildHopperGroupLabel(name, loads) {
  const group = document.createElement('div');
  group.className = 'calculate-hopper-pattern__group';
  const label = document.createElement('span');
  label.textContent = name;
  const value = document.createElement('strong');
  value.textContent = `${fmtRit(loads)} ${t('calculate.recommendation.load')}`;
  group.appendChild(label);
  group.appendChild(value);
  return group;
}

// Deterministic per-pile Hopper Sequence. Unambiguous ONLY when each grade
// side (Higher Grade vs LGLO) has at most one ACTIVE contributing source
// -- in that case the OPERATIONAL hopperPattern's loads counts (this
// task's Part A -- never the physical unitRatio) map onto those sources
// directly, since with a single active source per side the group's
// effective Ni/tonnes-per-load IS that one source's own values, so the
// pattern loads unambiguously describe THAT source. With more than one
// active source on either side, there is no single correct per-pile split,
// so this returns null and the caller simply omits the sequence card
// rather than showing a misleading invented ordering. A source appearing
// here always has activeUnits > 0, so it is always Material USE (this
// task's Section 13) -- the Hopper Sequence can never point at a STOPped
// source.
function buildHopperSequenceEntries(candidate, hopperPattern) {
  const higherActive = candidate.sources.filter((s) => HIGHER_GRADE_CLASSES.has(s.oreClass) && s.activeUnits > 0);
  const lgloActive = candidate.sources.filter((s) => s.oreClass === 'LGLO' && s.activeUnits > 0);
  if (higherActive.length > 1 || lgloActive.length > 1) return null;

  const entries = [];
  if (higherActive.length === 1 && hopperPattern.higherLoads > 0) {
    entries.push({ contractor: higherActive[0].contractor, pileId: higherActive[0].pileId, loads: hopperPattern.higherLoads });
  }
  if (lgloActive.length === 1 && hopperPattern.lgloLoads > 0) {
    entries.push({ contractor: lgloActive[0].contractor, pileId: lgloActive[0].pileId, loads: hopperPattern.lgloLoads });
  }
  return entries.length > 0 ? entries : null;
}

function buildHopperSequenceCard(entries) {
  const wrap = document.createElement('div');
  wrap.className = 'calculate-hopper-sequence';

  const title = document.createElement('h3');
  title.className = 'calculate-subsection-label';
  title.textContent = t('calculate.recommendation.hopperSequence');
  wrap.appendChild(title);

  const list = document.createElement('ol');
  list.className = 'calculate-hopper-sequence__list';
  entries.forEach((entry) => {
    const item = document.createElement('li');
    item.className = 'calculate-hopper-sequence__item';
    const label = document.createElement('span');
    label.textContent = `${entry.contractor} · ${entry.pileId}`;
    const value = document.createElement('strong');
    value.textContent = `${fmtRit(entry.loads)} ${t('calculate.recommendation.load')}`;
    item.appendChild(label);
    item.appendChild(value);
    list.appendChild(item);
  });
  wrap.appendChild(list);

  const repeat = document.createElement('p');
  repeat.className = 'calculate-hopper-sequence__repeat';
  repeat.textContent = `↻ ${t('calculate.recommendation.repeat')}`;
  wrap.appendChild(repeat);

  return wrap;
}

// Unit Ratio and Tonnage Ratio -- both read directly from the engine's
// candidate, never recomputed in this file.
function buildRatiosRow(candidate) {
  const wrap = document.createElement('div');
  wrap.className = 'calculate-recommendation-ratios';
  wrap.appendChild(buildRatioItem('calculate.recommendation.unitRatio', `${fmtRit(candidate.unitRatio.higher)} : ${fmtRit(candidate.unitRatio.lglo)}`));
  wrap.appendChild(buildRatioItem('calculate.recommendation.tonnageRatio', `${(candidate.tonnageRatio.higher * 100).toFixed(1)}% : ${(candidate.tonnageRatio.lglo * 100).toFixed(1)}%`));
  return wrap;
}

function buildRatioItem(labelKey, valueText) {
  const item = document.createElement('div');
  item.className = 'calculate-recommendation-ratio-item';
  const label = document.createElement('span');
  label.textContent = t(labelKey);
  const value = document.createElement('strong');
  value.textContent = valueText;
  item.appendChild(label);
  item.appendChild(value);
  return item;
}

// Source Fleet Breakdown -- collapsed by default (details/summary). Never
// labels a source USE/LIMIT/STOP -- that is Phase 5.
function buildSourceBreakdownDetails(candidate) {
  const details = document.createElement('details');
  details.className = 'calculate-recommendation-sources-details';
  const summary = document.createElement('summary');
  summary.textContent = t('calculate.recommendation.sourceBreakdown');
  details.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'calculate-recommendation-sources';
  candidate.sources.forEach((source) => list.appendChild(buildRecommendationSourceRow(source)));
  details.appendChild(list);

  return details;
}

function buildRecommendationSourceRow(source) {
  const row = document.createElement('div');
  row.className = 'calculate-breakdown-row calculate-recommendation-source-row';

  const main = document.createElement('div');
  main.className = 'calculate-breakdown-row__main';
  const idEl = document.createElement('span');
  idEl.className = 'calculate-breakdown-row__id';
  idEl.textContent = source.pileId;
  main.appendChild(idEl);
  row.appendChild(main);

  const sourceLine = document.createElement('div');
  sourceLine.className = 'calculate-breakdown-row__source-line';
  const contractorEl = document.createElement('span');
  contractorEl.className = 'calculate-breakdown-row__contractor';
  contractorEl.textContent = source.contractor;
  const badgeEl = document.createElement('span');
  badgeEl.className = 'calculate-breakdown-row__badge';
  badgeEl.textContent = source.oreClass || EM_DASH;
  sourceLine.appendChild(contractorEl);
  sourceLine.appendChild(badgeEl);
  row.appendChild(sourceLine);

  const meta = document.createElement('div');
  meta.className = 'calculate-breakdown-row__meta';
  meta.appendChild(buildMetaSpan(`${t('calculate.fields.ni')}: ${source.ni.toFixed(3)}%`));
  meta.appendChild(buildMetaSpan(`${t('calculate.recommendation.assigned')}: ${fmtRit(source.assignedUnits)} DT`));
  meta.appendChild(buildMetaSpan(`${t('calculate.recommendation.active')}: ${fmtRit(source.activeUnits)} DT`));
  row.appendChild(meta);

  // Surplus is shown ONLY when this source actually has idle physical DT
  // -- never implying those trucks are consumed or permanently
  // unavailable.
  if (source.standbyUnits > 0) {
    const surplus = document.createElement('div');
    surplus.className = 'calculate-breakdown-row__meta calculate-recommendation-source-row__surplus';
    surplus.appendChild(buildMetaSpan(`${t('calculate.recommendation.surplus')}: ${fmtRit(source.standbyUnits)} DT`));
    row.appendChild(surplus);
  }

  return row;
}

// Same-Contractor relocation detail -- purely displays the relocations
// already present in the selected pure candidate; never a Fleet Action
// status system, and the engine itself guarantees these are never
// cross-Contractor.
function buildRelocationSection(candidate) {
  const wrap = document.createElement('div');
  wrap.className = 'calculate-recommendation-relocations';

  const title = document.createElement('h3');
  title.className = 'calculate-subsection-label';
  title.textContent = t('calculate.recommendation.relocation');
  wrap.appendChild(title);

  candidate.relocations.forEach((relocation) => wrap.appendChild(buildRelocationRow(relocation)));

  return wrap;
}

function buildRelocationRow(relocation) {
  const row = document.createElement('div');
  row.className = 'calculate-breakdown-row calculate-recommendation-relocation-row';

  const main = document.createElement('div');
  main.className = 'calculate-breakdown-row__main';
  const contractorEl = document.createElement('span');
  contractorEl.className = 'calculate-breakdown-row__id';
  contractorEl.textContent = relocation.contractor;
  const unitsEl = document.createElement('strong');
  unitsEl.textContent = `${fmtRit(relocation.units)} DT`;
  main.appendChild(contractorEl);
  main.appendChild(unitsEl);
  row.appendChild(main);

  const path = document.createElement('div');
  path.className = 'calculate-recommendation-relocation-row__path';
  path.textContent = `${relocation.fromPileId} → ${relocation.toPileId}`;
  row.appendChild(path);

  return row;
}

/* ============================================================
   MATERIAL ACTIONS / FLEET ACTIONS (V2.4 Phase 5). Two separate sections
   (this task's Sections 2/18/19) -- never merged into one status. Both are
   entirely derived from `deriveRecommendationActions(result)`
   (recommendation-actions.js, a pure module) -- nothing here recomputes
   USE/LIMIT/STOP or fleet quantities; this file only formats/localizes
   already-decided values for display, the same DOM/pure split every other
   section on this page already follows.
============================================================ */
function buildMaterialActionsSection(actions) {
  const wrap = document.createElement('div');
  wrap.className = 'calculate-actions-section calculate-material-actions';

  const title = document.createElement('h3');
  title.className = 'calculate-subsection-label';
  title.textContent = t('calculate.actions.materialTitle');
  wrap.appendChild(title);

  // Target Not Achievable (architecture doc Section 23.3, this task's
  // Section 25) -- actions below are evaluated against the best-attainable
  // candidate, never presented as though an unreachable target had been
  // met.
  if (actions.status === 'TARGET_NOT_ACHIEVABLE') {
    const note = document.createElement('p');
    note.className = 'calculate-actions-baseline-note';
    note.textContent = t('calculate.actions.bestAttainableNote');
    wrap.appendChild(note);
  }

  const list = document.createElement('div');
  list.className = 'calculate-actions-list';
  actions.materialActions.forEach((entry) => list.appendChild(buildMaterialActionRow(entry)));
  wrap.appendChild(list);

  return wrap;
}

function materialActionLabelKey(action) {
  if (action === MATERIAL_ACTION_USE) return 'calculate.actions.material.use';
  if (action === MATERIAL_ACTION_LIMIT) return 'calculate.actions.material.limit';
  return 'calculate.actions.material.stop';
}

function materialActionReasonKey(action) {
  if (action === MATERIAL_ACTION_USE) return 'calculate.actions.material.useReason';
  if (action === MATERIAL_ACTION_LIMIT) return 'calculate.actions.material.limitReason';
  return 'calculate.actions.material.stopReason';
}

// action is always exactly one of MATERIAL_ACTION_USE/LIMIT/STOP
// (recommendation-actions.js's own return contract) -- used verbatim as a
// lowercased CSS modifier so USE/LIMIT/STOP map onto --use/--limit/--stop
// without a second hand-maintained lookup table.
function buildMaterialActionRow(entry) {
  const row = document.createElement('div');
  row.className = `calculate-breakdown-row calculate-action-row calculate-material-action-row calculate-material-action-row--${entry.action.toLowerCase()}`;

  const main = document.createElement('div');
  main.className = 'calculate-breakdown-row__main';
  const idEl = document.createElement('span');
  idEl.className = 'calculate-breakdown-row__id';
  idEl.textContent = `${entry.contractor} · ${entry.pileId}`;
  main.appendChild(idEl);

  // Status must include text, never color alone (this task's Section 18).
  const badge = document.createElement('span');
  badge.className = `calculate-action-badge calculate-action-badge--${entry.action.toLowerCase()}`;
  badge.textContent = t(materialActionLabelKey(entry.action));
  main.appendChild(badge);
  row.appendChild(main);

  const meta = document.createElement('div');
  meta.className = 'calculate-breakdown-row__meta';
  meta.appendChild(buildMetaSpan(`${entry.oreClass || EM_DASH} · ${t('calculate.fields.ni')} ${entry.ni.toFixed(3)}%`));
  row.appendChild(meta);

  // Short, fixed explanation (this task's Section 21) -- never a raw
  // internal score/deviation number.
  const reason = document.createElement('p');
  reason.className = 'calculate-action-reason';
  reason.textContent = t(materialActionReasonKey(entry.action));
  row.appendChild(reason);

  return row;
}

function buildFleetActionsSection(actions) {
  const wrap = document.createElement('div');
  wrap.className = 'calculate-actions-section calculate-fleet-actions';

  const title = document.createElement('h3');
  title.className = 'calculate-subsection-label';
  title.textContent = t('calculate.actions.fleetTitle');
  wrap.appendChild(title);

  const list = document.createElement('div');
  list.className = 'calculate-actions-list';
  actions.fleetActions.forEach((entry) => list.appendChild(buildFleetActionRow(entry)));
  wrap.appendChild(list);

  return wrap;
}

// Physical DT breakdown for one source -- USE/MOVE/RECEIVE/SEPARATE are
// independent QUANTITIES, never a single enum (unlike Material Action),
// per this task's Section 2/11-13. Only nonzero lines render (Section 19:
// "do not show zero-value rows unless useful"); useUnits is the one
// exception shown even at zero, so a fully-relocated-away or fully-idle
// source never renders an empty-looking row.
function buildFleetActionRow(entry) {
  const row = document.createElement('div');
  row.className = 'calculate-breakdown-row calculate-action-row calculate-fleet-action-row';

  const main = document.createElement('div');
  main.className = 'calculate-breakdown-row__main';
  const idEl = document.createElement('span');
  idEl.className = 'calculate-breakdown-row__id';
  idEl.textContent = `${entry.contractor} · ${entry.pileId}`;
  main.appendChild(idEl);
  row.appendChild(main);

  const lines = document.createElement('div');
  lines.className = 'calculate-fleet-action-row__lines';

  lines.appendChild(buildFleetActionLine('use', `${fmtRit(entry.useUnits)} DT`));

  // Same-Contractor MOVE only -- the engine (fleet-allocation.js's
  // planContractorRelocations()) never produces a cross-Contractor
  // relocation in the first place (this task's Section 15), so there is
  // nothing to filter out here.
  entry.relocationsOut.forEach((relocation) => {
    const suffix = t('calculate.actions.fleet.toPileSuffix', { pileId: relocation.toPileId });
    lines.appendChild(buildFleetActionLine('move', `${fmtRit(relocation.units)} DT ${suffix}`));
  });

  // Optional RECEIVE clarity line (this task's Section 12) -- purely a
  // display convenience; the underlying Fleet Action model (useUnits/
  // moveOutUnits/moveInUnits/separateUnits) stays the same either way.
  entry.relocationsIn.forEach((relocation) => {
    const suffix = t('calculate.actions.fleet.fromPileSuffix', { pileId: relocation.fromPileId });
    lines.appendChild(buildFleetActionLine('receive', `${fmtRit(relocation.units)} DT ${suffix}`));
  });

  // STANDBY (V2.4 Phase 6.1 -- UI wording only, internal
  // separateUnits/'separate' unchanged). A short hint accompanies it so
  // STANDBY is never misread as permanently removed/broken/Contractor-lost
  // (this task's Section 15).
  if (entry.separateUnits > 0) {
    lines.appendChild(buildFleetActionLine('separate', `${fmtRit(entry.separateUnits)} DT`));
    const standbyHint = document.createElement('p');
    standbyHint.className = 'calculate-fleet-action-standby-hint';
    standbyHint.textContent = t('calculate.actions.fleet.standbyHint');
    lines.appendChild(standbyHint);
  }

  row.appendChild(lines);
  return row;
}

const FLEET_ACTION_LABEL_KEYS = {
  use: 'calculate.actions.fleet.use',
  move: 'calculate.actions.fleet.move',
  receive: 'calculate.actions.fleet.receive',
  separate: 'calculate.actions.fleet.separate',
};

function buildFleetActionLine(kind, valueText) {
  const line = document.createElement('div');
  line.className = `calculate-fleet-action-line calculate-fleet-action-line--${kind}`;
  const label = document.createElement('span');
  label.textContent = t(FLEET_ACTION_LABEL_KEYS[kind]);
  const value = document.createElement('strong');
  value.textContent = valueText;
  line.appendChild(label);
  line.appendChild(value);
  return line;
}

// Action-boundary guard for Calculate actions (architecture doc Section
// 10) -- mirrors report-page.js's own private requireFullAccessForReportAction()
// byte-for-byte in structure and behavior. Exported so tests can call it
// directly, and because it is the one guard handleCalculateRecommendation()
// calls before doing anything else. The live Blend recompute is NOT
// gated by this -- it is a passive local recalculation, never a
// protected explicit action, and must not navigate or request License
// attention on its own (this task's Section 3). Bootstrap
// (initCalculatePage()) never calls this either, for the same reason.
export function requireFullAccessForCalculateAction() {
  if (hasFullAccess()) return true;
  navigateTo('settings');
  requestFullAccessAttention('calculate-action');
  return false;
}

/* ============================================================
   PLANNED BLEND RECOVERY (V2.4 Phase 6) -- rendered as the LAST child of
   the Recommendation result (after Hopper Pattern/Fleet Utilization/
   Material Actions/Fleet Actions), and only while
   `result.status === 'TARGET_NOT_ACHIEVABLE'` (this task's Section 2/19).
   Baseline is ALWAYS the best-attainable candidate's own
   estimatedNi/totalTonnage -- never the live sticky "NI SUMPRODUCT" Blend
   summary (this task's Section 1/7). The pure formula/validation/matching
   logic all lives in planned-blend-recovery.js; everything here is DOM
   wiring only.
============================================================ */
function resetRecoveryState() {
  recoveryAddedDtRaw = '';
  recoveryTonnesPerDtRaw = '';
  recoveryFieldErrors = null;
  recoveryResult = null;
  recoveryEls = null;
}

function buildRecoverySection(result) {
  const candidate = result.candidate;
  const wrap = document.createElement('div');
  wrap.className = 'calculate-actions-section calculate-recovery-section';

  const title = document.createElement('h3');
  title.className = 'calculate-subsection-label';
  title.textContent = t('calculate.recovery.title');
  wrap.appendChild(title);

  // Baseline display -- reuses the same status-row styling as the
  // Recommendation status card, but with Recovery-specific labels so it is
  // never confused with the live Blend summary or the Recommendation's own
  // Target/Tolerance rows.
  const baselineRows = document.createElement('div');
  baselineRows.className = 'calculate-recommendation-status__rows calculate-recovery-baseline';
  baselineRows.appendChild(buildStatusRow('calculate.recovery.currentPlannedNi', `${candidate.estimatedNi.toFixed(3)}%`));
  baselineRows.appendChild(buildStatusRow('calculate.recovery.currentPlannedTonnage', `${fmtTon(candidate.totalTonnage)} t`));
  wrap.appendChild(baselineRows);

  const controls = document.createElement('div');
  controls.className = 'calculate-recommendation-controls calculate-recovery-controls';
  const addedDtField = buildRecoveryField('addedDt', 'numeric');
  const tonnesPerDtField = buildRecoveryField('tonnesPerDt', 'decimal');
  controls.appendChild(addedDtField.field);
  controls.appendChild(tonnesPerDtField.field);
  wrap.appendChild(controls);

  const fieldError = document.createElement('p');
  fieldError.className = 'calculate-recommendation-field-error';
  fieldError.setAttribute('role', 'alert');
  fieldError.hidden = true;
  wrap.appendChild(fieldError);

  // Recovery is its OWN explicit action (this task's Section 18) -- never
  // triggered by simply typing Added DT / Tonnes-per-DT.
  const btnRow = document.createElement('div');
  btnRow.className = 'calculate-btn-row';
  const calculateBtn = document.createElement('button');
  calculateBtn.type = 'button';
  calculateBtn.className = 'calculate-btn calculate-btn-primary calculate-calculate-recovery-btn';
  calculateBtn.textContent = t('calculate.recovery.calculate');
  calculateBtn.addEventListener('click', handleCalculateRecovery);
  btnRow.appendChild(calculateBtn);
  wrap.appendChild(btnRow);

  const resultBox = document.createElement('div');
  resultBox.className = 'calculate-recovery-result';
  resultBox.hidden = true;
  wrap.appendChild(resultBox);

  const qualifyingBox = document.createElement('div');
  qualifyingBox.className = 'calculate-recovery-qualifying';
  qualifyingBox.hidden = true;
  wrap.appendChild(qualifyingBox);

  // `candidate` is stashed here (not re-read from lastRecommendationResult)
  // so renderRecoveryResult() always matches qualifying sources against the
  // EXACT candidate this Recovery baseline came from (this task's Section
  // 26 -- reads the best-attainable candidate's own `.sources`, never a
  // second independent lookup).
  recoveryEls = {
    addedDtInput: addedDtField.input,
    tonnesPerDtInput: tonnesPerDtField.input,
    fieldError,
    resultBox,
    qualifyingBox,
    candidate,
  };

  renderRecoveryFieldError();
  renderRecoveryResult();

  return wrap;
}

const RECOVERY_FIELD_LABEL_KEYS = {
  addedDt: 'calculate.recovery.addedDt',
  tonnesPerDt: 'calculate.recovery.tonnesPerDt',
};

// Editing Added DT / Tonnes-per-DT clears ONLY the Recovery result (this
// task's Section 19) -- via clearRecoveryResult(), never
// clearRecommendationResult(). It deliberately does not touch
// lastRecommendationResult, Material Actions, or Fleet Actions.
function buildRecoveryField(fieldName, inputMode) {
  const field = document.createElement('div');
  field.className = 'calculate-recommendation-field calculate-recovery-field';

  const label = document.createElement('label');
  label.className = 'calculate-recommendation-field__label';
  label.textContent = t(RECOVERY_FIELD_LABEL_KEYS[fieldName]);

  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('inputmode', inputMode);
  input.setAttribute('enterkeyhint', fieldName === 'addedDt' ? 'next' : 'done');
  input.setAttribute('aria-label', label.textContent);
  input.dataset.field = fieldName;
  input.className = 'calculate-recommendation-input';
  input.value = fieldName === 'addedDt' ? recoveryAddedDtRaw : recoveryTonnesPerDtRaw;
  input.addEventListener('input', () => {
    if (fieldName === 'addedDt') recoveryAddedDtRaw = input.value;
    else recoveryTonnesPerDtRaw = input.value;
    clearRecoveryResult();
  });

  field.appendChild(label);
  field.appendChild(input);
  return { field, label, input };
}

// Recovery calculation IS a Calculate action (this task's Section 18) --
// gated by the exact same FULL_ACCESS boundary guard as
// handleCalculateRecommendation().
function handleCalculateRecovery() {
  if (!requireFullAccessForCalculateAction()) return;
  // Defensive only -- the button only ever exists inside a freshly built
  // TARGET_NOT_ACHIEVABLE Recovery section, so lastRecommendationResult is
  // always the matching result here.
  if (!lastRecommendationResult || lastRecommendationResult.status !== 'TARGET_NOT_ACHIEVABLE') return;

  const candidate = lastRecommendationResult.candidate;
  const result = calculateRequiredNewDomeNi({
    currentNi: candidate.estimatedNi,
    currentTonnage: candidate.totalTonnage,
    targetNi: lastRecommendationResult.targetNi,
    addedUnits: recoveryAddedDtRaw,
    tonnesPerUnit: recoveryTonnesPerDtRaw,
  });

  if (!result.ok) {
    recoveryResult = null;
    recoveryFieldErrors = result.error === 'INVALID_INPUT'
      ? { addedUnitsError: result.addedUnitsError, tonnesPerUnitError: result.tonnesPerUnitError }
      : null;
    renderRecoveryFieldError();
    renderRecoveryResult();
    return;
  }

  recoveryFieldErrors = null;
  recoveryResult = result;
  renderRecoveryFieldError();
  renderRecoveryResult();
}

// Lighter counterpart to clearRecommendationResult() -- clears ONLY the
// Recovery result/error (this task's Section 19), leaving
// lastRecommendationResult, Material Actions, and Fleet Actions untouched.
function clearRecoveryResult() {
  if (!recoveryResult && !recoveryFieldErrors) return;
  recoveryResult = null;
  recoveryFieldErrors = null;
  renderRecoveryFieldError();
  renderRecoveryResult();
}

function renderRecoveryFieldError() {
  if (!recoveryEls) return;
  const errs = recoveryFieldErrors;
  markInvalid(recoveryEls.addedDtInput, errs && errs.addedUnitsError, null, 'calculate-recommendation-input');
  markInvalid(recoveryEls.tonnesPerDtInput, errs && errs.tonnesPerUnitError, null, 'calculate-recommendation-input');

  const messages = errs ? [errs.addedUnitsError, errs.tonnesPerUnitError].filter(Boolean) : [];
  if (messages.length) {
    recoveryEls.fieldError.hidden = false;
    recoveryEls.fieldError.textContent = messages.map((key) => t(key)).join(' · ');
  } else {
    recoveryEls.fieldError.hidden = true;
    recoveryEls.fieldError.textContent = '';
  }
}

function renderRecoveryResult() {
  if (!recoveryEls) return;
  if (!recoveryResult) {
    recoveryEls.resultBox.hidden = true;
    recoveryEls.resultBox.replaceChildren();
    recoveryEls.qualifyingBox.hidden = true;
    recoveryEls.qualifyingBox.replaceChildren();
    return;
  }

  recoveryEls.resultBox.hidden = false;
  recoveryEls.resultBox.replaceChildren(buildRecoveryResultContent(recoveryResult));

  // Chemical-only match against the SAME candidate.sources this Recovery
  // baseline came from (this task's Section 26) -- never a second
  // independent source lookup.
  const qualifyingSources = findQualifyingSources(recoveryEls.candidate.sources, recoveryResult.requiredNi);
  recoveryEls.qualifyingBox.hidden = false;
  recoveryEls.qualifyingBox.replaceChildren(buildQualifyingSourcesContent(qualifyingSources));
}

// Displays the MINIMUM required Ni with a "≥" prefix (this task's Section
// 6) -- never clamped, never forced to be >= Target/Current Ni beyond what
// the math itself produces.
function buildRecoveryResultContent(result) {
  const wrap = document.createElement('div');
  wrap.className = 'calculate-recovery-result__inner';

  const label = document.createElement('span');
  label.className = 'calculate-recovery-result-label';
  label.textContent = t('calculate.recovery.minimumNewSourceNi');
  wrap.appendChild(label);

  const value = document.createElement('strong');
  value.className = 'calculate-recovery-result-value';
  value.textContent = `≥ ${result.requiredNi.toFixed(3)}%`;
  wrap.appendChild(value);

  return wrap;
}

// Deterministic ordering only (lowest qualifying Ni, then Contractor, then
// Pile ID -- see findQualifyingSources()'s own header comment) -- never
// highest-Ni-first (this task's Section 15/25 test 6).
function buildQualifyingSourcesContent(qualifyingSources) {
  const wrap = document.createElement('div');
  wrap.className = 'calculate-recovery-qualifying__inner';

  const title = document.createElement('h4');
  title.className = 'calculate-subsection-label calculate-recovery-qualifying-title';
  title.textContent = t('calculate.recovery.qualifyingSources');
  wrap.appendChild(title);

  if (qualifyingSources.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'calculate-recovery-qualifying-empty';
    empty.textContent = t('calculate.recovery.noQualifyingSources');
    wrap.appendChild(empty);
    return wrap;
  }

  const list = document.createElement('div');
  list.className = 'calculate-actions-list';
  qualifyingSources.forEach((source) => list.appendChild(buildQualifyingSourceRow(source)));
  wrap.appendChild(list);

  // Chemical-only caveat (this task's Section 16/17) -- a qualifying source
  // proves nothing about available tonnage/stockpile/campaign supply, and
  // may already be fully committed to the best-attainable candidate itself.
  const hint = document.createElement('p');
  hint.className = 'calculate-recovery-qualifying-hint';
  hint.textContent = t('calculate.recovery.chemicalQualificationHint');
  wrap.appendChild(hint);

  return wrap;
}

function buildQualifyingSourceRow(source) {
  const row = document.createElement('div');
  row.className = 'calculate-breakdown-row calculate-recovery-qualifying-row';

  const main = document.createElement('div');
  main.className = 'calculate-breakdown-row__main';
  const idEl = document.createElement('span');
  idEl.className = 'calculate-breakdown-row__id';
  idEl.textContent = `${source.contractor} · ${source.pileId}`;
  main.appendChild(idEl);

  // Reuses the Material Action USE badge styling (green, "meets" framing)
  // -- this is a distinct concept (chemical qualification, not a Material
  // Action verdict) but intentionally shares the same visual language.
  const badge = document.createElement('span');
  badge.className = 'calculate-action-badge calculate-action-badge--use';
  badge.textContent = t('calculate.recovery.meetsMinimum');
  main.appendChild(badge);
  row.appendChild(main);

  const meta = document.createElement('div');
  meta.className = 'calculate-breakdown-row__meta';
  meta.appendChild(buildMetaSpan(`${source.oreClass || EM_DASH} · ${t('calculate.fields.ni')} ${source.ni.toFixed(3)}%`));
  row.appendChild(meta);

  return row;
}
