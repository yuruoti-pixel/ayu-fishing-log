const DB_NAME = "ayuFishingLogDb";
const DB_VERSION = 2;
const STORE_STATE = "state";
const STORE_PHOTOS = "photos";
const STATE_KEY = "app";
const LEGACY_STORAGE_KEY = "ayuFishingLog.v1";
const MAX_RECORD_PHOTOS = 5;

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
  combo: "候補＋直接入力",
  photos: "写真"
};

const settingPages = {
  fields: "入力項目の設定",
  options: "選択肢の設定",
  app: "バックアップ・初期化"
};

const comboFieldIds = new Set([
  "fishingCoop",
  "river",
  "morning_point",
  "afternoon_point",
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
let calendarCursor = new Date();
let selectedCalendarDate = today();
let searchDetailsOpen = false;
let backupPage = "top";

const views = document.querySelectorAll(".view");
const navButtons = document.querySelectorAll(".nav-button");
const addForm = document.getElementById("addForm");
const editForm = document.getElementById("editForm");
const recordList = document.getElementById("recordList");
const calendarPanel = document.getElementById("calendarPanel");
const dayRecordPanel = document.getElementById("dayRecordPanel");
const searchForm = document.getElementById("searchForm");
const searchSummary = document.getElementById("searchSummary");
const searchResults = document.getElementById("searchResults");
const bestPanel = document.getElementById("bestPanel");
const backupContent = document.getElementById("backupContent");
const fieldSettings = document.getElementById("fieldSettings");
const optionSettings = document.getElementById("optionSettings");
const searchInput = document.getElementById("searchInput");
const toast = document.getElementById("toast");
const actionSheet = document.getElementById("actionSheet");

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
    schemaVersion: 5,
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
      if (!database.objectStoreNames.contains(STORE_PHOTOS)) database.createObjectStore(STORE_PHOTOS, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function writePhoto(photo) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PHOTOS, "readwrite");
    tx.objectStore(STORE_PHOTOS).put(photo);
    tx.oncomplete = () => resolve(photo);
    tx.onerror = () => reject(tx.error);
  });
}

function readPhoto(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PHOTOS, "readonly");
    const request = tx.objectStore(STORE_PHOTOS).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function deletePhotoBlob(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PHOTOS, "readwrite");
    tx.objectStore(STORE_PHOTOS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
    schemaVersion: Number(raw.schemaVersion || 1),
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
  const previousVersion = Number(targetState.schemaVersion || 1);
  const defaultOptionKeys = {
    fishingCoop: "fishingCoop",
    river: "river",
    morning_point: "point",
    afternoon_point: "point",
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
    startTime: 10,
    point: 20,
    waterTemp: 30,
    waterLevel: 40,
    waterClarity: 50,
    riverCondition: 60,
    mossCondition: 70,
    rod: 80,
    underwaterLine: 90,
    hanakan: 100,
    hook: 110,
    catchCount: 120,
    maxSize: 130,
    memo: 140
  };
  targetState.fields.forEach((field) => {
    if (field.id === "photos") {
      if (field.label !== "写真" || field.type !== "photos" || field.section !== "common" || field.order !== 60) changed = true;
      field.label = "写真";
      field.type = "photos";
      field.section = "common";
      field.sourceId = "photoIds";
      field.order = 60;
      field.visible = true;
    }
    if (field.id === "commonMemo" && Number(field.order || 0) < 70) {
      field.order = 70;
      changed = true;
    }
    if (field.id === "river" && field.label !== "河川") {
      field.label = "河川";
      changed = true;
    }
    if (field.id === "fishingCoop" && previousVersion < 5 && field.visible !== false) {
      field.visible = false;
      changed = true;
    }
    if (field.id === "point") {
      if (field.visible !== false || !field.deprecated || field.section !== "common") changed = true;
      field.visible = false;
      field.deprecated = true;
      field.section = "common";
      field.label = "ポイント名";
      field.order = 900;
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
  ["fishingCoop", "point", "underwaterLine", "hanakan", "hook", "morningStartTime", "afternoonStartTime"].forEach((key) => {
    if (!Array.isArray(targetState.options[key])) {
      targetState.options[key] = structuredClone(templateOptions[key] || []);
      changed = true;
    }
  });
  if (targetState.schemaVersion !== 5) {
    targetState.schemaVersion = 5;
    changed = true;
  }
  return changed;
}

function normalizeRecord(record) {
  if (record.common || record.morning || record.afternoon) {
    const common = { ...(record.common || {}) };
    const morning = { ...(record.morning || {}) };
    const afternoon = { ...(record.afternoon || {}) };
    if (common.point && !morning.point) morning.point = common.point;
    common.photoIds = Array.isArray(common.photoIds) ? common.photoIds : [];
    return {
      id: record.id || crypto.randomUUID(),
      createdAt: record.createdAt || new Date().toISOString(),
      updatedAt: record.updatedAt || new Date().toISOString(),
      common,
      morning,
      afternoon,
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
      photoIds: [],
      commonMemo: record.memo || ""
    },
    morning: {
      waterTemp: record.waterTemp || "",
      startTime: "",
      point: record.point || "",
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

function exportFields() {
  const common = state.fields
    .filter((field) => field.section === "common" && !field.deprecated && (field.visible || field.id === "fishingCoop"))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  return [...common, ...sectionFields("morning"), ...sectionFields("afternoon")];
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
  actions.className = `form-actions ${mode === "edit" ? "edit-actions" : "add-actions"}`;
  actions.innerHTML = mode === "add"
    ? '<button class="primary-button" type="submit">記録を保存</button>'
    : [
      '<button class="primary-button" type="submit">変更を保存</button>',
      '<button class="secondary-button" id="moreActionsButton" type="button">その他の操作</button>'
    ].join("");
  form.appendChild(actions);
}

function createFieldControl(field, record, mode) {
  const wrapper = document.createElement("div");
  wrapper.className = `form-field ${field.type === "textarea" || field.type === "photos" ? "full" : ""}`;
  const inputName = `${field.section}.${field.sourceId || field.id}`;
  const label = document.createElement("label");
  label.htmlFor = `${mode}-${field.id}`;
  label.textContent = `${field.label}${field.unit ? `（${field.unit}）` : ""}${field.required ? " *" : ""}`;
  wrapper.appendChild(label);

  let input;
  const value = recordSectionValue(record, field);
  if (field.type === "photos") {
    input = document.createElement("input");
    input.type = "hidden";
    input.id = `${mode}-${field.id}`;
    input.name = inputName;
    input.dataset.fieldId = field.id;
    input.value = JSON.stringify(Array.isArray(value) ? value : []);
    wrapper.appendChild(input);
    wrapper.appendChild(createPhotoPicker(field, value, mode));
    return wrapper;
  } else if (field.type === "select") {
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

function createPhotoPicker(field, value = [], mode) {
  const ids = Array.isArray(value) ? value : [];
  const box = document.createElement("div");
  box.className = "photo-field";
  box.dataset.photoField = field.id;
  box.innerHTML = `
    <p class="photo-note">写真はアプリ内に圧縮コピーとして保存されます。スマホ容量を使用します。大事な写真は通常の写真アプリやバックアップにも残してください。</p>
    <div class="photo-thumbs" data-photo-thumbs="${field.id}">${ids.length ? "" : '<span class="photo-empty">写真はまだありません</span>'}</div>
    <div class="photo-actions">
      <button class="secondary-button" type="button" data-photo-select="${field.id}">写真を選ぶ</button>
      <button class="secondary-button" type="button" data-photo-capture="${field.id}">カメラ撮影</button>
      <input class="photo-input" type="file" accept="image/*" multiple data-photo-input="${field.id}">
      <input class="photo-input" type="file" accept="image/*" capture="environment" data-photo-camera-input="${field.id}">
    </div>
  `;
  renderPhotoThumbs(box, ids);
  return box;
}

async function renderPhotoThumbs(container, ids) {
  const thumbs = container.querySelector(".photo-thumbs");
  if (!thumbs) return;
  thumbs.innerHTML = ids.length ? "" : '<span class="photo-empty">写真はまだありません</span>';
  for (const id of ids) {
    const photo = await readPhoto(id);
    if (!photo?.blob) continue;
    const url = URL.createObjectURL(photo.blob);
    const item = document.createElement("div");
    item.className = "photo-thumb";
    item.innerHTML = `
      <button type="button" data-photo-view="${id}" data-photo-longpress="${id}" aria-label="写真を拡大"><img src="${url}" alt="釣行写真"></button>
    `;
    thumbs.appendChild(item);
  }
}

function photoIdsFromInput(form, fieldId = "photos") {
  const input = form.querySelector(`[data-field-id="${fieldId}"]`);
  if (!input) return [];
  try { return JSON.parse(input.value || "[]"); } catch { return []; }
}

function setPhotoIdsToInput(form, ids, fieldId = "photos") {
  const input = form.querySelector(`[data-field-id="${fieldId}"]`);
  if (input) input.value = JSON.stringify(ids);
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.76));
  return { blob, width, height };
}

async function addPhotosToForm(form, files) {
  const ids = photoIdsFromInput(form);
  if (ids.length >= MAX_RECORD_PHOTOS) {
    showToast("写真は最大5枚までです");
    return;
  }
  const slots = MAX_RECORD_PHOTOS - ids.length;
  const selected = Array.from(files).slice(0, slots);
  if (files.length > slots) showToast("写真は最大5枚までです");
  for (const file of selected) {
    if (!file.type.startsWith("image/")) continue;
    const compressed = await compressImage(file);
    const id = crypto.randomUUID();
    await writePhoto({
      id,
      blob: compressed.blob,
      type: "image/jpeg",
      size: compressed.blob.size,
      width: compressed.width,
      height: compressed.height,
      createdAt: new Date().toISOString(),
      originalName: file.name || ""
    });
    ids.push(id);
  }
  setPhotoIdsToInput(form, ids);
  buildForm(form, collectForm(form, form === editForm ? getEditingRecord() || createEmptyRecord() : createEmptyRecord()), form === editForm ? "edit" : "add");
}

async function deletePhotoFromForm(form, id) {
  if (!confirm("この写真を記録から削除します。実行しますか？")) return;
  const ids = photoIdsFromInput(form).filter((photoId) => photoId !== id);
  setPhotoIdsToInput(form, ids);
  const inOtherRecord = state.records.some((record) => record.id !== editingId && (record.common?.photoIds || []).includes(id));
  if (!inOtherRecord) await deletePhotoBlob(id);
  buildForm(form, collectForm(form, form === editForm ? getEditingRecord() || createEmptyRecord() : createEmptyRecord()), form === editForm ? "edit" : "add");
}

async function openPhotoViewer(id) {
  const photo = await readPhoto(id);
  if (!photo?.blob) return;
  const url = URL.createObjectURL(photo.blob);
  actionSheet.innerHTML = `
    <div class="action-sheet-backdrop" data-close-actions="true"></div>
    <div class="photo-viewer-panel">
      <button class="small-button" type="button" data-close-actions="true">閉じる</button>
      <img src="${url}" alt="釣行写真">
    </div>
  `;
  actionSheet.classList.add("show");
  actionSheet.setAttribute("aria-hidden", "false");
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
    if (field.type === "photos") {
      try { value = JSON.parse(input.value || "[]"); } catch { value = []; }
    } else if (field.type === "multiselect") value = Array.from(input.selectedOptions).map((option) => option.value);
    else if (field.type === "checkbox") value = input.checked;
    else value = input.value.trim();
    setRecordSectionValue(record, field, value);
  });
  return record;
}

function showView(name) {
  views.forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  navButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  if (name === "home") renderCalendar();
  if (name === "add") buildForm(addForm, createEmptyRecord(), "add");
  if (name === "list") renderList();
  if (name === "search") renderSearch();
  if (name === "settings") renderSettings();
  if (name === "backup") renderBackup();
}

function renderList() {
  const query = searchInput.value.trim().toLowerCase();
  const records = [...state.records]
    .filter((record) => [record.common.fishingCoop, record.common.river, record.morning.point, record.afternoon.point, record.common.point, record.common.commonMemo, record.morning.memo, record.afternoon.memo].join(" ").toLowerCase().includes(query))
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
          <div class="record-river">${escapeHtml(record.common.river || "河川未設定")} ${recordPoints(record) ? `・${escapeHtml(recordPoints(record))}` : ""}</div>
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

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const monthRecords = state.records.filter((record) => {
    const date = record.common?.date || "";
    return date.startsWith(`${year}-${String(month + 1).padStart(2, "0")}`);
  });
  const daysWithRecords = new Set(monthRecords.map((record) => record.common.date));
  const first = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0).getDate();
  const blanks = first.getDay();
  const cells = [];
  for (let i = 0; i < blanks; i++) cells.push('<div class="calendar-cell muted"></div>');
  for (let day = 1; day <= lastDay; day++) {
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    cells.push(`
      <button class="calendar-cell ${date === selectedCalendarDate ? "selected" : ""}" type="button" data-calendar-date="${date}">
        <span>${day}</span>
        ${daysWithRecords.has(date) ? '<small>●</small>' : ""}
      </button>
    `);
  }
  while (cells.length < 42) cells.push('<div class="calendar-cell muted"></div>');
  calendarPanel.innerHTML = `
    <div class="calendar-toolbar">
      <button class="small-button" type="button" data-calendar-move="-1">前月</button>
      <div class="month-picker">
        <input id="calendarYear" type="number" value="${year}" min="2000" max="2100">
        <select id="calendarMonth">
          ${Array.from({ length: 12 }, (_, index) => `<option value="${index}" ${index === month ? "selected" : ""}>${index + 1}月</option>`).join("")}
        </select>
      </div>
      <button class="small-button" type="button" data-calendar-move="1">翌月</button>
    </div>
    <div class="calendar-weekdays">${["日", "月", "火", "水", "木", "金", "土"].map((d) => `<span>${d}</span>`).join("")}</div>
    <div class="calendar-grid">${cells.join("")}</div>
  `;
  renderDayRecords(selectedCalendarDate);
}

function renderDayRecords(date) {
  const records = state.records.filter((record) => record.common?.date === date);
  dayRecordPanel.innerHTML = `
    <h3>${date.replaceAll("-", "/")} の記録</h3>
    ${records.length ? records.map(dayRecordCard).join("") : '<p class="empty-state">この日の記録はありません。</p>'}
  `;
}

function dayRecordCard(record) {
  return `
    <article class="record-card">
      <div class="record-main">
        <div>
          <div class="record-river">河川：${escapeHtml(record.common?.river || "未設定")}</div>
          <div class="record-meta"><span>天気：${escapeHtml(record.common?.weather || "未設定")}</span><span>ポイント：${escapeHtml(recordPoints(record) || "未設定")}</span></div>
        </div>
        <div class="record-catch">合計：${totalCatch(record)}匹</div>
      </div>
      <div class="record-meta"><span>午前釣果：${sessionCatch(record, "morning")}匹</span><span>午後釣果：${sessionCatch(record, "afternoon")}匹</span></div>
      <div class="card-actions"><button class="secondary-button" type="button" data-edit="${record.id}">編集</button></div>
    </article>
  `;
}

function renderSearch() {
  searchForm.innerHTML = `
    <div class="search-card">
      <h3>基本条件</h3>
      <div class="search-grid basic-search-grid">
        <label>開始日<input name="startDate" type="date"></label>
        <label>終了日<input name="endDate" type="date"></label>
        <label>月<input name="month" type="month"></label>
        <label>河川<input name="river" type="text" list="riverList"></label>
        <label>ポイント名<input name="point" type="text" list="pointList"></label>
      </div>
      <div class="search-actions">
        <button class="primary-button" type="submit">検索する</button>
        <button class="secondary-button" type="button" id="clearSearchButton">条件をクリア</button>
        <button class="secondary-button" type="button" id="toggleDetailSearchButton">${searchDetailsOpen ? "詳細条件を閉じる" : "詳細条件を開く"}</button>
      </div>
    </div>
    <div class="search-card detail-search ${searchDetailsOpen ? "open" : ""}" id="detailSearchPanel">
      <h3>詳細条件</h3>
      <div class="search-grid detail-search-grid">
        <label>天気<select name="weather"><option value="">すべて</option>${optionChoices("weather")}</select></label>
        <label>水濁り<select name="waterClarity"><option value="">すべて</option>${optionChoices("waterClarity")}</select></label>
        <label>川の状態<select name="riverCondition"><option value="">すべて</option>${optionChoices("riverCondition")}</select></label>
        <label>苔<select name="mossCondition"><option value="">すべて</option>${optionChoices("mossCondition")}</select></label>
        <div class="range-field">
          <span>気温</span>
          <input name="airMin" type="number" inputmode="decimal" placeholder="下限">
          <span>〜</span>
          <input name="airMax" type="number" inputmode="decimal" placeholder="上限">
          <span>℃</span>
        </div>
        <div class="range-field">
          <span>水温</span>
          <input name="waterMin" type="number" inputmode="decimal" placeholder="下限">
          <span>〜</span>
          <input name="waterMax" type="number" inputmode="decimal" placeholder="上限">
          <span>℃</span>
        </div>
      </div>
    </div>
    <datalist id="riverList">${(state.options.river || []).map((v) => `<option value="${escapeAttribute(v)}">`).join("")}</datalist>
    <datalist id="pointList">${(state.options.point || []).map((v) => `<option value="${escapeAttribute(v)}">`).join("")}</datalist>
  `;
  renderSearchResults(state.records);
}

function optionChoices(key) {
  return (state.options[key] || []).map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`).join("");
}

function currentSearchConditions() {
  return Object.fromEntries(new FormData(searchForm).entries());
}

function searchFilteredRecords() {
  const c = currentSearchConditions();
  return state.records.filter((record) => {
    const date = record.common?.date || "";
    if (c.startDate && date < c.startDate) return false;
    if (c.endDate && date > c.endDate) return false;
    if (c.month && !date.startsWith(c.month)) return false;
    if (c.river && !String(record.common?.river || "").includes(c.river.trim())) return false;
    if (c.point && !recordPoints(record).includes(c.point.trim())) return false;
    if (c.weather && record.common?.weather !== c.weather) return false;
    if (!inRange(record.common?.airTemp, c.airMin, c.airMax)) return false;
    if (!sessionMatchesRange(record, "waterTemp", c.waterMin, c.waterMax)) return false;
    if (c.waterClarity && !sessionHas(record, "waterClarity", c.waterClarity)) return false;
    if (c.riverCondition && !sessionHas(record, "riverCondition", c.riverCondition)) return false;
    if (c.mossCondition && !sessionHas(record, "mossCondition", c.mossCondition)) return false;
    return true;
  });
}

function inRange(value, min, max) {
  if (min === "" && max === "") return true;
  const num = Number(value);
  if (Number.isNaN(num)) return false;
  if (min !== "" && num < Number(min)) return false;
  if (max !== "" && num > Number(max)) return false;
  return true;
}

function sessionMatchesRange(record, key, min, max) {
  if (min === "" && max === "") return true;
  return ["morning", "afternoon"].some((section) => inRange(record[section]?.[key], min, max));
}

function sessionHas(record, key, value) {
  return ["morning", "afternoon"].some((section) => record[section]?.[key] === value);
}

function renderSearchResults(records) {
  const total = records.reduce((sum, record) => sum + totalCatch(record), 0);
  const morningTotal = records.reduce((sum, record) => sum + sessionCatch(record, "morning"), 0);
  const afternoonTotal = records.reduce((sum, record) => sum + sessionCatch(record, "afternoon"), 0);
  const days = fishingDays(records);
  searchSummary.innerHTML = `<h3 class="panel-title">集計</h3>` + [
    ["釣行日数", `${days}日`],
    ["合計釣果", `${total}匹`],
    ["平均釣果", `${days ? (total / days).toFixed(1) : "0.0"}匹`],
    ["午前合計", `${morningTotal}匹`],
    ["午後合計", `${afternoonTotal}匹`]
  ].map(([label, value]) => `<div class="summary-card"><span>${label}</span><strong>${value}</strong></div>`).join("");
  searchResults.innerHTML = `<h3 class="panel-title">検索結果</h3>` + (records.length ? records.map(searchResultCard).join("") : '<p class="empty-state">該当する記録がありません。</p>');
  bestPanel.innerHTML = `<h3 class="panel-title">ベスト3</h3>${renderBestPanel(records)}`;
}

function searchResultCard(record) {
  return `
    <article class="record-card">
      <div class="record-main">
        <div>
          <div class="record-date">${escapeHtml(record.common?.date || "日付なし")}</div>
          <div class="record-river">河川：${escapeHtml(record.common?.river || "未設定")}</div>
          <div class="record-meta"><span>ポイント：${escapeHtml(recordPoints(record) || "未設定")}</span><span>天気：${escapeHtml(record.common?.weather || "未設定")}</span></div>
        </div>
        <div class="record-catch">合計 ${totalCatch(record)}匹</div>
      </div>
      <div class="record-meta"><span>午前釣果：${sessionCatch(record, "morning")}匹</span><span>午後釣果：${sessionCatch(record, "afternoon")}匹</span></div>
      <div class="card-actions"><button class="secondary-button" type="button" data-edit="${record.id}">編集</button></div>
    </article>
  `;
}

function renderBestPanel(records) {
  return ["rod", "underwaterLine", "hook"].map((key) => {
    const label = { rod: "使用竿", underwaterLine: "水中糸", hook: "針" }[key];
    const ranks = toolRanking(records, key);
    return `
      <section class="best-card">
        <h3>${label} ベスト3</h3>
        ${ranks.length ? ranks.map((rank, index) => `<p>${index + 1}位　${escapeHtml(rank.name)}　平均${rank.average.toFixed(1)}匹　使用日数${rank.days}日　合計${rank.total}匹</p>`).join("") : '<p>対象データがありません。</p>'}
      </section>
    `;
  }).join("");
}

function renderBackup() {
  if (backupPage === "top") {
    backupContent.innerHTML = `
      <div class="backup-warning">
        <strong>バックアップのお願い</strong>
        <p>記録はスマホ内のIndexedDBに保存します。Chromeのブラウザデータ削除や端末故障に備えて、釣行後はJSONバックアップを保存してください。</p>
      </div>
      <div class="backup-menu-grid">
        <button class="backup-menu-card" type="button" data-backup-page="save">
          <strong>保存する</strong>
          <span>CSVやJSONバックアップをスマホに保存します。</span>
        </button>
        <button class="backup-menu-card" type="button" data-backup-page="share">
          <strong>共有する</strong>
          <span>CSVやJSONバックアップをLINE、Google Drive、メールなどへ送ります。</span>
        </button>
        <button class="backup-menu-card danger-menu" type="button" data-backup-page="restore">
          <strong>復元する</strong>
          <span>JSONバックアップから記録を戻します。</span>
        </button>
      </div>
    `;
    return;
  }
  if (backupPage === "save") {
    backupContent.innerHTML = `
      <div class="backup-subhead">
        <h3>保存する</h3>
        <button class="small-button" type="button" data-backup-page="top">バックアップメニューへ戻る</button>
      </div>
      <p class="notice">ファイルをこのスマホに保存します。CSVはExcelや一覧確認・集計用です。JSONバックアップはアプリに復元するためのバックアップです。</p>
      <button id="exportCsvButton" class="primary-button" type="button">CSVを保存</button>
      <button id="exportJsonButton" class="secondary-button" type="button">JSONバックアップを保存</button>
      <button id="exportPhotoZipButton" class="secondary-button" type="button">写真付きバックアップZIPを保存</button>
      <p class="notice">写真付きバックアップZIPは写真を含むため、通常のJSONバックアップより容量が大きくなります。長期保管はGoogle Drive、パソコン、NASなどをおすすめします。</p>
    `;
    return;
  }
  if (backupPage === "share") {
    backupContent.innerHTML = `
      <div class="backup-subhead">
        <h3>共有する</h3>
        <button class="small-button" type="button" data-backup-page="top">バックアップメニューへ戻る</button>
      </div>
      <p class="notice">LINE、メール、Google Driveなどへ送れます。直接共有できない端末では、ファイルを保存してから共有してください。</p>
      <button id="shareCsvButton" class="primary-button" type="button">CSVを共有</button>
      <button id="shareJsonButton" class="secondary-button" type="button">JSONバックアップを共有</button>
      <button id="sharePhotoZipButton" class="secondary-button" type="button">写真付きバックアップZIPを共有</button>
      <p class="notice">写真付きバックアップZIPは写真を含むため、通常のJSONバックアップより容量が大きくなります。</p>
    `;
    return;
  }
  backupContent.innerHTML = `
    <div class="backup-subhead">
      <h3>復元する</h3>
      <button class="small-button" type="button" data-backup-page="top">バックアップメニューへ戻る</button>
    </div>
    <div class="backup-warning danger-warning">
      <strong>復元前の注意</strong>
      <p>JSONバックアップから復元すると、現在の記録や設定がバックアップ内容に置き換わる場合があります。復元前に必要なデータを保存してください。</p>
      <p>LINEなどで受け取ったバックアップファイルは、先にスマホの「ダウンロード」や「Files」アプリに保存してから選んでください。表示されない場合は「すべてのファイル」や「ダウンロード」フォルダから選んでください。</p>
    </div>
    <button id="chooseJsonRestoreButton" class="secondary-button" type="button">JSONから復元</button>
    <button id="choosePhotoZipRestoreButton" class="secondary-button" type="button">写真付きバックアップZIPから復元</button>
  `;
}

function openJsonRestorePicker() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json,text/json,text/plain";
  input.removeAttribute("capture");
  input.addEventListener("change", () => {
    const [file] = input.files || [];
    if (file) confirmAndImportJson(file);
    input.value = "";
    input.remove();
  }, { once: true });
  input.click();
}

function openPhotoZipRestorePicker() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip,application/x-zip-compressed,application/octet-stream";
  input.removeAttribute("capture");
  input.addEventListener("change", () => {
    const [file] = input.files || [];
    if (file) importPhotoZip(file);
    input.value = "";
    input.remove();
  }, { once: true });
  input.click();
}

function isJsonFile(file) {
  return /\.json$/i.test(file.name) || ["application/json", "text/json", "text/plain"].includes(file.type);
}

function isZipFile(file) {
  return /\.zip$/i.test(file.name) || ["application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(file.type);
}

function confirmAndImportJson(file) {
  if (!isJsonFile(file)) {
    showToast("このファイル形式は復元に対応していません。JSONファイルを選択してください。");
    return;
  }
  if (!confirm("JSONバックアップから復元します。現在のデータが置き換わる可能性があります。実行しますか？")) return;
  importJson(file);
}

async function clearPhotoStore() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PHOTOS, "readwrite");
    tx.objectStore(STORE_PHOTOS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function importPhotoZip(file) {
  if (!isZipFile(file)) {
    showToast("このファイル形式は復元に対応していません。写真付きバックアップZIPを選択してください。");
    return;
  }
  if (!confirm("写真付きバックアップZIPから復元します。現在の記録・設定・写真データがバックアップ内容に置き換わる可能性があります。実行しますか？")) return;
  try {
    showToast("写真付きバックアップを復元中です");
    const entries = readZipEntries(await file.arrayBuffer());
    const backupBytes = entries.get("backup.json");
    if (!backupBytes) throw new Error("backup.json not found");
    const backup = JSON.parse(new TextDecoder().decode(backupBytes));
    if (backup.backupFormat !== "ayu-photo-zip" || !backup.state) throw new Error("invalid backup");
    const nextState = normalizeState(backup.state);
    mergeNewTemplateItems(nextState);
    applySchemaRules(nextState);
    await clearPhotoStore();
    for (const item of Object.values(backup.photos?.map || {})) {
      const bytes = entries.get(item.filename);
      if (!bytes) continue;
      await writePhoto({
        id: item.id,
        blob: new Blob([bytes], { type: item.type || "image/jpeg" }),
        type: item.type || "image/jpeg",
        size: item.size || bytes.length,
        width: item.width || null,
        height: item.height || null,
        createdAt: item.createdAt || new Date().toISOString()
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    state = nextState;
    await saveState();
    buildForm(addForm, createEmptyRecord(), "add");
    showToast("写真付きバックアップを復元しました");
    showView("list");
  } catch {
    showToast("写真付きバックアップZIPを復元できませんでした");
  }
}

function toolRanking(records, key) {
  const map = new Map();
  records.forEach((record) => {
    ["morning", "afternoon"].forEach((section) => {
      const name = record[section]?.[key];
      if (!name) return;
      const catchCount = sessionCatch(record, section);
      if (!map.has(name)) map.set(name, { name, total: 0, dates: new Set() });
      const item = map.get(name);
      item.total += catchCount;
      if (record.common?.date) item.dates.add(record.common.date);
    });
  });
  return [...map.values()]
    .map((item) => ({ name: item.name, total: item.total, days: item.dates.size, average: item.dates.size ? item.total / item.dates.size : 0 }))
    .sort((a, b) => b.average - a.average)
    .slice(0, 3);
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
      <p class="notice">CSVは閲覧・集計用、JSONは復元用です。LINE送信は一時共有向きなので、長期保管はGoogle Drive、パソコン、NASなどをおすすめします。</p>
      <button id="settingsExportCsvButton" class="primary-button" type="button">CSVを保存</button>
      <button id="settingsShareCsvButton" class="secondary-button" type="button">CSVを共有</button>
      <button id="settingsExportJsonButton" class="secondary-button" type="button">JSONバックアップを保存</button>
      <button id="settingsShareJsonButton" class="secondary-button" type="button">JSONバックアップを共有</button>
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
  const deleted = state.records.find((record) => record.id === id);
  state.records = state.records.filter((record) => record.id !== id);
  for (const photoId of deleted?.common?.photoIds || []) {
    const stillUsed = state.records.some((record) => (record.common?.photoIds || []).includes(photoId));
    if (!stillUsed) await deletePhotoBlob(photoId);
  }
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

function recordPoints(record) {
  return [...new Set([record?.morning?.point, record?.afternoon?.point, record?.common?.point].filter(Boolean))].join(" / ");
}

function fishingDays(records) {
  return new Set(records.map((record) => record.common?.date).filter(Boolean)).size;
}

function getEditingRecord() {
  if (!editingId) return null;
  const base = state.records.find((record) => record.id === editingId);
  return base ? collectForm(editForm, base) : null;
}

function buildShareText(record) {
  const lines = ["【鮎釣り記録】"];
  appendShareSection(lines, "common", record, true);
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

function appendShareSection(lines, section, record, includeFishingCoop = false) {
  const fields = section === "common" && includeFishingCoop
    ? state.fields.filter((field) => field.section === "common" && !field.deprecated && (field.visible || field.id === "fishingCoop")).sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    : sectionFields(section);
  fields.forEach((field) => {
    if (section === "common" && (field.sourceId || field.id) === "commonMemo") return;
    if (field.type === "photos") return;
    if (field.id === "fishingCoop" && !record.common?.fishingCoop && !field.visible) return;
    lines.push(`${shareLabel(field)}：${formatValue(recordSectionValue(record, field))}`);
  });
}

function shareLabel(field) {
  if (field.id === "date") return "日付";
  if (field.id === "river") return "河川";
  if (field.id === "point") return "ポイント";
  if (field.sourceId === "point") return "ポイント";
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

function openActionSheet() {
  actionSheet.innerHTML = `
    <div class="action-sheet-backdrop" data-close-actions="true"></div>
    <div class="action-sheet-panel">
      <h3>その他の操作</h3>
      <button class="secondary-button" id="shareRecordButton" type="button">共有</button>
      <button class="secondary-button" id="lineShareButton" type="button">LINEへ送る</button>
      <button class="secondary-button" id="copyShareButton" type="button">コピー</button>
      <button class="danger-button" id="deleteEditingButton" type="button">削除</button>
      <button class="small-button" type="button" data-close-actions="true">閉じる</button>
    </div>
  `;
  actionSheet.classList.add("show");
  actionSheet.setAttribute("aria-hidden", "false");
}

function closeActionSheet() {
  actionSheet.classList.remove("show");
  actionSheet.setAttribute("aria-hidden", "true");
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
  const fields = exportFields();
  const headers = fields.map((field) => `${sections[field.section].prefix}${field.label}`).concat("合計釣果数");
  const rows = [...state.records]
    .sort((a, b) => (b.common.date || "").localeCompare(a.common.date || ""))
    .map((record) => fields.map((field) => field.type === "photos" ? (record.common?.photoIds || []).length : formatValue(recordSectionValue(record, field))).concat(totalCatch(record)));
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  exportFile(`ayu-log-${today()}.csv`, `\ufeff${csv}`, "text/csv;charset=utf-8");
}

function buildCsvBlob() {
  const fields = exportFields();
  const headers = fields.map((field) => `${sections[field.section].prefix}${field.label}`).concat("合計釣果数");
  const rows = [...state.records]
    .sort((a, b) => (b.common.date || "").localeCompare(a.common.date || ""))
    .map((record) => fields.map((field) => field.type === "photos" ? (record.common?.photoIds || []).length : formatValue(recordSectionValue(record, field))).concat(totalCatch(record)));
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  return new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
}

function buildJsonBlob() {
  return new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
}

function usedPhotoIds() {
  return [...new Set(state.records.flatMap((record) => record.common?.photoIds || []))];
}

async function buildPhotoZipBlob() {
  showToast("写真付きバックアップを作成中です");
  const photoIds = usedPhotoIds();
  const photoEntries = [];
  const photoMap = {};
  let index = 1;
  for (const id of photoIds) {
    const photo = await readPhoto(id);
    if (!photo?.blob) continue;
    const filename = `photos/photo_${String(index).padStart(3, "0")}.jpg`;
    photoMap[id] = {
      id,
      filename,
      type: photo.type || "image/jpeg",
      size: photo.size || photo.blob.size || 0,
      width: photo.width || null,
      height: photo.height || null,
      createdAt: photo.createdAt || ""
    };
    photoEntries.push({ name: filename, data: new Uint8Array(await photo.blob.arrayBuffer()) });
    index += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const backup = {
    backupFormat: "ayu-photo-zip",
    backupVersion: 1,
    createdAt: new Date().toISOString(),
    state: {
      schemaVersion: state.schemaVersion,
      fields: state.fields,
      options: state.options,
      records: state.records
    },
    photos: {
      map: photoMap,
      count: Object.keys(photoMap).length
    }
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(backup, null, 2));
  return createZipBlob([{ name: "backup.json", data: jsonBytes }, ...photoEntries]);
}

function photoZipFilename() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
  return `ayu-fishing-log-photo-backup-${stamp}.zip`;
}

async function savePhotoZip() {
  try {
    const blob = await buildPhotoZipBlob();
    saveBlob(photoZipFilename(), blob);
    showToast("写真付きバックアップを保存しました");
  } catch {
    showToast("写真付きバックアップの作成に失敗しました");
  }
}

async function sharePhotoZip() {
  try {
    const filename = photoZipFilename();
    const blob = await buildPhotoZipBlob();
    await shareFile(
      blob,
      filename,
      "鮎釣り写真付きバックアップ",
      "この端末では直接共有できないため、ファイルを保存しました。保存後は、スマホのダウンロードまたはFilesアプリからファイルを選んで共有してください。"
    );
  } catch {
    showToast("写真付きバックアップの共有に失敗しました");
  }
}

async function shareBlob(blob, filename, title) {
  await shareFile(blob, filename, title, "この端末では直接共有できないため、ファイルを保存しました。保存後は、スマホのダウンロードまたはFilesアプリからファイルを選んで共有してください。");
}

async function shareFile(blob, filename, title, fallbackMessage) {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  const saveFallback = () => {
    saveBlob(filename, blob);
    showToast(fallbackMessage);
  };
  try {
    if (!navigator.share) {
      saveFallback();
      return;
    }
    if (navigator.canShare && !navigator.canShare({ files: [file] })) {
      saveFallback();
      return;
    }
    await navigator.share({ title, text: filename, files: [file] });
    showToast("共有画面を開きました");
  } catch (error) {
    if (error.name === "AbortError") {
      showToast("共有をキャンセルしました。");
      return;
    }
    saveFallback();
  }
}

function saveBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

let crcTable;
function crc32(bytes) {
  crcTable ||= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function createZipBlob(entries) {
  const encoder = new TextEncoder();
  const now = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;
  entries.forEach((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0800);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, now.time);
    writeU16(localView, 12, now.day);
    writeU32(localView, 14, crc);
    writeU32(localView, 18, data.length);
    writeU32(localView, 22, data.length);
    writeU16(localView, 26, nameBytes.length);
    local.set(nameBytes, 30);
    parts.push(local, data);

    const center = new Uint8Array(46 + nameBytes.length);
    const centerView = new DataView(center.buffer);
    writeU32(centerView, 0, 0x02014b50);
    writeU16(centerView, 4, 20);
    writeU16(centerView, 6, 20);
    writeU16(centerView, 8, 0x0800);
    writeU16(centerView, 10, 0);
    writeU16(centerView, 12, now.time);
    writeU16(centerView, 14, now.day);
    writeU32(centerView, 16, crc);
    writeU32(centerView, 20, data.length);
    writeU32(centerView, 24, data.length);
    writeU16(centerView, 28, nameBytes.length);
    writeU32(centerView, 42, offset);
    center.set(nameBytes, 46);
    central.push(center);
    offset += local.length + data.length;
  });
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 8, entries.length);
  writeU16(endView, 10, entries.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, offset);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

function readZipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;
  while (offset + 30 < bytes.length) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    if (method !== 0) throw new Error("unsupported zip compression");
    entries.set(name, bytes.slice(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
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
    if ((field.sourceId || field.id) === "startTime") return false;
    const value = recordSectionValue(record, field);
    return Array.isArray(value) ? value.length : String(value || "").trim();
  });
  if (hasAfternoonValue && !confirm("午後の入力内容を午前の内容で上書きします。実行しますか？")) return;
  afternoonFields.forEach((afternoonField) => {
    if ((afternoonField.sourceId || afternoonField.id) === "startTime") return;
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
  let photoPressTimer = null;
  let photoLongPressed = false;
  const clearPhotoPress = () => {
    window.clearTimeout(photoPressTimer);
    photoPressTimer = null;
  };
  form.addEventListener("click", (event) => {
    const tab = event.target.dataset.formTab;
    if (tab) {
      activeTab[mode] = tab;
      buildForm(form, collectForm(form, mode === "edit" ? getEditingRecord() || createEmptyRecord() : createEmptyRecord()), mode);
      return;
    }
    if (event.target.dataset.copyMorning) copyMorningToAfternoon(form, mode);
    if (event.target.dataset.photoSelect) {
      form.querySelector(`[data-photo-input="${event.target.dataset.photoSelect}"]`)?.click();
      return;
    }
    if (event.target.dataset.photoCapture) {
      const ids = photoIdsFromInput(form);
      if (ids.length >= MAX_RECORD_PHOTOS) {
        showToast("写真は最大5枚までです");
        return;
      }
      const cameraInput = form.querySelector(`[data-photo-camera-input="${event.target.dataset.photoCapture}"]`);
      if (!cameraInput) {
        showToast("この端末ではカメラ起動に対応していない可能性があります。写真を選択してください。");
        form.querySelector(`[data-photo-input="${event.target.dataset.photoCapture}"]`)?.click();
        return;
      }
      cameraInput.click();
      return;
    }
    if (event.target.dataset.photoDelete) {
      deletePhotoFromForm(form, event.target.dataset.photoDelete);
      return;
    }
    const photoViewTarget = event.target.closest("[data-photo-view]");
    if (photoViewTarget) {
      if (photoLongPressed) {
        photoLongPressed = false;
        return;
      }
      openPhotoViewer(photoViewTarget.dataset.photoView);
      return;
    }
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
  form.addEventListener("change", (event) => {
    if (event.target.dataset.photoInput || event.target.dataset.photoCameraInput) {
      addPhotosToForm(form, event.target.files);
      event.target.value = "";
    }
  });
  form.addEventListener("pointerdown", (event) => {
    const target = event.target.closest("[data-photo-longpress]");
    if (!target) return;
    photoLongPressed = false;
    clearPhotoPress();
    photoPressTimer = window.setTimeout(() => {
      photoLongPressed = true;
      deletePhotoFromForm(form, target.dataset.photoLongpress);
    }, 650);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((type) => {
    form.addEventListener(type, clearPhotoPress);
  });
  form.addEventListener("contextmenu", (event) => {
    if (event.target.closest("[data-photo-longpress]")) event.preventDefault();
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

backupContent.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const nextPage = button.dataset.backupPage;
  if (nextPage) {
    backupPage = nextPage;
    renderBackup();
    return;
  }
  if (button.id === "exportCsvButton") exportCsv();
  if (button.id === "shareCsvButton") shareBlob(buildCsvBlob(), `ayu-log-${today()}.csv`, "鮎釣りCSV");
  if (button.id === "exportJsonButton") exportJson();
  if (button.id === "shareJsonButton") shareBlob(buildJsonBlob(), `ayu-log-backup-${today()}.json`, "鮎釣りJSONバックアップ");
  if (button.id === "exportPhotoZipButton") savePhotoZip();
  if (button.id === "sharePhotoZipButton") sharePhotoZip();
  if (button.id === "chooseJsonRestoreButton") openJsonRestorePicker();
  if (button.id === "choosePhotoZipRestoreButton") openPhotoZipRestorePicker();
});

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
  if (event.target.id === "moreActionsButton") openActionSheet();
});

actionSheet.addEventListener("click", (event) => {
  if (event.target.dataset.closeActions) return closeActionSheet();
  if (event.target.id === "deleteEditingButton") deleteRecord(editingId);
  if (event.target.id === "shareRecordButton") shareCurrentRecord();
  if (event.target.id === "lineShareButton") lineShareCurrentRecord();
  if (event.target.id === "copyShareButton") copyCurrentRecord();
  if (event.target.closest("button")) closeActionSheet();
});

recordList.addEventListener("click", (event) => {
  const target = event.target.closest("[data-edit], [data-delete]");
  if (!target) return;
  if (target.dataset.edit) openEdit(target.dataset.edit);
  if (target.dataset.delete) deleteRecord(target.dataset.delete);
});

searchInput.addEventListener("input", renderList);

calendarPanel.addEventListener("click", (event) => {
  const move = event.target.dataset.calendarMove;
  if (move) {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + Number(move), 1);
    renderCalendar();
    return;
  }
  const date = event.target.closest("[data-calendar-date]")?.dataset.calendarDate;
  if (date) {
    selectedCalendarDate = date;
    renderCalendar();
  }
});

calendarPanel.addEventListener("change", (event) => {
  if (event.target.id === "calendarYear" || event.target.id === "calendarMonth") {
    const year = Number(document.getElementById("calendarYear").value);
    const month = Number(document.getElementById("calendarMonth").value);
    calendarCursor = new Date(year, month, 1);
    renderCalendar();
  }
});

dayRecordPanel.addEventListener("click", (event) => {
  const target = event.target.closest("[data-edit]");
  if (target) openEdit(target.dataset.edit);
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  renderSearchResults(searchFilteredRecords());
});

searchForm.addEventListener("change", () => renderSearchResults(searchFilteredRecords()));

searchForm.addEventListener("click", (event) => {
  if (event.target.id === "toggleDetailSearchButton") {
    searchDetailsOpen = !searchDetailsOpen;
    const current = currentSearchConditions();
    renderSearch();
    Object.entries(current).forEach(([key, value]) => {
      const input = searchForm.elements[key];
      if (input) input.value = value;
    });
    renderSearchResults(searchFilteredRecords());
  }
  if (event.target.id === "clearSearchButton") {
    searchForm.reset();
    renderSearchResults(state.records);
  }
});

searchResults.addEventListener("click", (event) => {
  const target = event.target.closest("[data-edit]");
  if (target) openEdit(target.dataset.edit);
});

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
  if (event.target.id === "settingsShareCsvButton") return shareBlob(buildCsvBlob(), `ayu-log-${today()}.csv`, "鮎釣りCSV");
  if (event.target.id === "settingsExportJsonButton") return exportJson();
  if (event.target.id === "settingsShareJsonButton") return shareBlob(buildJsonBlob(), `ayu-log-backup-${today()}.json`, "鮎釣りJSONバックアップ");
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
    renderCalendar();
  } catch (error) {
    document.body.innerHTML = '<main class="view active"><div class="section-heading"><h2>起動できません</h2><p>初期設定またはIndexedDBを読み込めません。HTTP/HTTPSで開いているか確認してください。</p></div></main>';
  }
})();
