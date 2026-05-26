const DB_NAME = "ayuFishingLogDb";
const DB_VERSION = 1;
const STORE_STATE = "state";
const STATE_KEY = "app";
const LEGACY_STORAGE_KEY = "ayuFishingLog.v1";

const sections = {
  common: { label: "共通情報", prefix: "" },
  morning: { label: "午前", prefix: "午前_" },
  afternoon: { label: "午後", prefix: "午後_" }
};

const typeLabels = {
  date: "日付",
  number: "数字",
  text: "テキスト",
  textarea: "長文メモ",
  select: "単一選択",
  multiselect: "複数選択",
  checkbox: "チェック",
  combo: "候補＋直接入力"
};

const settingPages = {
  fields: "入力項目の設定",
  options: "選択肢の設定",
  app: "バックアップ・初期化"
};

const comboFieldIds = new Set([
  "fishingCoop",
  "river",
  "point",
  "morning_rod",
  "afternoon_rod",
  "morning_underwaterLine",
  "afternoon_underwaterLine",
  "morning_hanakan",
  "afternoon_hanakan",
  "morning_hook",
  "afternoon_hook"
]);

let templateFields = [];
let templateOptions = {};
let db;
let state;
let editingId = null;
let activeTab = { add: "common", edit: "common" };
let settingPage = "top";
let expandedFieldId = "";

const views = document.querySelectorAll(".view");
const navButtons = document.querySelectorAll(".nav-button");
const addForm = document.getElementById("addForm");
const editForm = document.getElementById("editForm");
const recordList = document.getElementById("recordList");
const fieldSettings = document.getElementById("fieldSettings");
const optionSettings = document.getElementById("optionSettings");
const searchInput = document.getElementById("searchInput");
const toast = document.getElementById("toast");

async function loadInitialTemplates() {
  const [fieldsRes, optionsRes] = await Promise.all([
    fetch("fields.json", { cache: "no-cache" }),
    fetch("options.json", { cache: "no-cache" })
  ]);
  if (!fieldsRes.ok || !optionsRes.ok) throw new Error("初期設定ファイルを読み込めません");
  templateFields = await fieldsRes.json();
  templateOptions = await optionsRes.json();
}

function makeDefaultState() {
  return {
    schemaVersion: 4,
    fields: structuredClone(templateFields),
    options: structuredClone(templateOptions),
    records: []
  };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_STATE)) database.createObjectStore(STORE_STATE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readStateFromDb() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STATE, "readonly");
    const request = tx.objectStore(STORE_STATE).get(STATE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function writeStateToDb(nextState) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STATE, "readwrite");
    tx.objectStore(STORE_STATE).put(nextState, STATE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadState() {
  const saved = await readStateFromDb();
  if (saved) {
    const merged = normalizeState(saved);
    const changed = mergeNewTemplateItems(merged) || applySchemaRules(merged);
    if (changed) await writeStateToDb(merged);
    return merged;
  }

  const legacy = loadLegacyState();
  if (legacy) {
    mergeNewTemplateItems(legacy);
    applySchemaRules(legacy);
    await writeStateToDb(legacy);
    return legacy;
  }

  const fallback = makeDefaultState();
  applySchemaRules(fallback);
  await writeStateToDb(fallback);
  return fallback;
}

function loadLegacyState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY));
    return saved ? normalizeState(saved) : null;
  } catch {
    return null;
  }
}

function normalizeState(raw) {
  const fallback = makeDefaultState();
  return {
    schemaVersion: 4,
    fields: Array.isArray(raw.fields) ? raw.fields : fallback.fields,
    options: { ...fallback.options, ...(raw.options || {}) },
    records: Array.isArray(raw.records) ? raw.records.map(normalizeRecord) : []
  };
}

function mergeNewTemplateItems(targetState) {
  let changed = false;
  const existingIds = new Set(targetState.fields.map((field) => field.id));
  templateFields.forEach((field) => {
    if (!existingIds.has(field.id)) {
      targetState.fields.push(structuredClone(field));
      changed = true;
    }
  });
  Object.entries(templateOptions).forEach(([key, values]) => {
    if (!Array.isArray(targetState.options[key])) {
      targetState.options[key] = structuredClone(values);
      changed = true;
    }
  });
  return changed;
}

function applySchemaRules(targetState) {
  let changed = false;
  const defaultOptionKeys = {
    fishingCoop: "fishingCoop",
    river: "river",
    point: "point",
    morning_rod: "rod",
    afternoon_rod: "rod",
    morning_underwaterLine: "underwaterLine",
    afternoon_underwaterLine: "underwaterLine",
    morning_hanakan: "hanakan",
    afternoon_hanakan: "hanakan",
    morning_hook: "hook",
    afternoon_hook: "hook"
  };
  const fixedSessionOrders = {
    rod: 60,
    underwaterLine: 70,
    hanakan: 80,
    hook: 90,
    maxSize: 100,
    catchCount: 110,
    memo: 120
  };
  targetState.fields.forEach((field) => {
    if (field.id === "river" && field.label === "川") {
      field.label = "川の名前";
      changed = true;
    }
    if (field.sourceId === "rig" || field.id.endsWith("_rig")) {
      if (field.visible !== false || !field.deprecated) changed = true;
      field.visible = false;
      field.deprecated = true;
      field.order = field.order || 900;
    }
    if (comboFieldIds.has(field.id) && field.type !== "combo") {
      field.type = "combo";
      changed = true;
    }
    if (comboFieldIds.has(field.id) && !field.optionKey) {
      field.optionKey = defaultOptionKeys[field.id] || field.id;
      changed = true;
    }
    if ((field.section === "morning" || field.section === "afternoon") && Object.hasOwn(fixedSessionOrders, field.sourceId)) {
      const nextOrder = fixedSessionOrders[field.sourceId];
      if (field.order !== nextOrder) {
        field.order = nextOrder;
        changed = true;
      }
    }
  });
  ["fishingCoop", "point", "underwaterLine", "hanakan", "hook"].forEach((key) => {
    if (!Array.isArray(targetState.options[key])) {
      targetState.options[key] = structuredClone(templateOptions[key] || []);
      changed = true;
    }
  });
  return changed;
}

function normalizeRecord(record) {
  if (record.common || record.morning || record.afternoon) {
    return {
      id: record.id || crypto.randomUUID(),
      createdAt: record.createdAt || new Date().toISOString(),
      updatedAt: record.updatedAt || new Date().toISOString(),
      common: { ...(record.common || {}) },
      morning: { ...(record.morning || {}) },
      afternoon: { ...(record.afternoon || {}) },
      archivedValues: { ...(record.archivedValues || {}) }
    };
  }
  return {
    id: record.id || crypto.randomUUID(),
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: record.updatedAt || new Date().toISOString(),
    common: {
      date: record.date || "",
      fishingCoop: "",
      river: record.river || "",
      point: record.point || "",
      weather: record.weather || "",
      airTemp: record.airTemp || "",
      commonMemo: record.memo || ""
    },
    morning: {
      waterTemp: record.waterTemp || "",
      waterLevel: record.waterLevel || "",
      waterClarity: record.waterClarity || "",
      riverCondition: record.riverCondition || "",
      mossCondition: record.mossCondition || "",
      rod: record.rod || "",
      underwaterLine: "",
      hanakan: "",
      hook: "",
      rig: record.rig || "",
      catchCount: record.catchCount || "",
      maxSize: record.maxSize || "",
      memo: ""
    },
    afternoon: {},
    archivedValues: {}
  };
}

async function saveState() {
  await writeStateToDb(state);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sectionFields(section, includeHidden = false) {
  return state.fields
    .filter((field) => field.section === section && !field.deprecated && (includeHidden || field.visible))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

function recordSectionValue(record, field) {
  const section = record[field.section] || {};
  return section[field.sourceId || field.id] ?? "";
}

function setRecordSectionValue(record, field, value) {
  record[field.section] ||= {};
  record[field.section][field.sourceId || field.id] = value;
}

function createEmptyRecord() {
  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    common: { date: today() },
    morning: {},
    afternoon: {},
    archivedValues: {}
  };
  state.fields.forEach((field) => {
    const key = field.sourceId || field.id;
    record[field.section] ||= {};
    if (!(key in record[field.section])) record[field.section][key] = "";
  });
  return record;
}

function buildForm(form, record, mode) {
  form.innerHTML = "";
  const tabWrap = document.createElement("div");
  tabWrap.className = "section-tabs";
  Object.entries(sections).forEach(([key, section]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tab-button ${activeTab[mode] === key ? "active" : ""}`;
    button.dataset.formTab = key;
    button.textContent = section.label;
    tabWrap.appendChild(button);
  });
  form.appendChild(tabWrap);

  Object.entries(sections).forEach(([key, section]) => {
    const panel = document.createElement("div");
    panel.className = `form-section ${key} ${activeTab[mode] === key ? "active" : ""}`;
    panel.dataset.sectionPanel = key;
    panel.innerHTML = `<h3>${section.label}</h3>`;
    if (key === "afternoon") {
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "secondary-button copy-morning-button";
      copyButton.dataset.copyMorning = "true";
      copyButton.textContent = "午前と同じ";
      panel.appendChild(copyButton);
    }
    sectionFields(key).forEach((field) => panel.appendChild(createFieldControl(field, record, mode)));
    if (key !== "common") {
      const summary = document.createElement("p");
      summary.className = "section-total";
      summary.textContent = `${section.label}釣果：${sessionCatch(record, key)}匹`;
      panel.appendChild(summary);
    }
    form.appendChild(panel);
  });

  const total = document.createElement("div");
  total.className = "total-strip";
  total.textContent = `合計釣果：${totalCatch(record)}匹`;
  form.appendChild(total);

  const actions = document.createElement("div");
  actions.className = "form-actions";
  actions.innerHTML = mode === "add"
    ? '<button class="primary-button" type="submit">記録を保存</button>'
    : [
      '<button class="primary-button" type="submit">変更を保存</button>',
      '<button class="secondary-button" id="shareRecordButton" type="button">共有</button>',
      '<button class="secondary-button" id="lineShareButton" type="button">LINEへ送る</button>',
      '<button class="secondary-button" id="copyShareButton" type="button">コピー</button>',
      '<button class="danger-button" id="deleteEditingButton" type="button">削除</button>'
    ].join("");
  form.appendChild(actions);
}

function createFieldControl(field, record, mode) {
  const wrapper = document.createElement("div");
  wrapper.className = `form-field ${field.type === "textarea" ? "full" : ""}`;
  const inputName = `${field.section}.${field.sourceId || field.id}`;
  const label = document.createElement("label");
  label.htmlFor = `${mode}-${field.id}`;
  label.textContent = `${field.label}${field.unit ? `（${field.unit}）` : ""}${field.required ? " *" : ""}`;
  wrapper.appendChild(label);

  let input;
  const value = recordSectionValue(record, field);
  if (field.type === "select") {
    input = document.createElement("select");
    input.appendChild(new Option("選択してください", ""));
    (state.options[field.optionKey] || []).forEach((option) => input.appendChild(new Option(option, option)));
    input.value = value;
  } else if (field.type === "combo") {
    input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.autocomplete = "off";
    input.dataset.comboInput = field.optionKey;
  } else if (field.type === "multiselect") {
    input = document.createElement("select");
    input.multiple = true;
    input.size = Math.min(5, Math.max(3, (state.options[field.optionKey] || []).length));
    const values = Array.isArray(value) ? value : String(value || "").split("、").filter(Boolean);
    (state.options[field.optionKey] || []).forEach((option) => {
      const opt = new Option(option, option);
      opt.selected = values.includes(option);
      input.appendChild(opt);
    });
  } else if (field.type === "textarea") {
    input = document.createElement("textarea");
    input.value = value;
  } else if (field.type === "checkbox") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value === true || value === "true" || value === "1";
  } else {
    input = document.createElement("input");
    input.type = field.type;
    input.value = value;
    if (field.type === "number") input.inputMode = "decimal";
  }

  input.id = `${mode}-${field.id}`;
  input.name = inputName;
  input.required = !!field.required;
  input.dataset.fieldId = field.id;
  wrapper.appendChild(input);
  if (field.type === "combo") wrapper.appendChild(createCandidateList(field, value));
  return wrapper;
}

function createCandidateList(field, value = "") {
  const list = document.createElement("div");
  list.className = "candidate-list";
  list.dataset.candidatesFor = field.optionKey;
  const options = filteredOptions(field.optionKey, value);
  if (!options.length) {
    list.innerHTML = '<span class="candidate-empty">候補なし</span>';
    return list;
  }
  options.slice(0, 8).forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate-chip";
    button.dataset.candidateValue = option;
    button.textContent = option;
    list.appendChild(button);
  });
  return list;
}

function filteredOptions(optionKey, query) {
  const needle = String(query || "").trim().toLowerCase();
  return [...new Set(state.options[optionKey] || [])].filter((option) => !needle || option.toLowerCase().includes(needle));
}

function collectForm(form, existing = {}) {
  const record = normalizeRecord(existing);
  record.updatedAt = new Date().toISOString();
  state.fields.forEach((field) => {
    const input = form.elements[`${field.section}.${field.sourceId || field.id}`];
    if (!input) return;
    let value;
    if (field.type === "multiselect") value = Array.from(input.selectedOptions).map((option) => option.value);
    else if (field.type === "checkbox") value = input.checked;
    else value = input.value.trim();
    setRecordSectionValue(record, field, value);
  });
  return record;
}

function showView(name) {
  views.forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  navButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  if (name === "add") buildForm(addForm, createEmptyRecord(), "add");
  if (name === "list") renderList();
  if (name === "settings") renderSettings();
}

function renderList() {
  const query = searchInput.value.trim().toLowerCase();
  const records = [...state.records]
    .filter((record) => [record.common.fishingCoop, record.common.river, record.common.point, record.common.commonMemo, record.morning.memo, record.afternoon.memo].join(" ").toLowerCase().includes(query))
    .sort((a, b) => (b.common.date || "").localeCompare(a.common.date || ""));
  document.getElementById("recordCountText").textContent = `${records.length}件の記録`;
  recordList.innerHTML = "";
  if (!records.length) {
    recordList.innerHTML = '<p class="empty-state">まだ記録がありません。追加画面から最初の釣行を保存してください。</p>';
    return;
  }
  records.forEach((record) => {
    const card = document.createElement("article");
    card.className = "record-card";
    card.innerHTML = `
      <div class="record-main" data-edit="${record.id}">
        <div>
          <div class="record-date">${escapeHtml(record.common.date || "日付なし")}</div>
          <div class="record-river">${escapeHtml(record.common.fishingCoop || "漁協未設定")}・${escapeHtml(record.common.river || "川未設定")} ${record.common.point ? `・${escapeHtml(record.common.point)}` : ""}</div>
        </div>
        <div class="record-catch">合計 ${totalCatch(record)}匹</div>
      </div>
      <div class="record-meta">
        <span>${escapeHtml(record.common.weather || "天気未設定")}</span>
        <span>午前 ${sessionCatch(record, "morning")}匹</span>
        <span>午後 ${sessionCatch(record, "afternoon")}匹</span>
      </div>
      <div class="card-actions">
        <button class="secondary-button" type="button" data-edit="${record.id}">編集</button>
        <button class="danger-button" type="button" data-delete="${record.id}">削除</button>
      </div>
    `;
    recordList.appendChild(card);
  });
}

function renderSettings() {
  optionSettings.innerHTML = "";
  if (settingPage === "top") {
    fieldSettings.innerHTML = `
      <div class="setting-card">
        <h3>設定メニュー</h3>
        <div class="setting-menu-grid">
          <button class="secondary-button" type="button" data-setting-page="fields">入力項目の設定</button>
          <button class="secondary-button" type="button" data-setting-page="options">選択肢の設定</button>
          <button class="secondary-button" type="button" data-setting-page="app">バックアップ・初期化・アプリ設定</button>
          <button class="primary-button" type="button" data-view-shortcut="list">記録一覧へ戻る</button>
        </div>
      </div>
    `;
    return;
  }
  if (settingPage === "fields") renderFieldSettings();
  if (settingPage === "options") renderOptionSettings();
  if (settingPage === "app") renderAppSettings();
}

function settingsHeader(title) {
  return `
    <div class="setting-breadcrumb">
      <strong>設定 ＞ ${title}</strong>
      <div class="setting-nav-actions">
        <button class="small-button" type="button" data-setting-page="top">設定トップに戻る</button>
        <button class="secondary-button" type="button" data-view-shortcut="list">記録一覧へ戻る</button>
      </div>
    </div>
  `;
}

function renderFieldSettings() {
  fieldSettings.innerHTML = `
    ${settingsHeader(settingPages.fields)}
    <div class="setting-card">
      <h3>入力項目を追加</h3>
      <div class="field-add-grid">
        <input id="newFieldLabel" type="text" placeholder="表示名">
        <select id="newFieldSection">
          <option value="common">共通情報</option>
          <option value="morning">午前</option>
          <option value="afternoon">午後</option>
        </select>
        <select id="newFieldType">
          ${Object.entries(typeLabels).map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}
        </select>
        <button class="small-button" type="button" id="addFieldButton">項目追加</button>
      </div>
    </div>
    <div class="settings-stack">
      ${state.fields.map((field) => fieldCard(field)).join("")}
    </div>
  `;
}

function fieldCard(field) {
  const isOpen = expandedFieldId === field.id;
  return `
    <div class="setting-card field-card" data-field-row="${field.id}">
      <div class="field-card-head">
        <div>
          <h3>${escapeHtml(field.label)}</h3>
          <p>${sections[field.section]?.label || field.section}・${typeLabels[field.type] || field.type}・${field.visible ? "表示" : "非表示"}・順番 ${Number(field.order || 0)}</p>
        </div>
        <button class="small-button" type="button" data-field-toggle="${field.id}">${isOpen ? "閉じる" : "編集"}</button>
      </div>
      ${isOpen ? `
        <div class="field-edit-grid">
          <input type="text" value="${escapeAttribute(field.label)}" data-field-label="${field.id}" aria-label="表示名">
          <select data-field-section="${field.id}" aria-label="区分">
            ${Object.entries(sections).map(([key, section]) => `<option value="${key}" ${field.section === key ? "selected" : ""}>${section.label}</option>`).join("")}
          </select>
          <select data-field-type="${field.id}" aria-label="入力タイプ">
            ${Object.entries(typeLabels).map(([key, label]) => `<option value="${key}" ${field.type === key ? "selected" : ""}>${label}</option>`).join("")}
          </select>
          <input type="number" value="${Number(field.order || 0)}" data-field-order="${field.id}" aria-label="並び順">
          <label class="mini-check"><input type="checkbox" data-field-visible="${field.id}" ${field.visible ? "checked" : ""}>表示</label>
          <label class="mini-check"><input type="checkbox" data-field-required="${field.id}" ${field.required ? "checked" : ""}>必須</label>
          <button class="small-button" type="button" data-field-save="${field.id}">更新</button>
          <button class="danger-button" type="button" data-field-hide="${field.id}">非表示</button>
        </div>
      ` : ""}
    </div>
  `;
}

function renderOptionSettings() {
  fieldSettings.innerHTML = `
    ${settingsHeader(settingPages.options)}
    <div class="settings-stack">
      ${optionSettingKeys().map((key) => optionCategory(key)).join("")}
    </div>
  `;
}

function optionCategory(key) {
  const options = state.options[key] || [];
  return `
    <details class="setting-card option-category" ${["fishingCoop", "river", "point", "underwaterLine", "hanakan", "hook"].includes(key) ? "open" : ""}>
      <summary>${escapeHtml(optionLabel(key))}の選択肢 <span>${options.length}件</span></summary>
      <div class="option-actions">
        <input type="text" placeholder="追加する選択肢" data-option-input="${key}">
        <button class="small-button" type="button" data-option-add="${key}">追加</button>
      </div>
      <div class="option-list">
        ${options.map((option, index) => optionRow(key, option, index)).join("")}
      </div>
    </details>
  `;
}

function optionRow(key, option, index) {
  return `
    <div class="option-row">
      <input type="text" value="${escapeAttribute(option)}" data-option-edit="${key}" data-option-index="${index}" aria-label="${optionLabel(key)}の選択肢">
      <button class="small-button" type="button" data-option-save="${key}" data-option-index="${index}">更新</button>
      <button class="danger-button" type="button" data-option-delete="${key}" data-option-index="${index}">削除</button>
    </div>
  `;
}

function renderAppSettings() {
  fieldSettings.innerHTML = `
    ${settingsHeader(settingPages.app)}
    <div class="backup-panel">
      <div class="backup-warning">
        <strong>バックアップのお願い</strong>
        <p>記録はスマホ内のIndexedDBに保存します。Chromeのブラウザデータ削除や端末故障に備えて、釣行後はJSONバックアップを保存してください。</p>
      </div>
      <button id="settingsExportCsvButton" class="primary-button" type="button">CSV出力</button>
      <button id="settingsExportJsonButton" class="secondary-button" type="button">記録データのJSONバックアップ</button>
      <label class="file-import">記録データのJSON復元<input id="settingsImportJsonInput" type="file" accept="application/json,.json"></label>
      <button class="secondary-button" type="button" id="exportSettingsButton">設定をJSONバックアップ</button>
      <label class="file-import">設定をJSON復元<input id="importSettingsInput" type="file" accept="application/json,.json"></label>
      <button class="secondary-button" type="button" id="importTemplateButton">初期設定から新しい項目だけ取り込む</button>
      <button class="danger-button" type="button" id="resetSettingsButton">初期設定に戻す</button>
      <button class="danger-button" type="button" id="devResetButton">開発用リセット</button>
      <p class="notice">PWAは一度オンラインで開くとオフラインでも起動できます。更新が反映されない場合は、オンラインで開き直してから再度ホーム画面アイコンで起動してください。</p>
    </div>
  `;
}

function optionSettingKeys() {
  const keys = new Set(Object.keys(templateOptions));
  state.fields.forEach((field) => {
    if ((field.type === "select" || field.type === "multiselect" || field.type === "combo") && field.optionKey) keys.add(field.optionKey);
  });
  return Array.from(keys);
}

function optionLabel(key) {
  const field = state.fields.find((item) => item.optionKey === key);
  return field?.label || key;
}

function openEdit(id) {
  const record = state.records.find((item) => item.id === id);
  if (!record) return;
  editingId = id;
  activeTab.edit = "common";
  buildForm(editForm, record, "edit");
  showView("edit");
}

async function deleteRecord(id) {
  if (!confirm("この記録を削除しますか？")) return;
  state.records = state.records.filter((record) => record.id !== id);
  await saveState();
  renderList();
  showToast("記録を削除しました");
}

function sessionCatch(record, section) {
  return Number(record?.[section]?.catchCount || 0) || 0;
}

function totalCatch(record) {
  return sessionCatch(record, "morning") + sessionCatch(record, "afternoon");
}

function getEditingRecord() {
  if (!editingId) return null;
  const base = state.records.find((record) => record.id === editingId);
  return base ? collectForm(editForm, base) : null;
}

function buildShareText(record) {
  const lines = ["【鮎釣り記録】"];
  appendShareSection(lines, "common", record);
  lines.push("", "【午前】");
  appendShareSection(lines, "morning", record);
  lines.push("", "【午後】");
  appendShareSection(lines, "afternoon", record);
  lines.push("", `合計釣果：${totalCatch(record)}`);
  const commonMemo = record.common?.commonMemo || "";
  if (commonMemo || sectionFields("common").some((field) => (field.sourceId || field.id) === "commonMemo")) {
    lines.push(`共通メモ：${commonMemo}`);
  }
  return lines.join("\n");
}

function appendShareSection(lines, section, record) {
  sectionFields(section).forEach((field) => {
    if (section === "common" && (field.sourceId || field.id) === "commonMemo") return;
    lines.push(`${shareLabel(field)}：${formatValue(recordSectionValue(record, field))}`);
  });
}

function shareLabel(field) {
  if (field.id === "date") return "日付";
  if (field.id === "river") return "川";
  if (field.id === "point") return "ポイント";
  if (field.sourceId === "catchCount") return "釣果";
  return field.label;
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function shareCurrentRecord() {
  const record = getEditingRecord();
  if (!record) return;
  const text = buildShareText(record);
  if (navigator.share) {
    try {
      await navigator.share({ title: "鮎釣り記録", text });
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }
  await copyText(text);
  showToast("共有文をコピーしました");
}

function lineShareCurrentRecord() {
  const record = getEditingRecord();
  if (!record) return;
  location.href = `https://line.me/R/share?text=${encodeURIComponent(buildShareText(record))}`;
}

async function copyCurrentRecord() {
  const record = getEditingRecord();
  if (!record) return;
  await copyText(buildShareText(record));
  showToast("共有文をコピーしました");
}

function exportFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const fields = [...sectionFields("common"), ...sectionFields("morning"), ...sectionFields("afternoon")];
  const headers = fields.map((field) => `${sections[field.section].prefix}${field.label}`).concat("合計釣果数");
  const rows = [...state.records]
    .sort((a, b) => (b.common.date || "").localeCompare(a.common.date || ""))
    .map((record) => fields.map((field) => formatValue(recordSectionValue(record, field))).concat(totalCatch(record)));
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  exportFile(`ayu-log-${today()}.csv`, `\ufeff${csv}`, "text/csv;charset=utf-8");
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportJson() {
  exportFile(`ayu-log-backup-${today()}.json`, JSON.stringify(state, null, 2), "application/json");
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported.records) || !Array.isArray(imported.fields) || !imported.options) throw new Error("invalid");
      state = normalizeState(imported);
      mergeNewTemplateItems(state);
      applySchemaRules(state);
      await saveState();
      buildForm(addForm, createEmptyRecord(), "add");
      showToast("JSONを復元しました");
      showView("list");
    } catch {
      showToast("JSONを読み込めませんでした");
    }
  };
  reader.readAsText(file);
}

function exportSettings() {
  exportFile(`ayu-log-settings-${today()}.json`, JSON.stringify({ fields: state.fields, options: state.options }, null, 2), "application/json");
}

function importSettings(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported.fields) || !imported.options) throw new Error("invalid");
      state.fields = imported.fields;
      state.options = imported.options;
      mergeNewTemplateItems(state);
      applySchemaRules(state);
      await saveState();
      renderSettings();
      buildForm(addForm, createEmptyRecord(), "add");
      showToast("設定を復元しました");
    } catch {
      showToast("設定JSONを読み込めませんでした");
    }
  };
  reader.readAsText(file);
}

async function importNewTemplateItems() {
  const before = state.fields.length + Object.keys(state.options).length;
  mergeNewTemplateItems(state);
  applySchemaRules(state);
  await saveState();
  renderSettings();
  buildForm(addForm, createEmptyRecord(), "add");
  const after = state.fields.length + Object.keys(state.options).length;
  showToast(after > before ? "新しい初期項目を取り込みました" : "追加できる新しい項目はありません");
}

async function resetSettingsToTemplates() {
  if (!confirm("スマホで編集した項目や選択肢が初期状態に戻ります。実行しますか？")) return;
  state.fields = structuredClone(templateFields);
  state.options = structuredClone(templateOptions);
  applySchemaRules(state);
  await saveState();
  renderSettings();
  buildForm(addForm, createEmptyRecord(), "add");
  showToast("初期設定に戻しました");
}

async function devReset() {
  if (!confirm("開発用リセットです。記録と設定をすべて削除します。実行しますか？")) return;
  if (!confirm("本当に削除しますか？この操作は元に戻せません。")) return;
  state = makeDefaultState();
  applySchemaRules(state);
  await saveState();
  renderSettings();
  buildForm(addForm, createEmptyRecord(), "add");
  showToast("開発用リセットを実行しました");
}

function formatValue(value) {
  return Array.isArray(value) ? value.join("、") : (value ?? "");
}

function cleanCandidate(value) {
  return String(value || "").trim();
}

function hasOption(optionKey, value) {
  const clean = cleanCandidate(value);
  return (state.options[optionKey] || []).some((item) => item.trim().toLowerCase() === clean.toLowerCase());
}

function addOption(optionKey, value) {
  const clean = cleanCandidate(value);
  if (!clean || hasOption(optionKey, clean)) return false;
  state.options[optionKey] = [...(state.options[optionKey] || []), clean];
  return true;
}

async function askToAddNewCandidates(record) {
  let changed = false;
  for (const field of state.fields) {
    if (field.type !== "combo" || !field.optionKey) continue;
    const value = cleanCandidate(recordSectionValue(record, field));
    if (!value || hasOption(field.optionKey, value)) continue;
    if (confirm(`「${value}」を「${field.label}」の候補に追加しますか？`)) {
      changed = addOption(field.optionKey, value) || changed;
    }
  }
  return changed;
}

function copyMorningToAfternoon(form, mode) {
  const record = collectForm(form, mode === "edit" ? getEditingRecord() || createEmptyRecord() : createEmptyRecord());
  const afternoonFields = sectionFields("afternoon");
  const hasAfternoonValue = afternoonFields.some((field) => {
    const value = recordSectionValue(record, field);
    return Array.isArray(value) ? value.length : String(value || "").trim();
  });
  if (hasAfternoonValue && !confirm("午後の入力内容を午前の内容で上書きします。実行しますか？")) return;
  afternoonFields.forEach((afternoonField) => {
    const morningField = state.fields.find((field) => field.section === "morning" && (field.sourceId || field.id) === (afternoonField.sourceId || afternoonField.id));
    if (!morningField) return;
    setRecordSectionValue(record, afternoonField, recordSectionValue(record, morningField));
  });
  activeTab[mode] = "afternoon";
  buildForm(form, record, mode);
  showToast("午前の内容を午後へコピーしました");
}

function refreshCandidateList(input) {
  const fieldId = input.dataset.fieldId;
  const field = state.fields.find((item) => item.id === fieldId);
  const list = input.parentElement.querySelector(".candidate-list");
  if (!field || !list) return;
  list.replaceWith(createCandidateList(field, input.value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function bindFormBehavior(form, mode) {
  form.addEventListener("click", (event) => {
    const tab = event.target.dataset.formTab;
    if (tab) {
      activeTab[mode] = tab;
      buildForm(form, collectForm(form, mode === "edit" ? getEditingRecord() || createEmptyRecord() : createEmptyRecord()), mode);
      return;
    }
    if (event.target.dataset.copyMorning) copyMorningToAfternoon(form, mode);
    if (event.target.dataset.candidateValue !== undefined) {
      const input = event.target.closest(".form-field").querySelector("input[data-combo-input]");
      input.value = event.target.dataset.candidateValue;
      refreshCandidateList(input);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  form.addEventListener("input", (event) => {
    if (event.target.dataset.comboInput) refreshCandidateList(event.target);
    const record = collectForm(form, mode === "edit" ? getEditingRecord() || createEmptyRecord() : createEmptyRecord());
    const total = form.querySelector(".total-strip");
    if (total) total.textContent = `合計釣果：${totalCatch(record)}匹`;
  });
}

bindFormBehavior(addForm, "add");
bindFormBehavior(editForm, "edit");

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.view === "settings") {
      settingPage = "top";
      expandedFieldId = "";
    }
    showView(button.dataset.view);
  });
});

document.getElementById("quickAddButton").addEventListener("click", () => showView("add"));

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const record = collectForm(addForm, createEmptyRecord());
  const optionsChanged = await askToAddNewCandidates(record);
  state.records.push(record);
  await saveState();
  activeTab.add = "common";
  buildForm(addForm, createEmptyRecord(), "add");
  showToast(optionsChanged ? "記録と候補を保存しました" : "記録を保存しました");
  showView("list");
});

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const index = state.records.findIndex((record) => record.id === editingId);
  if (index < 0) return;
  const record = collectForm(editForm, state.records[index]);
  const optionsChanged = await askToAddNewCandidates(record);
  state.records[index] = record;
  await saveState();
  showToast(optionsChanged ? "変更と候補を保存しました" : "変更を保存しました");
  showView("list");
});

editForm.addEventListener("click", (event) => {
  if (event.target.id === "deleteEditingButton") deleteRecord(editingId);
  if (event.target.id === "shareRecordButton") shareCurrentRecord();
  if (event.target.id === "lineShareButton") lineShareCurrentRecord();
  if (event.target.id === "copyShareButton") copyCurrentRecord();
});

recordList.addEventListener("click", (event) => {
  const target = event.target.closest("[data-edit], [data-delete]");
  if (!target) return;
  if (target.dataset.edit) openEdit(target.dataset.edit);
  if (target.dataset.delete) deleteRecord(target.dataset.delete);
});

searchInput.addEventListener("input", renderList);

fieldSettings.addEventListener("click", async (event) => {
  const pageTarget = event.target.dataset.settingPage;
  if (pageTarget) {
    settingPage = pageTarget;
    expandedFieldId = "";
    renderSettings();
    return;
  }
  if (event.target.dataset.viewShortcut) {
    showView(event.target.dataset.viewShortcut);
    return;
  }
  if (event.target.id === "settingsExportCsvButton") return exportCsv();
  if (event.target.id === "settingsExportJsonButton") return exportJson();
  if (event.target.id === "exportSettingsButton") return exportSettings();
  if (event.target.id === "importTemplateButton") return importNewTemplateItems();
  if (event.target.id === "resetSettingsButton") return resetSettingsToTemplates();
  if (event.target.id === "devResetButton") return devReset();
  if (event.target.dataset.fieldToggle) {
    expandedFieldId = expandedFieldId === event.target.dataset.fieldToggle ? "" : event.target.dataset.fieldToggle;
    renderSettings();
    return;
  }
  if (event.target.id === "addFieldButton") {
    const label = document.getElementById("newFieldLabel").value.trim();
    const section = document.getElementById("newFieldSection").value;
    const type = document.getElementById("newFieldType").value;
    if (!label) return;
    const id = `${section}_${Date.now()}`;
    const optionKey = ["select", "multiselect", "combo"].includes(type) ? id : "";
    state.fields.push({ id, label, type, optionKey, section, visible: true, order: Date.now(), required: false });
    if (optionKey) state.options[optionKey] = [];
    await saveState();
    renderSettings();
    showToast("項目を追加しました");
    return;
  }
  const saveId = event.target.dataset.fieldSave;
  const hideId = event.target.dataset.fieldHide;
  if (!saveId && !hideId) return;
  const id = saveId || hideId;
  const field = state.fields.find((item) => item.id === id);
  if (!field) return;
  if (hideId) field.visible = false;
  if (saveId) {
    field.label = fieldSettings.querySelector(`[data-field-label="${id}"]`).value.trim() || field.label;
    field.section = fieldSettings.querySelector(`[data-field-section="${id}"]`).value;
    field.type = fieldSettings.querySelector(`[data-field-type="${id}"]`).value;
    if (["select", "multiselect", "combo"].includes(field.type) && !field.optionKey) {
      field.optionKey = field.id;
      state.options[field.optionKey] ||= [];
    }
    field.order = Number(fieldSettings.querySelector(`[data-field-order="${id}"]`).value || field.order || 0);
    field.visible = fieldSettings.querySelector(`[data-field-visible="${id}"]`).checked;
    field.required = fieldSettings.querySelector(`[data-field-required="${id}"]`).checked;
  }
  applySchemaRules(state);
  await saveState();
  renderSettings();
  buildForm(addForm, createEmptyRecord(), "add");
  showToast("入力項目を保存しました");
});

fieldSettings.addEventListener("change", (event) => {
  if (event.target.id === "importSettingsInput") {
    const [file] = event.target.files;
    if (file) importSettings(file);
    event.target.value = "";
  }
  if (event.target.id === "settingsImportJsonInput") {
    const [file] = event.target.files;
    if (file && confirm("記録データをJSONから復元しますか？")) importJson(file);
    event.target.value = "";
  }
});

fieldSettings.addEventListener("click", async (event) => {
  const addKey = event.target.dataset.optionAdd;
  const saveKey = event.target.dataset.optionSave;
  const deleteKey = event.target.dataset.optionDelete;
  if (!addKey && !saveKey && !deleteKey) return;

  if (addKey) {
    const input = fieldSettings.querySelector(`[data-option-input="${addKey}"]`);
    const value = cleanCandidate(input.value);
    if (!value) return;
    if (!addOption(addKey, value)) return showToast("同じ候補がすでにあります");
    input.value = "";
  }
  if (saveKey) {
    const index = Number(event.target.dataset.optionIndex);
    const input = fieldSettings.querySelector(`[data-option-edit="${saveKey}"][data-option-index="${index}"]`);
    const value = cleanCandidate(input.value);
    if (!value) return;
    const duplicate = (state.options[saveKey] || []).some((item, itemIndex) => itemIndex !== index && item.trim().toLowerCase() === value.toLowerCase());
    if (duplicate) return showToast("同じ候補がすでにあります");
    state.options[saveKey][index] = value;
  }
  if (deleteKey) {
    const index = Number(event.target.dataset.optionIndex);
    state.options[deleteKey].splice(index, 1);
  }
  await saveState();
  renderSettings();
  buildForm(addForm, createEmptyRecord(), "add");
  showToast("選択肢を保存しました");
});

document.getElementById("exportCsvButton").addEventListener("click", exportCsv);
document.getElementById("exportJsonButton").addEventListener("click", exportJson);
document.getElementById("importJsonInput").addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file && confirm("JSONバックアップから復元しますか？")) importJson(file);
  event.target.value = "";
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

(async function init() {
  try {
    await loadInitialTemplates();
    db = await openDatabase();
    state = await loadState();
    buildForm(addForm, createEmptyRecord(), "add");
  } catch (error) {
    document.body.innerHTML = '<main class="view active"><div class="section-heading"><h2>起動できません</h2><p>初期設定またはIndexedDBを読み込めません。HTTP/HTTPSで開いているか確認してください。</p></div></main>';
  }
})();
