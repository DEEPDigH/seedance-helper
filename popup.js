/**
 * popup.js - readable deobfuscated version.
 * Core globals/functions now use descriptive names.
 * Unresolved local temporaries use autoVar# placeholders for later refinement.
 * Cross-file globals jqTasks/jqImageFiles/jqVideoFiles/jqAudioFiles/jqBuildAtItems
 * are referenced by ui-enhancements.js and must be renamed together if changed.
 */
const getEl = id => document.getElementById(id),
  logEl = getEl("log");
let isQueueRunning = false;
let jqLastRefModeForDuration = getEl("refMode")?.value || "";
const jqDurationByRefMode = Object.create(null);
const seedanceModelOptions = ["Seedance 2.5", "Seedance 2.0 mini", "Seedance 2.0 Fast VIP", "Seedance 2.0 VIP", "Seedance 2.0 Fast", "Seedance 2.0", "Seedance 1.5 Pro", "Seedance 1.0", "Seedance 1.0 Fast"],
  durationOptions = ["4s", "5s", "6s", "7s", "8s", "9s", "10s", "11s", "12s", "13s", "14s", "15s"],
  maxImageCount = 12,
  maxVideoSeconds = 15,
  maxAudioSeconds = 15,
  allowedVideoSizes = [{
    width: 1280,
    height: 720
  }, {
    width: 720,
    height: 1280
  }],
  maxPromptChars = 3950,
  monitorPollMs = 5000,
  submitAcceptTimeoutMs = 20000,
  submitAcceptPollMs = 1500,
  slotWaitLogIntervalMs = 600000,
  singleLimitConfirmDelayMs = 1200,
  modelSubmitCooldownMs = 3000,
  fallbackCountProbeThreshold = 2,
  minConcurrencyLimit = 1,
  maxConcurrencyLimit = 10,
  modelGroupMap = {
    "Seedance 2.5": "vip",
    "Seedance 2.0 mini": "vip",
    "Seedance 2.0 Fast VIP": "vip",
    "Seedance 2.0 VIP": "vip",
    "Seedance 2.0 Fast": "standard",
    "Seedance 2.0": "standard"
  },
  defaultGroupLimits = {
    standard: 1,
    vip: 10
  };
let jqImageFiles = [],
  jqVideoFiles = [],
  jqAudioFiles = [],
  faceSegSourceFile = null,
  faceSegSourceImage = null,
  faceSegRects = [],
  faceSegDraftRect = null,
  faceSegDragging = false,
  faceSegDragStartX = 0,
  faceSegDragStartY = 0,
  faceSegScaleX = 1,
  faceSegScaleY = 1,
  faceSegFaceDataUrl = "",
  faceSegMaskDataUrl = "",
  jqTasks = [],
  nextTaskId = 1,
  monitorEnabled = false,
  monitorTimerId = null,
  monitorDefaultLimit = 10,
  monitorGroupLimits = {
    ...defaultGroupLimits
  },
  queuePaused = false,
  queuePauseReason = "",
  queuePauseScope = "all",
  queuePausedTaskId = null,
  cachedJimengTabId = null,
  isQueueLoopActive = false,
  pauseResumeResolver = null,
  retrySubmitOnceEnabled = true,
  queueAutoResumeEnabled = false,
  // 用户手动停止标记（内存级，不持久化）：手动关闭/暂停全部后置 true，
  // 此时添加任务不再自动开启队列；仅手动开启会清除。重开弹窗自动恢复默认 false。
  queueUserStopped = false;
const modelSubmitCooldownAt = Object.create(null),
  objectUrlCache = new WeakMap(),
  taskQueueStoreKey = "workspace3TaskQueueV1",
  taskPayloadDbName = "workspace3TaskPayloadDb",
  taskPayloadStoreName = "payloads",
  queueAutoResumeStoreKey = "workspace3QueueAutoResumeEnabledV1",
  stepRetryCounts = {
    genMode: 3,
    model: 4,
    refMode: 5,
    ratio: 2,
    duration: 4,
    submit: 2
  },
  stepDelayMs = {
    genMode: 500,
    model: 1300,
    refMode: 1300,
    ratio: 900,
    duration: 900,
    submit: 300
  },
  taskStatusLabels = {
    pending: "已添加",
    running: "提交中",
    generating: "生成中",
    done: "已完成",
    skipped: "已跳过",
    cancelled: "已中断",
    failed: "失败"
  };
function storageGetLocal(key) {
  return new Promise((resolve, reject) => {
    if (!chrome?.storage?.local) {
      resolve(undefined);
      return;
    }
    chrome.storage.local.get([key], items => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "storage get failed"));
        return;
      }
      resolve(items?.[key]);
    });
  });
}
let taskPayloadDbPromise = null;
function openTaskPayloadDb() {
  if (taskPayloadDbPromise) return taskPayloadDbPromise;
  return taskPayloadDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(taskPayloadDbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      !db.objectStoreNames.contains(taskPayloadStoreName) && db.createObjectStore(taskPayloadStoreName, {
        keyPath: "taskId"
      });
    }, request.onsuccess = () => resolve(request.result), request.onerror = () => reject(request.error || new Error("open task payload db failed"));
  }), taskPayloadDbPromise;
}
async function putTaskPayloadRecord(record) {
  const db = await openTaskPayloadDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(taskPayloadStoreName, "readwrite");
    tx.oncomplete = () => resolve(), tx.onerror = () => reject(tx.error || new Error("task payload put failed")), tx.objectStore(taskPayloadStoreName).put(record);
  });
}
async function getTaskPayloadRecord(taskId) {
  const db = await openTaskPayloadDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(taskPayloadStoreName, "readonly"),
      request = tx.objectStore(taskPayloadStoreName).get(taskId);
    request.onsuccess = () => resolve(request.result || null), request.onerror = () => reject(request.error || new Error("task payload get failed"));
  });
}
async function deleteTaskPayloadRecord(taskId) {
  const db = await openTaskPayloadDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(taskPayloadStoreName, "readwrite");
    tx.oncomplete = () => resolve(), tx.onerror = () => reject(tx.error || new Error("task payload delete failed")), tx.objectStore(taskPayloadStoreName)["delete"](taskId);
  });
}
const projectMaterialDbName = "workspace3ProjectMaterialDb",
  projectMaterialStoreName = "materials";
let projectMaterialDbPromise = null;
function openProjectMaterialDb() {
  if (projectMaterialDbPromise) return projectMaterialDbPromise;
  return projectMaterialDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(projectMaterialDbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      !db.objectStoreNames.contains(projectMaterialStoreName) && db.createObjectStore(projectMaterialStoreName, {
        keyPath: "matId"
      });
    }, request.onsuccess = () => resolve(request.result), request.onerror = () => reject(request.error || new Error("open project material db failed"));
  }), projectMaterialDbPromise;
}
async function putProjectMaterialBlob(record) {
  const db = await openProjectMaterialDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(projectMaterialStoreName, "readwrite");
    tx.oncomplete = () => resolve(), tx.onerror = () => reject(tx.error || new Error("project material put failed")), tx.objectStore(projectMaterialStoreName).put(record);
  });
}
async function getProjectMaterialBlob(matId) {
  const db = await openProjectMaterialDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(projectMaterialStoreName, "readonly"),
      request = tx.objectStore(projectMaterialStoreName).get(matId);
    request.onsuccess = () => resolve(request.result || null), request.onerror = () => reject(request.error || new Error("project material get failed"));
  });
}
async function deleteProjectMaterialBlob(matId) {
  const db = await openProjectMaterialDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(projectMaterialStoreName, "readwrite");
    tx.oncomplete = () => resolve(), tx.onerror = () => reject(tx.error || new Error("project material delete failed")), tx.objectStore(projectMaterialStoreName)["delete"](matId);
  });
}
function allowedVideoSizeText() {
  return allowedVideoSizes.map(size => size.width + "x" + size.height).join(" 或 ");
}
function isAllowedVideoSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  return allowedVideoSizes.some(size => size.width === width && size.height === height);
}
function normalizeTextWhitespace(text) {
  return String(text || "").replace(/\r\n?/g, "\n").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\u00A0/g, " ");
}
function stripFileExtension(name) {
  return String(name || "").replace(/\.[^./\\\s]+$/g, "");
}
function normalizeRatioText(ratioText) {
  const match = String(ratioText || "").trim().replace(/^'+/, "").replace(/[：]/g, ":").replace(/[０-９]/g, divider => String.fromCharCode(divider.charCodeAt(0) - 65248)),
    width = match.match(/^(\d+)\s*:\s*(\d+)$/);
  if (!width) return match;
  const height = String(parseInt(width[1], 10)),
    gcd = String(parseInt(width[2], 10));
  if (!Number.isFinite(Number(height)) || !Number.isFinite(Number(gcd)) || Number(gcd) <= 0) return match;
  return height + ":" + gcd;
}
function splitListText(text) {
  return String(text || "").split(/[;；]/).map(item => item.trim()).filter(Boolean);
}
function buildExportTimestamp() {
  const date = new Date(),
    pad2 = value => String(value).padStart(2, "0");
  return "" + date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate()) + "-" + pad2(date.getHours()) + pad2(date.getMinutes());
}
function normalizePromptText(text) {
  return normalizeTextWhitespace(text);
}
function countPromptChars(text) {
  return Array.from(String(text || "")).length;
}
// 提交区实时字数显示：N/上限，超限变红（提交时另有拦截，见 maxPromptChars 校验）
function jqUpdatePromptCharCount() {
  const el = getEl("promptCharCount");
  if (!el) return;
  const n = countPromptChars(getEl("promptText")?.value || "");
  el.textContent = n + "/" + maxPromptChars;
  el.classList.toggle("over", n > maxPromptChars);
}
window.jqUpdatePromptCharCount = jqUpdatePromptCharCount;
function serializeFileBlobs(file) {
  return (file || []).map(fileRecord => ({
    name: fileRecord.name,
    type: fileRecord.type,
    lastModified: fileRecord.lastModified,
    blob: fileRecord
  }));
}
function buildTaskPayloadSnapshot(payload) {
  const fileSummary = payload || readTaskPayloadForm(),
    file = file => ({
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      size: file.size || 0
    });
  return {
    promptText: fileSummary.promptText,
    images: fileSummary.imageFiles.map(file),
    videos: fileSummary.videoFiles.map(file),
    audios: fileSummary.audioFiles.map(file)
  };
}
async function saveTaskPayload(taskId, payload) {
  const record = payload || readTaskPayloadForm();
  await putTaskPayloadRecord({
    taskId: taskId,
    promptText: record.promptText,
    images: serializeFileBlobs(record.imageFiles),
    videos: serializeFileBlobs(record.videoFiles),
    audios: serializeFileBlobs(record.audioFiles),
    updatedAt: Date.now()
  });
}
function restoreFileFromStoredBlob(record, fallbackName) {
  if (!record) return null;
  if (record.blob instanceof Blob) {
    const blob = record.name || fallbackName + "-" + Date.now();
    return new File([record.blob], blob, {
      type: record.type || record.blob.type || "application/octet-stream",
      lastModified: record.lastModified || Date.now()
    });
  }
  return null;
}
async function restorePayloadFiles(record) {
  if (!record) return null;
  const fileFromRecord = (record.images || []).map(audioRecord => restoreFileFromStoredBlob(audioRecord, "image")).filter(Boolean),
    imageRecord = (record.videos || []).map(audioRecord => restoreFileFromStoredBlob(audioRecord, "video")).filter(Boolean),
    videoRecord = (record.audios || []).map(audioFile => restoreFileFromStoredBlob(audioFile, "audio")).filter(Boolean);
  return {
    promptText: String(record.promptText || ""),
    imageFiles: fileFromRecord,
    videoFiles: imageRecord,
    audioFiles: videoRecord
  };
}
function storageSetLocal(items) {
  return new Promise((resolve, reject) => {
    if (!chrome?.storage?.local) {
      resolve();
      return;
    }
    chrome.storage.local.set(items, () => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "storage set failed"));
        return;
      }
      resolve();
    });
  });
}
async function setQueueAutoResumeEnabled(enabled) {
  queueAutoResumeEnabled = !!enabled, await storageSetLocal({
    [queueAutoResumeStoreKey]: queueAutoResumeEnabled
  });
}
const jqProjectStoreKey = "workspace3ProjectsV1",
  jqActiveProjectStoreKey = "workspace3ActiveProjectV1";
let jqProjects = [{
    id: "default",
    name: "默认项目",
    archived: false
  }],
  jqActiveProjectId = "default",
  jqProjectClickTimer = null,
  jqProjectClickId = null;
const jqAutoMaterialFiles = new Map();
let jqProjectMaterialSyncTimer = null;
function jqEscapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}
function jqNormalizeProjectName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 28);
}
function jqNewProjectId() {
  return "project-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
function jqNewMaterialId() {
  return "mat-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
function jqNormalizeMaterialKind(kind) {
  return kind === "vid" || kind === "aud" ? kind : "img";
}
function jqNormalizeMaterialRecord(material) {
  if (!material || !material.name) return null;
  return {
    matId: String(material.matId || jqNewMaterialId()),
    name: String(material.name),
    kind: jqNormalizeMaterialKind(material.kind),
    type: String(material.type || ""),
    size: Number(material.size) || 0
  };
}
function jqNormalizeProjectRecord(project) {
  const now = String(project?.id || jqNewProjectId()),
    normalizedProject = now === "default" ? "默认项目" : jqNormalizeProjectName(project?.name) || "未命名项目",
    materials = Array.isArray(project?.materials) ? project.materials.map(jqNormalizeMaterialRecord).filter(Boolean) : [];
  return {
    id: now,
    name: normalizedProject,
    archived: now === "default" ? false : !!project?.archived,
    materials
  };
}
function jqProjectById(projectId) {
  return jqProjects.find(project => project.id === projectId) || null;
}
function jqProjectNameById(projectId) {
  return (jqProjectById(projectId) || jqProjects[0])?.name || "默认项目";
}
function jqTaskProjectId(task) {
  return String(task?.projectId || "default");
}
function jqTaskSortValue(task) {
  const createdAt = Number(task?.id);
  if (Number.isFinite(createdAt)) return createdAt;
  const idValue = Date.parse(task?.createdAt || "");
  return Number.isFinite(idValue) ? idValue : 0;
}
function jqSortTasksDesc() {
  const previousOrder = [...jqTasks];
  jqTasks.sort((leftTask, rightTask) => jqTaskSortValue(rightTask) - jqTaskSortValue(leftTask));
  return jqTasks.some((task, index) => task !== previousOrder[index]);
}
// 模型感知选任务：按 FIFO 顺序挑第一条「它的模型当前有空位」的 pending 任务；
// 所有模型都满载才回退到队首（由 waitForConcurrencySlot 等待）。避免队首模型满载时阻塞后面有空位的任务。
function jqNextRunnablePendingTask(state) {
  const pend = jqTasks.filter(runtimeState => runtimeState && runtimeState.status === "pending").sort((a, b) => jqTaskSortValue(a) - jqTaskSortValue(b));
  if (!pend.length) return null;
  if (state && typeof state === "object") {
    const runnable = pend.find(t => {
      const model = t.settings?.model || "";
      const slot = modelSlotFromMonitorState(state, model);
      return slot.reliable && slot.currentCount < slot.limit;
    });
    if (runnable) return runnable;
  }
  return pend[0];
}
// 判断某任务的模型此刻是否有空位（按模型独立计数 vs 该模型组上限）。
// 仅在拿到有效后台状态时可信；用于队头阻塞防护：选中的任务无空位则轮询重选，
// 不对它长阻塞，让任意先腾出空位的模型任务被接走。
function jqTaskModelHasFreeSlot(state, task) {
  if (!state || typeof state !== "object" || !task) return false;
  const model = task.settings?.model || "";
  const slot = modelSlotFromMonitorState(state, model);
  return slot.reliable && slot.currentCount < slot.limit;
}
function jqProjectTasks(projectId = jqActiveProjectId) {
  return jqTasks.filter(taskRecord => jqTaskProjectId(taskRecord) === projectId);
}
function jqVisibleTasks() {
  return jqProjectTasks(jqActiveProjectId);
}
let jqQueueSearchText = "";
function jqSearchNormalize(searchText) {
  return String(searchText || "").trim().toLowerCase();
}
const jqPlatformGeneratingTimeoutMs = 7200000;
function jqGeneratingSubmittedAt(task) {
  const submittedAt = Number(task?.platformSubmittedAt || task?.lastSubmittedAt || 0);
  return Number.isFinite(submittedAt) ? submittedAt : 0;
}
function jqFinalizeExpiredGenerating() {
  const expiredBefore = Date.now() - jqPlatformGeneratingTimeoutMs;
  let changed = false;
  for (const taskRecord of jqTasks || []) {
    if (!taskRecord) continue;
    // 逐条 run 超时收口：未在 2h 内同步完成的生成中 run → 标 timeout（耗时不可信，统计已自然排除）
    for (const run of jqTaskRuns(taskRecord)) {
      if (run.status === "generating" && Number(run.submittedAt) > 0 && run.submittedAt <= expiredBefore) {
        run.status = "timeout";
        run.completedAt = 0;
        run.finalizedReason = "timeout";
        changed = true;
      }
    }
    if (jqRecomputeTaskStatusFromRuns(taskRecord)) changed = true;
    // 老卡兜底（没有 runs 时按旧逻辑整卡收口）
    const legacySubmittedAt = jqGeneratingSubmittedAt(taskRecord);
    if (taskRecord.status === "generating" && legacySubmittedAt > 0 && legacySubmittedAt <= expiredBefore && !jqTaskRuns(taskRecord).some(r => r.status === "generating")) {
      taskRecord.status = "done";
      taskRecord.completedAt = null;
      taskRecord.autoFinalized = true;
      changed = true;
    }
  }
  if (changed) saveTasks().catch(() => {});
  return changed;
}
function jqLatestGeneratingTask() {
  return (jqTasks || []).filter(generatingTask => generatingTask && generatingTask.status === "generating").sort((leftTask, rightTask) => jqGeneratingSubmittedAt(rightTask) - jqGeneratingSubmittedAt(leftTask))[0] || null;
}
function jqCurrentTrackedTask() {
  const runningTask = jqCurrentRunningTask();
  if (runningTask) return {
    task: runningTask,
    mode: "提交中"
  };
  const latestGeneratingTask = jqLatestGeneratingTask();
  if (latestGeneratingTask) return {
    task: latestGeneratingTask,
    mode: "最近提交"
  };
  return {
    task: null,
    mode: "空闲"
  };
}
function jqTaskStatusLabel(task) {
  if (!task) return "";
  const repeatTotal = jqTaskRepeatTotal(task),
    repeatDone = jqTaskRepeatDone(task),
    runs = jqTaskRuns(task),
    doneN = runs.filter(r => r.status === "done").length,
    genN = runs.filter(r => r.status === "generating").length,
    failN = runs.filter(r => r.status === "failed").length;
  if (task.status === "generating" || genN > 0) {
    if (repeatTotal <= 1) return "生成中";
    if (genN > 0) return "生成中 " + (doneN + genN) + "/" + repeatTotal + (doneN ? " · " + doneN + " 完成" : "");
    return "生成中 " + repeatDone + "/" + repeatTotal;
  }
  if (task.status === "pending" && isQueueLoopActive) return repeatTotal > 1 ? "排队中 " + repeatDone + "/" + repeatTotal : "排队中";
  if (task.status === "done" && repeatTotal > 1 && failN > 0) return "部分完成 " + doneN + "/" + repeatTotal;
  return taskStatusLabels[task?.status] || task?.status || "";
}
const jqTaskNumberPrefixStoreKey = "workspace3TaskNumberPrefixEnabledV1";
let jqTaskNumberPrefixEnabled = false;
function jqSyncTaskNumberPrefixToggle() {
  const prefixToggleEl = getEl("taskNumberPrefixToggle");
  if (prefixToggleEl) prefixToggleEl.checked = !!jqTaskNumberPrefixEnabled;
}
async function jqLoadTaskNumberPrefixSetting() {
  try {
    const storedPrefixEnabled = await storageGetLocal(jqTaskNumberPrefixStoreKey);
    jqTaskNumberPrefixEnabled = !!storedPrefixEnabled;
  } catch {
    jqTaskNumberPrefixEnabled = false;
  }
  jqSyncTaskNumberPrefixToggle();
}
async function jqSetTaskNumberPrefixEnabled(enabled) {
  jqTaskNumberPrefixEnabled = !!enabled;
  jqSyncTaskNumberPrefixToggle();
  try {
    await storageSetLocal({
      [jqTaskNumberPrefixStoreKey]: jqTaskNumberPrefixEnabled
    });
  } catch {}
}
function jqStripTaskNumberPrefix(promptText) {
  return String(promptText || "").replace(/^#\d+\s*\n?/, "").replace(/^任务\s*#\d+\s*[:：]\s*\n?/, "");
}
function jqApplyTaskNumberPrefix(task, payload) {
  if (!jqTaskNumberPrefixEnabled || !task || !payload) return;
  const taskNumberPrefix = "#" + task.id,
    cleanPromptText = jqStripTaskNumberPrefix(payload.promptText);
  payload.promptText = taskNumberPrefix + (cleanPromptText ? "\n" + cleanPromptText : "");
  if (task.payload) task.payload.promptText = payload.promptText;
}
let jqRunSessionId = null,
  jqStatsManagerOpen = false,
  jqStatsManagerFilter = "samples";
function jqTaskDisplayName(task) {
  if (!task) return "";
  return String(task.taskName || "任务 #" + task.id);
}
function jqStatusRemainingCount(task) {
  if (!task) return 0;
  const repeatTotal = jqTaskRepeatTotal(task),
    repeatDone = jqTaskRepeatDone(task);
  if (task.status === "done" || task.status === "generating") return 0;
  return Math.max(0, repeatTotal - repeatDone);
}
function jqFormatStatusCount(statusCount) {
  return (statusCount?.cards || 0) + "卡 / " + (statusCount?.times || 0) + "次";
}
function jqFormatTaskTime(timestamp) {
  if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return "";
  const date = new Date(Number(timestamp));
  return String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + " " + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
}
function jqTaskTimeMetaHtml(task) {
  const timeParts = [],
    submittedAt = Number(task?.lastSubmittedAt || task?.platformSubmittedAt || 0),
    completedAt = Number(task?.completedAt || 0);
  if (Number.isFinite(submittedAt) && submittedAt > 0) timeParts.push("<span>提交 " + jqFormatTaskTime(submittedAt) + "</span>");
  if (task?.status === "done" && Number.isFinite(completedAt) && completedAt > 0) timeParts.push("<span>完成 " + jqFormatTaskTime(completedAt) + "</span>");
  return timeParts.length ? "<div class=\"task-card-time-meta\">" + timeParts.join("") + "</div>" : "";
}
function jqQueueStatusCounts(tasks) {
  const countsByStatus = {
    pending: {
      cards: 0,
      times: 0
    },
    failed: {
      cards: 0,
      times: 0
    },
    skipped: {
      cards: 0,
      times: 0
    },
    cancelled: {
      cards: 0,
      times: 0
    }
  };
  for (const task of tasks || []) {
    if (task && Object.prototype.hasOwnProperty.call(countsByStatus, task.status)) {
      countsByStatus[task.status].cards += 1;
      countsByStatus[task.status].times += jqStatusRemainingCount(task);
    }
  }
  return countsByStatus;
}
function jqCurrentRunningTask() {
  return (jqTasks || []).find(task => task && task.status === "running") || null;
}
function jqSetText(elementId, textValue) {
  const element = getEl(elementId);
  if (element) element.textContent = String(textValue);
  return element;
}
function jqRenderQueueOverview() {
  jqFinalizeExpiredGenerating();
  const currentProjectCounts = jqQueueStatusCounts(jqProjectTasks(jqActiveProjectId)),
    allProjectCounts = jqQueueStatusCounts(jqTasks || []),
    trackedTask = jqCurrentTrackedTask();
  jqSetText("queueCurrentPending", jqFormatStatusCount(currentProjectCounts.pending));
  jqSetText("queueCurrentFailed", jqFormatStatusCount(currentProjectCounts.failed));
  jqSetText("queueCurrentSkipped", jqFormatStatusCount(currentProjectCounts.skipped));
  jqSetText("queueCurrentCancelled", jqFormatStatusCount(currentProjectCounts.cancelled));
  jqSetText("queueAllPending", jqFormatStatusCount(allProjectCounts.pending));
  jqSetText("queueAllFailed", jqFormatStatusCount(allProjectCounts.failed));
  jqSetText("queueAllSkipped", jqFormatStatusCount(allProjectCounts.skipped));
  jqSetText("queueAllCancelled", jqFormatStatusCount(allProjectCounts.cancelled));
  const runningNameEl = getEl("queueRunningName");
  if (runningNameEl) {
    const trackedTaskRecord = trackedTask.task;
    const genCount = (jqTasks || []).filter(t => t && t.status === "generating").length;
    let prefix = trackedTask.mode;
    if (trackedTaskRecord && trackedTask.mode === "最近提交") prefix = genCount >= 2 ? "生成中 " + genCount + " 条 · 最近" : "生成中";
    const runningLabel = trackedTaskRecord ? prefix + " · " + jqTaskDisplayName(trackedTaskRecord) + " / " + jqProjectNameById(jqTaskProjectId(trackedTaskRecord)) : "空闲";
    runningNameEl.textContent = runningLabel;
    runningNameEl.title = trackedTaskRecord ? (genCount >= 2 ? "点击轮巡定位生成中任务（共 " + genCount + " 条，可连点）" : "点击定位：" + runningLabel) : "暂无可定位任务";
    runningNameEl.dataset.taskId = trackedTaskRecord ? String(trackedTaskRecord.id) : "";
    runningNameEl.classList.toggle("is-idle", !trackedTaskRecord);
  }
}
function jqBeginRunSession() {
  if (!jqRunSessionId) {
    jqRunSessionId = "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  return jqRunSessionId;
}
function jqEndRunSession() {
  jqRunSessionId = null;
}
function jqRecordTaskStart() {}
function jqRecordTaskSubmitted() {}
function jqRecordTaskFailed() {}
function jqFormatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "--";
  const totalSeconds = Math.round(durationMs / 1000),
    hours = Math.floor(totalSeconds / 3600),
    minutes = Math.floor(totalSeconds % 3600 / 60),
    seconds = totalSeconds % 60;
  if (hours) return hours + "h " + String(minutes).padStart(2, "0") + "m";
  if (minutes) return minutes + "m " + String(seconds).padStart(2, "0") + "s";
  return seconds + "s";
}
function jqMedian(values) {
  if (!values.length) return null;
  const sortedValues = [...values].sort((leftValue, rightValue) => leftValue - rightValue),
    middleIndex = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 ? sortedValues[middleIndex] : (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
}
function jqGenStatsAnomalyReason(record) {
  const created = Number(record?.createdTime),
    finished = Number(record?.at),
    duration = Number(record?.durationMs);
  if (!Number.isFinite(created) || created <= 0) return "缺少开始时间";
  if (!Number.isFinite(finished) || finished <= 0) return "缺少完成时间";
  if (!Number.isFinite(duration) || duration <= 0) return "缺少生成耗时";
  if (duration < 30000) return "耗时过短";
  if (duration > 21600000) return "耗时过长";
  return "";
}
function jqGenStatsRecordTitle(record) {
  const recId = String(record?.id || ""),
    serial = String(record?.serial || "");
  const linked = (jqTasks || []).find(t => t && (
    String(t.platformUniqueKey || "") === recId ||
    String(t.id) === serial ||
    jqTaskRuns(t).some(r => String(r.platformKey || "") === recId)
  ));
  if (linked) {
    const run = jqTaskRuns(linked).find(r => String(r.platformKey || "") === recId);
    return "#" + linked.id + " · " + jqTaskDisplayName(linked) + (run && jqTaskRepeatTotal(linked) > 1 ? " · 第" + run.seq + "次" : "");
  }
  if (record?.serial) return "#" + record.serial;
  return record?.id ? "平台记录 " + String(record.id).slice(0, 12) : "实测样本";
}
function jqGenStatsFilterRows(filterName) {
  return (Array.isArray(jqGenStats) ? jqGenStats : []).map((record, index) => ({
    record: record,
    index: index
  })).filter(({
    record: record
  }) => {
    if (filterName === "invalid") return !!jqGenStatsAnomalyReason(record);
    return true;
  }).map(({
    record: record,
    index: index
  }) => ({
    record: {
      ...record,
      taskName: jqGenStatsRecordTitle(record)
    },
    index: index
  })).reverse();
}
function jqGenStatsDeleteIndexes(indexes) {
  const sortedIndexes = [...new Set((indexes || []).map(Number).filter(Number.isInteger))].sort((leftIndex, rightIndex) => rightIndex - leftIndex);
  if (!sortedIndexes.length) return;
  for (const indexToDelete of sortedIndexes) {
    if (indexToDelete >= 0 && indexToDelete < jqGenStats.length) jqGenStats.splice(indexToDelete, 1);
  }
  jqSaveGenStats();
  jqRenderStatsPanel();
}
function jqRenderStatsManagerBody() {
  const rows = jqGenStatsFilterRows(jqStatsManagerFilter),
    filterLabels = {
      samples: "实测样本",
      invalid: "疑似异常"
    };
  return "<div class=\"stats-data-manager\"><div class=\"stats-data-controls\"><select id=\"statsDataFilter\" class=\"stats-data-filter\"><option value=\"samples\" " + (jqStatsManagerFilter === "samples" ? "selected" : "") + ">实测样本</option><option value=\"invalid\" " + (jqStatsManagerFilter === "invalid" ? "selected" : "") + ">疑似异常</option></select><button type=\"button\" id=\"statsDeleteSelected\" class=\"stats-data-delete-selected\">删除所选</button><span>" + (filterLabels[jqStatsManagerFilter] || "记录") + " " + rows.length + " 条</span></div>" + (rows.length ? "<div class=\"stats-data-list\">" + rows.map(({
    record: record,
    index: index
  }) => {
    const anomalyReason = jqGenStatsAnomalyReason(record),
      createdTime = Number(record?.createdTime),
      finishedTime = Number(record?.at),
      createdLabel = Number.isFinite(createdTime) && createdTime > 0 ? jqFormatTaskTime(createdTime) : "未知开始",
      finishedLabel = Number.isFinite(finishedTime) && finishedTime > 0 ? jqFormatTaskTime(finishedTime) : "未知完成",
      metaText = ["提交 " + createdLabel, "完成 " + finishedLabel, "耗时 " + jqFormatDuration(Number(record?.durationMs)), record?.model || "", record?.ratio || ""].filter(Boolean).join(" · ");
    return "<div class=\"stats-data-row " + (anomalyReason ? "is-anomaly" : "") + "\" data-stat-index=\"" + index + "\"><label class=\"stats-data-check\"><input type=\"checkbox\" class=\"stats-record-check\" value=\"" + index + "\"></label><div class=\"stats-data-main\"><strong>" + jqEscapeHtml(record?.taskName || "实测样本") + "</strong><span>" + jqEscapeHtml(metaText) + "</span>" + (anomalyReason ? "<em>" + jqEscapeHtml(anomalyReason) + "</em>" : "") + "</div><button type=\"button\" class=\"stats-record-delete\" data-stat-delete=\"" + index + "\">删除</button></div>";
  }).join("") + "</div>" : "<div class=\"stats-empty\">当前筛选没有记录。</div>") + "</div>";
}
function jqAppendStatsDataManager(containerEl) {
  if (!containerEl) return;
  containerEl.insertAdjacentHTML("beforeend", "<div class=\"stats-manager-shell\"><div class=\"stats-manager-head\"><div><strong>统计数据管理</strong><span>删除错误或无效记录，不影响任务卡片。</span></div><button type=\"button\" id=\"statsDataManageToggle\" class=\"stats-data-manage-toggle\">" + (jqStatsManagerOpen ? "收起管理" : "管理数据") + "</button></div>" + (jqStatsManagerOpen ? jqRenderStatsManagerBody() : "") + "</div>");
  jqBindStatsDataManager();
}
function jqBindStatsDataManager() {
  const toggleBtn = getEl("statsDataManageToggle");
  if (toggleBtn) toggleBtn.addEventListener("click", () => {
    jqStatsManagerOpen = !jqStatsManagerOpen;
    jqRenderStatsPanel();
  });
  const filterSelect = getEl("statsDataFilter");
  if (filterSelect) filterSelect.addEventListener("change", () => {
    jqStatsManagerFilter = filterSelect.value || "samples";
    jqRenderStatsPanel();
  });
  const deleteSelectedBtn = getEl("statsDeleteSelected");
  if (deleteSelectedBtn) deleteSelectedBtn.addEventListener("click", () => {
    const selectedIndexes = Array.from(document.querySelectorAll(".stats-record-check:checked")).map(checkbox => Number(checkbox.value));
    jqGenStatsDeleteIndexes(selectedIndexes);
  });
  document.querySelectorAll(".stats-record-delete").forEach(deleteBtn => deleteBtn.addEventListener("click", () => jqGenStatsDeleteIndexes([Number(deleteBtn.dataset.statDelete)])));
}
function jqStatsPeriodStart(kind) {
  const d = new Date();
  if (kind === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (kind === "week") {
    const day = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime();
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
// ===== F4a: 实测生成时长采集 =====================================
// 读每张卡片的 React record（uniqueKey + generateTimeInfo.createdTime + 状态），
// 按 uniqueKey 追踪「生成中 → 完成」跳变：开始=createdTime（精确），
// 完成=本次轮询检测时刻（±轮询间隔）。仅统计弹窗打开期间见证完成的任务。
const jqGenStatsStoreKey = "workspace3GenDurationsV1";
let jqGenStats = [];
const jqGenSeenGenerating = new Set();
// id→模型名缓存：DOM 记录带 modelName 时记下；net-hook 兜底记录(model 为空)靠它补出模型，
// 用于可靠过滤 VIP（不受滚动影响）。
const jqModelById = new Map();
async function jqLoadGenStats() {
  try {
    const storedStats = await storageGetLocal(jqGenStatsStoreKey);
    jqGenStats = Array.isArray(storedStats) ? storedStats.filter(Boolean) : [];
  } catch {
    jqGenStats = [];
  }
}
function jqSaveGenStats() {
  try {
    jqGenStats = jqGenStats.slice(-2000);
    storageSetLocal({ [jqGenStatsStoreKey]: jqGenStats }).catch(() => {});
  } catch {}
}
// 效率统计「显示 Fast」勾选偏好，持久化——按图表（今日/本周/本月）各自独立记忆，互不联动。
const jqStatsShowFastStoreKey = "workspace3StatsShowFastV2";
let jqStatsShowFastMap = { today: false, week: false, month: false };
async function jqLoadStatsShowFast() {
  try {
    const v = await storageGetLocal(jqStatsShowFastStoreKey);
    if (v && typeof v === "object") jqStatsShowFastMap = { today: !!v.today, week: !!v.week, month: !!v.month };
    else jqStatsShowFastMap = { today: false, week: false, month: false };
  } catch {
    jqStatsShowFastMap = { today: false, week: false, month: false };
  }
}
function jqStatsShowFastOn(key) {
  return !!(jqStatsShowFastMap && jqStatsShowFastMap[key]);
}
function jqStatsSetShowFast(key, on) {
  if (!key || !(key in jqStatsShowFastMap)) return;
  jqStatsShowFastMap[key] = !!on;
  // 只存被点的那一个，不再同步其它勾选框（各图表独立）
  try { storageSetLocal({ [jqStatsShowFastStoreKey]: jqStatsShowFastMap }).catch(() => {}); } catch {}
}
// 在页面 MAIN world 执行：读取每张卡片的 React record，返回精简状态数组。
// （必须自包含，不引用外部作用域——会被 executeScript 序列化注入。）
function jqScrapeTaskRecords() {
  const out = [];
  try {
    const cards = Array.from(document.querySelectorAll('[class*="video-record" i]'));
    const seen = new Set();
    for (const card of cards) {
      const fk = Object.keys(card).find((k) => k.indexOf("__reactFiber$") === 0);
      if (!fk) continue;
      let node = card[fk], lvl = 0, rec = null;
      while (node && lvl < 30) {
        const p = node.memoizedProps;
        if (p && p.record && typeof p.record === "object" && "uniqueKey" in p.record) { rec = p.record; break; }
        node = node.return; lvl++;
      }
      if (!rec) continue;
      const id = String(rec.uniqueKey || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const gti = rec.generateTimeInfo || {};
      const sm = (card.innerText || "").trim().match(/^#(\d+)/); // 任务编号前缀 #id
      out.push({
        id,
        serial: sm ? sm[1] : null,
        createdTime: Number(gti.createdTime) || 0,
        forecastQueueCost: Number(gti.forecastQueueCost) || 0,    // 即梦预估排队时长(ms)
        forecastGenerateCost: Number(gti.forecastGenerateCost) || 0, // 即梦预估生成时长(ms)
        isGenerating: !!rec.isGenerating,
        statusCode: Number(rec.statusCode) || 0,
        model: String(rec.modelName || ""),
        videoSec: Number(rec.duration) || 0,
        ratio: String(rec.videoRatioText || "")
      });
    }
    // 合并后端钩子(net-hook.js)捕获的平台记录：有些结果卡 DOM 扫描看不到（如被滚动卸载），
    // 靠 get_history_by_ids 接口数据兜住。按 id 去重。
    const cap = window.__jmCap;
    if (cap && cap.records) {
      for (const hid of Object.keys(cap.records)) {
        if (seen.has(hid)) continue;
        const h = cap.records[hid];
        if (!h) continue;
        seen.add(hid);
        out.push({
          id: hid,
          serial: null,
          createdTime: Number(h.createdTime) || 0,
          forecastQueueCost: 0,
          forecastGenerateCost: 0,
          isGenerating: !!h.isGenerating,
          statusCode: Number(h.statusCode) || 0,
          failed: !!h.failed,
          model: "",
          videoSec: 0,
          ratio: ""
        });
      }
    }
  } catch (e) {}
  return out;
}
// 后端钩子(net-hook.js / window.__jmCap)读写：标记一次提交 / 读取"提交后是否出现新生成中记录"。
// 受理判定兜底：主路靠并发计数增长；计数不可信（如页面滚动漏数）时靠接口出现的新平台记录。
async function jqHookMarkSubmit() {
  try {
    const tab = await getJimengTab();
    if (tab && tab.id) await runInJimengPage(tab.id, () => {
      if (window.__jmCap) { window.__jmCap.submitMark = Date.now(); window.__jmCap.acceptedSinceMark = false; window.__jmCap.acceptedRecords = []; }
    });
  } catch (e) {}
}
async function jqHookAccepted() {
  try {
    const tab = await getJimengTab();
    if (!tab || !tab.id) return false;
    return !!(await runInJimengPage(tab.id, () => !!(window.__jmCap && window.__jmCap.acceptedSinceMark && Array.isArray(window.__jmCap.acceptedRecords) && window.__jmCap.acceptedRecords.length)));
  } catch (e) { return false; }
}
// 即梦预估完成时刻 = 创建时刻 + 预估排队 + 预估生成（缺字段则返回 0，表示无法判断）。
function jqEstFinish(rec) {
  const c = Number(rec?.createdTime) || 0;
  if (c <= 0) return 0;
  return c + (Number(rec?.forecastQueueCost) || 0) + (Number(rec?.forecastGenerateCost) || 0);
}
// "撞见太晚"判定：检测到完成的时刻远超即梦预估完成（弹窗被冻结/休眠后才补查），
// 此时完成时间不可信。容差 = max(预估总时长, 30 分钟)，避免误伤真实偏慢的生成。
function jqIsLateDetection(rec, finishAt) {
  const est = jqEstFinish(rec);
  if (est <= 0 || !(Number(finishAt) > 0)) return false;
  const total = (Number(rec?.forecastQueueCost) || 0) + (Number(rec?.forecastGenerateCost) || 0);
  return finishAt > est + Math.max(total, 1800000);
}
async function jqCaptureGenTimes() {
  let tab;
  try { tab = await getJimengTab(); } catch { return; }
  if (!tab || !tab.id) return;
  let recs;
  try { recs = await runInJimengPage(tab.id, jqScrapeTaskRecords); } catch { return; }
  if (!Array.isArray(recs) || !recs.length) return;
  const recordedIds = new Set(jqGenStats.map((r) => r.id));
  let changed = false;
  for (const r of recs) {
    if (!r || !r.id) continue;
    // 见到带模型的记录就缓存（DOM 路径带 modelName；net-hook 兜底记录 model 为空，靠缓存补）
    if (r.model) jqModelById.set(r.id, r.model);
    if (r.isGenerating) { jqGenSeenGenerating.add(r.id); continue; }
    const done = r.statusCode === 50; // 50 = 生成成功（实测枚举）
    if (done && jqGenSeenGenerating.has(r.id) && !recordedIds.has(r.id) && r.createdTime > 0) {
      // 解析模型：当前记录的 model 或缓存里的；用于可靠过滤 VIP
      const model = r.model || jqModelById.get(r.id) || "";
      if (/VIP/i.test(model)) { jqGenSeenGenerating.delete(r.id); continue; } // VIP 不统计
      if (!model) continue; // 模型仍未知（全程未在屏幕出现）→ 暂不统计，避免漏放 VIP；保留标记以便后续拿到模型再判
      const finishAt = Date.now();
      const durationMs = finishAt - r.createdTime;
      // 撞见太晚（弹窗冻结/休眠后补查）→ 完成时刻不可信，不计入统计图表；清掉标记避免反复尝试
      if (jqIsLateDetection(r, finishAt)) { jqGenSeenGenerating.delete(r.id); continue; }
      if (durationMs > 0 && durationMs < 6 * 3600 * 1000) {
        jqGenStats.push({ id: r.id, serial: r.serial || "", at: finishAt, createdTime: r.createdTime, durationMs, model: model, videoSec: r.videoSec, ratio: r.ratio });
        recordedIds.add(r.id);
        jqGenSeenGenerating.delete(r.id);
        changed = true;
      }
    }
  }
  if (changed) { jqSaveGenStats(); jqRenderStatsPanel(); }
  try { jqSyncTaskStatusFromPlatform(recs); } catch {}
}
// 把"生成中"的每一次执行(run)跟即梦真实状态同步：序号(#id)优先精确绑定，否则按提交时刻就近兜底。
// 绑定下沉到 run 级——同一卡片多次执行各自绑定各自的平台 record，互不覆盖；不动队列驱动；保留 2h 超时兜底。
function jqSyncTaskStatusFromPlatform(recs) {
  if (!Array.isArray(jqTasks) || !jqTasks.length || !Array.isArray(recs) || !recs.length) return;
  const recById = new Map(recs.map((r) => [r.id, r]));
  const bound = new Set();
  for (const t of jqTasks) for (const run of jqTaskRuns(t)) if (run.platformKey) bound.add(run.platformKey);
  let changed = false;
  // 待绑定的 run：状态 generating 且尚未绑定平台 record（不限任务当前状态——更早的重复也要绑）
  const openRuns = [];
  for (const t of jqTasks) {
    if (!t) continue;
    jqEnsureTaskRuns(t);
    for (const run of jqTaskRuns(t)) if (run.status === "generating" && !run.platformKey) openRuns.push({ t, run });
  }
  // Pass 1：序号 #id 精确绑定
  for (const { t, run } of openRuns) {
    if (run.platformKey) continue;
    const rec = recs.find((r) => r.serial && String(r.serial) === String(t.id) && !bound.has(r.id));
    if (rec) { run.platformKey = rec.id; bound.add(rec.id); changed = true; }
  }
  // Pass 2：兜底——按提交时间从早到晚，绑 createdTime 与提交时刻最接近的未绑定 record（30 分钟内）
  const fb = openRuns
    .filter((x) => !x.run.platformKey && Number(x.run.submittedAt) > 0)
    .sort((a, b) => a.run.submittedAt - b.run.submittedAt);
  for (const { run } of fb) {
    const subAt = run.submittedAt;
    let best = null, bestDiff = Infinity;
    for (const r of recs) {
      if (bound.has(r.id) || !(r.createdTime > 0)) continue;
      const diff = Math.abs(r.createdTime - subAt);
      if (diff < bestDiff) { bestDiff = diff; best = r; }
    }
    if (best && bestDiff <= 1800000) { run.platformKey = best.id; bound.add(best.id); changed = true; }
  }
  // 同步完成状态：绑定的 record 已完成(statusCode 50) → 该 run 标完成 + 真实耗时
  for (const t of jqTasks) {
    for (const run of jqTaskRuns(t)) {
      if (run.status !== "generating" || !run.platformKey) continue;
      const rec = recById.get(run.platformKey);
      if (rec && !rec.isGenerating && rec.statusCode === 50) {
        run.status = "done";
        run.completedAt = Date.now();
        run.finalizedReason = "platform";
        run.durationMs = rec.createdTime > 0 ? run.completedAt - rec.createdTime
          : run.submittedAt > 0 ? run.completedAt - run.submittedAt : 0;
        // 撞见太晚 → 完成时刻不可信，标记以便卡片上把该次执行记录标灰
        run.unreliable = jqIsLateDetection(rec, run.completedAt);
        changed = true;
      } else if (rec && !rec.isGenerating && rec.failed === true) {
        // 即时失败：平台已结束该记录却无产出（钩子判定 finish_time≠0 且 item_list 空）。
        // 只对钩子明确置 failed 的记录生效，经典 DOM 记录不带此标志，不会被误判。
        run.status = "failed";
        run.completedAt = Date.now();
        run.finalizedReason = "platform-failed";
        run.errorMessage = "平台生成失败";
        run.durationMs = rec.createdTime > 0 ? run.completedAt - rec.createdTime
          : run.submittedAt > 0 ? run.completedAt - run.submittedAt : 0;
        changed = true;
      }
    }
    if (jqRecomputeTaskStatusFromRuns(t)) changed = true;
  }
  if (changed) { saveTasks().catch(() => {}); renderQueue(); }
}
function jqStartGenCapture() {
  jqCaptureGenTimes();
  setInterval(jqCaptureGenTimes, 8000);
  // 窗口一变可见（从后台/被遮挡切回前台）立刻补查一次——
  // Chrome 会冻结后台页面的 setInterval，靠这一下尽快撞见"已完成"，减少完成时间被拖晚。
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) jqCaptureGenTimes();
  });
}
// ===== F4b: 基于实测生成时长的统计视图（中位数 + 样本数 + 热力图）=========
function jqGenRows(kind) {
  const start = jqStatsPeriodStart(kind);
  return (Array.isArray(jqGenStats) ? jqGenStats : []).filter(
    (r) => Number(r.createdTime) >= start && Number(r.durationMs) > 0
  );
}
// 中位耗时 → 颜色：绿(快) → 红(慢)
function jqGenColor(med, min, max) {
  if (!Number.isFinite(med) || med <= 0) return "rgba(255,255,255,0.045)";
  const t = max > min ? (med - min) / (max - min) : 0;
  const hue = Math.round(120 * (1 - t));
  return "hsl(" + hue + ", 68%, 42%)";
}
// 通用热力图：rowOf(createdTime)->行号，每格=该(行,小时)的中位耗时
function jqGenHeatmapHtml(rows, rowOf, rowLabels) {
  const R = rowLabels.length;
  const grid = Array.from({ length: R }, () => Array.from({ length: 24 }, () => []));
  for (const r of rows) {
    const ts = Number(r.createdTime);
    if (!ts) continue;
    const ri = rowOf(ts);
    if (ri < 0 || ri >= R) continue;
    grid[ri][new Date(ts).getHours()].push(Number(r.durationMs));
  }
  const meds = grid.map((row) => row.map((arr) => jqMedian(arr)));
  const scaleVals = meds.flat().filter((m) => Number.isFinite(m) && m > 0);
  if (!scaleVals.length) return "<div class=\"stats-empty\">暂无完成样本（保持弹窗开着，待任务完成即记录）。</div>";
  const min = Math.min.apply(null, scaleVals), max = Math.max.apply(null, scaleVals);
  let html = "<div class=\"gen-heatmap\"><div class=\"gen-hm-row gen-hm-head\"><span class=\"gen-hm-label\"></span>";
  for (let h = 0; h < 24; h++) html += "<i>" + h + "</i>";
  html += "</div>";
  for (let ri = 0; ri < R; ri++) {
    html += "<div class=\"gen-hm-row\"><span class=\"gen-hm-label\">" + jqEscapeHtml(rowLabels[ri]) + "</span>";
    for (let h = 0; h < 24; h++) {
      const m = meds[ri][h], c = grid[ri][h].length;
      const title = c ? rowLabels[ri] + " " + String(h).padStart(2, "0") + "时 · 中位 " + jqFormatDuration(m) + " · " + c + "条" : "";
      html += "<b style=\"background:" + jqGenColor(m, min, max) + "\" title=\"" + jqEscapeHtml(title) + "\"></b>";
    }
    html += "</div>";
  }
  html += "</div><div class=\"gen-hm-legend\">快<span class=\"bar\"></span>慢　最快 " +
    jqFormatDuration(min) + " · 最慢 " + jqFormatDuration(max) + "</div>";
  return html;
}
// 今日散点图：横=提交时刻(0–24)，纵=耗时(低=快)。Seedance 2.0 / Fast 分色，
// Fast 默认隐藏（勾选显示），VIP 已在采集阶段排除。
function jqGenTodayScatterHtml(rows) {
  const data = (rows || []).filter((r) => !/VIP/i.test(r.model || "") && Number(r.durationMs) > 0 && Number(r.createdTime) > 0);
  if (!data.length) return "<div class=\"stats-empty\">今日暂无完成样本（保持弹窗开着，待任务完成即记录）。</div>";
  const isFast = (m) => /fast/i.test(m || "");
  const main = data.filter((r) => !isFast(r.model));
  const fast = data.filter((r) => isFast(r.model));
  const W = 960, H = 300, padL = 48, padR = 12, padT = 12, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxDur = (Math.max.apply(null, data.map((r) => Number(r.durationMs))) || 1) * 1.08;
  const xOf = (ts) => { const d = new Date(Number(ts)); return padL + ((d.getHours() + d.getMinutes() / 60) / 24) * plotW; };
  const yOf = (ms) => padT + plotH - (Number(ms) / maxDur) * plotH;
  const hhmm = (ts) => { const d = new Date(Number(ts)); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  let grid = "";
  for (let h = 0; h <= 24; h += 4) {
    const x = (padL + (h / 24) * plotW).toFixed(1);
    grid += "<line x1=\"" + x + "\" y1=\"" + padT + "\" x2=\"" + x + "\" y2=\"" + (padT + plotH) + "\" class=\"gs-grid\"/>";
    grid += "<text x=\"" + x + "\" y=\"" + (H - 6) + "\" class=\"gs-axis\" text-anchor=\"middle\">" + h + "</text>";
  }
  [0, 0.5, 1].forEach((f) => {
    const val = maxDur * f, y = yOf(val).toFixed(1);
    grid += "<line x1=\"" + padL + "\" y1=\"" + y + "\" x2=\"" + (W - padR) + "\" y2=\"" + y + "\" class=\"gs-grid\"/>";
    grid += "<text x=\"" + (padL - 6) + "\" y=\"" + (Number(y) + 3).toFixed(1) + "\" class=\"gs-axis\" text-anchor=\"end\">" + (f === 0 ? "0" : jqFormatDuration(val)) + "</text>";
  });
  const ptsOf = (arr, cls) => arr.map((r) =>
    "<circle cx=\"" + xOf(r.createdTime).toFixed(1) + "\" cy=\"" + yOf(r.durationMs).toFixed(1) + "\" r=\"3.6\" class=\"" + cls + "\"><title>提交 " + hhmm(r.createdTime) + " · 耗时 " + jqFormatDuration(r.durationMs) + "</title></circle>"
  ).join("");
  const medLine = (arr, cls) => {
    const med = jqMedian(arr.map((r) => Number(r.durationMs)).filter((n) => n > 0));
    if (!Number.isFinite(med) || med <= 0) return "";
    const y = yOf(med).toFixed(1);
    return "<line x1=\"" + padL + "\" y1=\"" + y + "\" x2=\"" + (W - padR) + "\" y2=\"" + y + "\" class=\"" + cls + "\"/>";
  };
  // 每个点旁的耗时标签：贪心防重叠（慢点优先 → 离群点必有标签；主点先于 Fast 占位，避免被隐藏的 Fast 标签挤掉）。
  // 候选位:右/右上/右下/左,都放不下就省略该标签。
  const placedBoxes = [];
  const fs = 11;
  const boxHit = (a) => placedBoxes.some((b) => !(a.x + a.w <= b.x || a.x >= b.x + b.w || a.y + a.h <= b.y || a.y >= b.y + b.h));
  const labelsOf = (arr, cls) => arr.slice().sort((p, q) => Number(q.durationMs) - Number(p.durationMs)).map((r) => {
    const cx = xOf(r.createdTime), cy = yOf(r.durationMs), txt = jqFormatDuration(r.durationMs),
      w = Math.max(8, txt.length * fs * 0.6), h = fs,
      cands = [[cx + 5, cy - h / 2, "start", cx + 5], [cx + 5, cy - h - 3, "start", cx + 5], [cx + 5, cy + 3, "start", cx + 5], [cx - 5 - w, cy - h / 2, "end", cx - 5]];
    for (const c of cands) {
      const box = { x: c[0], y: c[1], w, h };
      if (box.x < padL || box.x + box.w > W - padR || box.y < padT || box.y + box.h > padT + plotH) continue;
      if (!boxHit(box)) { placedBoxes.push(box); return "<text x=\"" + Number(c[3]).toFixed(1) + "\" y=\"" + (box.y + h - 2).toFixed(1) + "\" class=\"gs-ptlabel " + cls + "\" text-anchor=\"" + c[2] + "\">" + txt + "</text>"; }
    }
    return "";
  }).join("");
  const svg = "<svg class=\"gen-scatter\" viewBox=\"0 0 " + W + " " + H + "\">" + grid +
    medLine(main, "gs-median") + medLine(fast, "gs-median-fast") +
    ptsOf(main, "pt-main") + ptsOf(fast, "pt-fast") +
    labelsOf(main, "gs-ptlabel-main") + labelsOf(fast, "gs-ptlabel-fast") + "</svg>";
  return "<div class=\"gen-scatter-wrap\"><div class=\"gen-scatter-legend\">" +
    "<label class=\"gen-fast-chk\"><input type=\"checkbox\" class=\"gen-fast-toggle\" data-fastkey=\"today\"" + (jqStatsShowFastOn("today") ? " checked" : "") + "> 显示 Fast</label>" +
    "<span class=\"gs-key gs-key-main\">● Seedance 2.0 (" + main.length + ")</span>" +
    "<span class=\"gs-key gs-key-fast\">● Fast (" + fast.length + ")</span>" +
    "<span class=\"gs-hint\">纵=耗时(低=快) · 横=提交时刻</span></div>" + svg + "</div>";
}
// 一个热力图区块：按模型分流（默认 Seedance 2.0，勾选切到 Fast；VIP 已排除）
function jqGenHeatmapSection(rows, rowOf, rowLabels, fastKey) {
  const notVip = (rows || []).filter((r) => !/VIP/i.test(r.model || ""));
  const main = notVip.filter((r) => !/fast/i.test(r.model || ""));
  const fast = notVip.filter((r) => /fast/i.test(r.model || ""));
  return "<div class=\"gen-hm-toggle-wrap\">" +
    "<label class=\"gen-fast-chk\"><input type=\"checkbox\" class=\"gen-fast-toggle\" data-fastkey=\"" + fastKey + "\"" + (jqStatsShowFastOn(fastKey) ? " checked" : "") + "> 看 Fast</label>" +
    "<div class=\"gen-hm-main\">" + jqGenHeatmapHtml(main, rowOf, rowLabels) + "</div>" +
    "<div class=\"gen-hm-fast\">" + jqGenHeatmapHtml(fast, rowOf, rowLabels) + "</div>" +
    "</div>";
}
function jqStatsPanelHtml() {
  const DAY = 86400000;
  const md = (ts) => { const d = new Date(ts); return (d.getMonth() + 1) + "/" + d.getDate(); };
  const monthStart = jqStatsPeriodStart("month");
  const weekStart = jqStatsPeriodStart("week");
  const WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const weekLabels = WEEK.map((w, i) => md(weekStart + i * DAY) + " " + w);
  const weekTitle = "本周 (" + md(weekStart) + "–" + md(weekStart + 6 * DAY) + ")";
  const weeks = Math.max(1, Math.floor((Date.now() - monthStart) / (7 * DAY)) + 1);
  const monthLabels = Array.from({ length: weeks }, (_, i) => "第" + (i + 1) + "周 " + md(monthStart + i * 7 * DAY) + "起");
  const monthTitle = "本月 (" + md(monthStart) + "–" + md(Date.now()) + ")";
  return "<div class=\"stats-tabs-layout\">" +
    "<section class=\"stats-period-section\"><div class=\"stats-section-title\">今日 · 提交时刻 × 生成耗时</div>" +
      jqGenTodayScatterHtml(jqGenRows("day")) + "</section>" +
    "<section class=\"stats-period-section\"><div class=\"stats-section-title\">" + weekTitle + " · 每天每时段</div>" +
      jqGenHeatmapSection(jqGenRows("week"), (ts) => (new Date(ts).getDay() + 6) % 7, weekLabels, "week") + "</section>" +
    "<section class=\"stats-period-section\"><div class=\"stats-section-title\">" + monthTitle + " · 每周每时段</div>" +
      jqGenHeatmapSection(jqGenRows("month"), (ts) => Math.floor((ts - monthStart) / (7 * DAY)), monthLabels, "month") + "</section>" +
    "</div>";
}
function jqRenderStatsPanel() {
  const el = getEl("statsContent");
  if (!el) return;
  // Skip rendering while the stats panel is hidden; it is re-rendered on open
  // (see stats toggle handler). Avoids rebuilding the whole panel + charts on
  // every stats record (start/submitted/failed) during a queue run.
  const statsPanel = getEl("statsToolPanel");
  if (statsPanel && statsPanel.hidden) return;
  el.innerHTML = jqStatsPanelHtml();
  // 一次性委托绑定：勾选「Fast」只记住该图表自己的偏好（按 data-fastkey），不联动其它
  if (!el.__fastBound) {
    el.__fastBound = true;
    el.addEventListener("change", (e) => {
      const cb = e.target;
      if (cb && cb.classList && cb.classList.contains("gen-fast-toggle")) jqStatsSetShowFast(cb.dataset.fastkey, cb.checked);
    });
  }
  jqAppendStatsDataManager(el);
}
window.jqRenderStatsPanel = jqRenderStatsPanel;
async function jqStartQueueToggle() {
  if (queueAutoResumeEnabled) {
    queueUserStopped = true;
    await setQueueAutoResumeEnabled(false);
    appendLog("⏸ 自动续跑已关闭，当前任务不受影响（添加任务不会自动执行，需手动开启）");
    renderQueue();
    return;
  }
  queueUserStopped = false;
  await setQueueAutoResumeEnabled(true);
  jqBeginRunSession();
  appendLog("▶️ 自动续跑已开启，开始执行队列；暂无任务时会等待新任务");
  renderQueue();
  await runQueue();
}
function jqTaskSearchBlob(searchTask) {
  const searchSettings = searchTask.settings || {},
    searchPayload = searchTask.payload || {},
    searchImages = searchPayload.images || [],
    searchVideos = searchPayload.videos || [],
    searchAudios = searchPayload.audios || [];
  return [searchTask.id, searchTask.taskName || "", jqProjectNameById(jqTaskProjectId(searchTask)), jqTaskStatusLabel(searchTask), searchSettings.genMode || "", searchSettings.model || "", searchSettings.refMode || "", searchSettings.ratio || "", searchSettings.duration || "", searchPayload.promptText || "", ...searchImages.map(imageRef => imageRef?.name || ""), ...searchVideos.map(videoRef => videoRef?.name || ""), ...searchAudios.map(audioRef => audioRef?.name || "")].join(" ").toLowerCase();
}
function jqFilterTasksBySearch(taskList) {
  const normalizedQuery = jqSearchNormalize(jqQueueSearchText);
  if (!normalizedQuery) return taskList;
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return taskList.filter(task => {
    const taskSearchText = jqTaskSearchBlob(task);
    return queryTokens.every(queryToken => taskSearchText.includes(queryToken));
  });
}
function jqRenderSearchState(totalCount, filteredCount) {
  const searchMetaEl = getEl("queueSearchMeta"),
    searchClearBtn = getEl("queueSearchClear"),
    normalizedQuery = jqSearchNormalize(jqQueueSearchText);
  if (searchMetaEl) searchMetaEl.textContent = normalizedQuery ? "匹配 " + filteredCount + " / " + totalCount : totalCount + " 个任务";
  if (searchClearBtn) searchClearBtn.hidden = !normalizedQuery;
}
function jqBindQueueSearch() {
  const searchInputEl = getEl("queueSearchInput"),
    searchClearBtn = getEl("queueSearchClear");
  if (!searchInputEl || searchInputEl.dataset.bound === "1") return;
  searchInputEl.dataset.bound = "1";
  searchInputEl.value = jqQueueSearchText;
  searchInputEl.addEventListener("input", () => {
    jqQueueSearchText = searchInputEl.value || "";
    renderQueue();
  });
  searchClearBtn && searchClearBtn.addEventListener("click", () => {
    jqQueueSearchText = "";
    searchInputEl.value = "";
    renderQueue();
    searchInputEl.focus();
  });
}
function jqClampRepeat(repeatValue) {
  const repeatNumber = Number(repeatValue);
  return Math.max(1, Math.min(20, Number.isFinite(repeatNumber) ? Math.floor(repeatNumber) : 1));
}
function jqTaskRepeatTotal(task) {
  return jqClampRepeat(task?.repeatTotal || 1);
}
function jqTaskRepeatDone(task) {
  const repeatTotal = jqTaskRepeatTotal(task),
    repeatDoneValue = Number(task?.repeatDone);
  return Math.max(0, Math.min(repeatTotal, Number.isFinite(repeatDoneValue) ? Math.floor(repeatDoneValue) : 0));
}
function jqTaskRemaining(task) {
  return Math.max(0, jqTaskRepeatTotal(task) - jqTaskRepeatDone(task));
}
// ===== 执行记录 runs[]：同一卡片多次执行，每次一条独立、不互相覆盖的记录 =====
// 每条 run: {seq, runId, submittedAt, completedAt, durationMs, status, platformKey, finalizedReason, errorMessage}
//   status: "generating" | "done" | "failed" | "timeout"
function jqTaskRuns(t) {
  return Array.isArray(t?.runs) ? t.runs : [];
}
// 惰性合成：老卡片没有 runs，但有 repeatDone/时间字段 → 还原（最后一次有真时间，更早的只能占位）
function jqEnsureTaskRuns(t) {
  if (!t || Array.isArray(t.runs)) return false;
  const done = Math.max(0, Math.min(jqTaskRepeatTotal(t), Number(t.repeatDone) || 0));
  const runs = [];
  for (let i = 1; i <= done; i++) {
    const isLast = i === done;
    runs.push({
      seq: i,
      runId: "t" + t.id + "-r" + i,
      submittedAt: isLast ? (Number(t.platformSubmittedAt || t.lastSubmittedAt) || 0) : 0,
      completedAt: isLast ? (Number(t.completedAt) || 0) : 0,
      durationMs: 0,
      status: isLast && t.status === "generating" ? "generating" : t.autoFinalized && isLast ? "timeout" : "done",
      platformKey: isLast ? (t.platformUniqueKey || "") : "",
      finalizedReason: isLast ? (t.autoFinalized ? "timeout" : t.platformSynced ? "platform" : "legacy") : "legacy",
      errorMessage: ""
    });
  }
  t.runs = runs;
  return true;
}
function jqRunStatusMeta(s) {
  switch (s) {
    case "done": return { cls: "run-done", dot: "●", label: "已完成" };
    case "generating": return { cls: "run-generating", dot: "◐", label: "生成中" };
    case "failed": return { cls: "run-failed", dot: "●", label: "失败" };
    case "timeout": return { cls: "run-timeout", dot: "◍", label: "超时" };
    default: return { cls: "run-pending", dot: "○", label: s || "" };
  }
}
// 任务级状态由 runs 聚合：所有 run 都已结束（无 generating）且已提交满总次数 → 任务标完成。
// 仅在任务当前为 "generating" 时收口，不动 pending（队列驱动间隙）等其它状态。
function jqRecomputeTaskStatusFromRuns(t) {
  if (!t || t.status !== "generating") return false;
  const runs = jqTaskRuns(t);
  if (!runs.length) return false;
  if (runs.some(r => r.status === "generating")) return false;
  if (jqTaskRepeatDone(t) < jqTaskRepeatTotal(t)) return false;
  // 所有 run 已结束：只要有失败的 run，任务标失败（便于"重试失败任务"捞到）；否则标完成。
  if (runs.some(r => r.status === "failed")) {
    t.status = "failed";
    t.completedAt = Date.now();
    t.platformSynced = true;
    if (!t.errorMessage) t.errorMessage = "平台生成失败";
    return true;
  }
  t.status = "done";
  t.completedAt = Date.now();
  t.platformSynced = true;
  return true;
}
// 卡片中段「执行记录」列表：每行 第N次 · 状态 · 提交→完成 · 耗时。
function jqTaskRunsHtml(t) {
  jqEnsureTaskRuns(t);
  const runs = jqTaskRuns(t);
  if (!runs.length) return jqTaskTimeMetaHtml(t);
  const rows = runs.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0)).map((r) => {
    const m = jqRunStatusMeta(r.status),
      sub = Number(r.submittedAt) > 0 ? jqFormatTaskTime(r.submittedAt) : "--";
    let tail;
    if (r.status === "done") {
      const comp = Number(r.completedAt) > 0 ? jqFormatTaskTime(r.completedAt) : "--",
        dur = Number(r.durationMs) > 0 ? jqFormatDuration(Number(r.durationMs))
          : Number(r.completedAt) > 0 && Number(r.submittedAt) > 0 ? jqFormatDuration(r.completedAt - r.submittedAt) : "--";
      tail = "提交 " + sub + " → 完成 " + comp + " · " + dur;
    } else if (r.status === "generating") {
      const el = Number(r.submittedAt) > 0 ? jqFormatDuration(Date.now() - r.submittedAt) : "--";
      tail = "提交 " + sub + " · 已 " + el + "…";
    } else if (r.status === "timeout") {
      tail = "提交 " + sub + " · 2h 未同步，按完成计 · 时长未知";
    } else if (r.status === "failed") {
      tail = "提交 " + sub + (r.errorMessage ? " · " + r.errorMessage : "");
    } else {
      tail = "提交 " + sub;
    }
    const title = r.platformKey ? "平台 " + String(r.platformKey).slice(0, 12) : "";
    const cls = m.cls + (r.unreliable ? " run-unreliable" : "");
    return "<div class=\"task-run-row " + cls + "\"" + (title ? " title=\"" + jqEscapeHtml(title) + "\"" : "") +
      "><span class=\"task-run-seq\">第" + (r.seq || "?") + "次</span><span class=\"task-run-dot\">" + m.dot +
      "</span><span class=\"task-run-label\">" + m.label + "</span><span class=\"task-run-meta\">" + jqEscapeHtml(tail) + "</span></div>";
  }).join("");
  return "<details class=\"task-card-runs\" open><summary>执行记录 (" + runs.length + ")</summary>" + rows + "</details>";
}
function jqCurrentTaskRepeat() {
  const repeatInputEl = getEl("taskRepeatInput"),
    repeatTotal = jqClampRepeat(repeatInputEl?.value);
  if (repeatInputEl) repeatInputEl.value = String(repeatTotal);
  return repeatTotal;
}
function jqCurrentTaskName() {
  return String(getEl("taskNameInput")?.value || "").trim().slice(0, 40);
}
function jqEnsureProjectByName(projectName) {
  const normalizedProjectName = jqNormalizeProjectName(projectName);
  if (!normalizedProjectName) return jqActiveProjectId || "default";
  let existingProject = jqProjects.find(project => project.name === normalizedProjectName);
  if (existingProject) {
    if (existingProject.archived) {
      existingProject.archived = false;
      jqSaveProjects().catch(() => {});
    }
    return existingProject.id;
  }
  const newProject = {
    id: jqNewProjectId(),
    name: normalizedProjectName,
    archived: false
  };
  jqProjects.push(newProject);
  jqSaveProjects().catch(() => {});
  return newProject.id;
}
function jqEnsureTaskProjects() {
  let changed = false;
  const defaultProject = new Set(jqProjects.map(validProjectIds => validProjectIds.id));
  for (const task of jqTasks) {
    if (!task.projectId || !defaultProject.has(task.projectId)) {
      task.projectId = "default";
      changed = true;
    }
    const fallbackProjectId = jqTaskRepeatTotal(task);
    if (task.repeatTotal !== fallbackProjectId) {
      task.repeatTotal = fallbackProjectId;
      changed = true;
    }
    let maxId = Number(task.repeatDone);
    if (!Number.isFinite(maxId)) {
      maxId = task.status === "done" ? fallbackProjectId : 0;
      changed = true;
    }
    maxId = Math.max(0, Math.min(fallbackProjectId, Math.floor(maxId)));
    if (task.repeatDone !== maxId) {
      task.repeatDone = maxId;
      changed = true;
    }
    if (task.status === "pending" && task.repeatDone >= fallbackProjectId) {
      task.status = "done";
      changed = true;
    }
    if (typeof task.taskName !== "string") {
      task.taskName = "";
      changed = true;
    }
  }
  return changed;
}
async function jqSaveProjects() {
  await storageSetLocal({
    [jqProjectStoreKey]: jqProjects,
    [jqActiveProjectStoreKey]: jqActiveProjectId
  });
}
async function jqLoadProjects() {
  const storedProjects = await storageGetLocal(jqProjectStoreKey),
    defaultProject = await storageGetLocal(jqActiveProjectStoreKey);
  if (Array.isArray(storedProjects) && storedProjects.length) {
    const changed = new Set();
    jqProjects = storedProjects.map(jqNormalizeProjectRecord).filter(project => {
      if (changed.has(project.id)) return false;
      changed.add(project.id);
      return true;
    });
  }
  if (!jqProjects.some(normalizedProject => normalizedProject.id === "default")) jqProjects.unshift({
    id: "default",
    name: "默认项目",
    archived: false
  });
  const storedActiveId = jqProjects.find(activeExists => activeExists.id === defaultProject && !activeExists.archived) || jqProjects.find(nextId => !nextId.archived) || jqProjects[0];
  jqActiveProjectId = storedActiveId?.id || "default";
  jqBindProjectUi();
  jqRenderProjects();
}
function jqProjectStats(projectId) {
  const tasks = jqProjectTasks(projectId);
  return {
    total: tasks.length,
    pending: tasks.filter(pendingTimes => pendingTimes.status === "pending").length,
    failed: tasks.filter(pendingCards => pendingCards.status === "failed").length,
    done: tasks.filter(projectTask => projectTask.status === "done").length
  };
}
function jqRenderProjectItem(project) {
  const stats = jqProjectStats(project.id),
    materialCount = Array.isArray(project.materials) ? project.materials.length : 0,
    materialBadge = materialCount ? "<em class=\"project-item-mat\" title=\"" + materialCount + " 个项目素材\">素材" + materialCount + "</em>" : "";
  return "<button type=\"button\" class=\"project-item " + (project.id === jqActiveProjectId ? "active" : "") + "\" data-project-id=\"" + jqEscapeHtml(project.id) + "\" title=\"双击名字改名，双击空白处打开素材库\"><span class=\"project-item-name\">" + jqEscapeHtml(project.name) + "</span>" + materialBadge + "<strong>" + stats.total + "</strong></button>";
}
function jqRenderProjectRow(project, index) {
  const stats = jqProjectStats(project.id),
    isActive = project.id === "default",
    isArchived = project.id === jqActiveProjectId,
    escapedName = project.archived ? "恢复" : "归档";
  return "<div class=\"project-manager-row " + (isArchived ? "active " : "") + (project.archived ? "archived" : "") + "\" data-project-id=\"" + jqEscapeHtml(project.id) + "\"><div class=\"project-manager-row-main\"><div class=\"project-manager-row-title\"><span>" + jqEscapeHtml(project.name) + "</span>" + (isArchived ? "<span class=\"project-manager-badge\">当前</span>" : "") + (project.archived ? "<span class=\"project-manager-badge\">已归档</span>" : "") + "</div><div class=\"project-manager-row-meta\">" + stats.total + " 个任务 · 已添加 " + stats.pending + " · 失败 " + stats.failed + " · 完成 " + stats.done + "</div></div><div class=\"project-manager-actions\"><button type=\"button\" data-project-action=\"select\" " + (project.archived ? "disabled" : "") + ">打开</button><button type=\"button\" data-project-action=\"rename\">重命名</button><button type=\"button\" data-project-action=\"up\" " + (index <= 0 ? "disabled" : "") + ">上移</button><button type=\"button\" data-project-action=\"down\" " + (index >= jqProjects.length - 1 ? "disabled" : "") + ">下移</button><button type=\"button\" data-project-action=\"archive\" " + (isActive ? "disabled" : "") + ">" + escapedName + "</button><button type=\"button\" data-project-action=\"exportCsv\">导出CSV</button><button type=\"button\" data-project-action=\"exportZip\">导出ZIP</button><button type=\"button\" class=\"danger\" data-project-action=\"delete\" " + (isActive ? "disabled" : "") + ">删除</button></div></div>";
}
function jqRenderProjects() {
  const projectListEl = getEl("projectList"),
    visibleProjects = getEl("activeProjectName"),
    pinnedProjects = getEl("projectManagerList");
  if (visibleProjects) visibleProjects.textContent = jqProjectNameById(jqActiveProjectId);
  if (projectListEl) {
    const hiddenCount = jqProjects.filter(project => !project.archived);
    let projectGridEl = hiddenCount.slice(0, 6);
    const managerListEl = hiddenCount.find(project => project.id === jqActiveProjectId);
    if (managerListEl && !projectGridEl.some(project => project.id === managerListEl.id)) {
      if (projectGridEl.length >= 6) projectGridEl[projectGridEl.length - 1] = managerListEl;else projectGridEl.push(managerListEl);
    }
    let currentProjectEl = projectGridEl.map(jqRenderProjectItem).join("");
    if (hiddenCount.length > 6) currentProjectEl += "<div class=\"project-list-note\">还有 " + (hiddenCount.length - 6) + " 个项目，点项目管理查看</div>";
    projectListEl.innerHTML = currentProjectEl;
  }
  if (pinnedProjects) pinnedProjects.innerHTML = jqProjects.map(jqRenderProjectRow).join("");
}
function jqSetActiveProject(projectId) {
  const project = jqProjectById(projectId);
  if (!project) return;
  if (project.archived) {
    appendLog("⚠️ 项目已归档，请先恢复项目");
    return;
  }
  jqActiveProjectId = projectId;
  jqSaveProjects().catch(() => {});
  jqRenderProjects();
  if (typeof renderQueue === "function") renderQueue();
}
function jqCreateProjectFromInput() {
  const inputEl = getEl("projectNameInput"),
    name = jqNormalizeProjectName(inputEl?.value);
  if (!name) {
    appendLog("⚠️ 请输入项目名称");
    return;
  }
  const projectId = jqEnsureProjectByName(name);
  if (inputEl) inputEl.value = "";
  jqSetActiveProject(projectId);
  jqSaveProjects().catch(() => {});
  appendLog("✅ 已创建项目：" + name);
}
function jqOpenProjectManager() {
  const projectManagerModal = getEl("projectManagerModal");
  jqRenderProjects();
  if (projectManagerModal) projectManagerModal.hidden = false;
}
function jqCloseProjectManager() {
  const projectManagerModal = getEl("projectManagerModal");
  if (projectManagerModal) projectManagerModal.hidden = true;
}
async function jqApplyProjectRename(projectId, rawName) {
  const project = jqProjectById(projectId);
  if (!project) return false;
  const nextName = jqNormalizeProjectName(rawName);
  if (!nextName || nextName === project.name) return false;
  if (jqProjects.some(other => other.id !== projectId && other.name === nextName)) {
    appendLog("⚠️ 已存在同名项目");
    return false;
  }
  project.name = nextName;
  await jqSaveProjects();
  jqRenderProjects();
  renderQueue();
  appendLog("✅ 项目已重命名：" + nextName);
  return true;
}
async function jqRenameProject(projectId) {
  const project = jqProjectById(projectId);
  if (!project) return;
  await jqApplyProjectRename(projectId, prompt("输入新的项目名称", project.name));
}
function jqStartInlineProjectRename(nameEl, projectId) {
  if (!nameEl || nameEl.dataset.editing === "1") return;
  const project = jqProjectById(projectId);
  if (!project) return;
  nameEl.dataset.editing = "1";
  const originalName = project.name,
    inputEl = document.createElement("input");
  inputEl.type = "text", inputEl.maxLength = 28, inputEl.value = originalName, inputEl.className = "project-item-name-input";
  nameEl.textContent = "", nameEl.appendChild(inputEl), inputEl.focus(), inputEl.select();
  let finished = false;
  const finish = async commit => {
    if (finished) return;
    finished = true;
    if (commit) await jqApplyProjectRename(projectId, inputEl.value);
    jqRenderProjects();
  };
  inputEl.addEventListener("keydown", keyEvent => {
    keyEvent.stopPropagation();
    if (keyEvent.key === "Enter") {
      keyEvent.preventDefault(), finish(true);
    } else if (keyEvent.key === "Escape") {
      keyEvent.preventDefault(), finish(false);
    }
  }), inputEl.addEventListener("blur", () => finish(true)), inputEl.addEventListener("click", clickEvent => clickEvent.stopPropagation()), inputEl.addEventListener("dblclick", clickEvent => clickEvent.stopPropagation());
}
function jqMaterialKindForFile(file) {
  const name = String(file?.name || "").toLowerCase(),
    type = String(file?.type || "").toLowerCase();
  if (type.startsWith("video/") || name.endsWith(".mp4")) return "vid";
  if (type.startsWith("audio/")) return "aud";
  return "img";
}
function jqMaterialKindLabel(kind) {
  return kind === "vid" ? "视频" : kind === "aud" ? "音频" : "图片";
}
function jqMaterialKindTitle(kind) {
  return kind === "vid" ? "视频素材" : kind === "aud" ? "音频素材" : "图片素材";
}
function jqFormatMaterialSize(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知大小";
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}
function jqMaterialFileExt(name) {
  const match = String(name || "").match(/\.([^.]+)$/);
  return match ? match[1].slice(0, 8).toUpperCase() : "FILE";
}
let jqMaterialPanelProjectId = null;
function jqOpenProjectMaterialPanel(projectId) {
  const project = jqProjectById(projectId);
  if (!project) return;
  jqMaterialPanelProjectId = projectId;
  const modalEl = getEl("projectMaterialModal"),
    titleEl = getEl("projectMaterialTitle");
  if (titleEl) titleEl.textContent = "项目素材 · " + project.name;
  jqRenderProjectMaterials();
  if (modalEl) modalEl.hidden = false;
}
function jqCloseProjectMaterialPanel() {
  const modalEl = getEl("projectMaterialModal");
  if (modalEl) modalEl.hidden = true;
  jqMaterialPanelProjectId = null;
}
function jqRenderProjectMaterials() {
  const listEl = getEl("projectMaterialList"),
    statsEl = getEl("projectMaterialStats");
  if (!listEl) return;
  const project = jqProjectById(jqMaterialPanelProjectId);
  if (!project) {
    listEl.innerHTML = "";
    if (statsEl) statsEl.innerHTML = "";
    return;
  }
  const materials = Array.isArray(project.materials) ? project.materials : [];
  const counts = materials.reduce((acc, material) => {
    const kind = material?.kind === "vid" || material?.kind === "aud" ? material.kind : "img";
    acc[kind] += 1;
    acc.total += 1;
    return acc;
  }, {
    total: 0,
    img: 0,
    vid: 0,
    aud: 0
  });
  if (statsEl) statsEl.innerHTML = "<span><strong>" + counts.total + "</strong> 总素材</span><span><strong>" + counts.img + "</strong> 图片</span><span><strong>" + counts.vid + "</strong> 视频</span><span><strong>" + counts.aud + "</strong> 音频</span>";
  if (!materials.length) {
    listEl.innerHTML = "<div class=\"project-material-empty\"><strong>还没有项目素材</strong><span>点击上方添加素材后，提示词里输入 @ 就可以引用。</span></div>";
    return;
  }
  listEl.innerHTML = materials.map(material => {
    const kind = material?.kind === "vid" || material?.kind === "aud" ? material.kind : "img",
      name = String(material?.name || "未命名素材"),
      ext = jqMaterialFileExt(name),
      sizeText = jqFormatMaterialSize(material?.size),
      tagText = "@" + stripFileExtension(name);
    return "<article class=\"project-material-card " + kind + "\" data-mat-id=\"" + jqEscapeHtml(material.matId) + "\"><div class=\"project-material-card-head\"><span class=\"project-material-kind " + kind + "\">" + jqMaterialKindLabel(kind) + "</span><button type=\"button\" class=\"project-material-remove\" data-mat-id=\"" + jqEscapeHtml(material.matId) + "\" aria-label=\"删除素材\">×</button></div><div class=\"project-material-name\" title=\"" + jqEscapeHtml(name) + "\">" + jqEscapeHtml(name) + "</div><div class=\"project-material-meta\"><span>" + jqEscapeHtml(ext) + "</span><span>" + jqEscapeHtml(sizeText) + "</span></div><div class=\"project-material-ref\" title=\"提示词引用名\">" + jqEscapeHtml(tagText) + "</div><div class=\"project-material-kind-title\">" + jqMaterialKindTitle(kind) + "</div></article>";
  }).join("");
}
async function jqAddProjectMaterials(files) {
  const project = jqProjectById(jqMaterialPanelProjectId);
  if (!project || !files || !files.length) return;
  project.materials = Array.isArray(project.materials) ? project.materials : [];
  const existingNames = new Set(project.materials.map(material => stripFileExtension(material.name).toLowerCase()));
  let added = 0;
  for (const file of files) {
    const baseName = stripFileExtension(file.name).toLowerCase();
    if (existingNames.has(baseName)) {
      appendLog("⚠️ 项目已存在同名素材，跳过：" + file.name);
      continue;
    }
    const matId = jqNewMaterialId(),
      dataUrl = await readFileAsDataUrl(file);
    await putProjectMaterialBlob({
      matId,
      dataUrl
    });
    project.materials.push({
      matId,
      name: file.name,
      kind: jqMaterialKindForFile(file),
      type: file.type || "",
      size: file.size || 0
    }), existingNames.add(baseName), added += 1;
  }
  if (added) {
    await jqSaveProjects();
    jqRenderProjects();
    jqRenderProjectMaterials();
    renderMediaChips();
    appendLog("✅ 已向项目添加 " + added + " 个素材");
  }
}
async function jqRemoveProjectMaterial(matId) {
  const project = jqProjectById(jqMaterialPanelProjectId);
  if (!project || !Array.isArray(project.materials)) return;
  const index = project.materials.findIndex(material => material.matId === matId);
  if (index < 0) return;
  project.materials.splice(index, 1);
  await deleteProjectMaterialBlob(matId).catch(() => {});
  await jqSaveProjects();
  jqRenderProjects();
  jqRenderProjectMaterials();
  renderMediaChips();
}
async function jqMaterializeProjectMaterial(material) {
  if (!material) return null;
  const stored = await getProjectMaterialBlob(material.matId);
  if (!stored || !stored.dataUrl) return null;
  return dataUrlToFile(stored.dataUrl, material.name);
}
async function jqMoveProject(projectId, direction) {
  const index = jqProjects.findIndex(project => project.id === projectId);
  if (index < 0) return;
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= jqProjects.length) return;
  const [movingProject] = jqProjects.splice(index, 1);
  jqProjects.splice(targetIndex, 0, movingProject);
  await jqSaveProjects();
  jqRenderProjects();
}
async function jqToggleArchiveProject(projectId) {
  const project = jqProjectById(projectId);
  if (!project || project.id === "default") return;
  project.archived = !project.archived;
  if (project.archived && jqActiveProjectId === project.id) {
    const activeProject = jqProjects.find(replacementProject => !replacementProject.archived) || jqProjects[0];
    jqActiveProjectId = activeProject.id;
  }
  await jqSaveProjects();
  jqRenderProjects();
  renderQueue();
  appendLog((project.archived ? "📦 已归档项目：" : "✅ 已恢复项目：") + project.name);
}
async function jqDeleteProject(projectId) {
  const project = jqProjectById(projectId);
  if (!project || project.id === "default") return;
  const projectName = jqProjectTasks(projectId);
  if (!confirm("删除项目「" + project.name + "」以及其中 " + projectName.length + " 个任务？此操作不可恢复。")) return;
  await Promise.allSettled(projectName.map(replacementProject => deleteTaskPayloadRecord(replacementProject.id)));
  if (Array.isArray(project.materials)) await Promise.allSettled(project.materials.map(material => deleteProjectMaterialBlob(material.matId)));
  jqTasks = jqTasks.filter(tasksToRemove => jqTaskProjectId(tasksToRemove) !== projectId);
  jqProjects = jqProjects.filter(task => task.id !== projectId);
  if (jqActiveProjectId === projectId) {
    const task = jqProjects.find(taskId => !taskId.archived) || jqProjects[0];
    jqActiveProjectId = task?.id || "default";
  }
  await jqSaveProjects();
  await saveTasks();
  jqRenderProjects();
  renderQueue();
  appendLog("🗑 已删除项目：" + project.name);
}
function jqSanitizeFileName(fileName) {
  return String(fileName || "project").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 60) || "project";
}
function jqExportProjectId(projectId) {
  return typeof projectId === "string" && jqProjectById(projectId) ? projectId : jqActiveProjectId;
}
function jqCsvCell(value) {
  return "\"" + String(value ?? "").replace(/"/g, "\"\"") + "\"";
}
function jqTaskCsvHeaders() {
  return ["项目", "任务卡片名", "生成次数", "已执行次数", "ID", "创建时间", "状态", "提示词", "创作模式", "模型", "参考模式", "比例", "时长"];
}
function jqTaskCsvRow(task) {
  const settings = task.settings || {},
    payload = String(task.payload?.promptText || "").replace(/\r?\n/g, "\\n");
  return [jqProjectNameById(jqTaskProjectId(task)), task.taskName || "", jqTaskRepeatTotal(task), jqTaskRepeatDone(task), task.id, task.createdAt, taskStatusLabels[task.status] || task.status, payload, settings.genMode || "", settings.model || "", settings.refMode || "", normalizeRatioText(settings.ratio || ""), settings.duration || ""].map(jqCsvCell).join(",");
}
function jqBuildTaskCsvText(tasks) {
  return [jqTaskCsvHeaders().map(jqCsvCell).join(","), ...tasks.map(jqTaskCsvRow)].join("\n");
}
function jqReadImportedCell(row, columnMap, columnName) {
  const fallbackValue = columnMap[columnName];
  return Number.isInteger(fallbackValue) ? String(row[fallbackValue] || "").trim() : "";
}
function jqApplyImportedTaskMeta(task, row, columnMap) {
  const status = jqReadImportedCell(row, columnMap, "项目");
  if (status) task.projectId = jqEnsureProjectByName(status);
  const repeatTotal = jqReadImportedCell(row, columnMap, "任务卡片名");
  if (repeatTotal) task.taskName = repeatTotal.slice(0, 40);
  const repeatDone = Number(jqReadImportedCell(row, columnMap, "生成次数"));
  if (Number.isFinite(repeatDone)) task.repeatTotal = jqClampRepeat(repeatDone);
  const projectName = Number(jqReadImportedCell(row, columnMap, "已执行次数"));
  task.repeatDone = Number.isFinite(projectName) ? Math.max(0, Math.min(jqTaskRepeatTotal(task), Math.floor(projectName))) : 0;
  if (task.repeatDone >= jqTaskRepeatTotal(task)) task.status = "done";
}
function jqBindProjectUi() {
  if (window.__jqProjectUiBound) return;
  window.__jqProjectUiBound = true;
  getEl("createProjectBtn")?.addEventListener("click", jqCreateProjectFromInput);
  getEl("projectNameInput")?.addEventListener("keydown", projectNameInput => {
    if (projectNameInput.key === "Enter") {
      projectNameInput.preventDefault();
      jqCreateProjectFromInput();
    }
  });
  getEl("projectList")?.addEventListener("click", clickEvent => {
    if (clickEvent.target.closest(".project-item-name-input")) return;
    const itemEl = clickEvent.target.closest("button[data-project-id]");
    if (!itemEl) return;
    const projectId = itemEl.dataset.projectId,
      onName = !!clickEvent.target.closest(".project-item-name"),
      nameEl = itemEl.querySelector(".project-item-name");
    // 手动识别双击：单击切换项目会重渲染 DOM，原生 dblclick 会失效，故延迟单击动作
    if (jqProjectClickTimer && jqProjectClickId === projectId) {
      clearTimeout(jqProjectClickTimer), jqProjectClickTimer = null, jqProjectClickId = null;
      if (onName) jqStartInlineProjectRename(nameEl, projectId);else jqOpenProjectMaterialPanel(projectId);
      return;
    }
    jqProjectClickTimer && clearTimeout(jqProjectClickTimer), jqProjectClickId = projectId, jqProjectClickTimer = setTimeout(() => {
      jqProjectClickTimer = null, jqProjectClickId = null, jqSetActiveProject(projectId);
    }, 250);
  });
  getEl("taskRepeatInput")?.addEventListener("change", jqCurrentTaskRepeat);
  getEl("taskNumberPrefixToggle")?.addEventListener("change", projectManagerPanel => jqSetTaskNumberPrefixEnabled(projectManagerPanel.target.checked));
  jqSyncTaskNumberPrefixToggle();
  getEl("openProjectManager")?.addEventListener("click", jqOpenProjectManager);
  getEl("projectManagerClose")?.addEventListener("click", jqCloseProjectManager);
  getEl("projectManagerModal")?.addEventListener("click", openManagerBtn => {
    if (openManagerBtn.target === openManagerBtn.currentTarget) jqCloseProjectManager();
  });
  getEl("projectManagerList")?.addEventListener("click", closeManagerBtn => {
    const event = closeManagerBtn.target.closest("button[data-project-action]");
    if (!event) return;
    const target = event.closest("[data-project-id]")?.dataset.projectId,
      projectId = event.dataset.projectAction;
    if (!target) return;
    if (projectId === "select") jqSetActiveProject(target);else if (projectId === "rename") jqRenameProject(target).catch(event => appendLog("❌ 项目重命名失败: " + (event.message || event)));else if (projectId === "up" || projectId === "down") jqMoveProject(target, projectId).catch(() => {});else if (projectId === "archive") jqToggleArchiveProject(target).catch(target => appendLog("❌ 项目归档失败: " + (target.message || target)));else if (projectId === "delete") jqDeleteProject(target).catch(projectId => appendLog("❌ 项目删除失败: " + (projectId.message || projectId)));else if (projectId === "exportCsv") exportProjectCsv(target);else if (projectId === "exportZip") exportProjectZip(target);
  });
  document.addEventListener("keydown", action => {
    if (action.key === "Escape" && !getEl("projectManagerModal")?.hidden) jqCloseProjectManager();
  });
  getEl("projectMaterialClose")?.addEventListener("click", jqCloseProjectMaterialPanel);
  getEl("projectMaterialModal")?.addEventListener("click", modalEvent => {
    if (modalEvent.target === modalEvent.currentTarget) jqCloseProjectMaterialPanel();
  });
  getEl("projectMaterialAddInput")?.addEventListener("change", async changeEvent => {
    const files = Array.from(changeEvent.target.files || []);
    changeEvent.target.value = "";
    if (files.length) await jqAddProjectMaterials(files).catch(error => appendLog("❌ 添加素材失败: " + (error.message || error)));
  });
  getEl("projectMaterialList")?.addEventListener("click", listEvent => {
    const removeBtn = listEvent.target.closest(".project-material-remove");
    if (removeBtn) jqRemoveProjectMaterial(removeBtn.dataset.matId).catch(error => appendLog("❌ 删除素材失败: " + (error.message || error)));
  });
  document.addEventListener("keydown", escEvent => {
    if (escEvent.key === "Escape" && !getEl("projectMaterialModal")?.hidden) jqCloseProjectMaterialPanel();
  });
}
function canRunAction() {
  return true;
}
function isAllReferenceMode(refMode) {
  return compactText(refMode).includes(compactText("全能参考"));
}
function isFirstLastFrameMode(refMode) {
  return compactText(refMode).includes(compactText("首尾帧"));
}
function isUltraLongVideoMode(refMode) {
  return compactText(refMode).includes(compactText("超长视频"));
}
function durationMemoryKeyForRefMode(refMode) {
  return isUltraLongVideoMode(refMode) ? "ultra-long" : "standard";
}
function isSeedance25Model(model) {
  return compactText(model) === compactText("Seedance 2.5");
}
function durationRangeForSettings(refMode, model) {
  if (isSeedance25Model(model)) return isUltraLongVideoMode(refMode) ? {
    min: 30,
    max: 180
  } : {
    min: 4,
    max: 30
  };
  return {
    min: 4,
    max: 15
  };
}
function maxImageCountForSettings(refMode, model) {
  if (isFirstLastFrameMode(refMode)) return 2;
  return isSeedance25Model(model) ? 50 : maxImageCount;
}
function maxReferenceMaterialCountForSettings(model) {
  return isSeedance25Model(model) ? 50 : null;
}
function referenceMaterialCount(payload) {
  return (payload?.imageFiles?.length || 0) + (payload?.videoFiles?.length || 0) + (payload?.audioFiles?.length || 0);
}
function updatePromptPlaceholder(refMode, model) {
  const promptText = getEl("promptText");
  if (!promptText) return;
  const maxReferenceMaterials = maxReferenceMaterialCountForSettings(model),
    maxMaterials = maxReferenceMaterials === null ? maxImageCountForSettings(refMode, model) : maxReferenceMaterials,
    placeholderText = "上传最多" + maxMaterials + "个参考素材、输入文字或 @ 参考内容，自由组合图、文、音、视频多元素。";
  promptText.placeholder = placeholderText;
  document.querySelector(".prompt-codemirror.CodeMirror")?.setAttribute("data-placeholder", placeholderText);
}
function refModeOptionsForModel(model) {
  const options = ["全能参考", "首尾帧"];
  isSeedance25Model(model) && options.push("超长视频");
  return options;
}
function modelOptionsForRefMode(refMode) {
  if (isUltraLongVideoMode(refMode)) return ["Seedance 2.5"];
  if (isAllReferenceMode(refMode)) return ["Seedance 2.5", "Seedance 2.0 mini", "Seedance 2.0 Fast VIP", "Seedance 2.0 VIP", "Seedance 2.0 Fast", "Seedance 2.0"];
  if (isFirstLastFrameMode(refMode)) return seedanceModelOptions.filter(modelName => {
    const compactModel = compactText(modelName);
    return compactModel !== compactText("Seedance 1.0") && compactModel !== compactText("Seedance 1.0 Fast");
  });
  return seedanceModelOptions;
}
function durationOptionsForRefMode(refMode, model) {
  const durationRange = durationRangeForSettings(refMode, model);
  if (isSeedance25Model(model)) return Array.from({
    length: durationRange.max - durationRange.min + 1
  }, (_, index) => durationRange.min + index + "s");
  if (isFirstLastFrameMode(refMode)) {
    const compactModel = compactText(model);
    if (compactModel === compactText("Seedance 1.0") || compactModel === compactText("Seedance 1.0 Fast")) return ["5s", "10s"];
    if (compactModel === compactText("Seedance 1.5 Pro")) return ["5s", "10s", "12s"];
    return durationOptions;
  }
  return durationOptions;
}
function renderModelOptions(selectEl) {
  const currentValue = getEl("model"),
    optionList = currentValue.value;
  currentValue.innerHTML = selectEl.map(optionValue => "<option value=\"" + optionValue + "\">" + optionValue + "</option>").join(""), currentValue.value = selectEl.includes(optionList) ? optionList : selectEl[0];
}
function renderDurationOptions(selectEl) {
  const currentValue = getEl("duration"),
    optionList = currentValue.value;
  currentValue.innerHTML = selectEl.map(optionValue => "<option value=\"" + optionValue + "\">" + optionValue + "</option>").join(""), currentValue.value = selectEl.includes(optionList) ? optionList : selectEl[0];
  jqRefreshDurationSlider();
}
// 参考模式下拉：固定为「全能参考/首尾帧」，Seedance 2.5 额外提供超长视频。当前值合法则保留，否则取第一项。
function jqSyncRefModeOptions(modelOverride = getEl("model")?.value || "") {
  const sel = getEl("refMode");
  if (!sel) return;
  const want = refModeOptionsForModel(modelOverride);
  const cur = sel.value;
  const ok = want.includes(cur);
  sel.innerHTML = want.map((o, i) => "<option value=\"" + o + "\"" + ((ok ? cur === o : i === 0) ? " selected" : "") + ">" + o + "</option>").join("");
  sel.value = ok ? cur : want[0];
}
function syncFormOptions() {
  const genModeEl = getEl("refMode").value;
  const refModeEl = modelOptionsForRefMode(genModeEl);
  renderModelOptions(refModeEl);
  const modelEl = getEl("model").value,
    maxImages = maxImageCountForSettings(genModeEl, modelEl),
    durationEl = durationOptionsForRefMode(genModeEl, modelEl);
  jqImageFiles.length > maxImages && (jqImageFiles = jqImageFiles.slice(0, maxImages), renderImagePreviews(), refreshUploadSummary());
  renderDurationOptions(durationEl);
  updatePromptPlaceholder(genModeEl, modelEl);
  jqApplyResolutionLock();
}
function setUiBusy(busy) {
  document.querySelectorAll("button[data-step]").forEach(disabled => {
    disabled.disabled = busy;
  });
  const busyText = getEl("pauseAllTasks");
  if (busyText) busyText.disabled = !(isQueueRunning || isQueueLoopActive);
  const input = getEl("clearAllCards");
  if (input) input.disabled = false;
  if (!busy) syncFormOptions();
}
function clampConcurrencyLimit(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return maxConcurrencyLimit;
  return Math.max(minConcurrencyLimit, Math.min(maxConcurrencyLimit, Math.floor(numberValue)));
}
function normalizeMonitorGroup(groupName) {
  return String(groupName || "").toLowerCase() === "vip" ? "vip" : "standard";
}
function normalizeGroupLimits(limits) {
  const normalizedLimits = limits && typeof limits === "object" ? limits : {};
  return {
    standard: clampConcurrencyLimit(normalizedLimits.standard),
    vip: clampConcurrencyLimit(normalizedLimits.vip)
  };
}
function normalizeModelName(model) {
  const normalizedModel = String(model || "").toLowerCase().replace(/\s+/g, "").replace(/[：:]/g, ".").replace(/[·•]/g, ".").replace(/[_-]/g, ".");
  if (normalizedModel.includes("seedance2.5")) return "Seedance 2.5";
  if (normalizedModel.includes("seedance2.0fastvip")) return "Seedance 2.0 Fast VIP";
  if (normalizedModel.includes("seedance2.0vip")) return "Seedance 2.0 VIP";
  if (normalizedModel.includes("seedance2.0fast")) return "Seedance 2.0 Fast";
  if (normalizedModel.includes("seedance2.0mini")) return "Seedance 2.0 mini";
  if (normalizedModel.includes("seedance2.0")) return "Seedance 2.0";
  return "";
}
function monitorGroupForModel(model) {
  const modelName = normalizeModelName(model);
  if (modelName && Object.prototype.hasOwnProperty.call(modelGroupMap, modelName)) return modelGroupMap[modelName];
  return "standard";
}
function concurrencyLimitForModel(model) {
  const group = monitorGroupForModel(model);
  return clampConcurrencyLimit(monitorGroupLimits[group]);
}
function modelCountFromMonitorState(state, model) {
  const modelName = normalizeModelName(model);
  if (!modelName) return Number(state?.currentCount);
  return Number(state?.modelCounts?.[modelName]);
}
function monitorUnknownCountFromState(state) {
  const unknownCount = Number(state?.unknownCount);
  return Number.isFinite(unknownCount) && unknownCount > 0 ? Math.floor(unknownCount) : 0;
}
function modelSlotFromMonitorState(state, model) {
  const currentCount = modelCountFromMonitorState(state, model),
    limit = concurrencyLimitForModel(model),
    unknownCount = monitorUnknownCountFromState(state),
    totalCount = Number(state?.currentCount),
    apiGenRaw = Number(state?.apiGeneratingCount),
    apiGenerating = Number.isFinite(apiGenRaw) && apiGenRaw >= 0 ? apiGenRaw : -1,
    // 防滚动漏数：接口(net-hook)说在生成的数 > 页面 DOM 数到的总数 → 说明有生成中的卡被滚动/虚拟列表藏了，
    // 此刻按模型分的计数不可信，判为 unreliable（闸门会等待，不会误判有空位）。-1 表示拿不到接口数，不参与判定。
    domHidesGenerating = apiGenerating >= 0 && Number.isFinite(totalCount) && totalCount >= 0 && apiGenerating > totalCount;
  return {
    currentCount,
    limit,
    unknownCount,
    apiGenerating,
    reliable: Number.isFinite(totalCount) && totalCount >= 0 && unknownCount === 0 && !domHidesGenerating && Number.isFinite(currentCount) && currentCount >= 0 && Number.isFinite(limit)
  };
}
function modelCounterKey(model) {
  const modelName = normalizeModelName(model);
  if (modelName) return modelName;
  const group = String(model || "").trim().toLowerCase();
  return group || "__unknown_model__";
}
function markModelSubmitCooldown(model) {
  const key = modelCounterKey(model);
  modelSubmitCooldownAt[key] = Date.now();
}
function pauseAllQueue(reason) {
  queuePaused = true, queuePauseReason = String(reason || "已暂停全部，停止后续任务"), queuePauseScope = "all", queuePausedTaskId = null, queueUserStopped = true, setQueueAutoResumeEnabled(false)["catch"](() => {});
}
function pauseTaskQueue(taskId, reason) {
  queuePaused = true, queuePauseReason = String(reason || "已暂停任务 #" + taskId), queuePauseScope = "task", queuePausedTaskId = Number.isFinite(taskId) ? taskId : null;
}
function clearQueuePause() {
  queuePaused = false, queuePauseReason = "", queuePauseScope = "all", queuePausedTaskId = null;
}
function assertQueueNotPaused() {
  if (queuePaused) throw new Error(queuePauseReason || "已暂停全部，停止后续任务");
}
function waitForQueueResume() {
  return new Promise(resolve => {
    pauseResumeResolver = resolve;
  });
}
function resolveQueueResumeWaiter() {
  if (typeof pauseResumeResolver === "function") {
    const resolver = pauseResumeResolver;
    pauseResumeResolver = null, resolver();
  }
}
async function withQueueBusyLock(label, runner) {
  if (isQueueRunning || isQueueLoopActive) {
    appendLog("⏳ 正在执行中，请稍候（" + label + "）");
    return;
  }
  isQueueRunning = true, clearCachedJimengTab(), setUiBusy(true), renderQueue();
  try {
    await runner();
  } finally {
    clearCachedJimengTab(), isQueueRunning = false, setUiBusy(false), renderQueue();
  }
}
const readTaskSettingsForm = () => ({
  genMode: getEl("genMode").value.trim(),
  model: getEl("model").value.trim(),
  refMode: getEl("refMode").value.trim(),
  ratio: getEl("ratio").value.trim(),
  resolution: (getEl("resolution")?.value || "720P").trim(),
  count: Math.max(1, Math.min(4, parseInt(getEl("genCount")?.value, 10) || 1)),
  duration: getEl("duration").value.trim(),
  promptText: (getEl("promptText")?.value || "").trim()
});
// 比例·分辨率·数量 合并弹层：仅 Seedance 2.0 VIP 解锁 1080P/4K，其余锁 720P
function jqUpdateRatioComboLabel() {
  const btn = getEl("ratioComboBtn");
  if (!btn) return;
  const ratio = getEl("ratio")?.value || "21:9",
    res = getEl("resolution")?.value || "480P",
    cnt = getEl("genCount")?.value || "1";
  btn.innerHTML = ratio + " · " + res + " · " + cnt + "个 <span class=\"jm-caret\">▾</span>";
}
function jqApplyResolutionLock() {
  const pop = getEl("ratioPopover");
  if (!pop) return;
  const model = (getEl("model")?.value || "").trim(),
    allowedResolutions = model === "Seedance 2.0 VIP" ? ["720P", "1080P", "4K"] : isSeedance25Model(model) ? ["480P", "720P"] : ["720P"];
  pop.querySelectorAll(".jm-pop-opts[data-group=\"resolution\"] button").forEach(b => {
    const allowed = allowedResolutions.includes(b.dataset.val);
    b.disabled = !allowed;
    b.classList.toggle("locked", !allowed);
  });
  const resEl = getEl("resolution");
  if (resEl && !allowedResolutions.includes(resEl.value)) {
    resEl.value = "720P";
    pop.querySelectorAll(".jm-pop-opts[data-group=\"resolution\"] button").forEach(b => b.classList.toggle("on", b.dataset.val === "720P"));
    jqUpdateRatioComboLabel();
  }
}
// 数量锁：2.0 / 2.0 Fast 强制 1；mini / VIP / Fast VIP 允许 1-4
function jqApplyCountLock() {
  const pop = getEl("ratioPopover");
  if (!pop) return;
  const model = (getEl("model")?.value || "").trim();
  const lockedToOne = (model === "Seedance 2.0" || model === "Seedance 2.0 Fast");
  pop.querySelectorAll(".jm-pop-opts[data-group=\"count\"] button").forEach(b => {
    const isOne = b.dataset.val === "1";
    b.disabled = lockedToOne && !isOne;
    b.classList.toggle("locked", lockedToOne && !isOne);
  });
  const countEl = getEl("genCount");
  if (lockedToOne && countEl && countEl.value !== "1") {
    countEl.value = "1";
    pop.querySelectorAll(".jm-pop-opts[data-group=\"count\"] button").forEach(b => b.classList.toggle("on", b.dataset.val === "1"));
    jqUpdateRatioComboLabel();
  }
}
function jqUpdateModelChipLabel() {
  const label = getEl("jmModelChipLabel"), modelEl = getEl("model");
  if (label && modelEl) label.textContent = modelEl.value || "";
}
function jqUpdateRefModeChipLabel() {
  const label = getEl("jmRefModeChipLabel"), el = getEl("refMode");
  if (label && el) label.textContent = el.value || "";
}
function jqUpdateDurationChipLabel() {
  const label = getEl("jmDurationChipLabel"), el = getEl("duration");
  if (label && el) label.textContent = el.value || "";
}
// 点开任一 chip 弹层时，关掉其它已打开的弹层（模型/参考/时长/比例）
function jqCloseAllChipPopovers(exceptEl) {
  ["modelPopover", "refModePopover", "durationPopover", "ratioPopover"].forEach(id => {
    const p = getEl(id);
    if (p && p !== exceptEl) p.hidden = true;
  });
}
function jqBindRatioCombo() {
  const btn = getEl("ratioComboBtn"),
    pop = getEl("ratioPopover");
  if (!btn || !pop || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", clickEvent => {
    clickEvent.stopPropagation();
    const willOpen = pop.hidden;
    jqCloseAllChipPopovers(pop);
    pop.hidden = !willOpen;
  });
  pop.addEventListener("click", clickEvent => {
    const opt = clickEvent.target.closest(".jm-pop-opts button");
    if (!opt || opt.disabled) return;
    clickEvent.stopPropagation();
    const group = opt.parentElement.dataset.group,
      val = opt.dataset.val;
    opt.parentElement.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === opt));
    if (group === "ratio") getEl("ratio").value = val;else if (group === "resolution") getEl("resolution").value = val;else if (group === "count") getEl("genCount").value = val;
    jqUpdateRatioComboLabel();
  });
  document.addEventListener("click", clickEvent => {
    if (!pop.hidden && !pop.contains(clickEvent.target) && clickEvent.target !== btn) pop.hidden = true;
  });
  jqApplyResolutionLock(), jqApplyCountLock(), jqUpdateRatioComboLabel();
}
let jqLogHistory = [];
function jqLogIsExpanded() {
  const logContainer = logEl?.closest?.(".log-resizable");
  return !!(logContainer && logContainer.classList.contains("is-expanded"));
}
function jqRenderLog() {
  if (!logEl) return;
  const visibleLogs = jqLogIsExpanded() ? jqLogHistory : jqLogHistory.slice(-1);
  logEl.textContent = visibleLogs.join("\n") || "等待执行...";
  logEl.scrollTop = logEl.scrollHeight;
}
window.jqRenderLog = jqRenderLog;
let appendLog = logMessage => {
  const logLine = new Date().toLocaleTimeString() + "  " + logMessage;
  jqLogHistory.push(logLine);
  if (jqLogHistory.length > 10) jqLogHistory = jqLogHistory.slice(-10);
  jqRenderLog();
};
function readTaskPayloadForm() {
  return {
    promptText: (getEl("promptText")?.value || "").trim(),
    imageFiles: jqImageFiles.slice(),
    videoFiles: jqVideoFiles.slice(),
    audioFiles: jqAudioFiles.slice()
  };
}
function fileIdentityKey(file) {
  return file.name + "__" + file.size + "__" + file.lastModified;
}
function mediaFileIdentityKey(mediaFile) {
  return mediaFile.name + "__" + mediaFile.size + "__" + mediaFile.lastModified;
}
function objectUrlForFile(file) {
  if (objectUrlCache.has(file)) return objectUrlCache.get(file);
  const objectUrl = URL.createObjectURL(file);
  return objectUrlCache.set(file, objectUrl), objectUrl;
}
function renderImagePreviews() {
  const imagePreviewGridEl = getEl("imagePreviewGrid");
  if (!imagePreviewGridEl) return;
  imagePreviewGridEl.innerHTML = jqImageFiles.map((imageFile, imageIndex) => {
    return "\n      <div class=\"image-preview-card\">\n        <button type=\"button\" class=\"image-remove-btn\" data-index=\"" + imageIndex + "\" aria-label=\"删除图片" + (imageIndex + 1) + "\">×</button>\n        <img class=\"image-preview-thumb\" src=\"" + objectUrlForFile(imageFile) + "\" alt=\"图片" + (imageIndex + 1) + "\" />\n        <div class=\"image-preview-meta\">\n          <span class=\"image-preview-index\">图片" + (imageIndex + 1) + "</span>\n          <span class=\"image-preview-name\" title=\"" + jqEscapeHtml(imageFile.name) + "\">" + jqEscapeHtml(imageFile.name) + "</span>\n        </div>\n      </div>\n    ";
  }).join(""), imagePreviewGridEl.querySelectorAll(".image-remove-btn").forEach(removeButton => {
    removeButton.addEventListener("click", () => {
      const removeIndex = Number(removeButton.dataset.index);
      if (Number.isNaN(removeIndex)) return;
      jqImageFiles.splice(removeIndex, 1), renderImagePreviews(), refreshUploadSummary();
    });
  });
}
function addImageFiles(files) {
  const maxImagesForMode = maxImageCountForSettings(getEl("refMode").value, getEl("model").value),
    maxReferenceMaterials = maxReferenceMaterialCountForSettings(getEl("model").value),
    existingKeys = new Set(jqImageFiles.map(fileIdentityKey));
  for (const file of files) {
    const fileKey = fileIdentityKey(file);
    if (existingKeys.has(fileKey)) continue;
    if (jqImageFiles.length >= maxImagesForMode) break;
    if (maxReferenceMaterials !== null && referenceMaterialCount(readTaskPayloadForm()) >= maxReferenceMaterials) break;
    jqImageFiles.push(file), existingKeys.add(fileKey);
  }
  renderImagePreviews();
}
function renderVideoFileList() {
  const videoFileListEl = getEl("videoFileList");
  if (!videoFileListEl) return;
  videoFileListEl.innerHTML = jqVideoFiles.map((videoFile, videoIndex) => "\n    <div class=\"file-list-item\">\n      <span class=\"file-list-index\">视频" + (videoIndex + 1) + "</span>\n      <span class=\"file-list-name\" title=\"" + jqEscapeHtml(videoFile.name) + "\">" + jqEscapeHtml(videoFile.name) + "</span>\n      <button type=\"button\" class=\"file-remove-btn\" data-kind=\"video\" data-index=\"" + videoIndex + "\" aria-label=\"删除视频" + (videoIndex + 1) + "\">×</button>\n    </div>\n  ").join(""), videoFileListEl.querySelectorAll(".file-remove-btn").forEach(removeButton => {
    removeButton.addEventListener("click", () => {
      const removeIndex = Number(removeButton.dataset.index);
      if (Number.isNaN(removeIndex)) return;
      jqVideoFiles.splice(removeIndex, 1), renderVideoFileList(), refreshUploadSummary();
    });
  });
}
function addVideoFiles(files) {
  const maxReferenceMaterials = maxReferenceMaterialCountForSettings(getEl("model").value),
    existingKeys = new Set(jqVideoFiles.map(mediaFileIdentityKey));
  for (const file of files) {
    const fileKey = mediaFileIdentityKey(file);
    if (existingKeys.has(fileKey)) continue;
    if (maxReferenceMaterials !== null && referenceMaterialCount(readTaskPayloadForm()) >= maxReferenceMaterials) break;
    jqVideoFiles.push(file), existingKeys.add(fileKey);
  }
  renderVideoFileList();
}
function renderAudioFileList() {
  const audioFileListEl = getEl("audioFileList");
  if (!audioFileListEl) return;
  audioFileListEl.innerHTML = jqAudioFiles.map((audioFile, audioIndex) => "\n    <div class=\"file-list-item\">\n      <span class=\"file-list-index\">音频" + (audioIndex + 1) + "</span>\n      <span class=\"file-list-name\" title=\"" + jqEscapeHtml(audioFile.name) + "\">" + jqEscapeHtml(audioFile.name) + "</span>\n      <button type=\"button\" class=\"file-remove-btn\" data-kind=\"audio\" data-index=\"" + audioIndex + "\" aria-label=\"删除音频" + (audioIndex + 1) + "\">×</button>\n    </div>\n  ").join(""), audioFileListEl.querySelectorAll(".file-remove-btn").forEach(removeButton => {
    removeButton.addEventListener("click", () => {
      const removeIndex = Number(removeButton.dataset.index);
      if (Number.isNaN(removeIndex)) return;
      jqAudioFiles.splice(removeIndex, 1), renderAudioFileList(), refreshUploadSummary();
    });
  });
}
function addAudioFiles(files) {
  const maxReferenceMaterials = maxReferenceMaterialCountForSettings(getEl("model").value),
    existingKeys = new Set(jqAudioFiles.map(mediaFileIdentityKey));
  for (const file of files) {
    const fileKey = mediaFileIdentityKey(file);
    if (existingKeys.has(fileKey)) continue;
    if (maxReferenceMaterials !== null && referenceMaterialCount(readTaskPayloadForm()) >= maxReferenceMaterials) break;
    jqAudioFiles.push(file), existingKeys.add(fileKey);
  }
  renderAudioFileList();
}
function readMediaDuration(file) {
  return new Promise((resolve, reject) => {
    const isVideoFile = file.type.startsWith("video/") || file.name.toLowerCase().endsWith(".mp4"),
      mediaEl = document.createElement(isVideoFile ? "video" : "audio"),
      objectUrl = URL.createObjectURL(file);
    mediaEl.preload = "metadata", mediaEl.onloadedmetadata = () => {
      URL.revokeObjectURL(objectUrl), resolve({
        duration: Number.isFinite(mediaEl.duration) ? mediaEl.duration : 0,
        width: isVideoFile ? mediaEl.videoWidth || 0 : 0,
        height: isVideoFile ? mediaEl.videoHeight || 0 : 0
      });
    }, mediaEl.onerror = () => {
      URL.revokeObjectURL(objectUrl), reject(new Error("无法读取文件信息: " + file.name));
    }, mediaEl.src = objectUrl;
  });
}
async function refreshUploadSummary() {
  const summaryEl = getEl("uploadSummary"),
    errorEl = getEl("uploadError");
  if (!summaryEl) return;
  const payload = readTaskPayloadForm(),
    maxImages = maxImageCountForSettings(getEl("refMode").value, getEl("model").value),
    maxReferenceMaterials = maxReferenceMaterialCountForSettings(getEl("model").value),
    errors = [];
  payload.imageFiles.length > maxImages && errors.push("图片最多 " + maxImages + " 张（当前 " + payload.imageFiles.length + " 张）");
  maxReferenceMaterials !== null && referenceMaterialCount(payload) > maxReferenceMaterials && errors.push("参考素材最多 " + maxReferenceMaterials + " 个（当前 " + referenceMaterialCount(payload) + " 个）");
  let videoDuration = 0;
  for (const videoFile of payload.videoFiles) {
    if (videoFile.type !== "video/mp4" && !videoFile.name.toLowerCase().endsWith(".mp4")) {
      errors.push("视频 " + videoFile.name + " 不是 MP4 格式");
      continue;
    }
    try {
      const videoInfo = await readMediaDuration(videoFile);
      videoDuration += videoInfo.duration, videoInfo.width && videoInfo.height && !isAllowedVideoSize(videoInfo.width, videoInfo.height) && errors.push("视频 " + videoFile.name + " 分辨率 " + videoInfo.width + "x" + videoInfo.height + "，需 " + allowedVideoSizeText() + "（建议24帧）");
    } catch {
      errors.push("无法读取视频 " + videoFile.name + " 信息");
    }
  }
  videoDuration > maxVideoSeconds && errors.push("视频总时长 " + videoDuration.toFixed(1) + "s 超过 " + maxVideoSeconds + "s");
  let audioDuration = 0;
  for (const audioFile of payload.audioFiles) {
    try {
      const audioInfo = await readMediaDuration(audioFile);
      audioDuration += audioInfo.duration;
    } catch {
      errors.push("无法读取音频 " + audioFile.name + " 信息");
    }
  }
  audioDuration > maxAudioSeconds && errors.push("音频总时长 " + audioDuration.toFixed(1) + "s 超过 " + maxAudioSeconds + "s"), summaryEl.textContent = "图片 " + payload.imageFiles.length + " 张，视频 " + payload.videoFiles.length + " 个 (" + videoDuration.toFixed(1) + "s)，音频 " + payload.audioFiles.length + " 个 (" + audioDuration.toFixed(1) + "s)", errorEl && (errorEl.textContent = errors.join("\n"), errorEl.style.display = errors.length ? "block" : "none"), renderImagePreviews(), renderVideoFileList(), renderAudioFileList(), renderMediaChips();
}
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "")), reader.onerror = () => reject(new Error("读取文件失败: " + (file?.name || "unknown"))), reader.readAsDataURL(file);
  });
}
function setFaceSegStatus(statusText) {
  const statusEl = getEl("faceSegStatus");
  if (statusEl) statusEl.textContent = statusText;
}
function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image), image.onerror = () => reject(new Error("人像图加载失败")), image.src = dataUrl;
  });
}
function clampFaceRect(rect, maxWidth, maxHeight) {
  const width = Math.max(1, Math.min(Math.round(Number(rect?.width) || 1), maxWidth)),
    height = Math.max(1, Math.min(Math.round(Number(rect?.height) || 1), maxHeight)),
    maxX = Math.max(0, maxWidth - width),
    maxY = Math.max(0, maxHeight - height),
    x = Math.max(0, Math.min(Math.round(Number(rect?.x) || 0), maxX)),
    y = Math.max(0, Math.min(Math.round(Number(rect?.y) || 0), maxY));
  return {
    x: x,
    y: y,
    width: width,
    height: height
  };
}
function rectFromDragPoints(startX, startY, endX, endY, imageWidth, imageHeight) {
  const clampedStartX = Math.max(0, Math.min(Math.round(startX), imageWidth)),
    clampedStartY = Math.max(0, Math.min(Math.round(startY), imageHeight)),
    clampedEndX = Math.max(0, Math.min(Math.round(endX), imageWidth)),
    clampedEndY = Math.max(0, Math.min(Math.round(endY), imageHeight)),
    x = Math.min(clampedStartX, clampedEndX),
    y = Math.min(clampedStartY, clampedEndY),
    width = Math.abs(clampedEndX - clampedStartX),
    height = Math.abs(clampedEndY - clampedStartY);
  return clampFaceRect({
    x: x,
    y: y,
    width: Math.max(1, width),
    height: Math.max(1, height)
  }, imageWidth, imageHeight);
}
function setFaceSegOutputEnabled(enabled) {
  const downloadFaceBtn = getEl("faceSegDownloadFace");
  if (downloadFaceBtn) downloadFaceBtn.disabled = !enabled;
  const downloadMaskedBtn = getEl("faceSegDownloadMasked");
  if (downloadMaskedBtn) downloadMaskedBtn.disabled = !enabled;
  const sendToTaskBtn = getEl("faceSegSendToW2");
  if (sendToTaskBtn) sendToTaskBtn.disabled = !enabled;
}
function downloadFaceSegOutput(dataUrl, suffix) {
  if (!dataUrl) return;
  const baseName = (faceSegSourceFile?.name || "portrait").replace(/\.[^.]+$/, ""),
    link = document.createElement("a");
  link.href = dataUrl, link.download = "" + baseName + suffix + ".png", document.body.appendChild(link), link.click(), link.remove();
}
function dataUrlToFile(dataUrl, fileName) {
  const base64Text = atob(dataUrl.split(",")[1]),
    mimeType = dataUrl.split(",")[0].match(/:(.*?);/)[1],
    buffer = new ArrayBuffer(base64Text.length),
    bytes = new Uint8Array(buffer);
  for (let byteIndex = 0; byteIndex < base64Text.length; byteIndex++) bytes[byteIndex] = base64Text.charCodeAt(byteIndex);
  return new File([buffer], fileName, {
    type: mimeType
  });
}
function readFaceSegOptions() {
  const splitDegreeInput = getEl("faceSegSplitDegree"),
    splitSubdivideInput = getEl("faceSegSplitSubdivide"),
    blurEnabledInput = getEl("faceSegBlurEnabled"),
    blurStrengthInput = getEl("faceSegBlurStrength"),
    rawSplitDegree = Number(splitDegreeInput?.value ?? 50),
    splitDegree = Number.isFinite(rawSplitDegree) ? Math.max(0, Math.min(100, rawSplitDegree)) : 50,
    gap = Math.round(2 + splitDegree / 100 * 18),
    rawSubdivide = Number(splitSubdivideInput?.value ?? 0),
    splitSubdivide = Number.isFinite(rawSubdivide) ? Math.max(-4, Math.min(8, Math.round(rawSubdivide))) : 0,
    blurEnabled = !!blurEnabledInput?.checked,
    rawBlurStrength = Number(blurStrengthInput?.value ?? 6),
    blurStrength = Number.isFinite(rawBlurStrength) ? Math.max(0, Math.min(20, rawBlurStrength)) : 6,
    blurPx = blurEnabled ? Number((blurStrength / 2).toFixed(1)) : 0;
  return {
    splitDegree: splitDegree,
    splitSubdivide: splitSubdivide,
    gap: gap,
    blurEnabled: blurEnabled,
    blurStrength: blurStrength,
    blurPx: blurPx
  };
}
function syncFaceSegOptionLabels() {
  const options = readFaceSegOptions(),
    degreeValueEl = getEl("faceSegSplitDegreeValue"),
    subdivideValueEl = getEl("faceSegSplitSubdivideValue"),
    blurValueEl = getEl("faceSegBlurStrengthValue"),
    blurToggleEl = getEl("faceSegBlurEnabled"),
    blurStrengthEl = getEl("faceSegBlurStrength");
  if (degreeValueEl) degreeValueEl.textContent = String(Math.round(options.splitDegree));
  if (subdivideValueEl) {
    const plusSign = options.splitSubdivide > 0 ? "+" : "";
    subdivideValueEl.textContent = "" + plusSign + options.splitSubdivide;
  }
  if (blurValueEl) blurValueEl.textContent = String(Math.round(options.blurStrength));
  if (blurStrengthEl) blurStrengthEl.disabled = !options.blurEnabled;
  if (blurToggleEl) blurToggleEl.setAttribute("aria-checked", options.blurEnabled ? "true" : "false");
}
function bindFaceSegOptionEvents() {
  const degreeInput = getEl("faceSegSplitDegree"),
    subdivideInput = getEl("faceSegSplitSubdivide"),
    blurToggleEl = getEl("faceSegBlurEnabled"),
    blurStrengthEl = getEl("faceSegBlurStrength");
  if (!degreeInput || !subdivideInput || !blurToggleEl || !blurStrengthEl) return;
  const refreshPreview = () => {
    syncFaceSegOptionLabels(), faceSegSourceImage && faceSegRects.length && rebuildFaceSegResult();
  };
  degreeInput.addEventListener("input", refreshPreview), subdivideInput.addEventListener("input", refreshPreview), blurToggleEl.addEventListener("change", refreshPreview), blurStrengthEl.addEventListener("input", refreshPreview), syncFaceSegOptionLabels();
}
function buildSegmentedFaceCanvas(sourceImage, rects, gap = 10, extraSubdivide = 0) {
  const canvas = document.createElement("canvas");
  canvas.width = sourceImage.naturalWidth, canvas.height = sourceImage.naturalHeight;
  const ctx = canvas.getContext("2d");
  let scaleUsed = 1,
    totalCols = 0,
    totalRows = 0;
  rects.forEach(rect => {
    const rectWidth = Math.max(1, Math.round(rect.width)),
      rectHeight = Math.max(1, Math.round(rect.height)),
      area = rectWidth * rectHeight,
      targetCellSize = Math.max(60, Math.min(180, Math.round(Math.sqrt(area / 8)))),
      baseCols = Math.max(2, Math.round(rectWidth / targetCellSize)),
      baseRows = Math.max(2, Math.round(rectHeight / targetCellSize)),
      cols = Math.max(1, Math.min(24, baseCols + extraSubdivide)),
      rows = Math.max(1, Math.min(24, baseRows + extraSubdivide));
    totalCols += cols, totalRows += rows;
    const stepX = Math.max(1, Math.floor(rectWidth / cols)),
      stepY = Math.max(1, Math.floor(rectHeight / rows)),
      maxGapX = cols > 1 ? Math.floor((rectWidth - 1) / (cols - 1)) : 0,
      maxGapY = rows > 1 ? Math.floor((rectHeight - 1) / (rows - 1)) : 0,
      gapX = Math.max(0, Math.min(gap, maxGapX)),
      gapY = Math.max(0, Math.min(gap, maxGapY)),
      compactWidth = Math.max(1, rectWidth - (cols - 1) * gapX),
      compactHeight = Math.max(1, rectHeight - (rows - 1) * gapY),
      scaleX = compactWidth / rectWidth,
      scaleY = compactHeight / rectHeight;
    scaleUsed = Math.min(scaleUsed, scaleX, scaleY);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const sourceX = rect.x + col * stepX,
          sourceY = rect.y + row * stepY,
          remainingWidth = rect.x + rectWidth - sourceX,
          remainingHeight = rect.y + rectHeight - sourceY,
          sourceWidth = col === cols - 1 ? remainingWidth : stepX,
          sourceHeight = row === rows - 1 ? remainingHeight : stepY;
        if (sourceWidth <= 1 || sourceHeight <= 1) continue;
        const localX = sourceX - rect.x,
          localY = sourceY - rect.y,
          destX = rect.x + localX * scaleX + col * gapX,
          destY = rect.y + localY * scaleY + row * gapY,
          destWidth = Math.max(1, sourceWidth * scaleX),
          destHeight = Math.max(1, sourceHeight * scaleY);
        ctx.drawImage(sourceImage, sourceX, sourceY, sourceWidth, sourceHeight, destX, destY, destWidth, destHeight);
      }
    }
  });
  const avgCols = rects.length ? totalCols / rects.length : 0,
    avgRows = rects.length ? totalRows / rects.length : 0;
  return {
    canvas: canvas,
    scaleUsed: scaleUsed,
    avgCols: avgCols,
    avgRows: avgRows
  };
}
function faceSegCanvasPointFromEvent(event) {
  const canvas = getEl("faceSegCanvas");
  if (!canvas || !faceSegSourceImage) return null;
  const canvasRect = canvas.getBoundingClientRect(),
    clientX = event.clientX - canvasRect.left,
    clientY = event.clientY - canvasRect.top,
    canvasX = Math.max(0, Math.min(clientX * canvas.width / (canvasRect.width || canvas.width), canvas.width)),
    canvasY = Math.max(0, Math.min(clientY * canvas.height / (canvasRect.height || canvas.height), canvas.height)),
    imageX = canvasX * faceSegScaleX,
    imageY = canvasY * faceSegScaleY;
  return {
    x: imageX,
    y: imageY
  };
}
function redrawFaceSegCanvas() {
  const canvas = getEl("faceSegCanvas"),
    sourceImage = faceSegSourceImage;
  if (!canvas || !sourceImage) return;
  const ctx = canvas.getContext("2d"),
    canvasWidth = canvas.width,
    canvasHeight = canvas.height;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight), ctx.drawImage(sourceImage, 0, 0, canvasWidth, canvasHeight);
  const drawRect = (rect, isDraft = false) => {
    const drawX = Math.round(rect.x / faceSegScaleX),
      drawY = Math.round(rect.y / faceSegScaleY),
      drawWidth = Math.max(1, Math.round(rect.width / faceSegScaleX)),
      drawHeight = Math.max(1, Math.round(rect.height / faceSegScaleY));
    ctx.save(), isDraft ? (ctx.strokeStyle = "#fde047", ctx.lineWidth = 2, ctx.setLineDash([6, 4]), ctx.fillStyle = "rgba(250, 204, 21, 0.16)") : (ctx.strokeStyle = "#60a5fa", ctx.lineWidth = 2, ctx.setLineDash([]), ctx.fillStyle = "rgba(37, 99, 235, 0.18)"), ctx.fillRect(drawX, drawY, drawWidth, drawHeight), ctx.strokeRect(drawX, drawY, drawWidth, drawHeight), ctx.restore();
  };
  faceSegRects.forEach(rect => drawRect(rect, false));
  if (faceSegDraftRect) drawRect(faceSegDraftRect, true);
}
function rebuildFaceSegResult() {
  if (!faceSegSourceImage) return false;
  if (!faceSegRects.length) return resetFaceSegResult(), setFaceSegStatus("请在原图上拖拽圈选区域，可多区域"), false;
  const sourceImage = faceSegSourceImage,
    clampedRects = faceSegRects.map(rect => clampFaceRect(rect, sourceImage.naturalWidth, sourceImage.naturalHeight)),
    maskCanvas = document.createElement("canvas");
  maskCanvas.width = sourceImage.naturalWidth, maskCanvas.height = sourceImage.naturalHeight;
  const maskCtx = maskCanvas.getContext("2d");
  maskCtx.drawImage(sourceImage, 0, 0), maskCtx.fillStyle = "#000000", clampedRects.forEach(rect => {
    maskCtx.fillRect(rect.x, rect.y, rect.width, rect.height);
  });
  const options = readFaceSegOptions(),
    segmentedResult = buildSegmentedFaceCanvas(sourceImage, clampedRects, options.gap, options.splitSubdivide),
    outputCanvas = segmentedResult.canvas;
  if (options.blurEnabled && options.blurPx > 0) {
    const blurCanvas = document.createElement("canvas");
    blurCanvas.width = outputCanvas.width, blurCanvas.height = outputCanvas.height;
    const blurCtx = blurCanvas.getContext("2d");
    blurCtx.filter = "blur(" + options.blurPx + "px)", blurCtx.drawImage(outputCanvas, 0, 0), blurCtx.filter = "none", outputCanvas.width = outputCanvas.width;
    const outputCtx = outputCanvas.getContext("2d");
    outputCtx.drawImage(blurCanvas, 0, 0);
  }
  faceSegFaceDataUrl = outputCanvas.toDataURL("image/png"), faceSegMaskDataUrl = maskCanvas.toDataURL("image/png");
  const facePreviewEl = getEl("faceSegFacePreview"),
    maskPreviewEl = getEl("faceSegMaskedPreview");
  if (facePreviewEl) facePreviewEl.src = faceSegFaceDataUrl;
  if (maskPreviewEl) maskPreviewEl.src = faceSegMaskDataUrl;
  setFaceSegOutputEnabled(true);
  const scaleText = segmentedResult.scaleUsed > 0 && segmentedResult.scaleUsed < 1 ? "（分离缩放 " + (segmentedResult.scaleUsed * 100).toFixed(0) + "%）" : "",
    cutCols = Math.max(0, Math.round(segmentedResult.avgCols) - 1),
    cutRows = Math.max(0, Math.round(segmentedResult.avgRows) - 1),
    subdivideSign = options.splitSubdivide > 0 ? "+" : "",
    blurText = options.blurEnabled ? "，隔块模糊 " + Math.round(options.blurStrength) : "";
  return setFaceSegStatus("已圈选 " + clampedRects.length + " 个区域，切割程度 " + Math.round(options.splitDegree) + "，切割细分 " + subdivideSign + options.splitSubdivide + "（横切约 " + cutCols + "，竖切约 " + cutRows + "）" + blurText + "，脸部图已执行原位切割（不重排）" + scaleText), true;
}
function layoutFaceSegCanvas() {
  const canvas = getEl("faceSegCanvas"),
    sourceImage = faceSegSourceImage;
  if (!canvas || !sourceImage) return;
  const maxCanvasWidth = 248,
    scale = Math.min(1, maxCanvasWidth / sourceImage.naturalWidth),
    canvasWidth = Math.max(1, Math.round(sourceImage.naturalWidth * scale)),
    canvasHeight = Math.max(1, Math.round(sourceImage.naturalHeight * scale));
  canvas.width = canvasWidth, canvas.height = canvasHeight, canvas.style.width = canvasWidth + "px", canvas.style.height = canvasHeight + "px", faceSegScaleX = sourceImage.naturalWidth / canvasWidth, faceSegScaleY = sourceImage.naturalHeight / canvasHeight, redrawFaceSegCanvas();
}
function bindFaceSegCanvasDrag() {
  const canvas = getEl("faceSegCanvas");
  if (!canvas || canvas.dataset.bound === "1") return;
  canvas.dataset.bound = "1", canvas.addEventListener("mousedown", mouseEvent => {
    if (!faceSegSourceImage) return;
    const startPoint = faceSegCanvasPointFromEvent(mouseEvent);
    if (!startPoint) return;
    faceSegDragging = true, faceSegDragStartX = startPoint.x, faceSegDragStartY = startPoint.y, faceSegDraftRect = rectFromDragPoints(faceSegDragStartX, faceSegDragStartY, startPoint.x, startPoint.y, faceSegSourceImage.naturalWidth, faceSegSourceImage.naturalHeight), redrawFaceSegCanvas();
  }), canvas.addEventListener("mousemove", mouseEvent => {
    if (!faceSegDragging || !faceSegSourceImage) return;
    const point = faceSegCanvasPointFromEvent(mouseEvent);
    if (!point || !faceSegDraftRect) return;
    faceSegDraftRect = rectFromDragPoints(faceSegDragStartX, faceSegDragStartY, point.x, point.y, faceSegSourceImage.naturalWidth, faceSegSourceImage.naturalHeight), redrawFaceSegCanvas();
  });
  const finishDrag = mouseEvent => {
    if (!faceSegDragging || !faceSegSourceImage || !faceSegDraftRect) return;
    const endPoint = faceSegCanvasPointFromEvent(mouseEvent),
      finalRect = endPoint ? rectFromDragPoints(faceSegDragStartX, faceSegDragStartY, endPoint.x, endPoint.y, faceSegSourceImage.naturalWidth, faceSegSourceImage.naturalHeight) : faceSegDraftRect;
    faceSegDragging = false, faceSegDraftRect = null, finalRect.width >= 6 && finalRect.height >= 6 && faceSegRects.push(finalRect), redrawFaceSegCanvas(), rebuildFaceSegResult();
  };
  canvas.addEventListener("mouseup", finishDrag), canvas.addEventListener("mouseleave", finishDrag);
}
function resetFaceSegResult() {
  faceSegFaceDataUrl = "", faceSegMaskDataUrl = "";
  const facePreviewEl = getEl("faceSegFacePreview"),
    maskPreviewEl = getEl("faceSegMaskedPreview");
  if (facePreviewEl) facePreviewEl.removeAttribute("src");
  if (maskPreviewEl) maskPreviewEl.removeAttribute("src");
  setFaceSegOutputEnabled(false);
}
async function loadFaceSegImage(file) {
  faceSegSourceFile = file || null, faceSegSourceImage = null, faceSegRects = [], faceSegDraftRect = null, faceSegDragging = false, faceSegDragStartX = 0, faceSegDragStartY = 0, resetFaceSegResult();
  if (!file) {
    setFaceSegStatus("待上传人像图");
    return;
  }
  setFaceSegStatus("正在读取图片...");
  const dataUrl = await readFileAsDataUrl(file),
    image = await loadImageFromDataUrl(dataUrl);
  faceSegSourceImage = image;
  const adjustPanel = getEl("faceSegAdjust");
  if (adjustPanel) adjustPanel.style.display = "block";
  layoutFaceSegCanvas(), bindFaceSegCanvasDrag(), setFaceSegStatus("请在原图上拖拽圈选区域，可多区域");
}
async function serializeFileAsDataUrl(file) {
  if (!file) return null;
  return {
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    dataUrl: await readFileAsDataUrl(file)
  };
}
async function validateTaskPayload(payloadInput, options = {}) {
  const payload = payloadInput || readTaskPayloadForm(),
    shouldAlert = options.showAlert !== false,
    settings = options.settings || readTaskSettingsForm(),
    maxImages = maxImageCountForSettings(settings.refMode, settings.model),
    maxReferenceMaterials = maxReferenceMaterialCountForSettings(settings.model),
    normalizedPrompt = normalizePromptText(payload.promptText),
    promptCharCount = countPromptChars(normalizedPrompt);
  if (promptCharCount > maxPromptChars) {
    const errorText = "提示词总字数 " + promptCharCount + " 超过 " + maxPromptChars + "，请精简后再提交到项目队列";
    appendLog("❌ " + errorText);
    shouldAlert && typeof window.alert === "function" && window.alert(errorText);
    throw new Error(errorText);
  }
  if (payload.imageFiles.length > maxImages) throw new Error("图片最多支持 " + maxImages + " 张");
  if (maxReferenceMaterials !== null && referenceMaterialCount(payload) > maxReferenceMaterials) throw new Error("参考素材最多支持 " + maxReferenceMaterials + " 个");
  let videoDuration = 0;
  for (const videoFile of payload.videoFiles) {
    if (videoFile.type !== "video/mp4" && !videoFile.name.toLowerCase().endsWith(".mp4")) throw new Error("视频 " + videoFile.name + " 不是 MP4 格式");
    const videoInfo = await readMediaDuration(videoFile);
    if (videoInfo.width && videoInfo.height && !isAllowedVideoSize(videoInfo.width, videoInfo.height)) throw new Error("视频 " + videoFile.name + " 分辨率 " + videoInfo.width + "x" + videoInfo.height + "，需要 " + allowedVideoSizeText() + "（建议24帧）");
    videoDuration += videoInfo.duration;
  }
  if (videoDuration > maxVideoSeconds) throw new Error("视频总时长 " + videoDuration.toFixed(1) + "s 超过 " + maxVideoSeconds + "s");
  let audioDuration = 0;
  for (const audioFile of payload.audioFiles) {
    const audioInfo = await readMediaDuration(audioFile);
    audioDuration += audioInfo.duration;
  }
  if (audioDuration > maxAudioSeconds) throw new Error("音频总时长 " + audioDuration.toFixed(1) + "s 超过 " + maxAudioSeconds + "s");
  return {
    ok: true,
    videoDuration: videoDuration,
    audioDuration: audioDuration,
    promptTextForSubmit: normalizedPrompt,
    promptCharCount: promptCharCount
  };
}
async function buildSerializablePayload(payloadInput, options = {}) {
  const payload = payloadInput || readTaskPayloadForm(),
    validation = await validateTaskPayload(payload, options),
    imageRecords = await Promise.all(payload.imageFiles.map(imageFile => serializeFileAsDataUrl(imageFile))),
    videoRecords = await Promise.all(payload.videoFiles.map(videoFile => serializeFileAsDataUrl(videoFile))),
    audioRecords = await Promise.all(payload.audioFiles.map(audioFile => serializeFileAsDataUrl(audioFile)));
  return {
    promptText: validation.promptTextForSubmit,
    images: imageRecords.filter(Boolean),
    videos: videoRecords.filter(Boolean),
    audios: audioRecords.filter(Boolean)
  };
}
async function buildCurrentSerializablePayload() {
  return buildSerializablePayload(readTaskPayloadForm(), {
    showAlert: true
  });
}
function payloadHasInlineDataUrls(payload) {
  const images = Array.isArray(payload?.images) ? payload.images : [],
    videos = Array.isArray(payload?.videos) ? payload.videos : [],
    audios = Array.isArray(payload?.audios) ? payload.audios : [];
  return images.some(imageRecord => imageRecord?.dataUrl) || videos.some(videoRecord => videoRecord?.dataUrl) || audios.some(audioRecord => audioRecord?.dataUrl);
}
async function storedDataUrlToFileRecord(storedRecord, fallbackKind) {
  if (!storedRecord?.dataUrl) return null;
  const blob = await fetch(storedRecord.dataUrl).then(response => response.blob());
  return {
    name: storedRecord.name || fallbackKind + "-" + Date.now(),
    type: storedRecord.type || blob.type || "application/octet-stream",
    lastModified: storedRecord.lastModified || Date.now(),
    blob: blob
  };
}
async function loadExecutableTaskPayload(task) {
  if (!task) throw new Error("任务不存在");
  const snapshotPayload = task.payload,
    hasInlineDataUrls = Array.isArray(snapshotPayload?.images) && snapshotPayload.images.some(imageRecord => imageRecord?.dataUrl) || Array.isArray(snapshotPayload?.videos) && snapshotPayload.videos.some(videoRecord => videoRecord?.dataUrl) || Array.isArray(snapshotPayload?.audios) && snapshotPayload.audios.some(audioRecord => audioRecord?.dataUrl);
  if (hasInlineDataUrls) return snapshotPayload;
  const storedPayload = await getTaskPayloadRecord(task.id),
    restoredPayload = await restorePayloadFiles(storedPayload);
  if (!restoredPayload) throw new Error("任务 #" + task.id + " 的素材缓存不存在，请重新编辑并保存该任务");
  return buildSerializablePayload(restoredPayload, {
    showAlert: false,
    settings: task.settings || {}
  });
}
let atDropdownInsertStart = -1;
const firstLastFrameHintText = "首尾帧不用@，添加图片即可，首帧第1张、尾帧第2张";
let firstLastFrameHintTimer = null;
function isForbiddenFirstLastFrameImageRef(tagText) {
  const atLabel = String(tagText || "").replace(/^[@＠]/, "").trim();
  if (!atLabel) return false;
  const atItem = jqBuildAtItems().find(item => item.label === atLabel || item.tag === "@" + atLabel);
  if (!atItem || atItem.kind !== "img") return false;
  return isFirstLastFrameMode(getEl("refMode")?.value || "");
}
function showFirstLastFrameHint() {
  appendLog("⚠️ " + firstLastFrameHintText);
  const inlineHintEl = getEl("promptInlineHint");
  inlineHintEl && (inlineHintEl.textContent = firstLastFrameHintText, inlineHintEl.style.display = "block", firstLastFrameHintTimer && (clearTimeout(firstLastFrameHintTimer), firstLastFrameHintTimer = null), firstLastFrameHintTimer = setTimeout(() => {
    inlineHintEl.style.display = "none", inlineHintEl.textContent = "", firstLastFrameHintTimer = null;
  }, 4500));
  const uploadErrorEl = getEl("uploadError");
  uploadErrorEl && (uploadErrorEl.textContent = firstLastFrameHintText, uploadErrorEl.style.display = "block");
}
function jqBuildAtItems() {
  const payload = readTaskPayloadForm(),
    items = [],
    usedLabels = new Set(),
    uniqueLabelForFile = (fileName, fallbackLabel) => {
      const baseLabel = stripFileExtension(fileName).replace(/[@＠;；]/g, "").replace(/\s+/g, "").trim();
      let label = baseLabel || fallbackLabel,
        suffix = 2;
      while (usedLabels.has(label.toLowerCase())) {
        label = (baseLabel || fallbackLabel) + "_" + suffix, suffix += 1;
      }
      return usedLabels.add(label.toLowerCase()), label;
    };
  const uploadedBaseNames = new Set(),
    iconForKind = kind => kind === "vid" ? "视" : kind === "aud" ? "音" : "图";
  payload.imageFiles.forEach((imageFile, imageIndex) => {
    const imageLabel = uniqueLabelForFile(imageFile.name, "图片" + (imageIndex + 1));
    uploadedBaseNames.add(stripFileExtension(imageFile.name).toLowerCase());
    items.push({
      tag: "@" + imageLabel,
      label: imageLabel,
      fileName: imageFile.name,
      kind: "img",
      icon: "图",
      source: "upload",
      thumbUrl: objectUrlForFile(imageFile)
    });
  }), payload.videoFiles.forEach((videoFile, videoIndex) => {
    const videoLabel = uniqueLabelForFile(videoFile.name, "视频" + (videoIndex + 1));
    uploadedBaseNames.add(stripFileExtension(videoFile.name).toLowerCase());
    items.push({
      tag: "@" + videoLabel,
      label: videoLabel,
      fileName: videoFile.name,
      kind: "vid",
      icon: "视",
      source: "upload"
    });
  }), payload.audioFiles.forEach((audioFile, audioIndex) => {
    const audioLabel = uniqueLabelForFile(audioFile.name, "音频" + (audioIndex + 1));
    uploadedBaseNames.add(stripFileExtension(audioFile.name).toLowerCase());
    items.push({
      tag: "@" + audioLabel,
      label: audioLabel,
      fileName: audioFile.name,
      kind: "aud",
      icon: "音",
      source: "upload"
    });
  });
  // 当前项目素材库：同名（按文件名去扩展名）已上传的则隐藏，下方上传素材优先
  const activeProject = jqProjectById(jqActiveProjectId),
    projectMaterials = activeProject && Array.isArray(activeProject.materials) ? activeProject.materials : [];
  projectMaterials.forEach(material => {
    const baseName = stripFileExtension(material.name).toLowerCase();
    if (uploadedBaseNames.has(baseName)) return;
    const materialLabel = uniqueLabelForFile(material.name, jqMaterialKindLabel(material.kind));
    items.push({
      tag: "@" + materialLabel,
      label: materialLabel,
      fileName: material.name,
      kind: material.kind,
      icon: iconForKind(material.kind),
      source: "project",
      matId: material.matId
    });
  });
  return items;
}
function renderMediaChips() {
  const chipsEl = getEl("mediaChips");
  if (!chipsEl) return;
  // 图二只显示已加载到上传区的素材（含被引用后实体化的项目素材）；未引用的项目素材只在 @ 下拉里出现
  const atItems = jqBuildAtItems().filter(item => item.source !== "project");
  chipsEl.innerHTML = atItems.map(item => "<span class=\"media-chip " + item.kind + "\" data-tag=\"" + item.tag + "\" title=\"" + item.fileName + "\">" + item.tag + "</span>").join(""), chipsEl.querySelectorAll(".media-chip").forEach(chipEl => {
    chipEl.addEventListener("click", () => insertAtTagIntoPrompt(chipEl.dataset.tag));
  });
}
function hideAtDropdown() {
  const dropdownEl = getEl("atDropdown");
  if (!dropdownEl) return;
  dropdownEl.style.display = "none", atDropdownInsertStart = -1;
}
function jqMaterialRefKey(text) {
  return String(text || "").replace(/[@＠;；]/g, "").replace(/\s+/g, "").trim().toLowerCase();
}
function jqRemoveUploadedFile(file) {
  for (const arr of [jqImageFiles, jqVideoFiles, jqAudioFiles]) {
    const index = arr.indexOf(file);
    if (index >= 0) return arr.splice(index, 1), true;
  }
  return false;
}
// 按提示词里的 @引用同步项目素材到上传区：被引用→加载一份（同一素材多次引用只一份）；
// 取消引用→撤下（仅限自动加载的，手动上传永不动）。同名手动上传优先，不再实体化项目素材。
let jqSyncMaterialsBusy = false,
  jqSyncMaterialsAgain = false;
async function jqSyncReferencedProjectMaterials() {
  if (jqSyncMaterialsBusy) {
    jqSyncMaterialsAgain = true;
    return;
  }
  jqSyncMaterialsBusy = true;
  try {
    const project = jqProjectById(jqActiveProjectId),
      materials = project && Array.isArray(project.materials) ? project.materials : [],
      refs = new Set(extractPromptAtRefs(getEl("promptText")?.value || "").map(jqMaterialRefKey));
    let changed = false;
    // 撤下：之前自动加载、现在不再被引用的项目素材
    for (const [matId, file] of Array.from(jqAutoMaterialFiles.entries())) {
      const material = materials.find(entry => entry.matId === matId),
        stillReferenced = material && refs.has(jqMaterialRefKey(stripFileExtension(material.name)));
      if (!stillReferenced) jqRemoveUploadedFile(file), jqAutoMaterialFiles.delete(matId), changed = true;
    }
    // 加载：被引用、且上传区还没有的项目素材（同名手动上传优先）
    const uploadedBaseNames = new Set([...jqImageFiles, ...jqVideoFiles, ...jqAudioFiles].map(uploadedFile => stripFileExtension(uploadedFile.name).toLowerCase()));
    for (const material of materials) {
      if (jqAutoMaterialFiles.has(material.matId)) continue;
      if (!refs.has(jqMaterialRefKey(stripFileExtension(material.name)))) continue;
      const baseName = stripFileExtension(material.name).toLowerCase();
      if (uploadedBaseNames.has(baseName)) continue;
      const file = await jqMaterializeProjectMaterial(material);
      if (!file) {
        appendLog("⚠️ 无法读取项目素材：" + material.name);
        continue;
      }
      const targetArr = material.kind === "vid" ? jqVideoFiles : material.kind === "aud" ? jqAudioFiles : jqImageFiles;
      if (material.kind === "vid") addVideoFiles([file]);else if (material.kind === "aud") addAudioFiles([file]);else addImageFiles([file]);
      if (targetArr.includes(file)) jqAutoMaterialFiles.set(material.matId, file), uploadedBaseNames.add(baseName), changed = true;
    }
    if (changed) await refreshUploadSummary();
  } finally {
    jqSyncMaterialsBusy = false;
    if (jqSyncMaterialsAgain) jqSyncMaterialsAgain = false, jqSyncReferencedProjectMaterials();
  }
}
function insertAtTagIntoPrompt(tag) {
  const promptEl = getEl("promptText");
  if (!promptEl || !tag) return;
  if (isForbiddenFirstLastFrameImageRef(tag)) {
    showFirstLastFrameHint(), hideAtDropdown();
    return;
  }
  const cursor = promptEl.selectionStart,
    value = promptEl.value,
    insertStart = atDropdownInsertStart >= 0 ? atDropdownInsertStart : cursor;
  promptEl.value = "" + value.slice(0, insertStart) + tag + value.slice(cursor);
  const inlineHintEl = getEl("promptInlineHint");
  inlineHintEl && inlineHintEl.style.display !== "none" && (inlineHintEl.style.display = "none", inlineHintEl.textContent = "");
  const nextCursor = insertStart + tag.length;
  promptEl.setSelectionRange(nextCursor, nextCursor), promptEl.focus(), hideAtDropdown();
  // 直接改 value 不会触发 input 事件，手动同步一次（点下拉/chip 引用）
  jqSyncReferencedProjectMaterials().catch(error => appendLog("⚠️ 引用项目素材失败: " + (error.message || error)));
}
function showAtDropdown(query) {
  const dropdownEl = getEl("atDropdown");
  if (!dropdownEl) return;
  const normalizedQuery = String(query || "").toLowerCase(),
    matchingItems = jqBuildAtItems().filter(item => {
      return !normalizedQuery || item.label.toLowerCase().includes(normalizedQuery) || item.fileName.toLowerCase().includes(normalizedQuery);
    });
  if (!matchingItems.length) {
    hideAtDropdown();
    return;
  }
  dropdownEl.innerHTML = matchingItems.map((item, itemIndex) => "<div class=\"at-dropdown-item" + (itemIndex === 0 ? " active" : "") + "\" data-tag=\"" + jqEscapeHtml(item.tag) + "\"><span>" + jqEscapeHtml(item.icon) + "</span><span>" + jqEscapeHtml(item.label) + "</span><small>" + jqEscapeHtml(item.fileName) + "</small></div>").join(""), dropdownEl.querySelectorAll(".at-dropdown-item").forEach(optionEl => {
    optionEl.addEventListener("mousedown", mouseEvent => {
      mouseEvent.preventDefault(), insertAtTagIntoPrompt(optionEl.dataset.tag);
    });
  }), dropdownEl.style.display = "block";
}
function bindAtMentionPromptInput() {
  const promptEl = getEl("promptText");
  if (!promptEl) return;
  promptEl.addEventListener("keydown", keyEvent => {
    const dropdownEl = getEl("atDropdown");
    if (!dropdownEl || dropdownEl.style.display === "none") return;
    const optionEls = Array.from(dropdownEl.querySelectorAll(".at-dropdown-item"));
    if (!optionEls.length) return;
    if (keyEvent.key === "Escape") {
      keyEvent.preventDefault(), hideAtDropdown();
      return;
    }
    if (keyEvent.key === "Enter" || keyEvent.key === "Tab") {
      const activeOptionEl = dropdownEl.querySelector(".at-dropdown-item.active");
      activeOptionEl && (keyEvent.preventDefault(), insertAtTagIntoPrompt(activeOptionEl.dataset.tag));
      return;
    }
    if (keyEvent.key === "ArrowDown" || keyEvent.key === "ArrowUp") {
      keyEvent.preventDefault();
      const activeIndex = optionEls.findIndex(optionEl => optionEl.classList.contains("active"));
      if (activeIndex >= 0) optionEls[activeIndex].classList.remove("active");
      const nextIndex = keyEvent.key === "ArrowDown" ? (activeIndex + 1 + optionEls.length) % optionEls.length : (activeIndex - 1 + optionEls.length) % optionEls.length;
      optionEls[nextIndex].classList.add("active"), optionEls[nextIndex].scrollIntoView({
        block: "nearest"
      });
    }
  }), promptEl.addEventListener("input", () => {
    const cursor = promptEl.selectionStart,
      value = promptEl.value,
      beforeCursor = value.slice(0, cursor),
      atIndex = beforeCursor.lastIndexOf("@");
    if (atIndex === -1) {
      hideAtDropdown();
      return;
    }
    const query = beforeCursor.slice(atIndex + 1);
    if (/\s/.test(query)) {
      hideAtDropdown();
      return;
    }
    atDropdownInsertStart = atIndex, showAtDropdown(query);
  }), promptEl.addEventListener("input", () => {
    // 手动打字引用 / 删除引用 → 防抖同步项目素材到上传区
    jqProjectMaterialSyncTimer && clearTimeout(jqProjectMaterialSyncTimer), jqProjectMaterialSyncTimer = setTimeout(() => {
      jqProjectMaterialSyncTimer = null, jqSyncReferencedProjectMaterials().catch(() => {});
    }, 350);
  }), promptEl.addEventListener("blur", () => {
    setTimeout(hideAtDropdown, 150);
  });
}
async function findJimengTab() {
  const tabs = await chrome.tabs.query({
      url: ["https://jimeng.jianying.com/*", "https://*.jimeng.jianying.com/*"]
    }),
    generateTab = tabs.find(tab => {
      return isJimengGenerateUrl(tab?.url);
    }),
    anyJimengTab = tabs.find(tab => /jimeng\.jianying\.com/i.test(tab?.url || "")),
    jimengTab = generateTab || anyJimengTab;
  if (!jimengTab?.id) throw new Error("未找到即梦网页标签页，请先打开即梦生成页");
  try {
    await chrome.runtime.sendMessage({
      type: "W4_BG_SET_TARGET_TAB",
      tabId: jimengTab.id
    });
  } catch {}
  return jimengTab;
}
async function getJimengTab() {
  if (Number.isFinite(cachedJimengTabId)) try {
    const cachedTab = await chrome.tabs.get(cachedJimengTabId);
    if (cachedTab?.id) return cachedTab;
  } catch {
    cachedJimengTabId = null;
  }
  const jimengTab = await findJimengTab();
  return cachedJimengTabId = jimengTab.id, jimengTab;
}
function clearCachedJimengTab() {
  cachedJimengTabId = null;
}
// 注入失败现场诊断：拿到 undefined 结果或抛错时，记录标签是否被浏览器睡眠(discarded)、
// 加载状态、URL，并补探页面就绪情况（readyState/隐藏/是否有弹窗/提交按钮在不在）。
async function jqDiagInjectFailure(tabId, label) {
  try {
    const t = await chrome.tabs.get(tabId);
    let probe = null;
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tabId }, world: "MAIN",
        func: () => ({ rs: document.readyState, hidden: document.hidden, wasDiscarded: !!document.wasDiscarded, hasSubmit: !!document.querySelector("button[class*='submit-button']"), modal: !!document.querySelector(".lv-modal, [role='dialog'], .lv-message, .lv-notification") })
      });
      probe = out && out[0] ? out[0].result : null;
    } catch (e) { probe = "probe失败:" + (e && e.message || e); }
    appendLog("🔍[诊断] " + label + " discarded=" + t.discarded + " status=" + t.status + " url=" + String(t.url || "").slice(0, 45) + " | probe=" + JSON.stringify(probe));
  } catch (e) {
    appendLog("🔍[诊断] " + label + " 取标签信息失败: " + (e && e.message || e));
  }
}
async function runInJimengPage(tabId, pageFunction, args = []) {
  let out;
  try {
    out = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "MAIN",
      func: pageFunction,
      args: args
    });
  } catch (e) {
    // 注入抛错（常见：标签被浏览器丢弃 / 页面导航中 / 帧被移除）
    try { await jqDiagInjectFailure(tabId, "注入抛错: " + (e && e.message || e)); } catch {}
    throw e;
  }
  const result = out && out[0] ? out[0].result : undefined;
  if (result === undefined) {
    // executeScript 返回空 = empty-response 的根源，记录现场
    try { await jqDiagInjectFailure(tabId, "注入返回 undefined"); } catch {}
  }
  return result;
}
function compactText(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}
function isJimengGenerateUrl(url) {
  try {
    const parsedUrl = new URL(String(url || "")),
      isJimengHost = /(^|\.)jimeng\.jianying\.com$/i.test(parsedUrl.hostname),
      isGeneratePath = parsedUrl.pathname === "/ai-tool/generate";
    return isJimengHost && isGeneratePath;
  } catch {
    return false;
  }
}
async function closePagePopovers(tabId) {
  return runInJimengPage(tabId, () => {
    return document.body?.dispatchEvent(new MouseEvent("click", {
      bubbles: true
    })), document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true
    })), document.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Escape",
      code: "Escape",
      bubbles: true
    })), {
      ok: true
    };
  });
}
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function retryPageStep(tabId, stepName, settings, maxAttempts = 3, payload = null) {
  let lastResult = {
    ok: false,
    error: "unknown"
  };
  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
    await closePagePopovers(tabId), await sleep(120 + attemptIndex * 80);
    const result = await runPageStep(tabId, stepName, settings, payload);
    if (result?.ok) return result;
    lastResult = result || {
      ok: false,
      error: "empty-response"
    }, await sleep(260 + attemptIndex * 180);
  }
  return lastResult;
}
async function selectGenerationModeOnPage(tabId, targetMode) {
  return runInJimengPage(tabId, async pageTargetMode => {
    const compact = text => String(text || "").replace(/\s+/g, "").trim(),
      targetKey = compact(pageTargetMode || "视频生成"),
      wantsVideoMode = /视频/.test(targetKey),
      visibleOptions = () => {
        return Array.from(document.querySelectorAll(".lv-select-option, li[role=\"option\"], [role=\"option\"]")).filter(optionEl => {
          const rect = optionEl.getBoundingClientRect(),
            style = window.getComputedStyle(optionEl);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        });
      },
      isVisible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect(),
          style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      },
      selectCandidates = () => {
        return Array.from(document.querySelectorAll("div[role=\"combobox\"], .lv-select, .arco-select-view, [class*=\"select-view\"]")).filter(selectEl => isVisible(selectEl));
      },
      closePopovers = () => {
        document.body?.dispatchEvent(new MouseEvent("click", {
          bubbles: true
        })), document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true
        })), document.dispatchEvent(new KeyboardEvent("keyup", {
          key: "Escape",
          code: "Escape",
          bubbles: true
        }));
      },
      openSelect = async selectEl => {
        const arrowEl = selectEl.querySelector?.(".lv-select-suffix, .lv-select-arrow-icon") || selectEl;
        arrowEl.click?.(), selectEl.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          composed: true
        })), selectEl.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          composed: true
        })), selectEl.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true
        })), await new Promise(resolve => setTimeout(resolve, 180));
      },
      matchesMode = text => {
        const key = compact(text);
        if (!key) return false;
        if (key === targetKey || key.includes(targetKey) || targetKey.includes(key)) return true;
        if (wantsVideoMode && /视频|文生视频|图生视频/.test(key) && !/图片|文生图|图像/.test(key)) return true;
        return false;
      },
      findModeSelect = async () => {
        const selects = selectCandidates();
        for (const selectEl of selects) {
          closePopovers(), await new Promise(resolve => setTimeout(resolve, 60)), await openSelect(selectEl);
          const options = visibleOptions(),
            targetOption = options.find(optionEl => matchesMode(optionEl.innerText || optionEl.textContent || ""));
          if (targetOption) return {
            select: selectEl,
            target: targetOption
          };
        }
        return closePopovers(), null;
      },
      selection = await findModeSelect();
    if (!selection) {
      const selectCount = selectCandidates().length;
      return {
        ok: false,
        error: "未找到创作模式（目标=" + pageTargetMode + "，下拉候选=" + selectCount + "）"
      };
    }
    return selection.target.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      composed: true
    })), selection.target.click(), await new Promise(resolve => setTimeout(resolve, 160)), {
      ok: true
    };
  }, [targetMode]);
}
async function selectModelOnPage(tabId, targetModel) {
  return runInJimengPage(tabId, async pageTargetModel => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
      visibleOptions = () => {
        return Array.from(document.querySelectorAll(".lv-select-option, li[role=\"option\"], [role=\"option\"]")).filter(optionEl => {
          const rect = optionEl.getBoundingClientRect(),
            style = window.getComputedStyle(optionEl);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        });
      },
      normalizeModelText = text => String(text || "").toLowerCase().replace(/[：:]/g, ".").replace(/[·•]/g, ".").replace(/[_-]/g, ".").replace(/\s+/g, " ").trim(),
      parseModel = text => {
        const normalized = normalizeModelText(text),
          compactText = normalized.replace(/\s+/g, ""),
          versionMatch = normalized.match(/\b([0-9]+)\s*\.\s*([0-9]+)\b/),
          seedanceMatch = compactText.match(/seedance(\d{2})/);
        let version = "";
        if (versionMatch) version = versionMatch[1] + "." + versionMatch[2];else seedanceMatch && (version = seedanceMatch[1][0] + "." + seedanceMatch[1][1]);
        // 变体只取「seedanceX.Y 后紧跟的那个词」，避免选项描述文字（如 mini 的"Fast一半的价格"）污染判定
        const variantMatch = compactText.match(/seedance\d[.]\d(fastvip|mini|fast|vip|pro)/),
          variant = variantMatch ? variantMatch[1] : "";
        return {
          raw: compactText,
          version: version,
          isFast: variant === "fast" || variant === "fastvip",
          isPro: variant === "pro",
          isVip: variant === "vip" || variant === "fastvip",
          isMini: variant === "mini"
        };
      },
      openSelect = async selectEl => {
        const arrowEl = selectEl.querySelector?.(".lv-select-suffix, .lv-select-arrow-icon") || selectEl;
        arrowEl.click?.(), selectEl.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          composed: true
        })), selectEl.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          composed: true
        })), selectEl.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true
        })), await wait(180);
      },
      closePopovers = () => {
        document.body?.dispatchEvent(new MouseEvent("click", {
          bubbles: true
        })), document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true
        })), document.dispatchEvent(new KeyboardEvent("keyup", {
          key: "Escape",
          code: "Escape",
          bubbles: true
        }));
      },
      findModelSelect = async () => {
        const selects = Array.from(document.querySelectorAll("div[role=\"combobox\"], .lv-select, .arco-select-view, [class*=\"select-view\"]"));
        if (!selects.length) return null;
        const directModelSelect = selects.find(selectEl => /seedance/i.test(selectEl.textContent || ""));
        if (directModelSelect) return directModelSelect;
        for (const selectEl of selects) {
          closePopovers(), await wait(100), await openSelect(selectEl);
          const options = visibleOptions(),
            hasSeedanceOption = options.some(optionEl => /seedance/i.test(optionEl.textContent || ""));
          closePopovers(), await wait(80);
          if (hasSeedanceOption) return selectEl;
        }
        return null;
      },
      targetParsed = parseModel(pageTargetModel || "Seedance 2.0");
    if (!targetParsed.version) return {
      ok: false,
      error: "模型目标无法解析: " + pageTargetModel
    };
    const modelSelect = await findModelSelect();
    if (!modelSelect) return {
      ok: false,
      error: "未找到模型选择框"
    };
    closePopovers(), await wait(100), await openSelect(modelSelect);
    const options = visibleOptions(),
      targetOption = options.find(optionEl => {
        const parsedOption = parseModel(optionEl.textContent || "");
        if (!parsedOption.version) return false;
        return parsedOption.version === targetParsed.version && parsedOption.isFast === targetParsed.isFast && parsedOption.isPro === targetParsed.isPro && parsedOption.isVip === targetParsed.isVip && parsedOption.isMini === targetParsed.isMini;
      });
    if (!targetOption) {
      const candidateText = options.map(optionEl => normalizeModelText(optionEl.textContent || "")).join(", ");
      return {
        ok: false,
        error: "未找到模型: " + pageTargetModel + "，候选=" + candidateText
      };
    }
    targetOption.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      composed: true
    })), targetOption.click(), await wait(260);
    const valueEl = modelSelect.querySelector?.(".lv-select-view-value, .arco-select-view-value, [class*=\"view-value\"], [class*=\"value\"]") || modelSelect,
      currentParsed = parseModel(valueEl.textContent || ""),
      isApplied = currentParsed.version === targetParsed.version && currentParsed.isFast === targetParsed.isFast && currentParsed.isPro === targetParsed.isPro && currentParsed.isVip === targetParsed.isVip;
    if (!isApplied) return {
      ok: false,
      error: "模型回读未生效，目标=" + pageTargetModel + " 当前=" + (valueEl.textContent || "").trim()
    };
    return {
      ok: true
    };
  }, [targetModel]);
}
async function selectReferenceModeOnPage(tabId, targetRefMode) {
  return runInJimengPage(tabId, async pageTargetRefMode => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
      compact = text => String(text || "").replace(/\s+/g, "").trim(),
      targetKey = compact(pageTargetRefMode || "全能参考"),
      knownRefModes = ["全能参考", "首尾帧", "超长视频"].map(compact),
      isVisible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect(),
          style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      },
      visibleOptions = () => {
        return Array.from(document.querySelectorAll(".lv-select-option, li[role=\"option\"], [role=\"option\"]")).filter(optionEl => isVisible(optionEl));
      },
      closePopovers = () => {
        document.body?.dispatchEvent(new MouseEvent("click", {
          bubbles: true
        })), document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true
        })), document.dispatchEvent(new KeyboardEvent("keyup", {
          key: "Escape",
          code: "Escape",
          bubbles: true
        }));
      },
      openSelect = async selectEl => {
        const arrowEl = selectEl.querySelector?.(".lv-select-suffix, .lv-select-arrow-icon") || selectEl;
        arrowEl.click?.(), selectEl.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          composed: true
        })), selectEl.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          composed: true
        })), selectEl.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true
        })), await wait(220);
      },
      selectCandidates = () => {
        return Array.from(document.querySelectorAll("div[role=\"combobox\"], .lv-select, .arco-select-view, [class*=\"select-view\"]")).filter(selectEl => isVisible(selectEl));
      },
      matchesRefMode = text => {
        const key = compact(text);
        if (!key) return false;
        return key === targetKey || key.includes(targetKey) || targetKey.includes(key);
      },
      findReferenceSelect = async () => {
        const selects = selectCandidates();
        for (const selectEl of selects) {
          closePopovers(), await wait(80), await openSelect(selectEl);
          const options = visibleOptions(),
            optionKeys = options.map(optionEl => compact(optionEl.textContent || "")),
            hasKnownRefOptions = optionKeys.some(optionKey => knownRefModes.some(knownKey => optionKey.includes(knownKey)));
          if (!hasKnownRefOptions) {
            closePopovers(), await wait(60);
            continue;
          }
          const targetOption = options.find(optionEl => matchesRefMode(optionEl.textContent || ""));
          if (targetOption) return {
            select: selectEl,
            target: targetOption
          };
        }
        return closePopovers(), null;
      },
      selection = await findReferenceSelect();
    if (!selection) return {
      ok: false,
      error: "未找到参考模式: " + pageTargetRefMode
    };
    selection.target.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      composed: true
    })), selection.target.click(), await wait(220);
    const currentKey = compact(selection.select.textContent || "");
    if (!currentKey.includes(targetKey)) return {
      ok: false,
      error: "参考模式回读未生效，目标=" + pageTargetRefMode + " 当前=" + (selection.select.textContent || "").trim()
    };
    return {
      ok: true
    };
  }, [targetRefMode]);
}
// 在即梦「比例·分辨率·数量」合并弹层里一次设好三项（按文字点击，不依赖哈希类名/radio）。
async function jqSetRatioResCountOnPage(tabId, ratio, resolution, count) {
  return runInJimengPage(tabId, async (targetRatio, targetRes, targetCount) => {
    const wait = ms => new Promise(r => setTimeout(r, ms)),
      norm = s => String(s || "").replace(/\s+/g, "").trim(),
      vis = el => { if (!el) return false; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; },
      fire = el => { ["mousedown", "mouseup", "click"].forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, composed: true }))); },
      popOpen = () => Array.from(document.querySelectorAll("div")).some(e => vis(e) && /选择比例/.test(e.textContent || "") && /选择分辨率/.test(e.textContent || "")),
      resolutionLabelRe = /(?:480P|720P|1080P|4K)/i;
    // 1) 打开合并弹层
    if (!popOpen()) {
      const chip = Array.from(document.querySelectorAll("button")).find(e => vis(e) && resolutionLabelRe.test(e.innerText || "") && /(个|:)/.test(e.innerText || "")) || Array.from(document.querySelectorAll("button")).find(e => vis(e) && resolutionLabelRe.test(e.innerText || ""));
      if (chip) { fire(chip); for (let i = 0; i < 15 && !popOpen(); i++) await wait(120); }
    }
    if (!popOpen()) return { ok: false, error: "未能打开 比例/分辨率/数量 弹层" };
    // 2) 弹层根 = 同时含三个标题的最小 div
    const root = Array.from(document.querySelectorAll("div")).filter(vis).filter(e => /选择比例/.test(e.textContent || "") && /选择分辨率/.test(e.textContent || "")).sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0];
    if (!root) return { ok: false, error: "未找到弹层根" };
    const sectionAfter = titleRe => {
      const titleEl = Array.from(root.querySelectorAll("*")).find(e => vis(e) && titleRe.test(norm(e.textContent)) && norm(e.textContent).length < 8);
      return titleEl ? titleEl.nextElementSibling || titleEl.parentElement : null;
    };
    const clickOpt = (section, matchFn) => {
      if (!section) return false;
      const leaves = Array.from(section.querySelectorAll("*")).filter(e => vis(e) && matchFn(norm(e.textContent)) && !Array.from(e.children).some(c => matchFn(norm(c.textContent))));
      if (!leaves.length) return false;
      let el = leaves[0], node = el;
      for (let i = 0; i < 6 && node && node !== section; i++) { if (getComputedStyle(node).cursor === "pointer" || node.getAttribute("role")) { el = node; break; } node = node.parentElement; }
      return fire(el), true;
    };
    const notes = [],
      ratioKey = norm(targetRatio).replace(/[^0-9:：]/g, "").replace("：", ":"),
      resKey = norm(targetRes).replace(/[^0-9a-z]/gi, "").toUpperCase();
    clickOpt(sectionAfter(/选择比例/), t => t.replace(/[^0-9:：]/g, "").replace("：", ":") === ratioKey) || notes.push("比例" + targetRatio);
    await wait(160);
    clickOpt(sectionAfter(/选择分辨率/), t => t.replace(/[^0-9a-z]/gi, "").toUpperCase() === resKey) || notes.push("分辨率" + targetRes);
    await wait(160);
    const countSection = sectionAfter(/选择生成数量/);
    if (countSection) clickOpt(countSection, t => t === String(targetCount)) || notes.push("数量" + targetCount);
    await wait(160);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await wait(120);
    return { ok: true, note: notes.length ? "未匹配: " + notes.join("、") : "" };
  }, [ratio || "16:9", resolution || "720P", count || 1]);
}
async function selectDurationOnPage(tabId, targetDuration, durationRange = {
  min: 4,
  max: 15
}) {
  return runInJimengPage(tabId, async (pageTargetDuration, pageDurationRange) => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
      minSeconds = Math.max(1, Number(pageDurationRange?.min) || 4),
      maxSeconds = Math.max(minSeconds, Number(pageDurationRange?.max) || 15),
      targetSeconds = (() => {
        const matched = String(pageTargetDuration || "10s").match(/\d+/);
        return Math.min(maxSeconds, Math.max(minSeconds, Number(matched ? matched[0] : 10) || 10));
      })(),
      targetText = targetSeconds + "s",
      visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect(),
          style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      },
      textOf = element => String(element?.innerText || element?.textContent || "").replace(/\s+/g, "").trim(),
      fireClick = element => {
        if (!element) return;
        element.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          composed: true
        }));
        element.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          composed: true
        }));
        element.click?.();
      },
      setNativeValue = (element, value) => {
        if (!element) return;
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value"),
          valueText = String(value);
        element.focus?.();
        element.select?.();
        if (descriptor?.set) descriptor.set.call(element, valueText);else element.value = valueText;
        try {
          element.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            data: valueText,
            inputType: "insertText"
          }));
        } catch {
          element.dispatchEvent(new Event("input", {
            bubbles: true
          }));
        }
        element.dispatchEvent(new Event("change", {
          bubbles: true
        }));
      },
      durationToolbarButton = () => {
        const candidates = Array.from(document.querySelectorAll("button")).filter(button => visible(button) && /^\d+s$/.test(textOf(button)));
        return candidates.sort((left, right) => right.getBoundingClientRect().y - left.getBoundingClientRect().y)[0] || null;
      },
      durationPanel = () => {
        const panels = Array.from(document.querySelectorAll("div")).filter(element => {
          const text = element.textContent || "";
          return visible(element) && /选择视频生成时长/.test(text) && (element.querySelector("[role=\"slider\"]") || element.querySelector("input[role=\"spinbutton\"]"));
        });
        return panels.sort((left, right) => (left.textContent || "").length - (right.textContent || "").length)[0] || null;
      },
      readCurrentDuration = () => {
        const toolbarButton = durationToolbarButton(),
          toolbarMatch = textOf(toolbarButton).match(/^(\d+)s$/);
        if (toolbarMatch) return Number(toolbarMatch[1]);
        const panel = durationPanel(),
          input = panel?.querySelector("input[role=\"spinbutton\"]"),
          slider = panel?.querySelector("[role=\"slider\"]"),
          inputValue = Number(input?.value || input?.getAttribute("aria-valuenow")),
          sliderValue = Number(slider?.getAttribute("aria-valuenow"));
        if (Number.isFinite(inputValue) && inputValue > 0) return inputValue;
        if (Number.isFinite(sliderValue) && sliderValue > 0) return sliderValue;
        return null;
      },
      applyNewDurationPicker = async () => {
        let panel = durationPanel();
        if (!panel) {
          const button = durationToolbarButton();
          if (!button) return {
            ok: false,
            error: "未找到新版时长按钮"
          };
          fireClick(button);
          for (let i = 0; i < 15 && !panel; i++) {
            await wait(120), panel = durationPanel();
          }
        }
        if (!panel) return {
          ok: false,
          error: "未打开新版时长弹层"
        };
        const tickButton = Array.from(panel.querySelectorAll("button")).find(button => visible(button) && textOf(button) === String(targetSeconds));
        if (tickButton) fireClick(tickButton);
        const input = panel.querySelector("input[role=\"spinbutton\"]");
        if (input) {
          setNativeValue(input, targetSeconds);
          input.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            bubbles: true
          }));
          input.dispatchEvent(new KeyboardEvent("keyup", {
            key: "Enter",
            code: "Enter",
            bubbles: true
          }));
          input.blur?.();
        }
        await wait(260);
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true
        }));
        await wait(160);
        const currentSeconds = readCurrentDuration();
        return currentSeconds === targetSeconds ? {
          ok: true
        } : {
          ok: false,
          error: "新版时长回读未生效，目标=" + targetText + " 当前=" + (currentSeconds ? currentSeconds + "s" : "未知")
        };
      },
      applyLegacyDurationSelect = async () => {
        const comboboxes = Array.from(document.querySelectorAll("div[role=\"combobox\"]")),
          durationSelect = comboboxes.find(selectEl => {
            return selectEl.innerHTML.includes("rotate(") && /\d+s/.test(selectEl.innerText || "");
          });
        if (!durationSelect) return {
          ok: false,
          error: "未找到时长选择框"
        };
        fireClick(durationSelect), await wait(300);
        const options = Array.from(document.querySelectorAll("li[role=\"option\"]")),
          targetOption = options.find(optionEl => String(optionEl.textContent || "").trim() === targetText);
        if (!targetOption) {
          const candidateText = options.map(optionEl => String(optionEl.textContent || "").trim()).filter(Boolean).join(", ");
          return {
            ok: false,
            error: "未找到时长: " + pageTargetDuration + "，候选=" + candidateText
          };
        }
        fireClick(targetOption), await wait(260);
        const valueEl = durationSelect.querySelector?.(".lv-select-view-value, .arco-select-view-value, [class*=\"view-value\"], [class*=\"value\"]") || durationSelect,
          currentText = String(valueEl.textContent || "").trim();
        return currentText.includes(targetText) ? {
          ok: true
        } : {
          ok: false,
          error: "时长回读未生效，目标=" + targetText + " 当前=" + currentText
        };
      };
    const currentSeconds = readCurrentDuration();
    if (currentSeconds === targetSeconds) return {
      ok: true
    };
    const newResult = await applyNewDurationPicker();
    if (newResult?.ok) return newResult;
    const legacyResult = await applyLegacyDurationSelect();
    if (legacyResult?.ok) return legacyResult;
    return {
      ok: false,
      error: newResult?.error + "；旧版回退: " + legacyResult?.error
    };
  }, [targetDuration, durationRange]);
}
async function submitPayloadOnPage(tabId, payload, refMode = "", submitMode = "full", maxImages = maxImageCount) {
  return runInJimengPage(tabId, async (pagePayload, pageRefMode, pageSubmitMode, pageMaxImages) => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
      compact = text => String(text || "").replace(/\s+/g, "").trim(),
      isFirstLastFrame = compact(pageRefMode).includes(compact("首尾帧")),
      setInputValue = (element, value, emitChange = false) => {
        if (!element) return;
        element.focus?.();
        if ("value" in element) {
          const proto = Object.getPrototypeOf(element),
            descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
          if (descriptor?.set) descriptor.set.call(element, value);else element.value = value;
        } else element.textContent = value;
        element.dispatchEvent(new Event("input", {
          bubbles: true
        }));
        if (emitChange) element.dispatchEvent(new Event("change", {
          bubbles: true
        }));
      },
      readInputValue = element => "value" in element ? String(element.value || "") : String(element.textContent || ""),
      focusAtEnd = element => {
        if (!element) return;
        element.focus?.();
        if (typeof element.setSelectionRange === "function") {
          const length = readInputValue(element).length;
          element.setSelectionRange(length, length);
          return;
        }
        if (element.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(element), range.collapse(false);
          const selection = window.getSelection();
          selection.removeAllRanges(), selection.addRange(range);
        }
      },
      appendText = (element, text) => {
        if (!text) return;
        focusAtEnd(element);
        if (element.isContentEditable) {
          const execOk = (() => {
            try {
              if (typeof document.execCommand === "function") return document.execCommand("insertText", false, String(text));
            } catch {
              return false;
            }
            return false;
          })();
          if (!execOk) {
            const selection = window.getSelection();
            if (selection && selection.rangeCount) {
              const range = selection.getRangeAt(0);
              range.deleteContents(), range.insertNode(document.createTextNode(String(text))), range.collapse(false), selection.removeAllRanges(), selection.addRange(range);
            } else element.appendChild(document.createTextNode(String(text)));
          }
          element.dispatchEvent(new Event("input", {
            bubbles: true
          }));
        } else setInputValue(element, "" + readInputValue(element) + text);
        focusAtEnd(element);
      },
      typeText = async (element, text, delayMs = 30) => {
        appendText(element, String(text || "")), await wait(delayMs);
      },
      visibleLvOptions = () => {
        return Array.from(document.querySelectorAll(".lv-select-option")).filter(optionEl => {
          const rect = optionEl.getBoundingClientRect(),
            style = window.getComputedStyle(optionEl);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
      },
      waitForOptions = async (timeoutMs = 2000) => {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
          const options = visibleLvOptions();
          if (options.length) return options;
          await wait(80);
        }
        return [];
      },
      normalizeRefName = text => String(text || "").toLowerCase().replace(/\.[^./\\\s]+$/g, "").replace(/[\s_\-()（）【】\[\]{}]+/g, "").trim(),
      stripNameExt = text => String(text || "").replace(/\.[^./\\\s]+$/g, ""),
      optionLabel = optionEl => {
        if (!optionEl) return "";
        const labelEl = optionEl.querySelector(".option-label-WU2wTn, .option-name-rlE1lz, .ellipsis-text-t1K2b1, .option-text-ubNMsC .option-name-rlE1lz");
        return String(labelEl?.textContent || optionEl.textContent || "").trim();
      },
      pickBestOption = (options, keywords) => {
        if (!options.length) return null;
        const normalizedKeywords = keywords.map(keyword => normalizeRefName(keyword)).filter(Boolean),
          scoredOptions = options.map(optionEl => {
            const label = optionLabel(optionEl),
              normalizedLabel = normalizeRefName(label);
            let score = 0;
            return normalizedKeywords.forEach(keyword => {
              if (!keyword || !normalizedLabel) return;
              if (normalizedLabel === keyword) score = Math.max(score, 100);else {
                if (normalizedLabel.includes(keyword) || keyword.includes(normalizedLabel)) score = Math.max(score, 80);
              }
            }), {
              item: optionEl,
              score: score
            };
          });
        return scoredOptions.sort((left, right) => right.score - left.score), scoredOptions[0]?.score > 0 ? scoredOptions[0].item : null;
      },
      candidateKeywordsForTag = (tagName, payload) => {
        const tagText = String(tagName || "").trim(),
          keywords = [tagText, stripNameExt(tagText)],
          mediaItems = [...(Array.isArray(payload?.images) ? payload.images : []), ...(Array.isArray(payload?.videos) ? payload.videos : []), ...(Array.isArray(payload?.audios) ? payload.audios : [])],
          normalizedTag = normalizeRefName(tagText);
        return mediaItems.forEach(mediaItem => {
          const fileName = String(mediaItem?.name || "").trim();
          if (!fileName) return;
          const nameWithoutExt = stripNameExt(fileName);
          (normalizeRefName(nameWithoutExt) === normalizedTag || normalizeRefName(fileName) === normalizedTag) && (keywords.unshift(nameWithoutExt), keywords.unshift(fileName));
        }), Array.from(new Set(keywords.filter(Boolean)));
      },
      insertMentionByDropdown = async (editor, tagName, extraKeywords = []) => {
        focusAtEnd(editor), appendText(editor, "@"), editor.dispatchEvent(new KeyboardEvent("keydown", {
          key: "@",
          bubbles: true
        })), editor.dispatchEvent(new KeyboardEvent("keyup", {
          key: "@",
          bubbles: true
        }));
        let options = await waitForOptions(1400);
        if (!options.length) {
          const uploadButton = document.querySelector(".lv-badge button, [class*=\"upload\"][class*=\"btn\" i], [class*=\"media\"][class*=\"add\" i]");
          uploadButton && (uploadButton.click(), options = await waitForOptions(1400));
        }
        const matchedOption = pickBestOption(options, [tagName, ...extraKeywords]);
        if (!matchedOption) return false;
        return focusAtEnd(editor), matchedOption.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          composed: true
        })), matchedOption.click(), await wait(260), cleanupDuplicateAt(editor), await wait(40), focusAtEnd(editor), appendText(editor, " "), true;
      },
      normalizeAtText = text => {
        const source = String(text || ""),
          atPattern = /[@＠]([^\s@，。！？；：、,.!?;:]+)/g;
        let output = "",
          lastIndex = 0,
          match = null;
        while ((match = atPattern.exec(source)) !== null) {
          const plainText = source.slice(lastIndex, match.index).replace(/[@＠]+/g, "");
          output += plainText, output += "@" + match[1], lastIndex = atPattern.lastIndex;
        }
        return output += source.slice(lastIndex).replace(/[@＠]+/g, ""), output;
      },
      cleanupDuplicateAt = editor => {
        if (!editor) return;
        if (editor.isContentEditable) {
          let changed = false;
          const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
          let textNode = walker.nextNode();
          while (textNode) {
            const before = String(textNode.nodeValue || ""),
              after = before.replace(/[@＠]+/g, "");
            before !== after && (textNode.nodeValue = after, changed = true), textNode = walker.nextNode();
          }
          changed && editor.dispatchEvent(new Event("input", {
            bubbles: true
          }));
          focusAtEnd(editor);
          return;
        }
        const currentText = readInputValue(editor),
          cleanText = normalizeAtText(currentText);
        cleanText !== currentText && setInputValue(editor, cleanText), focusAtEnd(editor);
      },
      fillPromptWithMentions = async (editor, promptText) => {
        const cleanPromptText = normalizeAtText(promptText),
          buildKnownLabels = payload => {
            const normalizeLabel = text => String(text || "").replace(/\.[^./\\\s]+$/g, "").replace(/[@＠;；]/g, "").replace(/\s+/g, "").trim(),
              mediaItems = [...(Array.isArray(payload?.images) ? payload.images : []), ...(Array.isArray(payload?.videos) ? payload.videos : []), ...(Array.isArray(payload?.audios) ? payload.audios : [])],
              labels = Array.from(new Set(mediaItems.map(mediaItem => normalizeLabel(mediaItem?.name || "")).filter(Boolean)));
            return labels.sort((left, right) => right.length - left.length), labels;
          },
          splitPromptTokens = (text, knownLabels) => {
            const tokens = [];
            let buffer = "",
              cursor = 0;
            while (cursor < text.length) {
              const char = text[cursor];
              if (char === "@" || char === "＠") {
                const rest = text.slice(cursor + 1);
                let matchedLabel = "";
                for (const label of knownLabels) {
                  if (rest.startsWith(label)) {
                    matchedLabel = label;
                    break;
                  }
                }
                if (matchedLabel) {
                  if (buffer) tokens.push({
                    type: "text",
                    value: buffer
                  });
                  tokens.push({
                    type: "mention",
                    value: matchedLabel
                  }), buffer = "", cursor += 1 + matchedLabel.length;
                  continue;
                }
              }
              buffer += char, cursor += 1;
            }
            if (buffer) tokens.push({
              type: "text",
              value: buffer
            });
            return tokens;
          },
          knownLabels = buildKnownLabels(pagePayload),
          tokens = splitPromptTokens(cleanPromptText, knownLabels),
          hasMention = tokens.some(token => token.type === "mention");
        if (!hasMention) {
          setInputValue(editor, cleanPromptText, true);
          return;
        }
        setInputValue(editor, "");
        for (const token of tokens) {
          if (token.type === "text") {
            if (token.value) await typeText(editor, token.value, 8);
            continue;
          }
          const tagName = token.value,
            keywords = candidateKeywordsForTag(tagName, pagePayload),
            inserted = await insertMentionByDropdown(editor, tagName, keywords);
          if (!inserted) throw new Error("未找到 @ 候选：" + tagName + "，检索词=" + keywords.join("|"));
        }
        cleanupDuplicateAt(editor), await wait(120), cleanupDuplicateAt(editor), editor.dispatchEvent(new Event("change", {
          bubbles: true
        }));
      },
      findPromptEditor = () => {
        const semanticEditor = Array.from(document.querySelectorAll("textarea, input[type=\"text\"], [contenteditable=\"true\"]")).find(element => {
          const placeholder = (element.getAttribute?.("placeholder") || "").toLowerCase(),
            ariaLabel = (element.getAttribute?.("aria-label") || "").toLowerCase(),
            textContent = (element.textContent || "").toLowerCase();
          return /提示词|prompt|描述|想象|文案/.test(placeholder + " " + ariaLabel + " " + textContent);
        });
        if (semanticEditor) return semanticEditor;
        const textareas = Array.from(document.querySelectorAll("textarea"));
        if (textareas.length) return textareas[0];
        const editors = Array.from(document.querySelectorAll("[contenteditable=\"true\"]"));
        return editors[0] || null;
      },
      findFileInput = kind => {
        const inputs = Array.from(document.querySelectorAll("input[type=\"file\"]"));
        if (!inputs.length) return null;
        const scoreInput = input => {
            const accept = (input.getAttribute("accept") || "").toLowerCase(),
              identity = ((input.className || "") + " " + (input.id || "")).toLowerCase();
            let score = 0;
            if (kind === "image" && accept.includes("image")) score += 5;
            if (kind === "video" && accept.includes("video")) score += 5;
            if (kind === "audio" && accept.includes("audio")) score += 5;
            if (/upload|media|file|素材/.test(identity)) score += 2;
            return score;
          },
          scoredInputs = inputs.map(input => ({
            input: input,
            score: scoreInput(input)
          })).sort((left, right) => right.score - left.score);
        if (!scoredInputs.length) return null;
        return scoredInputs[0].input;
      },
      fileFromRecord = async record => {
        const blob = await fetch(record.dataUrl).then(response => response.blob());
        return new File([blob], record.name || "upload-" + Date.now(), {
          type: record.type || blob.type || "application/octet-stream",
          lastModified: record.lastModified || Date.now()
        });
      },
      setFileInputFiles = (input, files) => {
        const transfer = new DataTransfer();
        files.forEach(file => transfer.items.add(file)), input.files = transfer.files, input.dispatchEvent(new Event("input", {
          bubbles: true
        })), input.dispatchEvent(new Event("change", {
          bubbles: true
        }));
      },
      payloadData = pagePayload || {};
    if (pageSubmitMode !== "click") {
      const filesByInput = new Map(),
        addFilesForInput = (input, records) => {
          if (!input || !records?.length) return;
          if (!filesByInput.has(input)) filesByInput.set(input, []);
          filesByInput.get(input).push(...records);
        };
      if (Array.isArray(payloadData.images) && payloadData.images.length) {
        if (payloadData.images.length > pageMaxImages) return {
          ok: false,
          error: "图片最多支持" + pageMaxImages + "张"
        };
        addFilesForInput(findFileInput("image"), payloadData.images);
      }
      const referenceCount = (Array.isArray(payloadData.images) ? payloadData.images.length : 0) + (Array.isArray(payloadData.videos) ? payloadData.videos.length : 0) + (Array.isArray(payloadData.audios) ? payloadData.audios.length : 0);
      if (pageMaxImages === 50 && referenceCount > pageMaxImages) return {
        ok: false,
        error: "参考素材最多支持" + pageMaxImages + "个"
      };
      Array.isArray(payloadData.videos) && payloadData.videos.length && addFilesForInput(findFileInput("video"), payloadData.videos);
      Array.isArray(payloadData.audios) && payloadData.audios.length && addFilesForInput(findFileInput("audio"), payloadData.audios);
      for (const [input, records] of filesByInput.entries()) {
        if (!input) return {
          ok: false,
          error: "未找到上传输入框"
        };
        const files = await Promise.all(records.map(record => fileFromRecord(record))),
          emptyTransfer = new DataTransfer();
        input.files = emptyTransfer.files, input.dispatchEvent(new Event("change", {
          bubbles: true
        })), await wait(150), setFileInputFiles(input, files), await wait(300);
      }
      if (payloadData.promptText) {
        const promptEditor = findPromptEditor();
        if (!promptEditor) return {
          ok: false,
          error: "未找到提示词输入框"
        };
        if (isFirstLastFrame) {
          const cleanPromptText = normalizeAtText(payloadData.promptText || "");
          setInputValue(promptEditor, cleanPromptText, true);
        } else await fillPromptWithMentions(promptEditor, payloadData.promptText);
        await wait(120);
      }
    }
    if (pageSubmitMode !== "content") {
      const submitSelectors = ["button.submit-button-eYjq4p", "button.submit-button-wD1gIc", "button.submit-button-xdhu0e"];
      let submitButton = null;
      for (const selector of submitSelectors) {
        try {
          const button = document.querySelector(selector);
          if (button) {
            submitButton = button;
            break;
          }
        } catch (error) {}
      }
      if (!submitButton) {
        const visibleButtons = Array.from(document.querySelectorAll("button")).filter(button => {
          const rect = button.getBoundingClientRect(),
            style = window.getComputedStyle(button);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
        submitButton = visibleButtons.find(button => (button.className || "").includes("submit-button")) || visibleButtons.find(button => /(提交|提交生成|生成)/.test(button.textContent || ""));
      }
      if (!submitButton) return {
        ok: false,
        error: "未找到提交按钮"
      };
      submitButton.click();
      const form = submitButton.closest("form");
      if (form) form.dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true
      }));
    }
    return {
      ok: true
    };
  }, [payload || null, refMode || "", submitMode || "full", maxImages]);
}
async function runPageStep(tabId, stepName, settings, payload = null) {
  switch (stepName) {
    case "genMode":
      return selectGenerationModeOnPage(tabId, settings.genMode);
    case "model":
      return selectModelOnPage(tabId, settings.model);
    case "refMode":
      return selectReferenceModeOnPage(tabId, settings.refMode);
    case "ratio":
      return jqSetRatioResCountOnPage(tabId, settings.ratio, settings.resolution, settings.count);
    case "duration":
      return selectDurationOnPage(tabId, settings.duration, durationRangeForSettings(settings.refMode, settings.model));
    case "submit":
      return submitPayloadOnPage(tabId, payload, settings.refMode, "full", maxImageCountForSettings(settings.refMode, settings.model));
    default:
      return {
        ok: false,
        error: "未知步骤: " + stepName
      };
  }
}
function createTaskRecord(settings, payload) {
  return {
    id: nextTaskId++,
    createdAt: new Date().toLocaleTimeString(),
    status: "pending",
    errorMessage: "",
    projectId: jqActiveProjectId || "default",
    taskName: "",
    repeatTotal: 1,
    repeatDone: 0,
    settings: settings,
    payload: payload
  };
}
function stripTaskPayloadBlobs(task) {
  const payload = {
    promptText: String(task?.payload?.promptText || ""),
    images: Array.isArray(task?.payload?.images) ? task.payload.images.map(stripList => ({
      name: stripList?.name || "",
      type: stripList?.type || "",
      lastModified: stripList?.lastModified || 0,
      size: stripList?.size || 0
    })) : [],
    videos: Array.isArray(task?.payload?.videos) ? task.payload.videos.map(item => ({
      name: item?.name || "",
      type: item?.type || "",
      lastModified: item?.lastModified || 0,
      size: item?.size || 0
    })) : [],
    audios: Array.isArray(task?.payload?.audios) ? task.payload.audios.map(cleanTask => ({
      name: cleanTask?.name || "",
      type: cleanTask?.type || "",
      lastModified: cleanTask?.lastModified || 0,
      size: cleanTask?.size || 0
    })) : []
  };
  return {
    ...task,
    payload: payload
  };
}
async function saveTasks() {
  try {
    const payload = jqTasks.map(idsToDelete => stripTaskPayloadBlobs(idsToDelete));
    await storageSetLocal({
      [taskQueueStoreKey]: payload,
      nextTaskId: nextTaskId
    });
  } catch (taskId) {
    appendLog("⚠️ 任务持久化失败: " + (taskId.message || taskId));
  }
}
async function loadTasks() {
  try {
    await jqLoadProjects();
    const storedTasks = await storageGetLocal(taskQueueStoreKey),
      maxId = await storageGetLocal("nextTaskId");
    let changed = false;
    if (Array.isArray(storedTasks)) {
      jqTasks = storedTasks;
      let migrated = 0;
      for (const task of jqTasks) {
        if (await migrateInlinePayloadToDb(task)) {
          migrated += 1;
          changed = true;
        }
        task.payload = stripTaskPayloadBlobs(task).payload;
      }
      migrated > 0 && appendLog("ℹ️ 已迁移 " + migrated + " 个旧任务素材缓存，提升大队列稳定性");
      if (jqEnsureTaskProjects()) changed = true;
      if (jqSortTasksDesc()) changed = true;
    }
    if (typeof maxId === "number" && Number.isFinite(maxId)) nextTaskId = maxId;else jqTasks.length && (nextTaskId = Math.max(...jqTasks.map(task => task.id || 0)) + 1);
    if (Array.isArray(storedTasks) && changed) await saveTasks();
    jqRenderProjects();
  } catch (task) {
    appendLog("⚠️ 读取任务失败: " + (task.message || task));
  }
}
function createCrcTable() {
  const crcTableData = new Uint32Array(256);
  for (let byteValue = 0; byteValue < 256; byteValue++) {
    let crcValue = byteValue;
    for (let bitIndex = 0; bitIndex < 8; bitIndex++) crcValue = crcValue & 1 ? 3988292384 ^ crcValue >>> 1 : crcValue >>> 1;
    crcTableData[byteValue] = crcValue;
  }
  return crcTableData;
}
const crcTable = createCrcTable();
function crc32(bytes) {
  let crcValue = 4294967295;
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) crcValue = crcTable[(crcValue ^ bytes[byteIndex]) & 255] ^ crcValue >>> 8;
  return (crcValue ^ 4294967295) >>> 0;
}
function createZipBytes(entries) {
  const encoder = new TextEncoder(),
    localParts = [],
    centralParts = [];
  let offset = 0;
  const now = new Date(),
    dosTime = now.getHours() << 11 | now.getMinutes() << 5 | now.getSeconds() >> 1,
    dosDate = now.getFullYear() - 1980 << 9 | now.getMonth() + 1 << 5 | now.getDate();
  for (const entry of entries) {
    const nameBytes = encoder.encode(String(entry.name || "file").replace(/\\/g, "/")),
      dataBytes = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data),
      checksum = crc32(dataBytes),
      localHeader = new Uint8Array(30 + nameBytes.length),
      localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 67324752, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 2048, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, dataBytes);
    const centralHeader = new Uint8Array(46 + nameBytes.length),
      centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 33639248, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 2048, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0),
    endRecord = new Uint8Array(22),
    endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 101010256, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);
  const allParts = [...localParts, ...centralParts, endRecord],
    totalSize = allParts.reduce((total, part) => total + part.length, 0),
    outputBytes = new Uint8Array(totalSize);
  let writeOffset = 0;
  for (const part of allParts) {
    outputBytes.set(part, writeOffset);
    writeOffset += part.length;
  }
  return outputBytes;
}
async function unzipZipEntry(entryName, compressionMethod, compressedBytes, expectedSize, expectedCrc) {
  let uncompressedBytes;
  if (compressionMethod === 0) uncompressedBytes = compressedBytes;else if (compressionMethod === 8) {
    if (typeof DecompressionStream !== "function") throw new Error("当前浏览器不支持解压 Deflate ZIP。请使用最新版 Chrome，或将 ZIP 压缩等级设为“仅存储”。");
    try {
      const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      uncompressedBytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      throw new Error("无法解压 ZIP 条目「" + entryName + "」: " + (error.message || error));
    }
  } else throw new Error("ZIP 条目「" + entryName + "」使用了不支持的压缩方式（方法 " + compressionMethod + "）。请使用未加密的 ZIP，并选择“仅存储”或“Deflate”。");
  if (uncompressedBytes.length !== expectedSize) throw new Error("ZIP 条目「" + entryName + "」解压后的大小异常，文件可能已损坏。");
  if (crc32(uncompressedBytes) !== expectedCrc) throw new Error("ZIP 条目「" + entryName + "」校验失败，文件可能已损坏。");
  return uncompressedBytes;
}
async function readZipEntries(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let endOffset = -1;
  for (let scanOffset = zipBytes.length - 22; scanOffset >= Math.max(0, zipBytes.length - 65558); scanOffset--) {
    if (view.getUint32(scanOffset, true) === 101010256) {
      endOffset = scanOffset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("无效 ZIP 文件");
  const centralOffset = view.getUint32(endOffset + 16, true),
    entryCount = view.getUint16(endOffset + 8, true),
    utf8NameDecoder = new TextDecoder("utf-8"),
    gb18030NameDecoder = new TextDecoder("gb18030"),
    entries = {};
  let centralPos = centralOffset;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    if (centralPos + 46 > zipBytes.length || view.getUint32(centralPos, true) !== 33639248) throw new Error("ZIP 目录记录损坏");
    const generalPurposeFlags = view.getUint16(centralPos + 8, true),
      compressionMethod = view.getUint16(centralPos + 10, true),
      expectedCrc = view.getUint32(centralPos + 16, true),
      compressedSize = view.getUint32(centralPos + 20, true),
      uncompressedSize = view.getUint32(centralPos + 24, true),
      nameLen = view.getUint16(centralPos + 28, true),
      extraLen = view.getUint16(centralPos + 30, true),
      commentLen = view.getUint16(centralPos + 32, true),
      localOffset = view.getUint32(centralPos + 42, true),
      centralEntryEnd = centralPos + 46 + nameLen + extraLen + commentLen;
    if (centralEntryEnd > zipBytes.length) throw new Error("ZIP 目录记录不完整");
    const entryNameBytes = zipBytes.subarray(centralPos + 46, centralPos + 46 + nameLen),
      entryName = generalPurposeFlags & 2048 ? utf8NameDecoder.decode(entryNameBytes) : gb18030NameDecoder.decode(entryNameBytes);
    if (generalPurposeFlags & 1) throw new Error("ZIP 条目「" + entryName + "」已加密，无法导入。请移除密码或加密后重试。");
    if (localOffset + 30 > zipBytes.length) throw new Error("ZIP 条目「" + entryName + "」的本地记录无效");
    const localNameLen = view.getUint16(localOffset + 26, true),
      localExtraLen = view.getUint16(localOffset + 28, true),
      dataStart = localOffset + 30 + localNameLen + localExtraLen,
      dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBytes.length) throw new Error("ZIP 条目「" + entryName + "」的数据不完整");
    entries[entryName] = await unzipZipEntry(entryName, compressionMethod, zipBytes.subarray(dataStart, dataEnd), uncompressedSize, expectedCrc), centralPos = centralEntryEnd;
  }
  return entries;
}
async function exportProjectCsv(projectId = jqActiveProjectId) {
  try {
    const exportProjectId = jqExportProjectId(projectId),
      tasks = jqProjectTasks(exportProjectId),
      projectName = jqProjectNameById(exportProjectId);
    if (tasks.length === 0) {
      appendLog("⚠️ 项目「" + projectName + "」没有任务可导出");
      return;
    }
    appendLog("正在导出项目「" + projectName + "」CSV 表格...");
    const csvText = jqBuildTaskCsvText(tasks),
      csvBlob = new Blob(["\uFEFF" + csvText], {
        type: "text/csv;charset=utf-8"
      }),
      csvUrl = URL.createObjectURL(csvBlob),
      downloadLink = document.createElement("a");
    downloadLink.href = csvUrl;
    downloadLink.download = "seedance-" + jqSanitizeFileName(projectName) + "-" + buildExportTimestamp() + ".csv";
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    URL.revokeObjectURL(csvUrl);
    appendLog("✅ 已导出项目「" + projectName + "」CSV（" + tasks.length + " 行）");
  } catch (error) {
    appendLog("❌ 导出表格失败: " + (error.message || error));
  }
}
async function exportProjectZip(projectId = jqActiveProjectId) {
  try {
    const exportProjectId = jqExportProjectId(projectId),
      tasks = jqProjectTasks(exportProjectId),
      projectName = jqProjectNameById(exportProjectId);
    if (tasks.length === 0) {
      appendLog("⚠️ 项目「" + projectName + "」没有任务可导出");
      return;
    }
    appendLog("正在打包项目「" + projectName + "」ZIP 表格包（含素材文件），请稍候...");
    const encoder = new TextEncoder(),
      zipEntries = [],
      usedMediaNames = {
        images: new Set(),
        videos: new Set(),
        audios: new Set()
      },
      uniqueMediaName = (mediaKind, taskId, fileName) => {
        const safeInputName = String(fileName || "").trim() || "file-" + Date.now(),
          dotIndex = safeInputName.lastIndexOf("."),
          hasExtension = dotIndex > 0 && dotIndex < safeInputName.length - 1,
          baseName = hasExtension ? safeInputName.slice(0, dotIndex) : safeInputName,
          extension = hasExtension ? safeInputName.slice(dotIndex) : "",
          safeBaseName = baseName.replace(/[\\/:*?"<>|]/g, "_") || "file";
        let candidateName = "" + safeBaseName + extension,
          suffix = 2;
        while (usedMediaNames[mediaKind].has(candidateName)) {
          candidateName = safeBaseName + "_" + suffix + extension;
          suffix += 1;
        }
        return usedMediaNames[mediaKind].add(candidateName), candidateName;
      };
    for (const task of tasks) {
      const storedPayload = await getTaskPayloadRecord(task.id),
        restoredPayload = await restorePayloadFiles(storedPayload),
        imageFiles = restoredPayload?.imageFiles || [],
        videoFiles = restoredPayload?.videoFiles || [],
        audioFiles = restoredPayload?.audioFiles || [];
      for (const imageFile of imageFiles) {
        const imageName = uniqueMediaName("images", task.id, imageFile.name);
        zipEntries.push({
          name: "media/images/" + imageName,
          data: new Uint8Array(await imageFile.arrayBuffer())
        });
      }
      for (const videoFile of videoFiles) {
        const videoName = uniqueMediaName("videos", task.id, videoFile.name);
        zipEntries.push({
          name: "media/videos/" + videoName,
          data: new Uint8Array(await videoFile.arrayBuffer())
        });
      }
      for (const audioFile of audioFiles) {
        const audioName = uniqueMediaName("audios", task.id, audioFile.name);
        zipEntries.push({
          name: "media/audios/" + audioName,
          data: new Uint8Array(await audioFile.arrayBuffer())
        });
      }
    }
    const csvText = jqBuildTaskCsvText(tasks),
      csvBytes = encoder.encode(csvText),
      csvBytesWithBom = new Uint8Array(3 + csvBytes.length);
    csvBytesWithBom[0] = 239;
    csvBytesWithBom[1] = 187;
    csvBytesWithBom[2] = 191;
    csvBytesWithBom.set(csvBytes, 3);
    const instructionText = zipImportInstructions.join("\r\n");
    zipEntries.unshift({
      name: "导入说明.txt",
      data: encoder.encode(instructionText)
    });
    zipEntries.unshift({
      name: "tasks.csv",
      data: csvBytesWithBom
    });
    const zipBytes = createZipBytes(zipEntries),
      zipBlob = new Blob([zipBytes], {
        type: "application/zip"
      }),
      zipUrl = URL.createObjectURL(zipBlob),
      downloadLink = document.createElement("a");
    downloadLink.href = zipUrl;
    downloadLink.download = "seedance-" + jqSanitizeFileName(projectName) + "-" + buildExportTimestamp() + ".zip";
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    URL.revokeObjectURL(zipUrl);
    appendLog("✅ 已导出项目「" + projectName + "」ZIP 表格包（" + tasks.length + " 个任务，含素材文件）");
  } catch (error) {
    appendLog("❌ 导出 ZIP 失败: " + (error.message || error));
  }
}
const csvRequiredHeaders = ["创作模式", "模型", "参考模式", "比例", "时长", "提示词"],
  zipImportInstructions = ["项目队列 导入说明", "1) 请把任务所需素材都放在同一个根文件夹内（可有子文件夹）。", "2) 编辑 tasks.csv 时，建议保留全部列名。", "3) 必填列：创作模式、模型、参考模式、比例、时长、提示词。", "4) 提示词中的 @标签 会自动链接到对应的素材（无需单独填写文件名列）。", "5) 序号(ID)/创建时间/状态 可不改；其他按需修改。", "6) 导入 CSV 时，插件会先让你选择素材根目录，自动按 @标签 名字匹配文件。", "7) 兼容旧版本：如果表格中有'图片文件名/视频文件名/音频文件名'列，也会被识别。"];
function normalizeCsvHeaderKey(header) {
  return String(header || "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s"'`]/g, "").replace(/[()（）\[\]【】:：]/g, "");
}
function buildCsvColumnMap(headers) {
  const exactIndex = {},
    normalizedIndex = {};
  headers.forEach((header, index) => {
    exactIndex[header] = index;
    normalizedIndex[normalizeCsvHeaderKey(header)] = index;
  });
  const headerAliases = {
      ID: ["id"],
      "创建时间": ["创建时间", "创建日期", "createdat", "createdtime"],
      "状态": ["状态", "status"],
      "项目": ["项目", "项目名称", "project", "projectname"],
      "任务卡片名": ["任务卡片名", "卡片名", "任务名", "taskname", "name"],
      "生成次数": ["生成次数", "执行次数", "重复次数", "repeat", "repeattotal", "次数"],
      "已执行次数": ["已执行次数", "已生成次数", "已完成次数", "repeatdone", "done"],
      "提示词": ["提示词", "提示词文本", "prompt", "prompttext"],
      "图片文件名": ["图片文件名", "图片", "图片名", "images", "image", "imagefiles"],
      "视频文件名": ["视频文件名", "视频", "视频名", "videos", "video", "videofiles"],
      "音频文件名": ["音频文件名", "音频", "音频名", "audios", "audio", "audiofiles"],
      "创作模式": ["创作模式", "生成模式", "genmode", "mode"],
      "模型": ["模型", "model"],
      "参考模式": ["参考模式", "参考", "refmode", "reference", "ref"],
      "比例": ["比例", "ratio", "画幅比例"],
      "时长": ["时长", "duration", "秒数"]
    },
    columnMap = {};
  Object.keys(headerAliases).forEach(columnName => {
    for (const alias of headerAliases[columnName]) {
      const index = normalizedIndex[normalizeCsvHeaderKey(alias)];
      if (Number.isInteger(index)) {
        columnMap[columnName] = index;
        break;
      }
    }
    !Number.isInteger(columnMap[columnName]) && Number.isInteger(exactIndex[columnName]) && (columnMap[columnName] = exactIndex[columnName]);
  });
  return columnMap;
}
function hasRequiredCsvColumns(headers) {
  const columnMap = buildCsvColumnMap(headers || []);
  return csvRequiredHeaders.every(requiredHeader => Number.isInteger(columnMap[requiredHeader]));
}
function decodeCsvBytes(bytes) {
  const decodeWith = encoding => {
    try {
      return new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      return "";
    }
  };
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) return decodeWith("utf-16le");
  if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) return decodeWith("utf-16be");
  const utf8Text = decodeWith("utf-8"),
    utf8Headers = parseCsvText(utf8Text).headers,
    utf8HasRequiredColumns = hasRequiredCsvColumns(utf8Headers),
    gbText = decodeWith("gb18030"),
    gbHeaders = parseCsvText(gbText).headers,
    gbHasRequiredColumns = hasRequiredCsvColumns(gbHeaders);
  if (utf8HasRequiredColumns && gbHasRequiredColumns) return utf8Text;
  if (utf8HasRequiredColumns) return utf8Text;
  if (gbHasRequiredColumns) return gbText;
  return utf8Text || gbText;
}
function parseCsvLine(line) {
  const cells = [];
  let cell = "",
    inQuotes = false;
  for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
    const char = line[charIndex],
      nextChar = line[charIndex + 1];
    if (char === "\"") {
      inQuotes && nextChar === "\"" ? (cell += "\"", charIndex += 1) : inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(cell), cell = "";
      continue;
    }
    cell += char;
  }
  return cells.push(cell), cells;
}
function parseCsvText(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim().length > 0),
    dataLines = /^sep\s*=\s*,\s*$/i.test(lines[0] || "") ? lines.slice(1) : lines;
  if (!dataLines.length) return {
    headers: [],
    rows: []
  };
  const headers = parseCsvLine(dataLines[0]).map(header => String(header || "").trim()),
    rows = dataLines.slice(1).map(line => parseCsvLine(line));
  return {
    headers: headers,
    rows: rows
  };
}
function readCsvCell(row, columnMap, columnName) {
  const columnIndex = columnMap[columnName];
  if (!Number.isInteger(columnIndex) || columnIndex < 0) return "";
  return String(row[columnIndex] || "").trim();
}
function isCsvRowEmpty(row, columnMap) {
  if (!Array.isArray(row)) return true;
  const requiredColumns = ["提示词", "创作模式", "模型", "参考模式", "比例", "时长"];
  return requiredColumns.every(columnName => !readCsvCell(row, columnMap, columnName));
}
function extractPromptAtRefs(promptText) {
  const refs = [],
    refPattern = /[@＠]([^\s@，。！？；：、,.!?;:]+)/g;
  let match;
  while ((match = refPattern.exec(String(promptText || ""))) !== null) {
    match[1] && refs.push(match[1]);
  }
  return refs;
}
let pendingImportCsvFile = null;
function jqUpdatePendingCsvImportUi() {
  const pendingPanel = getEl("importMediaPending"),
    pendingText = getEl("importMediaPendingText");
  if (pendingText) pendingText.textContent = pendingImportCsvFile ? "CSV 已读取并检测到素材引用。请选择素材根目录，或跳过素材继续导入。" : "";
  if (pendingPanel) pendingPanel.hidden = !pendingImportCsvFile;
}
function jqSetPendingCsvImport(pendingImport) {
  pendingImportCsvFile = pendingImport || null;
  jqUpdatePendingCsvImportUi();
}
function jqClearPendingCsvImport() {
  jqSetPendingCsvImport(null);
}
function jqChoosePendingCsvMediaRoot() {
  if (!pendingImportCsvFile) {
    appendLog("⚠️ 没有待处理的 CSV 数据");
    return;
  }
  const folderInput = getEl("importMediaRootFolder");
  if (!folderInput) {
    appendLog("❌ 未找到素材目录选择控件");
    return;
  }
  folderInput.value = "";
  folderInput.click();
}
function jqImportPendingCsvWithoutMedia() {
  const pendingImport = pendingImportCsvFile;
  if (!pendingImport) {
    appendLog("⚠️ 没有待处理的 CSV 数据");
    return;
  }
  jqClearPendingCsvImport(), appendLog("📄 已跳过素材匹配，正在导入 CSV 任务..."), importCsvRowsWithMedia(pendingImport.rows, pendingImport.indexMap, null).catch(error => appendLog("❌ CSV 导入失败: " + (error.message || error)));
}
function jqCancelPendingCsvImport() {
  if (!pendingImportCsvFile) return;
  jqClearPendingCsvImport(), appendLog("ℹ️ 已取消本次 CSV 素材导入");
}
function buildMediaFileIndex(files) {
  const mediaIndex = new Map();
  for (const file of files) {
    const fullPath = (file.webkitRelativePath || file.name).replace(/\\/g, "/"),
      relativePath = fullPath.includes("/") ? fullPath.slice(fullPath.indexOf("/") + 1) : fullPath,
      baseName = stripFileExtension(relativePath);
    mediaIndex.set(relativePath.toLowerCase(), file), mediaIndex.set(baseName.toLowerCase(), file), mediaIndex.set(file.name.toLowerCase(), file), mediaIndex.set(stripFileExtension(file.name).toLowerCase(), file);
  }
  return mediaIndex;
}
function findMediaFileByRef(refText, mediaIndex) {
  if (!refText || !mediaIndex) return null;
  const normalizedRef = refText.trim().toLowerCase().replace(/\\/g, "/"),
    refBaseName = stripFileExtension(normalizedRef);
  return mediaIndex.get(normalizedRef) || mediaIndex.get(refBaseName) || mediaIndex.get(normalizedRef.split("/").pop()) || mediaIndex.get(stripFileExtension(normalizedRef.split("/").pop())) || null;
}
async function importCsvFile(csvFile) {
  try {
    jqClearPendingCsvImport();
    if (!csvFile) {
      appendLog("❌ 未选择文件");
      return;
    }
    const bytes = new Uint8Array(await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result), reader.onerror = () => reject(new Error("文件读取失败")), reader.readAsArrayBuffer(csvFile);
      })),
      csvText = decodeCsvBytes(bytes),
      {
        headers: headers,
        rows: rows
      } = parseCsvText(csvText);
    if (!headers.length) throw new Error("表格为空或格式无效");
    const columnMap = buildCsvColumnMap(headers),
      missingHeaders = csvRequiredHeaders.filter(requiredHeader => !Number.isInteger(columnMap[requiredHeader]));
    if (missingHeaders.length) {
      const actualHeadersText = headers.map(header => "\"" + header + "\"").join("、");
      throw new Error("表格缺少必填列: " + missingHeaders.join("、") + "。\n实际列名: " + actualHeadersText);
    }
    const hasPromptRefs = rows.some(row => {
        const promptText = readCsvCell(row, columnMap, "提示词");
        return extractPromptAtRefs(promptText).length > 0;
      }),
      hasMediaColumns = rows.some(row => readCsvCell(row, columnMap, "图片文件名") || readCsvCell(row, columnMap, "视频文件名") || readCsvCell(row, columnMap, "音频文件名"));
    if (hasPromptRefs || hasMediaColumns) {
      jqSetPendingCsvImport({
        rows: rows,
        indexMap: columnMap
      }), appendLog("📂 CSV 已读取，检测到素材。请点击“选择素材根目录并继续”，或选择“跳过素材继续导入”。");
      return;
    }
    await importCsvRowsWithMedia(rows, columnMap, null);
  } catch (error) {
    appendLog("❌ CSV 导入失败: " + (error.message || error));
  }
}
async function importCsvRowsWithMedia(rows, columnMap, mediaIndex) {
  let importedCount = 0,
    skippedRows = 0,
    missingMediaRefs = [];
  for (const row of rows) {
    if (isCsvRowEmpty(row, columnMap)) {
      skippedRows += 1;
      continue;
    }
    const rawPrompt = readCsvCell(row, columnMap, "提示词"),
      promptText = rawPrompt.replace(/\\n/g, "\n"),
      settings = {
        genMode: readCsvCell(row, columnMap, "创作模式") || "视频生成",
        model: readCsvCell(row, columnMap, "模型") || "Seedance 2.0",
        refMode: readCsvCell(row, columnMap, "参考模式") || "全能参考",
        ratio: normalizeRatioText(readCsvCell(row, columnMap, "比例") || "16:9"),
        duration: readCsvCell(row, columnMap, "时长") || "5s",
        promptText: promptText || ""
      },
      imageFiles = [],
      videoFiles = [],
      audioFiles = [];
    if (mediaIndex) {
      const promptRefs = extractPromptAtRefs(settings.promptText);
      for (const mediaRef of promptRefs) {
        const mediaFile = findMediaFileByRef(mediaRef, mediaIndex);
        if (mediaFile) {
          const extension = mediaFile.name.split(".").pop()?.toLowerCase() || "";
          if (["jpg", "jpeg", "png", "webp", "gif"].includes(extension)) imageFiles.push(mediaFile);else {
            if (["mp4"].includes(extension)) videoFiles.push(mediaFile);else ["mp3", "wav", "aac", "m4a"].includes(extension) && audioFiles.push(mediaFile);
          }
        } else missingMediaRefs.push(mediaRef);
      }
      for (const imageNameRef of splitListText(readCsvCell(row, columnMap, "图片文件名"))) {
        const imageFile = findMediaFileByRef(imageNameRef, mediaIndex);
        if (imageFile && !imageFiles.includes(imageFile)) imageFiles.push(imageFile);else !imageFile && missingMediaRefs.push(imageNameRef);
      }
      for (const videoNameRef of splitListText(readCsvCell(row, columnMap, "视频文件名"))) {
        const videoFile = findMediaFileByRef(videoNameRef, mediaIndex);
        if (videoFile && !videoFiles.includes(videoFile)) videoFiles.push(videoFile);else !videoFile && missingMediaRefs.push(videoNameRef);
      }
      for (const audioNameRef of splitListText(readCsvCell(row, columnMap, "音频文件名"))) {
        const audioFile = findMediaFileByRef(audioNameRef, mediaIndex);
        if (audioFile && !audioFiles.includes(audioFile)) audioFiles.push(audioFile);else !audioFile && missingMediaRefs.push(audioNameRef);
      }
    }
    const payloadSnapshot = {
        promptText: settings.promptText,
        images: imageFiles.map(imageFile => ({
          name: imageFile.name,
          type: imageFile.type,
          size: imageFile.size
        })),
        videos: videoFiles.map(videoFile => ({
          name: videoFile.name,
          type: videoFile.type,
          size: videoFile.size
        })),
        audios: audioFiles.map(audioFile => ({
          name: audioFile.name,
          type: audioFile.type,
          size: audioFile.size
        }))
      },
      task = createTaskRecord(settings, payloadSnapshot);
    jqApplyImportedTaskMeta(task, row, columnMap);
    await saveTaskPayload(task.id, {
      promptText: settings.promptText,
      imageFiles: imageFiles,
      videoFiles: videoFiles,
      audioFiles: audioFiles
    }), jqTasks.push(task), importedCount += 1;
  }
  if (importedCount > 0) {
    renderQueue(), await saveTasks();
    let message = "✅ CSV 导入完成：新增 " + importedCount + " 个任务" + (skippedRows ? "，跳过 " + skippedRows + " 行" : "");
    if (missingMediaRefs.length) message += "\n⚠️ 以下素材未找到（已跳过）：" + [...new Set(missingMediaRefs)].join("、");
    appendLog(message);
  } else appendLog("⚠️ 未导入任何任务" + (skippedRows ? "（跳过 " + skippedRows + " 行）" : ""));
}
async function importZipPackage(zipFile) {
  try {
    jqClearPendingCsvImport();
    if (!zipFile) {
      appendLog("❌ 未选择文件");
      return;
    }
    appendLog("正在解析 ZIP 表格包...");
    const zipEntries = await readZipEntries(new Uint8Array(await zipFile.arrayBuffer())),
      csvBytes = zipEntries["tasks.csv"] || zipEntries["tasks-template.csv"] || Object.entries(zipEntries).find(([entryName]) => /\.csv$/i.test(entryName))?.[1];
    if (!csvBytes) throw new Error("ZIP 内未找到 CSV 表格，请确认包含 tasks.csv");
    const csvText = decodeCsvBytes(csvBytes),
      {
        headers: headers,
        rows: rows
      } = parseCsvText(csvText);
    if (!headers.length) throw new Error("tasks.csv 为空");
    const columnMap = buildCsvColumnMap(headers),
      requiredHeaders = csvRequiredHeaders,
      missingHeaders = requiredHeaders.filter(header => !Number.isInteger(columnMap[header]));
    if (missingHeaders.length) {
      const actualHeadersText = headers.map(header => "\"" + header + "\"").join("、");
      throw new Error("tasks.csv 缺少列: " + missingHeaders.join("、") + "。\n实际列名: " + actualHeadersText + "\n💡 提示：如果用 Excel 编辑过，试试另存为 CSV（UTF-8）格式，或使用 XLSX 格式。");
    }
    let importedCount = 0,
      skippedRows = 0;
    for (const row of rows) {
      if (isCsvRowEmpty(row, columnMap)) {
        skippedRows += 1;
        continue;
      }
      const rawPrompt = readCsvCell(row, columnMap, "提示词"),
        promptText = rawPrompt.replace(/\\n/g, "\n"),
        idText = readCsvCell(row, columnMap, "ID"),
        parsedId = idText ? parseInt(idText, 10) : null,
        settings = {
          genMode: readCsvCell(row, columnMap, "创作模式") || "视频生成",
          model: readCsvCell(row, columnMap, "模型") || "Seedance 2.0",
          refMode: readCsvCell(row, columnMap, "参考模式") || "全能参考",
          ratio: normalizeRatioText(readCsvCell(row, columnMap, "比例") || "16:9"),
          duration: readCsvCell(row, columnMap, "时长") || "5s",
          promptText: promptText || ""
        },
        promptRefs = extractPromptAtRefs(settings.promptText),
        taskMediaPrefix = Number.isFinite(parsedId) ? "media/task_" + parsedId : null,
        findZipMediaRef = refName => {
          const normalizedRefName = stripFileExtension(refName).toLowerCase(),
            folders = ["images", "videos", "audios"];
          for (const folder of folders) {
            const matches = Object.keys(zipEntries).filter(entryName => {
              if (!entryName.startsWith("media/" + folder + "/") && !(taskMediaPrefix && entryName.startsWith(taskMediaPrefix + "/" + folder + "/"))) return false;
              const entryBaseName = entryName.split("/").pop() || "";
              return stripFileExtension(entryBaseName).toLowerCase() === normalizedRefName;
            });
            if (matches[0]) return {
              folder: folder,
              key: matches[0]
            };
          }
          return null;
        },
        imageRefs = [...splitListText(readCsvCell(row, columnMap, "图片文件名"))],
        videoRefs = [...splitListText(readCsvCell(row, columnMap, "视频文件名"))],
        audioRefs = [...splitListText(readCsvCell(row, columnMap, "音频文件名"))],
        refsByFolder = {
          images: [],
          videos: [],
          audios: []
        };
      for (const mediaRef of promptRefs) {
        const matchedMedia = findZipMediaRef(mediaRef);
        matchedMedia && refsByFolder[matchedMedia.folder].push(mediaRef);
      }
      imageRefs.push(...refsByFolder.images), videoRefs.push(...refsByFolder.videos), audioRefs.push(...refsByFolder.audios);
      const buildFilesFromRefs = (refs, folder, fallbackType) => {
          const files = [],
            seenRefs = new Set();
          for (const refName of refs) {
            const refKey = stripFileExtension(refName).toLowerCase();
            if (seenRefs.has(refKey)) continue;
            seenRefs.add(refKey);
            const matches = Object.keys(zipEntries).filter(entryName => {
                if (!entryName.startsWith("media/" + folder + "/") && !(taskMediaPrefix && entryName.startsWith(taskMediaPrefix + "/" + folder + "/"))) return false;
                const entryBaseName = entryName.split("/").pop() || "";
                return stripFileExtension(entryBaseName).toLowerCase() === refKey;
              }),
              zipKey = matches[0],
              fileData = zipKey ? zipEntries[zipKey] : null;
            if (fileData && zipKey) {
              const fileName = zipKey.split("/").pop() || refName,
                extension = (fileName.split(".").pop() || "").toLowerCase(),
                mimeByExt = {
                  jpg: "image/jpeg",
                  jpeg: "image/jpeg",
                  png: "image/png",
                  webp: "image/webp",
                  gif: "image/gif",
                  mp4: "video/mp4",
                  mp3: "audio/mpeg",
                  wav: "audio/wav",
                  aac: "audio/aac",
                  m4a: "audio/mp4"
                };
              files.push(new File([fileData], fileName, {
                type: mimeByExt[extension] || fallbackType
              }));
            }
          }
          return files;
        },
        imageFiles = buildFilesFromRefs(imageRefs, "images", "image/jpeg"),
        videoFiles = buildFilesFromRefs(videoRefs, "videos", "video/mp4"),
        audioFiles = buildFilesFromRefs(audioRefs, "audios", "audio/mpeg"),
        payloadSnapshot = {
          promptText: settings.promptText,
          images: imageFiles.map(imageFile => ({
            name: imageFile.name,
            type: imageFile.type,
            lastModified: imageFile.lastModified,
            size: imageFile.size
          })),
          videos: videoFiles.map(videoFile => ({
            name: videoFile.name,
            type: videoFile.type,
            lastModified: videoFile.lastModified,
            size: videoFile.size
          })),
          audios: audioFiles.map(audioFile => ({
            name: audioFile.name,
            type: audioFile.type,
            lastModified: audioFile.lastModified,
            size: audioFile.size
          }))
        },
        task = createTaskRecord(settings, payloadSnapshot);
      jqApplyImportedTaskMeta(task, row, columnMap);
      await saveTaskPayload(task.id, {
        promptText: settings.promptText,
        imageFiles: imageFiles,
        videoFiles: videoFiles,
        audioFiles: audioFiles
      }), jqTasks.push(task), importedCount += 1;
    }
    importedCount > 0 ? (renderQueue(), await saveTasks(), appendLog("✅ ZIP 导入完成：新增 " + importedCount + " 个任务" + (skippedRows ? "，跳过 " + skippedRows + " 行" : ""))) : appendLog("⚠️ 未导入任何任务" + (skippedRows ? "（跳过 " + skippedRows + " 行）" : ""));
  } catch (error) {
    appendLog("❌ ZIP 导入失败: " + (error.message || error));
  }
}
async function importJsonBackup(jsonFile) {
  try {
    if (!jsonFile) {
      appendLog("❌ 未选择文件");
      return;
    }
    appendLog("正在读取导入文件...");
    const jsonText = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || "")), reader.onerror = () => reject(new Error("文件读取失败")), reader.readAsText(jsonFile);
      }),
      backupData = JSON.parse(jsonText);
    if (!Array.isArray(backupData?.tasks)) throw new Error("JSON 格式无效，未找到 tasks 数组");
    appendLog("正在导入 " + backupData.tasks.length + " 个任务...");
    let importedCount = 0,
      failedCount = 0;
    for (const importedTask of backupData.tasks) {
      try {
        if (!importedTask?.settings) {
          failedCount++;
          continue;
        }
        const settings = importedTask.settings,
          payload = importedTask.payload || {
            promptText: "",
            images: [],
            videos: [],
            audios: []
          },
          task = createTaskRecord(settings, {
            promptText: payload.promptText || "",
            images: payload.images || [],
            videos: payload.videos || [],
            audios: payload.audios || []
          }),
          payloadFiles = {
            promptText: payload.promptText || "",
            imageFiles: [],
            videoFiles: [],
            audioFiles: []
          };
        for (const imageRecord of payload.images || []) {
          if (imageRecord.dataUrl) {
            const imageFile = await (async () => {
              const blob = await fetch(imageRecord.dataUrl).then(response => response.blob());
              return new File([blob], imageRecord.name || "image-" + Date.now(), {
                type: imageRecord.type,
                lastModified: imageRecord.lastModified
              });
            })();
            payloadFiles.imageFiles.push(imageFile);
          }
        }
        for (const videoRecord of payload.videos || []) {
          if (videoRecord.dataUrl) {
            const videoFile = await (async () => {
              const blob = await fetch(videoRecord.dataUrl).then(response => response.blob());
              return new File([blob], videoRecord.name || "video-" + Date.now(), {
                type: videoRecord.type,
                lastModified: videoRecord.lastModified
              });
            })();
            payloadFiles.videoFiles.push(videoFile);
          }
        }
        for (const audioRecord of payload.audios || []) {
          if (audioRecord.dataUrl) {
            const audioFile = await (async () => {
              const blob = await fetch(audioRecord.dataUrl).then(response => response.blob());
              return new File([blob], audioRecord.name || "audio-" + Date.now(), {
                type: audioRecord.type,
                lastModified: audioRecord.lastModified
              });
            })();
            payloadFiles.audioFiles.push(audioFile);
          }
        }
        await saveTaskPayload(task.id, payloadFiles), jqTasks.push(task), importedCount++;
      } catch (error) {
        failedCount++, appendLog("⚠️ 导入任务失败: " + (error.message || error));
      }
    }
    importedCount > 0 ? (renderQueue(), await saveTasks(), appendLog("✅ 已导入 " + importedCount + " 个任务" + (failedCount > 0 ? "（失败 " + failedCount + " 个）" : ""))) : appendLog("❌ 没有任务被成功导入（失败 " + failedCount + " 个）");
  } catch (error) {
    appendLog("❌ 导入失败: " + (error.message || error));
  }
}
function renderQueue() {
  jqFinalizeExpiredGenerating();
  const queueCardsEl = getEl("queueCards"),
    queueEmptyEl = getEl("queueEmpty"),
    queueCountEl = getEl("queueCount");
  jqBindQueueSearch();
  if (!queueCardsEl || !queueEmptyEl || !queueCountEl) return;
  const projectTasks = jqVisibleTasks(),
    filteredTasks = jqFilterTasksBySearch(projectTasks),
    activeProjectName = jqProjectNameById(jqActiveProjectId);
  const queueTitleEl = getEl("queueTitle");
  if (queueTitleEl) queueTitleEl.textContent = activeProjectName;
  queueCountEl.textContent = projectTasks.length + " 个任务";
  jqRenderSearchState(projectTasks.length, filteredTasks.length);
  queueEmptyEl.textContent = projectTasks.length ? jqSearchNormalize(jqQueueSearchText) ? "没有匹配的任务卡片。" : "当前项目暂无任务卡片，先在左侧设置参数后提交。" : "当前项目暂无任务卡片，先在左侧设置参数后提交。";
  queueEmptyEl.style.display = filteredTasks.length ? "none" : "block";
  queueCardsEl.innerHTML = filteredTasks.map((task, visibleIndex) => {
    const taskSettings = task.settings || {},
      promptPreview = task.payload?.promptText || "（无提示词）",
      imageCount = task.payload?.images?.length || 0,
      videoCount = task.payload?.videos?.length || 0,
      audioCount = task.payload?.audios?.length || 0,
      canMoveUp = visibleIndex > 0 && task.status !== "running",
      canMoveDown = visibleIndex < filteredTasks.length - 1 && task.status !== "running",
      executeText = task.status === "done" || task.status === "generating" ? "再执行" : "执行",
      skipText = task.status === "skipped" ? "恢复排队" : "跳过",
      isRunningTask = task.status === "running",
      hasActiveGeneration = task.status === "generating" || jqTaskRuns(task).some(run => run.status === "generating"),
      pauseActiveClass = isRunningTask ? " active" : "",
      repeatTotal = jqTaskRepeatTotal(task),
      repeatDone = jqTaskRepeatDone(task),
      repeatRemaining = jqTaskRemaining(task),
      displayRunIndex = task.status === "done" || task.status === "generating" ? repeatTotal : Math.min(repeatTotal, repeatDone + 1),
      repeatBadgeHtml = "<span class=\"task-card-repeat\">第 " + displayRunIndex + "/" + repeatTotal + " 次</span>",
      escapedTaskTitle = jqEscapeHtml(task.taskName || "任务 #" + task.id);
    return "<article class=\"task-card status-" + task.status + (hasActiveGeneration ? " is-generating" : "") + "\" data-task-id=\"" + task.id + "\"><div class=\"task-card-head\"><div class=\"task-card-title-wrap\"><div class=\"task-card-title\" title=\"" + escapedTaskTitle + "\">" + escapedTaskTitle + "</div><div class=\"task-card-subtitle\">#" + task.id + " · " + jqEscapeHtml(activeProjectName) + "</div></div><span class=\"task-status\">" + jqEscapeHtml(jqTaskStatusLabel(task)) + "</span><button type=\"button\" class=\"task-card-close\" data-action=\"cancel\" data-task-id=\"" + task.id + "\" " + (task.status === "running" ? "disabled" : "") + " aria-label=\"删除任务\">×</button></div><div class=\"task-card-summary\">" + jqEscapeHtml(taskSettings.model || "") + " · " + jqEscapeHtml(taskSettings.refMode || "") + " · " + jqEscapeHtml(taskSettings.ratio || "") + " · " + jqEscapeHtml(taskSettings.duration || "") + " " + repeatBadgeHtml + "</div><div class=\"task-card-repeat-detail\">已执行 " + repeatDone + " 次，剩余 " + repeatRemaining + " 次</div><div class=\"task-card-media\">图片 " + imageCount + " 张，视频 " + videoCount + " 个，音频 " + audioCount + " 个</div>" + jqTaskRunsHtml(task) + "<div class=\"task-card-prompt\">" + jqEscapeHtml(promptPreview) + "</div>" + (task.errorMessage ? "<div class=\"task-card-error\">" + jqEscapeHtml(task.errorMessage) + "</div>" : "") + "<div class=\"task-card-actions\"><button type=\"button\" class=\"task-action-btn edit\" data-action=\"edit\" data-task-id=\"" + task.id + "\" " + (task.status === "running" ? "disabled" : "") + ">编辑</button><button type=\"button\" class=\"task-action-btn move\" data-action=\"up\" data-task-id=\"" + task.id + "\" " + (canMoveUp ? "" : "disabled") + ">上移</button><button type=\"button\" class=\"task-action-btn move\" data-action=\"down\" data-task-id=\"" + task.id + "\" " + (canMoveDown ? "" : "disabled") + ">下移</button><button type=\"button\" class=\"task-action-btn execute\" data-action=\"execute\" data-task-id=\"" + task.id + "\" " + (task.status === "running" || task.status === "cancelled" ? "disabled" : "") + ">" + executeText + "</button><button type=\"button\" class=\"task-action-btn skip\" data-action=\"skip\" data-task-id=\"" + task.id + "\" " + (task.status === "running" || task.status === "cancelled" ? "disabled" : "") + ">" + skipText + "</button><button type=\"button\" class=\"task-action-btn pause" + pauseActiveClass + "\" data-action=\"pause\" data-task-id=\"" + task.id + "\" " + (isRunningTask ? "" : "disabled") + ">暂停</button></div></article>";
  }).join("");
  jqRenderProjects();
  jqRenderQueueOverview();
  jqRenderStatsPanel();
  const runAllBtn = getEl("runAll"),
    pauseAllBtn = getEl("pauseAllTasks"),
    autoResumeActive = !!queueAutoResumeEnabled;
  runAllBtn && (runAllBtn.textContent = "开始执行队列", runAllBtn.disabled = false, runAllBtn.classList.toggle("active", autoResumeActive), runAllBtn.setAttribute("aria-pressed", autoResumeActive ? "true" : "false"));
  pauseAllBtn && (pauseAllBtn.disabled = !(isQueueRunning || isQueueLoopActive), pauseAllBtn.classList.toggle("active", isQueueLoopActive && queuePaused));
}
function findTaskById(taskId) {
  return jqTasks.find(task => task.id === taskId) || null;
}
function resetTaskForm() {
  const promptEl = getEl("promptText");
  if (promptEl) promptEl.value = "";
  jqImageFiles = [], jqVideoFiles = [], jqAudioFiles = [], jqAutoMaterialFiles.clear();
  const imageInputEl = getEl("imageFiles"),
    videoInputEl = getEl("videoFiles"),
    audioInputEl = getEl("audioFiles");
  if (imageInputEl) imageInputEl.value = "";
  if (videoInputEl) videoInputEl.value = "";
  if (audioInputEl) audioInputEl.value = "";
  const repeatInputEl = getEl("taskRepeatInput");
  if (repeatInputEl) repeatInputEl.value = "1";
  hideAtDropdown();
}
async function loadQueueAutoResumeToggle() {
  try {
    const storedAutoResumeEnabled = await storageGetLocal(queueAutoResumeStoreKey);
    queueAutoResumeEnabled = !!storedAutoResumeEnabled;
  } catch {
    queueAutoResumeEnabled = false;
  }
}
async function quickCheckSubmitAccepted(tabId, baselineCount = null, logPrefix = "", heartbeat = null) {
  const tick = () => {
      if (typeof heartbeat === "function") heartbeat();
    },
    retryDelays = [300, 550, 850];
  for (let attemptIndex = 0; attemptIndex < retryDelays.length; attemptIndex += 1) {
    tick();
    const currentCount = await countGeneratingCardsOnPage(tabId),
      baselineForCompare = Number.isFinite(baselineCount) ? baselineCount : null;
    if (Number.isFinite(currentCount) && currentCount >= 0) {
      if (baselineForCompare !== null && currentCount > baselineForCompare) return {
        accepted: true,
        current: currentCount,
        baseline: baselineForCompare
      };
    }
    // 后端钩子兜底：计数不可信（页面滚动漏数等）时，靠"提交后出现新平台记录"判受理
    if (await jqHookAccepted()) return {
      accepted: true,
      reason: "hook-new-record",
      baseline: Number.isFinite(baselineCount) ? baselineCount : null
    };
    attemptIndex < retryDelays.length - 1 && (await sleep(retryDelays[attemptIndex]));
  }
  return logPrefix && appendLog(logPrefix + " 快速判定未发现受理增长，视为提交失败"), {
    accepted: false,
    baseline: Number.isFinite(baselineCount) ? baselineCount : null
  };
}
function isSubmitRelatedError(error) {
  const errorMessage = String(error || "");
  return /(\[submit\]|提交后|受理|提交按钮|快速判定未发现受理增长)/.test(errorMessage);
}
async function addTaskCard() {
  if (!canRunAction("加入任务")) return;
  try {
    syncFormOptions();
    const settings = {
        ...readTaskSettingsForm()
      },
      formPayload = readTaskPayloadForm(),
      validation = await validateTaskPayload(formPayload, {
        showAlert: true
      }),
      payloadForSubmit = {
        ...formPayload,
        promptText: validation.promptTextForSubmit
      },
      payloadSnapshot = buildTaskPayloadSnapshot(payloadForSubmit),
      repeatTotal = jqCurrentTaskRepeat(),
      task = createTaskRecord({
        ...settings
      }, JSON.parse(JSON.stringify(payloadSnapshot)));
    task.projectId = jqActiveProjectId || "default";
    task.taskName = jqCurrentTaskName();
    task.repeatTotal = repeatTotal;
    task.repeatDone = 0;
    jqApplyTaskNumberPrefix(task, payloadForSubmit);
    await saveTaskPayload(task.id, payloadForSubmit);
    jqTasks.unshift(task);
    jqSortTasksDesc();
    renderQueue();
    await saveTasks();
    resetTaskForm();
    const taskNameInputEl = getEl("taskNameInput");
    if (taskNameInputEl) taskNameInputEl.value = "";
    const repeatInputEl = getEl("taskRepeatInput");
    if (repeatInputEl) repeatInputEl.value = "1";
    await refreshUploadSummary();
    appendLog("✅ 已添加到「" + jqProjectNameById(jqActiveProjectId) + "」：1 个任务，生成次数 " + repeatTotal + " 次");
    if (!queueAutoResumeEnabled && !queueUserStopped) {
      await setQueueAutoResumeEnabled(true);
      jqBeginRunSession();
      appendLog("▶️ 已随添加任务开启队列执行");
    }
    if (queueUserStopped && !queueAutoResumeEnabled) appendLog("⏸ 队列已手动停止，任务已加入但不会自动执行，点「开始执行队列」恢复");
    queueAutoResumeEnabled && !isQueueLoopActive && !isQueueRunning && (appendLog("▶️ 队列将开始执行所有项目中的已添加任务"), runQueue().catch(queueStartError => appendLog("❌ 队列启动失败: " + (queueStartError.message || queueStartError))));
  } catch (error) {
    appendLog("❌ 加入任务失败: " + (error.message || error));
  }
}
function toggleTaskSkipped(taskId) {
  const task = findTaskById(taskId);
  if (!task || task.status === "running" || task.status === "cancelled") return;
  task.status = task.status === "skipped" ? "pending" : "skipped", task.errorMessage = "", renderQueue(), saveTasks();
}
function deleteTask(taskId) {
  const task = findTaskById(taskId);
  if (!task || task.status === "running") return;
  const taskIndex = jqTasks.findIndex(task => task.id === taskId);
  if (taskIndex >= 0) jqTasks.splice(taskIndex, 1);
  deleteTaskPayloadRecord(taskId)["catch"](() => {}), renderQueue(), saveTasks();
}
async function fileFromDataUrlRecord(fileRecord, fallbackKind) {
  const blob = await fetch(fileRecord.dataUrl).then(response => response.blob());
  return new File([blob], fileRecord.name || fallbackKind + "-" + Date.now(), {
    type: fileRecord.type || blob.type || "application/octet-stream",
    lastModified: fileRecord.lastModified || Date.now()
  });
}
async function migrateInlinePayloadToDb(task) {
  if (!task || !payloadHasInlineDataUrls(task.payload)) return false;
  const inlinePayload = task.payload || {},
    imageRecords = (await Promise.all((inlinePayload.images || []).map(imageRecord => storedDataUrlToFileRecord(imageRecord, "image")))).filter(Boolean),
    videoRecords = (await Promise.all((inlinePayload.videos || []).map(videoRecord => storedDataUrlToFileRecord(videoRecord, "video")))).filter(Boolean),
    audioRecords = (await Promise.all((inlinePayload.audios || []).map(audioRecord => storedDataUrlToFileRecord(audioRecord, "audio")))).filter(Boolean);
  return await putTaskPayloadRecord({
    taskId: task.id,
    promptText: String(inlinePayload.promptText || ""),
    images: imageRecords,
    videos: videoRecords,
    audios: audioRecords,
    updatedAt: Date.now()
  }), true;
}
async function editTaskToForm(taskId) {
  try { window.jqExpandComposerDefault && window.jqExpandComposerDefault(); } catch {}
  const task = findTaskById(taskId);
  if (!task) return;
  const settings = task.settings || {};
  if (getEl("genMode") && settings.genMode) getEl("genMode").value = settings.genMode;
  jqSyncRefModeOptions(settings.model || getEl("model")?.value || "");
  if (getEl("refMode") && settings.refMode) getEl("refMode").value = settings.refMode;
  renderModelOptions(modelOptionsForRefMode(getEl("refMode").value));
  if (getEl("model") && settings.model) {
    const hasModelOption = Array.from(getEl("model").options).some(modelOption => modelOption.value === settings.model);
    if (hasModelOption) getEl("model").value = settings.model;
  }
  renderDurationOptions(durationOptionsForRefMode(getEl("refMode").value, getEl("model").value));
  if (getEl("ratio") && settings.ratio) getEl("ratio").value = settings.ratio;
  if (getEl("resolution") && settings.resolution) getEl("resolution").value = settings.resolution;
  if (getEl("genCount") && settings.count) getEl("genCount").value = String(settings.count);
  if (getEl("duration") && settings.duration) {
    const hasDurationOption = Array.from(getEl("duration").options).some(durationOption => durationOption.value === settings.duration);
    if (hasDurationOption) getEl("duration").value = settings.duration;
  }
  syncFormOptions();
  jqApplyCountLock();
  jqUpdateModelChipLabel();
  jqUpdateRefModeChipLabel();
  jqUpdateDurationChipLabel();
  jqUpdateRatioComboLabel();
  const ratioPop = getEl("ratioPopover");
  if (ratioPop) {
    const curRatio = getEl("ratio").value, curRes = getEl("resolution").value, curCount = getEl("genCount").value;
    ratioPop.querySelectorAll('.jm-pop-opts[data-group="ratio"] button').forEach(b => b.classList.toggle("on", b.dataset.val === curRatio));
    ratioPop.querySelectorAll('.jm-pop-opts[data-group="resolution"] button').forEach(b => b.classList.toggle("on", b.dataset.val === curRes));
    ratioPop.querySelectorAll('.jm-pop-opts[data-group="count"] button').forEach(b => b.classList.toggle("on", b.dataset.val === curCount));
  }
  const storedPayload = await getTaskPayloadRecord(task.id);
  let imageFiles = [],
    videoFiles = [],
    audioFiles = [],
    promptText = "";
  if (storedPayload) {
    const restoredPayload = await restorePayloadFiles(storedPayload);
    promptText = restoredPayload?.promptText || "", imageFiles = restoredPayload?.imageFiles || [], videoFiles = restoredPayload?.videoFiles || [], audioFiles = restoredPayload?.audioFiles || [];
  } else promptText = task.payload?.promptText || "", imageFiles = await Promise.all((task.payload?.images || []).filter(imageRecordWithDataUrl => imageRecordWithDataUrl?.dataUrl).map(imageRecord => fileFromDataUrlRecord(imageRecord, "image"))), videoFiles = await Promise.all((task.payload?.videos || []).filter(videoRecordWithDataUrl => videoRecordWithDataUrl?.dataUrl).map(videoRecord => fileFromDataUrlRecord(videoRecord, "video"))), audioFiles = await Promise.all((task.payload?.audios || []).filter(audioRecordWithDataUrl => audioRecordWithDataUrl?.dataUrl).map(audioRecord => fileFromDataUrlRecord(audioRecord, "audio")));
  getEl("promptText").value = jqStripTaskNumberPrefix(promptText);
  try { jqUpdatePromptCharCount(); } catch (e) {}
  const taskNameInputEl = getEl("taskNameInput");
  if (taskNameInputEl) taskNameInputEl.value = String(task.taskName || "");
  jqImageFiles = imageFiles, jqVideoFiles = videoFiles, jqAudioFiles = audioFiles, await refreshUploadSummary(), appendLog("✅ 已回填任务 #" + task.id + " 到左侧");
}
function moveTask(taskId, direction) {
  const visibleTasks = jqVisibleTasks(),
    visibleIndex = visibleTasks.findIndex(task => task.id === taskId);
  if (visibleIndex < 0) return;
  const targetVisibleIndex = direction === "up" ? visibleIndex - 1 : visibleIndex + 1;
  if (targetVisibleIndex < 0 || targetVisibleIndex >= visibleTasks.length) return;
  const sourceIndex = jqTasks.findIndex(task => task.id === visibleTasks[visibleIndex].id),
    targetIndex = jqTasks.findIndex(task => task.id === visibleTasks[targetVisibleIndex].id);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const movingTask = jqTasks[sourceIndex];
  jqTasks[sourceIndex] = jqTasks[targetIndex];
  jqTasks[targetIndex] = movingTask;
  renderQueue();
  saveTasks();
}
function clearCurrentProjectTasks() {
  const visibleTasks = jqVisibleTasks();
  if (!visibleTasks.length) {
    appendLog("✓ 当前项目没有可清空的卡片");
    return;
  }
  const wasRunning = isQueueRunning || isQueueLoopActive;
  wasRunning && (pauseAllQueue("清空当前项目卡片后已暂停全部，停止后续任务"), resolveQueueResumeWaiter());
  const idsToDelete = new Set(visibleTasks.map(task => task.id));
  jqTasks = jqTasks.filter(task => !idsToDelete.has(task.id));
  idsToDelete.forEach(taskId => deleteTaskPayloadRecord(taskId).catch(() => {}));
  renderQueue();
  saveTasks();
  setQueueAutoResumeEnabled(false).catch(() => {});
  if (wasRunning) {
    appendLog("⏸ 已清空当前项目卡片，当前步骤结束后将停止全部后台任务");
    return;
  }
  appendLog("✅ 已清空「" + jqProjectNameById(jqActiveProjectId) + "」项目卡片");
}
function pauseAllTasks() {
  if (!isQueueLoopActive && !isQueueRunning) {
    appendLog("ℹ️ 当前没有执行中的任务");
    return;
  }
  pauseAllQueue("已手动暂停全部，停止后续任务"), renderQueue(), appendLog("⏸ 已请求暂停，当前步骤完成后停止");
}
function pauseSingleTask(taskId) {
  const task = findTaskById(taskId);
  if (!task) {
    appendLog("❌ 未找到任务 #" + taskId);
    return;
  }
  if (task.status !== "running") {
    appendLog("ℹ️ 仅执行中的任务可暂停（任务 #" + taskId + "）");
    return;
  }
  pauseTaskQueue(taskId, "已暂停任务 #" + taskId), appendLog("⏸ 已请求暂停任务 #" + taskId + "，当前步骤完成后停止该任务");
}
let jqLocateLastId = null;
function locateRunningTask() {
  // 可定位列表：提交中(running) 在前，然后生成中(generating) 按提交时间排序。
  // 每次点击轮巡到下一条，连点可遍历所有并发生成的任务。
  const running = (jqTasks || []).filter(t => t && t.status === "running");
  const gens = (jqTasks || []).filter(t => t && t.status === "generating")
    .sort((a, b) => jqGeneratingSubmittedAt(a) - jqGeneratingSubmittedAt(b));
  const list = running.concat(gens);
  if (!list.length) {
    const fallbackCard = document.querySelector(".task-card.status-running,.task-card.status-generating");
    if (!fallbackCard) {
      appendLog(isQueueRunning ? "ℹ️ 当前任务正在启动中，请稍后再定位" : "ℹ️ 当前没有可定位的任务卡片");
      return;
    }
    fallbackCard.classList.remove("locate-running");
    void fallbackCard.offsetWidth;
    fallbackCard.classList.add("locate-running");
    fallbackCard.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => { fallbackCard.classList.remove("locate-running"); }, 1200);
    return;
  }
  let idx = list.findIndex(t => String(t.id) === String(jqLocateLastId));
  idx = (idx + 1) % list.length; // 未找到(-1)→0=第一条；否则前进一位
  const task = list[idx];
  jqLocateLastId = task.id;
  const pid = jqTaskProjectId(task);
  if (pid && pid !== jqActiveProjectId) jqSetActiveProject(pid);
  window.requestAnimationFrame(() => {
    const card = document.querySelector(".task-card[data-task-id=\"" + task.id + "\"]");
    if (!card) {
      appendLog("ℹ️ 任务 #" + task.id + " 所在项目已切换，但卡片暂未渲染");
      return;
    }
    card.classList.remove("locate-running");
    void card.offsetWidth;
    card.classList.add("locate-running");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => { card.classList.remove("locate-running"); }, 1200);
    appendLog("ℹ️ 已定位 #" + task.id + (list.length > 1 ? "（" + (idx + 1) + "/" + list.length + "）" : ""));
  });
}
async function submitTaskToJimeng(tabId, settings, payload, logPrefix = "", heartbeat = null) {
  const isFirstLastFrame = isFirstLastFrameMode(settings.refMode),
    logPrefixText = logPrefix ? logPrefix + " " : "",
    tick = () => {
      if (typeof heartbeat === "function") heartbeat();
    };
  tick();
  if (isFirstLastFrame) {
    const allReferenceSettings = {
        ...settings,
        refMode: "全能参考"
      },
      firstLastPreSteps = ["genMode", "refMode"];
    for (const stepName of firstLastPreSteps) {
      tick(), appendLog(logPrefixText + "执行步骤: " + stepName + "...");
      const stepSettings = stepName === "refMode" ? allReferenceSettings : settings,
        stepResult = await retryPageStep(tabId, stepName, stepSettings, stepRetryCounts[stepName] || 2, null);
      if (!stepResult?.ok) throw new Error("[" + stepName + "] " + (stepResult?.error || "失败"));
      appendLog(logPrefixText + "✅ " + stepName + " 成功"), await sleep(stepDelayMs[stepName] || 300);
    }
    tick(), appendLog(logPrefixText + "上传图片和提示词...");
    const uploadResult = await submitPayloadOnPage(tabId, payload, settings.refMode, "content", maxImageCountForSettings(settings.refMode, settings.model));
    if (!uploadResult?.ok) throw new Error("[upload] " + (uploadResult?.error || "失败"));
    appendLog(logPrefixText + "✅ 内容上传成功"), appendLog(logPrefixText + "切换参考模式为首尾帧...");
    const restoreRefResult = await retryPageStep(tabId, "refMode", settings, stepRetryCounts.refMode || 2, null);
    if (!restoreRefResult?.ok) throw new Error("[refMode-restore] " + (restoreRefResult?.error || "失败"));
    appendLog(logPrefixText + "✅ 参考模式已切换为首尾帧");
    const firstLastPostSteps = ["model", "ratio", "duration"];
    for (const postStepName of firstLastPostSteps) {
      tick(), appendLog(logPrefixText + "执行步骤: " + postStepName + "...");
      const postStepResult = await retryPageStep(tabId, postStepName, settings, stepRetryCounts[postStepName] || 2, null);
      if (!postStepResult?.ok) throw new Error("[" + postStepName + "] " + (postStepResult?.error || "失败"));
      appendLog(logPrefixText + "✅ " + postStepName + " 成功"), await sleep(stepDelayMs[postStepName] || 300);
    }
    await sleep(1000), tick(), appendLog(logPrefixText + "点击提交生成...");
    const submitResult = await submitPayloadOnPage(tabId, null, "", "click");
    if (!submitResult?.ok) throw new Error("[submit] " + (submitResult?.error || "失败"));
    appendLog(logPrefixText + "✅ 提交成功");
    return;
  }
  const steps = isUltraLongVideoMode(settings.refMode) ? ["genMode", "model", "refMode", "ratio", "duration", "submit"] : ["genMode", "refMode", "model", "ratio", "duration", "submit"];
  for (const stepName of steps) {
    tick(), appendLog(logPrefixText + "执行步骤: " + stepName + "...");
    const stepPayload = stepName === "submit" ? payload : null,
      stepResult = await retryPageStep(tabId, stepName, settings, stepRetryCounts[stepName] || 2, stepPayload);
    if (!stepResult?.ok) throw new Error("[" + stepName + "] " + (stepResult?.error || "失败"));
    appendLog(logPrefixText + "✅ " + stepName + " 成功"), await sleep(stepDelayMs[stepName] || 300);
  }
}
async function executeTask(taskRef) {
  const task = findTaskById(taskRef.id);
  if (!task) return;
  task.status = "running";
  task.errorMessage = "";
  jqRecordTaskStart(task);
  renderQueue();
  try {
    const modelName = task.settings?.model || "",
      maxSubmitAttempts = retrySubmitOnceEnabled ? 2 : 1;
    let submitAttempt = 0,
      lastError = null;
    while (submitAttempt < maxSubmitAttempts) {
      submitAttempt += 1;
      assertQueueNotPaused();
      let baselineCount = null;
      if (monitorEnabled) try {
        const monitorTab = await getJimengTab(),
          monitorResponse = await sendRuntimeMessage({
            type: "W4_BG_CHECK_ONCE",
            tabId: monitorTab.id
          });
        if (monitorResponse?.ok) {
          applyMonitorState(monitorResponse.state);
          const monitorSlot = modelSlotFromMonitorState(monitorResponse.state, modelName);
          baselineCount = monitorSlot.reliable ? monitorSlot.currentCount : null;
        }
      } catch {}
      try {
        const reloadTab = await getJimengTab();
        appendLog("[任务 #" + task.id + "] 正在刷新页面...");
        await chrome.tabs.reload(reloadTab.id);
        await sleep(2000);
        assertQueueNotPaused();
        const submitTab = await getJimengTab();
        let quickBaselineCount = null;
        retrySubmitOnceEnabled && !monitorEnabled && (quickBaselineCount = await countGeneratingCardsOnPage(submitTab.id));
        let executablePayload = await loadExecutableTaskPayload(task);
        await jqHookMarkSubmit(); // 提交前打标记：之后出现的新平台记录 = 本次提交被受理
        await submitTaskToJimeng(submitTab.id, task.settings, executablePayload, "[任务 #" + task.id + "]", assertQueueNotPaused);
        if (monitorEnabled) {
          const monitorAcceptResult = await confirmSubmitAcceptedByMonitor(baselineCount, modelName, "[任务 #" + task.id + "]", assertQueueNotPaused);
          if (!monitorAcceptResult.accepted) throw new Error("提交后未被平台受理（超时）");
        }
        if (retrySubmitOnceEnabled && !monitorEnabled) {
          const quickAcceptResult = await quickCheckSubmitAccepted(submitTab.id, quickBaselineCount, "[任务 #" + task.id + "]", assertQueueNotPaused);
          if (!quickAcceptResult.accepted) throw new Error("提交后快速判定未发现受理增长");
        }
        lastError = null;
        break;
      } catch (submitError) {
        lastError = submitError;
        const submitErrorMessage = submitError?.message || String(submitError),
          shouldRetrySubmit = retrySubmitOnceEnabled && submitAttempt < maxSubmitAttempts && isSubmitRelatedError(submitErrorMessage) && !/暂停全部|停止后续任务/.test(submitErrorMessage);
        if (!shouldRetrySubmit) break;
        appendLog("[任务 #" + task.id + "] 提交失败，正在重新提交第 " + submitAttempt + " 次...");
      }
    }
    if (lastError) throw lastError;
    markModelSubmitCooldown(modelName);
    const submittedAt = Date.now(),
      repeatTotal = jqTaskRepeatTotal(task),
      repeatDone = Math.min(repeatTotal, jqTaskRepeatDone(task) + 1);
    task.repeatDone = repeatDone;
    task.lastSubmittedAt = submittedAt;
    task.platformSubmittedAt = submittedAt;
    task.completedAt = null;
    task.autoFinalized = false;
    task.submitSessionId = jqRunSessionId || null;
    task.errorMessage = "";
    // 本次执行追加一条独立 run（不覆盖此前任何一次）；seq 按真实执行次数单调递增，
    // 手动"再执行"超出计划次数时显示为更大序号，避免与已有次数冲突。后续由平台真同步绑定 record/耗时
    jqEnsureTaskRuns(task);
    if (!Array.isArray(task.runs)) task.runs = [];
    const runSeq = task.runs.length + 1;
    task.runs.push({
      seq: runSeq,
      runId: "t" + task.id + "-r" + runSeq,
      submittedAt: submittedAt,
      completedAt: 0,
      durationMs: 0,
      status: "generating",
      platformKey: "",
      finalizedReason: "",
      errorMessage: ""
    });
    jqRecordTaskSubmitted(task);
    // 旧启发式 jqCompletePreviousGenerating 已移除：它在提交新任务时会把其它"生成中"
    // 任务直接标"已完成"，覆盖真实状态。改由 jqSyncTaskStatusFromPlatform（即梦真同步）
    // + 2 小时超时兜底来处理"生成中→已完成"。
    if (repeatDone < repeatTotal) {
      task.status = "pending";
      appendLog("✅ 任务 #" + task.id + " 已提交第 " + repeatDone + "/" + repeatTotal + " 次，剩余 " + (repeatTotal - repeatDone) + " 次");
    } else {
      task.status = "generating";
      appendLog("✅ 任务 #" + task.id + " 已交给平台生成（" + repeatDone + "/" + repeatTotal + "）");
    }
  } catch (taskError) {
    const taskErrorMessage = taskError?.message || String(taskError),
      isSingleTaskPause = queuePauseScope === "task" && queuePausedTaskId === task.id;
    if (isSingleTaskPause) {
      task.status = "skipped";
      task.errorMessage = "";
      appendLog("⏸ 任务 #" + task.id + " 已暂停（仅当前任务）");
      clearQueuePause();
    } else if (/暂停全部|停止后续任务/.test(taskErrorMessage)) {
      task.status = "cancelled";
      task.errorMessage = taskErrorMessage;
      appendLog("⏸ 任务 #" + task.id + " 已暂停");
    } else {
      task.status = "failed";
      task.errorMessage = taskErrorMessage;
      // 记一条失败 run（本次尝试的序号 = 已成功次数 + 1），不影响此前已成功/生成中的 run
      jqEnsureTaskRuns(task);
      if (!Array.isArray(task.runs)) task.runs = [];
      const failSeq = task.runs.length + 1;
      task.runs.push({
        seq: failSeq,
        runId: "t" + task.id + "-r" + failSeq + "f",
        submittedAt: Date.now(),
        completedAt: 0,
        durationMs: 0,
        status: "failed",
        platformKey: "",
        finalizedReason: "error",
        errorMessage: taskErrorMessage
      });
      jqRecordTaskFailed(task, taskErrorMessage);
      appendLog("❌ 任务 #" + task.id + " 失败: " + task.errorMessage);
    }
  } finally {
    renderQueue();
    await saveTasks();
  }
}
async function retryFailedTasks() {
  if (!canRunAction("重试失败任务")) return;
  const failedTasks = jqTasks.filter(task => task.status === "failed" && jqTaskProjectId(task) === jqActiveProjectId);
  if (failedTasks.length === 0) {
    appendLog("✓ 当前项目暂无失败任务");
    return;
  }
  if (isQueueLoopActive && !queuePaused) {
    appendLog("⏳ 队列正在执行中");
    return;
  }
  if (isQueueRunning) {
    appendLog("⏳ 正在执行中，请稍候（重试失败任务）");
    return;
  }
  let resetCount = 0;
  for (const failedTask of failedTasks) {
    failedTask.status = "pending";
    failedTask.errorMessage = "";
    resetCount++;
  }
  await saveTasks();
  appendLog("🔄 已重置当前项目 " + resetCount + " 个失败任务为已添加，准备执行...");
  renderQueue();
  await runQueue();
}
async function executeSingleTask(taskId) {
  return withQueueBusyLock("任务 #" + taskId, async () => {
    if (!canRunAction("执行任务")) return;
    const task = findTaskById(taskId);
    if (!task) {
      appendLog("❌ 未找到任务 #" + taskId);
      return;
    }
    if (task.status === "cancelled") {
      appendLog("⚠️ 任务 #" + taskId + " 已中断，无法执行");
      return;
    }
    await waitForConcurrencySlot("[任务 #" + task.id + "]", task.settings?.model || "", assertQueueNotPaused), await executeTask(task);
  });
}
async function runManualStep(stepName) {
  return withQueueBusyLock("步骤 " + stepName, async () => {
    if (!canRunAction("步骤执行")) return;
    try {
      const tab = await getJimengTab();
      syncFormOptions();
      const settings = readTaskSettingsForm();
      appendLog("执行步骤: " + stepName + "...");
      const payload = stepName === "submit" ? await buildCurrentSerializablePayload() : null,
        stepResult = await retryPageStep(tab.id, stepName, settings, 2, payload);
      if (!stepResult?.ok) throw new Error(stepResult?.error || "执行失败");
      appendLog("✅ " + stepName + " 成功");
    } catch (error) {
      appendLog("❌ " + stepName + " 失败: " + (error.message || error));
    }
  });
}
async function runQueue() {
  if (!canRunAction("开始执行队列")) return;
  if (!isQueueLoopActive || queuePaused) jqBeginRunSession();
  if (isQueueLoopActive && queuePaused) {
    await setQueueAutoResumeEnabled(true);
    clearQueuePause();
    resolveQueueResumeWaiter();
    appendLog("▶️ 自动续跑已开启，队列恢复排队");
    renderQueue();
    return;
  }
  if (isQueueLoopActive) {
    appendLog("⏳ 队列正在执行中");
    return;
  }
  if (isQueueRunning) {
    appendLog("⏳ 正在执行中，请稍候（开始执行队列）");
    return;
  }
  const hasPendingTasks = () => jqTasks.some(task => task.status === "pending");
  if (!hasPendingTasks()) {
    appendLog(queueAutoResumeEnabled ? "🟢 自动续跑已开启，暂无任务，等待新任务加入" : "✓ 所有项目暂无已添加任务");
    renderQueue();
    return;
  }
  await setQueueAutoResumeEnabled(true);
  isQueueLoopActive = true;
  clearQueuePause();
  clearCachedJimengTab();
  setUiBusy(true);
  renderQueue();
  let processedCount = 0;
  try {
    while (true) {
      if (queuePaused) {
        if (queuePauseScope === "task") {
          clearQueuePause();
          renderQueue();
          continue;
        }
        appendLog("⏸ 队列执行已暂停，开启自动续跑后恢复排队");
        setUiBusy(false);
        renderQueue();
        await waitForQueueResume();
        setUiBusy(true);
        renderQueue();
        continue;
      }
      let runtimeQueueState = null;
      try { const runtimeStateResponse = await sendRuntimeMessage({ type: "W4_BG_GET_STATE" }); if (runtimeStateResponse?.ok) runtimeQueueState = runtimeStateResponse.state; } catch {}
      const nextTask = jqNextRunnablePendingTask(runtimeQueueState);
      if (!nextTask) break;
      // 队头阻塞防护：监控开启且拿到有效后台状态时，若选中任务的模型此刻无空位
      //（说明所有 pending 模型都满，jqNextRunnablePendingTask 回退到了队首），
      // 不进入对它的长阻塞，短暂轮询后回头重选，让任意先腾出空位的模型任务被接走。
      if (monitorEnabled && runtimeQueueState && !jqTaskModelHasFreeSlot(runtimeQueueState, nextTask)) {
        await sleep(monitorPollMs);
        continue;
      }
      const projectName = jqProjectNameById(jqTaskProjectId(nextTask));
      await waitForConcurrencySlot("[" + projectName + " 任务 #" + nextTask.id + "]", nextTask.settings?.model || "", assertQueueNotPaused);
      if (queuePaused) continue;
      await executeTask(nextTask);
      if (!queuePaused) processedCount += 1;
    }
    if (!queuePaused) {
      appendLog("✅ 所有项目队列执行完成，共处理 " + processedCount + " 个任务");
      if (processedCount > 0 && !hasPendingTasks()) {
        await setQueueAutoResumeEnabled(false);
        appendLog("⏹ 队列已处理完，自动续跑已关闭");
      }
    }
  } catch (error) {
    const errorMessage = error?.message || String(error);
    /暂停全部|停止后续任务/.test(errorMessage) ? appendLog("⏸ 队列执行已暂停") : appendLog("❌ 队列失败: " + errorMessage);
  } finally {
    isQueueLoopActive = false;
    jqEndRunSession();
    pauseResumeResolver = null;
    clearQueuePause();
    clearCachedJimengTab();
    setUiBusy(false);
    renderQueue();
  }
}
document.querySelectorAll("button[data-step]").forEach(stepButton => {
  stepButton.addEventListener("click", () => runManualStep(stepButton.dataset.step));
}), getEl("genMode") && getEl("genMode").addEventListener("change", () => { jqSyncRefModeOptions(); syncFormOptions(); }), getEl("refMode").addEventListener("change", () => { const previousRefMode = jqLastRefModeForDuration, currentRefMode = getEl("refMode").value, durationEl = getEl("duration"); if (previousRefMode && durationEl?.value) jqDurationByRefMode[durationMemoryKeyForRefMode(previousRefMode)] = durationEl.value; syncFormOptions(); const rememberedDuration = jqDurationByRefMode[durationMemoryKeyForRefMode(currentRefMode)]; if (durationEl && rememberedDuration && Array.from(durationEl.options).some(option => option.value === rememberedDuration)) durationEl.value = rememberedDuration; jqLastRefModeForDuration = currentRefMode; jqUpdateRefModeChipLabel(); jqUpdateDurationChipLabel(); }), getEl("model").addEventListener("change", () => { jqSyncRefModeOptions(); syncFormOptions(); jqApplyResolutionLock(); jqApplyCountLock(); jqUpdateRatioComboLabel(); jqUpdateModelChipLabel(); jqUpdateDurationChipLabel(); }), getEl("duration") && getEl("duration").addEventListener("change", () => { jqUpdateDurationChipLabel(); }), jqSyncRefModeOptions(), jqBindRatioCombo(), syncFormOptions(), jqUpdateModelChipLabel(), jqUpdateRefModeChipLabel(), jqUpdateDurationChipLabel();
const imageFilesInput = getEl("imageFiles");
imageFilesInput && imageFilesInput.addEventListener("change", () => {
  addImageFiles(Array.from(imageFilesInput.files || [])), imageFilesInput.value = "", refreshUploadSummary();
});
const videoFilesInput = getEl("videoFiles");
videoFilesInput && videoFilesInput.addEventListener("change", () => {
  addVideoFiles(Array.from(videoFilesInput.files || [])), videoFilesInput.value = "", refreshUploadSummary();
});
const audioFilesInput = getEl("audioFiles");
audioFilesInput && audioFilesInput.addEventListener("change", () => {
  addAudioFiles(Array.from(audioFilesInput.files || [])), audioFilesInput.value = "", refreshUploadSummary();
});
const faceSegImageInput = getEl("faceSegImage");
faceSegImageInput && faceSegImageInput.addEventListener("change", async () => {
  try {
    const selectedFile = Array.from(faceSegImageInput.files || [])[0] || null;
    await loadFaceSegImage(selectedFile);
  } catch (error) {
    setFaceSegStatus("处理失败: " + (error.message || error)), resetFaceSegResult();
  } finally {
    faceSegImageInput.value = "";
  }
});
bindFaceSegOptionEvents(), getEl("faceSegUndoBox")?.addEventListener("click", () => {
  if (!faceSegRects.length) {
    setFaceSegStatus("当前没有可撤销的区域");
    return;
  }
  faceSegRects.pop(), redrawFaceSegCanvas(), rebuildFaceSegResult();
}), getEl("faceSegClearBoxes")?.addEventListener("click", () => {
  if (!faceSegSourceImage) {
    setFaceSegStatus("请先上传人像图");
    return;
  }
  faceSegRects = [], faceSegDraftRect = null, redrawFaceSegCanvas(), resetFaceSegResult(), setFaceSegStatus("已清空全部区域，请重新圈选");
}), getEl("faceSegDownloadFace")?.addEventListener("click", () => {
  if (!faceSegFaceDataUrl) {
    setFaceSegStatus("请先圈选区域并生成预览");
    return;
  }
  downloadFaceSegOutput(faceSegFaceDataUrl, "脸部"), setFaceSegStatus("脸部切割图下载已触发");
}), getEl("faceSegDownloadMasked")?.addEventListener("click", () => {
  if (!faceSegMaskDataUrl) {
    setFaceSegStatus("请先圈选区域并生成预览");
    return;
  }
  downloadFaceSegOutput(faceSegMaskDataUrl, "蒙版"), setFaceSegStatus("蒙版图下载已触发");
}), getEl("faceSegSendToW2")?.addEventListener("click", () => {
  if (!faceSegFaceDataUrl || !faceSegMaskDataUrl) {
    setFaceSegStatus("请先圈选区域并生成预览");
    return;
  }
  const baseName = (faceSegSourceFile?.name || "portrait").replace(/\.[^.]+$/, ""),
    faceFile = dataUrlToFile(faceSegFaceDataUrl, baseName + "脸部.png"),
    maskFile = dataUrlToFile(faceSegMaskDataUrl, baseName + "蒙版.png");
  addImageFiles([faceFile, maskFile]), refreshUploadSummary(), setFaceSegStatus("已将脸部图和蒙版图加入任务添加图片素材（共 " + jqImageFiles.length + " 张）"), document.querySelector(".workspace2")?.scrollIntoView({
    behavior: "smooth"
  });
}), refreshUploadSummary(), bindAtMentionPromptInput(), renderQueue(), getEl("runAll").addEventListener("click", jqStartQueueToggle), getEl("runFailedOnly").addEventListener("click", retryFailedTasks), getEl("addTaskCard").addEventListener("click", addTaskCard), getEl("pauseAllTasks")?.addEventListener("click", pauseAllTasks), getEl("queueRunningName")?.addEventListener("click", locateRunningTask), getEl("clearAllCards").addEventListener("click", clearCurrentProjectTasks), getEl("exportTasksCsv").addEventListener("click", exportProjectCsv), getEl("exportTasks").addEventListener("click", exportProjectZip), getEl("importMediaRootFolder").addEventListener("change", event => {
  const mediaFiles = Array.from(event.target.files || []);
  event.target.value = "";
  if (!pendingImportCsvFile) {
    appendLog("⚠️ 没有待处理的 CSV 数据");
    return;
  }
  if (!mediaFiles.length) {
    appendLog("⚠️ 未选择素材目录。你可以重新选择、跳过素材继续导入，或取消本次导入。");
    return;
  }
  const {
    rows: csvRows,
    indexMap: csvIndexMap
  } = pendingImportCsvFile;
  jqClearPendingCsvImport();
  const mediaFileIndex = buildMediaFileIndex(mediaFiles);
  appendLog("📁 已加载素材目录（" + mediaFiles.length + " 个文件），正在导入..."), importCsvRowsWithMedia(csvRows, csvIndexMap, mediaFileIndex)["catch"](error => appendLog("❌ CSV 导入失败: " + (error.message || error)));
}), getEl("chooseImportMediaRoot")?.addEventListener("click", jqChoosePendingCsvMediaRoot), getEl("importCsvWithoutMedia")?.addEventListener("click", jqImportPendingCsvWithoutMedia), getEl("cancelPendingCsvImport")?.addEventListener("click", jqCancelPendingCsvImport), getEl("importTasks").addEventListener("click", () => {
  const fileInput = getEl("importTasksFile");
  if (fileInput) fileInput.click();
}), getEl("importTasksFile").addEventListener("change", event => {
  const importFile = event.target.files?.[0];
  if (importFile) {
    const lowerFileName = String(importFile.name || "").toLowerCase();
    if (lowerFileName.endsWith(".csv")) importCsvFile(importFile)["catch"](() => {});else {
      if (lowerFileName.endsWith(".json")) importJsonBackup(importFile)["catch"](() => {});else lowerFileName.endsWith(".zip") ? importZipPackage(importFile)["catch"](() => {}) : appendLog("❌ 仅支持导入 .csv（纯表格）、.zip（表格包）或 .json（完整备份）");
    }
  }
  event.target.value = "";
}), getEl("queueCards").addEventListener("click", event => {
  const actionButton = event.target.closest("button[data-action]");
  if (!actionButton) return;
  const taskId = Number(actionButton.dataset.taskId),
    action = actionButton.dataset.action;
  if (Number.isNaN(taskId)) return;
  if (action === "execute") {
    executeSingleTask(taskId);
    return;
  }
  if (action === "edit") {
    editTaskToForm(taskId);
    return;
  }
  if (action === "up") {
    moveTask(taskId, "up");
    return;
  }
  if (action === "down") {
    moveTask(taskId, "down");
    return;
  }
  if (action === "skip") {
    toggleTaskSkipped(taskId);
    return;
  }
  if (action === "pause") {
    pauseSingleTask(taskId);
    return;
  }
  action === "cancel" && deleteTask(taskId);
}), jqBindProjectUi(), Promise.all([loadTasks(), jqLoadTaskNumberPrefixSetting(), jqLoadGenStats(), jqLoadStatsShowFast()])["finally"](() => {
  renderQueue();
  jqRenderStatsPanel();
  jqStartGenCapture();
}), window.addEventListener("beforeunload", () => {
  setQueueAutoResumeEnabled(false)["catch"](() => {});
}), loadQueueAutoResumeToggle();
function setMonitorStatusText(statusText) {
  const statusEl = getEl("w4Status");
  if (statusEl) statusEl.textContent = statusText;
}
function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "sendMessage failed"));
        return;
      }
      resolve(response);
    });
  });
}
// 逐模型并发显示：2.0 / 2.0 Fast 定死 1；mini / 2.0 VIP / Fast VIP / 2.5 走 VIP 组上限。
function applyMonitorState(state) {
  if (!state || typeof state !== "object") return;
  monitorEnabled = !!state.enabled, monitorDefaultLimit = clampConcurrencyLimit(state.limit), monitorGroupLimits = normalizeGroupLimits(state.groupLimits || monitorGroupLimits), renderMonitorCurrentCount(Number.isFinite(state.currentCount) ? state.currentCount : NaN);
  setMonitorStatusText(state.status || (monitorEnabled ? "自动监控中" : "自动监控待启动")), document.querySelectorAll(".workspace4-limit-btn").forEach(limitButton => {
    const buttonGroup = normalizeMonitorGroup(limitButton.dataset.w4Group),
      buttonLimit = Number(limitButton.dataset.w4Limit);
    limitButton.classList.toggle("active", Number.isFinite(buttonLimit) && monitorGroupLimits[buttonGroup] === buttonLimit);
  });
}
async function syncMonitorState() {
  try {
    const response = await sendRuntimeMessage({
      type: "W4_BG_GET_STATE"
    });
    if (response?.ok) return applyMonitorState(response.state), true;
    return setMonitorStatusText(response?.error || "读取后台状态失败"), false;
  } catch (error) {
    return setMonitorStatusText("后台通讯失败: " + (error.message || error)), false;
  }
}
function renderMonitorCurrentCount(currentCount) {
  const currentCountEl = getEl("w4CurrentCount");
  if (currentCountEl) currentCountEl.textContent = Number.isFinite(currentCount) ? String(currentCount) : "-";
}
async function setMonitorGroupLimit(group, limit) {
  const normalizedGroup = normalizeMonitorGroup(group),
    clampedLimit = clampConcurrencyLimit(limit);
  monitorGroupLimits = {
    ...monitorGroupLimits,
    [normalizedGroup]: clampedLimit
  };
  try {
    const response = await sendRuntimeMessage({
      type: "W4_BG_SET_GROUP_LIMIT",
      group: normalizedGroup,
      limit: clampedLimit
    });
    if (response?.ok) applyMonitorState(response.state);else setMonitorStatusText(response?.error || "设置监测数量失败");
  } catch (error) {
    setMonitorStatusText("设置监测数量失败: " + (error.message || error));
  }
  !monitorEnabled && (await startMonitor(true));
}
function scheduleMonitorPoll() {
  monitorTimerId && (clearTimeout(monitorTimerId), monitorTimerId = null);
  if (!monitorEnabled) return;
  monitorTimerId = setTimeout(() => {
    pollMonitorState();
  }, monitorPollMs);
}
function countGeneratingCardsOnPage(tabId) {
  return runInJimengPage(tabId, () => {
    const normalizePageText = text => String(text || "").replace(/\s+/g, "").trim(),
      activeStatusPattern = /((?:[1-9]\d?|100)%造梦中|造梦中|生成中|排队中|排队生成|队列中|等待中|处理中|创作中|排队加速中|排队加速|加速中|会员加速已生效|当前排队\(|预计剩余)/,
      progressPattern = /(\d{1,2}:\d{2}(?::\d{2})?|预计剩余|当前排队\(|\d+%)/,
      cancelPattern = /(取消生成|终止生成|停止生成)/,
      cardSelector = "[id^=\"item_\"][data-id], .item-kc5ZSZ, [data-id][class*=\"item\" i], [class*=\"video-record\" i]",
      progressSelector = "[class*=\"progress-badge\" i], [class*=\"progress-tips\" i], [class*=\"loading-container\" i]",
      isVisible = element => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
      candidateCards = Array.from(document.querySelectorAll(cardSelector)).filter(card => isVisible(card)),
      topLevelCards = candidateCards.filter(card => !candidateCards.some(parentCard => parentCard !== card && parentCard.contains(card))),
      activeKeys = new Set(),
      cancelableKeys = new Set(),
      cardKey = element => {
        const directId = element.getAttribute("data-id") || element.id || "";
        if (directId) return "id:" + directId;
        const idOwner = element.closest("[data-id]");
        if (idOwner?.getAttribute("data-id")) return "id:" + idOwner.getAttribute("data-id");
        const text = normalizePageText(element.innerText || element.textContent || "");
        return "txt:" + text.slice(0, 80);
      };
    topLevelCards.forEach(card => {
      const progressEls = Array.from(card.querySelectorAll(progressSelector)),
        progressTexts = progressEls.filter(element => isVisible(element)).map(element => normalizePageText(element.innerText || element.textContent || "")).filter(Boolean),
        cardText = normalizePageText(card.innerText || card.textContent || ""),
        hasActiveStatus = progressTexts.some(text => activeStatusPattern.test(text)),
        hasProgressText = progressTexts.some(text => progressPattern.test(text)),
        hasCancelControl = cardText && cancelPattern.test(cardText),
        key = cardKey(card);
      if (hasActiveStatus && hasCancelControl) cancelableKeys.add(key);
      if (hasActiveStatus && (hasProgressText || hasCancelControl)) activeKeys.add(key);
    });
    if (activeKeys.size > 0) return activeKeys.size;
    if (cancelableKeys.size > 0) return cancelableKeys.size;
    const looseProgressEls = Array.from(document.querySelectorAll(progressSelector)).filter(element => {
      if (!isVisible(element)) return false;
      const text = normalizePageText(element.innerText || element.textContent || "");
      return !!text && activeStatusPattern.test(text);
    });
    if (!looseProgressEls.length) return 0;
    const looseKeys = new Set();
    return looseProgressEls.forEach(progressEl => {
      const card = progressEl.closest(cardSelector) || progressEl.closest("[class*=\"task\" i], [class*=\"item\" i], [class*=\"card\" i], [class*=\"row\" i], [class*=\"record\" i], li, tr");
      if (card && isVisible(card)) looseKeys.add(cardKey(card));
    }), looseKeys.size;
  });
}
async function getMonitorTargetTab() {
  const tab = await findJimengTab();
  if (!tab?.url || !isJimengGenerateUrl(tab.url)) return {
    ok: false,
    tab: null,
    error: "请先切到即梦生成页再监控"
  };
  return {
    ok: true,
    tab: tab,
    error: ""
  };
}
async function pollMonitorState() {
  if (!monitorEnabled) return;
  await syncMonitorState(), scheduleMonitorPoll();
}
async function waitForConcurrencySlot(logPrefix = "", modelName = "", heartbeat = null) {
  const tick = () => {
      if (typeof heartbeat === "function") heartbeat();
    },
    modelKey = modelCounterKey(modelName),
    modelLabel = normalizeModelName(modelName) || modelName || "当前模型";
  tick();
  const cooldownRemaining = () => {
    const lastSubmitAt = Number(modelSubmitCooldownAt[modelKey] || 0);
    if (!Number.isFinite(lastSubmitAt) || lastSubmitAt <= 0) return 0;
    return Math.max(0, modelSubmitCooldownMs - (Date.now() - lastSubmitAt));
  };
  let remainingCooldown = cooldownRemaining();
  while (remainingCooldown > 0) {
    if (logPrefix) {
      const cooldownSeconds = (remainingCooldown / 1000).toFixed(1);
      appendLog(logPrefix + " " + modelLabel + " 命中提交冷却硬闸，等待 " + cooldownSeconds + "s...");
    }
    await sleep(Math.min(remainingCooldown, 500)), tick(), remainingCooldown = cooldownRemaining();
  }
  const synced = await syncMonitorState();
  if (!monitorEnabled) return;
  if (!synced) throw new Error("[并发监控] 无法同步后台状态，已阻止提交以避免超并发");
  const waitStart = Date.now();
  let lastLogAt = waitStart,
    fallbackProbeCount = 0;
  while (monitorEnabled) {
    tick();
    const now = Date.now();
    if (now - lastLogAt >= slotWaitLogIntervalMs && logPrefix) {
      const waitedMinutes = Math.max(1, Math.floor((now - waitStart) / 60000));
      appendLog(logPrefix + " 已等待空位 " + waitedMinutes + " 分钟，继续监测中..."), lastLogAt = now;
    }
    const tab = await findJimengTab();
    tick();
    const response = await sendRuntimeMessage({
      type: "W4_BG_CHECK_ONCE",
      tabId: tab.id
    });
    tick();
    if (!response?.ok) throw new Error("[并发监控] " + (response?.error || "检测失败"));
    applyMonitorState(response.state);
    const slot = modelSlotFromMonitorState(response.state, modelName);
    if (slot.unknownCount > 0) {
      fallbackProbeCount = 0;
      logPrefix && appendLog(logPrefix + " 并发监控发现 " + slot.unknownCount + " 个未知模型生成中，等待下一轮确认...");
      await sleep(monitorPollMs), tick(), await syncMonitorState();
      if (!monitorEnabled) return;
      continue;
    } else if (slot.reliable && slot.currentCount < slot.limit) {
      await sleep(Math.min(singleLimitConfirmDelayMs, monitorPollMs)), tick();
      const confirmResponse = await sendRuntimeMessage({
        type: "W4_BG_CHECK_ONCE",
        tabId: tab.id
      });
      tick();
      if (!confirmResponse?.ok) throw new Error("[并发监控] " + (confirmResponse?.error || "二次确认失败"));
      applyMonitorState(confirmResponse.state);
      const confirmSlot = modelSlotFromMonitorState(confirmResponse.state, modelName);
      if (confirmSlot.reliable && confirmSlot.currentCount < confirmSlot.limit) {
        fallbackProbeCount = 0;
        return;
      }
      logPrefix && appendLog(logPrefix + " 并发监控二次确认未通过（" + modelLabel + " " + (Number.isFinite(confirmSlot.currentCount) ? confirmSlot.currentCount : "-") + "/" + confirmSlot.limit + (confirmSlot.unknownCount > 0 ? "，未知模型 " + confirmSlot.unknownCount : "") + "），继续等待...");
      await sleep(Math.max(400, Math.floor(2500))), tick(), await syncMonitorState();
      if (!monitorEnabled) return;
      continue;
    } else if (!slot.reliable) {
      fallbackProbeCount += 1;
      if (fallbackProbeCount >= fallbackCountProbeThreshold) try {
        const fallbackCount = await countGeneratingCardsOnPage(tab.id);
        // 兜底放行必须页面计数为 0 且接口(net-hook)生成中数也为 0；接口 >0 说明有卡被滚动藏了，不能放行。
        if (Number.isFinite(fallbackCount) && fallbackCount === 0 && slot.apiGenerating <= 0) {
          logPrefix && appendLog(logPrefix + " 并发监控主计数异常，但页面与接口生成数均为 0，允许提交");
          return;
        }
      } catch {}
    } else fallbackProbeCount = 0;
    logPrefix && appendLog(logPrefix + " 并发监控判定满载（" + modelLabel + " " + (Number.isFinite(slot.currentCount) ? slot.currentCount : "-") + "/" + slot.limit + "），等待空位...");
    await sleep(monitorPollMs), tick(), await syncMonitorState();
    if (!monitorEnabled) return;
  }
}
async function confirmSubmitAcceptedByMonitor(baselineCount, modelName = "", logPrefix = "", heartbeat = null) {
  const tick = () => {
    if (typeof heartbeat === "function") heartbeat();
  };
  tick();
  const synced = await syncMonitorState();
  if (!monitorEnabled) return {
    accepted: false,
    reason: "monitor-off"
  };
  if (!synced) return {
    accepted: false,
    reason: "sync-failed"
  };
  const startTime = Date.now(),
    baseline = Number.isFinite(baselineCount) && baselineCount >= 0 ? baselineCount : null;
  while (Date.now() - startTime < submitAcceptTimeoutMs) {
    tick();
    if (!monitorEnabled) return {
      accepted: false,
      reason: "monitor-stopped"
    };
    const tab = await findJimengTab();
    tick();
    const response = await sendRuntimeMessage({
      type: "W4_BG_CHECK_ONCE",
      tabId: tab.id
    });
    tick();
    if (response?.ok) {
      applyMonitorState(response.state);
      const slot = modelSlotFromMonitorState(response.state, modelName);
      if (slot.unknownCount > 0) {
        if (logPrefix) appendLog(logPrefix + " 平台受理确认遇到未知模型生成中，继续等待...");
      } else if (slot.reliable) {
        if (baseline !== null && slot.currentCount > baseline) return {
          accepted: true,
          reason: "count-increase",
          current: slot.currentCount,
          baseline: baseline
        };
      }
    }
    // 后端钩子兜底：计数不可信（页面滚动漏数等）时，靠"提交后出现新平台记录"判受理
    if (await jqHookAccepted()) return {
      accepted: true,
      reason: "hook-new-record",
      baseline: baseline
    };
    if (logPrefix) appendLog(logPrefix + " 已提交，等待平台受理确认...");
    await sleep(submitAcceptPollMs), tick();
  }
  return {
    accepted: false,
    reason: "timeout",
    baseline: baseline
  };
}
async function startMonitor(silent = false) {
  try {
    const target = await getMonitorTargetTab();
    if (!target.ok || !target.tab?.id) {
      if (!silent) setMonitorStatusText(target.error || "自动监控目标页不可用");
      return false;
    }
    const response = await sendRuntimeMessage({
      type: "W4_BG_START",
      limit: monitorDefaultLimit,
      groupLimits: monitorGroupLimits,
      tabId: target.tab.id
    });
    if (!response?.ok) {
      if (!silent) setMonitorStatusText(response?.error || "自动监控启动失败");
      return false;
    }
    applyMonitorState(response.state);
    if (monitorEnabled) pollMonitorState();
    return true;
  } catch (error) {
    if (!silent) setMonitorStatusText("自动监控启动失败: " + (error.message || error));
    return false;
  }
}
document.querySelectorAll(".workspace4-limit-btn").forEach(limitButton => {
  limitButton.addEventListener("click", () => {
    const group = normalizeMonitorGroup(limitButton.dataset.w4Group),
      rawLimit = Number(limitButton.dataset.w4Limit);
    if (!Number.isFinite(rawLimit)) return;
    const limit = clampConcurrencyLimit(rawLimit);
    setMonitorGroupLimit(group, limit), setMonitorStatusText((group === "vip" ? "VIP组" : "标准组") + "监测数量已切换为 " + limit);
  });
}), syncMonitorState().then(async () => {
  !monitorEnabled && (await startMonitor(true));
  if (monitorEnabled) pollMonitorState();
}), chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "BG_QUEUE_CONTINUE_SIGNAL") {
    const tasks = jqTasks || [],
      hasPendingTasks = tasks.some(task => task && task.status === "pending");
    return queueAutoResumeEnabled && hasPendingTasks && !isQueueLoopActive && !isQueueRunning && (appendLog("ℹ️ 后台检测到已添加任务，自动恢复队列执行"), runQueue()["catch"](() => {})), sendResponse({
      ok: true
    }), true;
  }
});

// =============================================================
// 即梦风悬浮输入框：缩略图横排合并 + 参考添加入口 + 滚动收缩 + @行内 widget 悬停大图
// =============================================================
function jqCollectAllRefs() {
  const all = [];
  (jqImageFiles || []).forEach((f, i) => all.push({ kind: "image", file: f, index: i, label: "图片" + (i+1) }));
  (jqVideoFiles || []).forEach((f, i) => all.push({ kind: "video", file: f, index: i, label: "视频" + (i+1) }));
  (jqAudioFiles || []).forEach((f, i) => all.push({ kind: "audio", file: f, index: i, label: "音频" + (i+1) }));
  return all;
}
// 即梦原生机制：一行 flex 缩略图，折叠重叠成堆，悬停整组就地放大铺开（纯 CSS 驱动展开）
function jqRenderThumbStrip() {
  const strip = getEl("jmThumbStrip"), group = getEl("jmRefGroup");
  if (!strip) return;
  const all = jqCollectAllRefs();
  if (group) group.classList.toggle("has-items", all.length > 0);
  const scatter = [-8, 5, -8, 5, -8, 4];
  strip.innerHTML = all.map((it, pos) => {
    const inner = it.kind === "image"
      ? `<img src="${objectUrlForFile(it.file)}" alt=""/>`
      : it.kind === "video"
        ? `<video src="${objectUrlForFile(it.file)}" muted></video>`
        : `<div class="jm-thumb-audio">♪</div>`;
    const rot = scatter[pos % scatter.length];
    const fname = String(it.file?.name || it.label || "");
    return `<div class="jm-thumb" data-kind="${it.kind}" data-index="${it.index}" style="--rot:${rot}deg">`
      + `<span class="jm-thumb-label" title="${fname.replace(/"/g, "&quot;")}">${fname.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`
      + inner
      + `<button type="button" class="jm-thumb-x" data-kind="${it.kind}" data-index="${it.index}" aria-label="删除">×</button>`
      + `</div>`;
  }).join("");
  strip.querySelectorAll(".jm-thumb-x").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      const kind = btn.dataset.kind, idx = Number(btn.dataset.index);
      if (Number.isNaN(idx)) return;
      if (kind === "image") jqImageFiles.splice(idx,1);
      else if (kind === "video") jqVideoFiles.splice(idx,1);
      else if (kind === "audio") jqAudioFiles.splice(idx,1);
      jqRenderThumbStrip();
      try { refreshUploadSummary(); } catch(e){}
      try { renderImagePreviews && renderImagePreviews(); } catch(e){}
      try { renderVideoFileList && renderVideoFileList(); } catch(e){}
      try { renderAudioFileList && renderAudioFileList(); } catch(e){}
    });
  });
}
window.jqRenderThumbStrip = jqRenderThumbStrip;

(function jqHookThumbStripIntoSummary(){
  if (typeof refreshUploadSummary !== "function") return;
  const _orig = refreshUploadSummary;
  refreshUploadSummary = async function(){
    const r = await _orig.apply(this, arguments);
    try { jqRenderThumbStrip(); } catch(e){}
    return r;
  };
})();

function jqBindRefAdd() {
  const btn = getEl("jmRefAddBtn"), picker = getEl("jmRefFilePicker");
  if (!btn || !picker || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    const files = Array.from(picker.files || []);
    const imgs = [], vids = [], auds = [];
    files.forEach(f => {
      const t = (f.type || "").toLowerCase(), n = (f.name || "").toLowerCase();
      if (t.startsWith("image/") || /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(n)) imgs.push(f);
      else if (t === "video/mp4" || /\.mp4$/i.test(n)) vids.push(f);
      else if (t.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(n)) auds.push(f);
      else imgs.push(f);
    });
    if (imgs.length && typeof addImageFiles === "function") addImageFiles(imgs);
    if (vids.length && typeof addVideoFiles === "function") addVideoFiles(vids);
    if (auds.length && typeof addAudioFiles === "function") addAudioFiles(auds);
    picker.value = "";
    try { refreshUploadSummary(); } catch(e){}
  });
}

function jqBindScrollShrink() {
  const composer = getEl("jmFloatingComposer");
  if (!composer) return;
  const expandComposer = () => {
    composer.classList.remove("is-shrunk");
    composer.classList.add("is-expanded");
  };
  const shrinkComposer = () => {
    composer.classList.remove("is-expanded");
    composer.classList.add("is-shrunk");
  };
  const onScroll = () => {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    if (y <= 8) expandComposer();
    else if (y > 50) shrinkComposer();
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  document.querySelectorAll(".wrap, .layout-shell, .main-column, .right-column").forEach(el => {
    el.addEventListener("scroll", () => {
      const y = el.scrollTop || 0;
      if (y <= 8) expandComposer();
      else if (y > 50) shrinkComposer();
    }, { passive: true });
  });
  ["click", "focusin"].forEach(eventName => {
    composer.addEventListener(eventName, event => {
      if (event.target?.closest?.(".jm-prompt-area, #promptText, #taskNameInput, #taskRepeatInput")) expandComposer();
    });
  });
  window.jqExpandComposerDefault = expandComposer;
  window.jqShrinkComposerMin = shrinkComposer;
}

function jqBindSubmitArrow() {
  const arrow = getEl("jmSubmitBtn"), addBtn = getEl("addTaskCard");
  if (!arrow || arrow.dataset.bound === "1") return;
  arrow.dataset.bound = "1";
  arrow.addEventListener("click", () => {
    if (addBtn) addBtn.click();
  });
}

// 视频模型 / 参考模式 / 时长：原生 <select> 改造成与比例弹层一致的自定义弹层。
// 以隐藏 <select> 为数据真源：弹层按钮从 select.options 实时构建（故选项联动后自动反映），
// 点选后写回 select 并派发 change，复用既有的 syncFormOptions / 锁定 / 标签刷新逻辑。
function jqBindComboChip(selectId, btnId, popId, labelUpdater) {
  const btn = getEl(btnId), pop = getEl(popId), sel = getEl(selectId);
  if (!btn || !pop || !sel || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const buildOpts = () => {
    const wrap = pop.querySelector(".jm-pop-opts");
    if (!wrap) return;
    const cur = sel.value;
    wrap.innerHTML = Array.from(sel.options).map(o => "<button type=\"button\" data-val=\"" + esc(o.value) + "\"" + (o.value === cur ? " class=\"on\"" : "") + ">" + esc(o.textContent || o.value) + "</button>").join("");
  };
  btn.addEventListener("click", e => {
    e.stopPropagation();
    if (sel.disabled) return;
    const willOpen = pop.hidden;
    jqCloseAllChipPopovers(pop);
    if (willOpen) { buildOpts(); pop.hidden = false; } else { pop.hidden = true; }
  });
  pop.addEventListener("click", e => {
    const opt = e.target.closest(".jm-pop-opts button");
    if (!opt || opt.disabled) return;
    e.stopPropagation();
    if (sel.value !== opt.dataset.val) {
      sel.value = opt.dataset.val;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (labelUpdater) try { labelUpdater(); } catch (x) {}
    pop.hidden = true;
  });
  document.addEventListener("click", e => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) pop.hidden = true;
  });
  if (labelUpdater) try { labelUpdater(); } catch (x) {}
}
function jqDurationScale(maxDuration) {
  const tickStep = maxDuration <= 30 ? 5 : Math.ceil(maxDuration / 6 / 5) * 5,
    scaleMax = Math.ceil(maxDuration / tickStep) * tickStep,
    ticks = [];
  for (let value = 0; value <= scaleMax; value += tickStep) ticks.push(value);
  return {
    max: scaleMax,
    ticks: ticks
  };
}
function jqRefreshDurationSlider() {
  const selectEl = getEl("duration"), slider = getEl("durationSlider"), numberInput = getEl("durationNumber"), ticksEl = getEl("durationTicks"), railTicksEl = getEl("durationRailTicks"), increaseBtn = getEl("durationIncrease"), decreaseBtn = getEl("durationDecrease");
  if (!selectEl || !slider || !numberInput || !ticksEl || !railTicksEl) return;
  const options = Array.from(selectEl.options).map(option => option.value),
    selectedIndex = Math.max(0, options.indexOf(selectEl.value)),
    numericOptions = options.map(option => Number.parseInt(option, 10)).filter(Number.isFinite),
    selectedValue = numericOptions[selectedIndex] || numericOptions[0],
    scale = jqDurationScale(Math.max(...numericOptions));
  slider.min = "0";
  slider.max = String(scale.max);
  slider.value = String(selectedValue);
  slider.disabled = options.length < 2;
  numberInput.min = String(Math.min(...numericOptions));
  numberInput.max = String(Math.max(...numericOptions));
  numberInput.step = "1";
  numberInput.value = String(selectedValue);
  slider.parentElement?.style.setProperty("--jm-duration-progress", selectedValue / scale.max * 100 + "%");
  ticksEl.innerHTML = scale.ticks.map(value => "<button type=\"button\" class=\"jm-duration-tick\" data-duration=\"" + value + "\" style=\"left:" + value / scale.max * 100 + "%\">" + value + "</button>").join("");
  railTicksEl.innerHTML = scale.ticks.slice(1, -1).map(value => "<i style=\"left:" + value / scale.max * 100 + "%\"></i>").join("");
  if (increaseBtn) increaseBtn.disabled = selectedIndex >= options.length - 1;
  if (decreaseBtn) decreaseBtn.disabled = selectedIndex <= 0;
}
function jqBindDurationSlider() {
  const btn = getEl("durationComboBtn"), pop = getEl("durationPopover"), selectEl = getEl("duration"), slider = getEl("durationSlider"), numberInput = getEl("durationNumber"), ticksEl = getEl("durationTicks"), valueEl = getEl("durationValue"), increaseBtn = getEl("durationIncrease"), decreaseBtn = getEl("durationDecrease");
  if (!btn || !pop || !selectEl || !slider || !numberInput || !ticksEl || !valueEl || !increaseBtn || !decreaseBtn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  const syncInputFocusState = () => valueEl.classList.toggle("is-focused", valueEl.contains(document.activeElement));
  const setDurationByIndex = index => {
    const options = Array.from(selectEl.options),
      selectedOption = options[Math.max(0, Math.min(options.length - 1, index))];
    if (!selectedOption) return;
    if (selectEl.value !== selectedOption.value) {
      selectEl.value = selectedOption.value;
      selectEl.dispatchEvent(new Event("change", {
        bubbles: true
      }));
    }
    jqRefreshDurationSlider();
    jqUpdateDurationChipLabel();
  };
  const closestDurationIndex = value => {
    const target = Number.parseInt(value, 10), options = Array.from(selectEl.options);
    if (!Number.isFinite(target)) return Math.max(0, options.findIndex(option => option.value === selectEl.value));
    return options.reduce((bestIndex, option, index) => Math.abs(Number.parseInt(option.value, 10) - target) < Math.abs(Number.parseInt(options[bestIndex].value, 10) - target) ? index : bestIndex, 0);
  };
  btn.addEventListener("click", event => {
    event.stopPropagation();
    const willOpen = pop.hidden;
    jqCloseAllChipPopovers(pop);
    if (willOpen) {
      jqRefreshDurationSlider();
      pop.hidden = false;
    } else pop.hidden = true;
  });
  slider.addEventListener("input", () => setDurationByIndex(closestDurationIndex(slider.value)));
  numberInput.addEventListener("focus", syncInputFocusState);
  valueEl.addEventListener("focusout", () => setTimeout(syncInputFocusState, 0));
  numberInput.addEventListener("change", () => setDurationByIndex(closestDurationIndex(numberInput.value)));
  numberInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      setDurationByIndex(closestDurationIndex(numberInput.value));
    }
  });
  ticksEl.addEventListener("click", event => {
    const tickButton = event.target.closest("button[data-duration]");
    if (tickButton) setDurationByIndex(closestDurationIndex(tickButton.dataset.duration));
  });
  increaseBtn.addEventListener("click", () => setDurationByIndex(Math.max(0, Array.from(selectEl.options).findIndex(option => option.value === selectEl.value)) + 1));
  decreaseBtn.addEventListener("click", () => setDurationByIndex(Math.max(0, Array.from(selectEl.options).findIndex(option => option.value === selectEl.value)) - 1));
  selectEl.addEventListener("change", jqRefreshDurationSlider);
  document.addEventListener("click", event => {
    if (!pop.hidden && !pop.contains(event.target) && event.target !== btn && !btn.contains(event.target)) pop.hidden = true;
  });
  syncInputFocusState();
  jqRefreshDurationSlider();
}
// 初始化所有新绑定
(function jqInitV4176(){
  const tryInit = () => {
    try { jqBindRefAdd(); } catch(e){}
    try { jqBindScrollShrink(); } catch(e){}
    try { jqBindSubmitArrow(); } catch(e){}
    try { jqRenderThumbStrip(); } catch(e){}
    try { jqBindComboChip("model", "modelComboBtn", "modelPopover", jqUpdateModelChipLabel); } catch(e){}
    try { jqBindComboChip("refMode", "refModeComboBtn", "refModePopover", jqUpdateRefModeChipLabel); } catch(e){}
    try { jqBindDurationSlider(); } catch(e){}
    try { getEl("promptText")?.addEventListener("input", jqUpdatePromptCharCount); jqUpdatePromptCharCount(); } catch(e){}
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryInit);
  } else {
    tryInit();
  }
})();
