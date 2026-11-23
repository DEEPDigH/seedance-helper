/**
 * background.js — Service Worker
 * 可读还原版 (deobfuscated)：经 AST 转换（常量求值、作用域改名、点号属性访问），
 * 已用规范化双向比对验证与原混淆版行为完全等价。变量名为语义推断，非原作者命名。
 *
 * 职责：监控即梦 Seedance 生成页并发任务数（按模型分组限额），驱动任务队列。
 */
const STORAGE_KEY_STATE = "workspace4BgStateV1",
  MONITOR_ALARM = "workspace4-monitor-alarm",
  MONITOR_ALARM_DELAY_MIN = 0.5,
  QUEUE_DRIVER_ALARM = "task-queue-driver-alarm",
  QUEUE_DRIVER_INTERVAL_MIN = 0.5,
  STORAGE_KEY_TASK_QUEUE = "workspace3TaskQueueV1",
  STORAGE_KEY_AUTO_RESUME = "workspace3QueueAutoResumeEnabledV1",
  POPUP_PAGE = "popup.html",
  MIN_LIMIT = 1,
  MAX_LIMIT = 10,
  MODEL_GROUP = {
    "Seedance 2.5": "vip",
    "Seedance 2.0 mini": "vip",
    "Seedance 2.0 Fast VIP": "vip",
    "Seedance 2.0 VIP": "vip",
    "Seedance 2.0 Fast": "standard",
    "Seedance 2.0": "standard"
  },
  DEFAULT_GROUP_LIMITS = {
    standard: 1,
    vip: 10
  },
  DEFAULT_STATE = {
    enabled: false,
    limit: 10,
    groupLimits: {
      ...DEFAULT_GROUP_LIMITS
    },
    currentCount: -1,
    modelCounts: {},
    unknownCount: 0,
    apiGeneratingCount: -1,
    status: "未启动监控",
    updatedAt: 0,
    targetTabId: null
  };
let state = {
  ...DEFAULT_STATE
};
let monitorCheckSequence = 0;
function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], res => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "storage get failed"));
        return;
      }
      resolve(res?.[key]);
    });
  });
}
function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "storage set failed"));
        return;
      }
      resolve();
    });
  });
}
async function saveState() {
  await storageSet({
    [STORAGE_KEY_STATE]: state
  });
}
function finiteOrMinusOne(n) {
  return Number.isFinite(n) ? n : -1;
}
function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MAX_LIMIT;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(n)));
}
function sanitizeModelCounts(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  return Object.keys(MODEL_GROUP).forEach(model => {
    const n = Number(obj[model]);
    out[model] = Number.isFinite(n) && n >= 0 ? n : 0;
  }), out;
}
function sanitizeGroupLimits(obj) {
  const src = obj && typeof obj === "object" ? obj : {};
  return {
    standard: clampLimit(src.standard),
    vip: clampLimit(src.vip)
  };
}
function limitForModel(model) {
  const group = MODEL_GROUP[model] || "standard",
    limits = sanitizeGroupLimits(state.groupLimits || {});
  return limits[group] || clampLimit(state.limit);
}
function isGeneratePage(url) {
  try {
    const u = new URL(String(url || "")),
      hostOk = /(^|\.)jimeng\.jianying\.com$/i.test(u.hostname),
      pathOk = u.pathname === "/ai-tool/generate";
    return hostOk && pathOk;
  } catch {
    return false;
  }
}
async function scheduleMonitorAlarm() {
  await chrome.alarms.clear(MONITOR_ALARM);
  if (!state.enabled) return;
  chrome.alarms.create(MONITOR_ALARM, {
    delayInMinutes: MONITOR_ALARM_DELAY_MIN
  });
}
async function scheduleQueueDriverAlarm() {
  await chrome.alarms.clear(QUEUE_DRIVER_ALARM), chrome.alarms.create(QUEUE_DRIVER_ALARM, {
    delayInMinutes: QUEUE_DRIVER_INTERVAL_MIN,
    periodInMinutes: QUEUE_DRIVER_INTERVAL_MIN
  });
}
async function getTaskQueue() {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY_TASK_QUEUE], res => {
      resolve(Array.isArray(res?.[STORAGE_KEY_TASK_QUEUE]) ? res[STORAGE_KEY_TASK_QUEUE] : []);
    });
  });
}
function hasPendingTask(queue) {
  return Array.isArray(queue) && queue.some(task => task && task.status === "pending");
}
async function signalPopupsQueueContinue() {
  try {
    const popupUrl = chrome.runtime.getURL(POPUP_PAGE),
      tabs = await chrome.tabs.query({
        url: popupUrl
      });
    if (!tabs.length) return;
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await new Promise(resolve => {
          chrome.tabs.sendMessage(tab.id, {
            type: "BG_QUEUE_CONTINUE_SIGNAL"
          }, () => {
            chrome.runtime.lastError, resolve();
          });
        });
      } catch {}
    }
  } catch {}
}
async function driveTaskQueue() {
  try {
    const autoResume = !!(await storageGet(STORAGE_KEY_AUTO_RESUME));
    if (!autoResume) return;
    const queue = await getTaskQueue();
    hasPendingTask(queue) && (await signalPopupsQueueContinue());
  } catch {}
}
async function findGenerateTab() {
  if (Number.isInteger(state.targetTabId)) try {
    const tab = await chrome.tabs.get(state.targetTabId);
    if (isGeneratePage(tab?.url)) return tab;
  } catch {}
  const tabs = await chrome.tabs.query({
      url: ["https://jimeng.jianying.com/*", "https://*.jimeng.jianying.com/*"]
    }),
    match = tabs.find(t => isGeneratePage(t?.url));
  if (match?.id) return state.targetTabId = match.id, match;
  return null;
}
async function countConcurrency(tabId) {
  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: {
        tabId: tabId
      },
      world: "MAIN",
      func: () => {
        const normalize = s => String(s || "").replace(/\s+/g, "").trim(),
          GENERATING_RE = /((?:[1-9]\d?|100)%造梦中|造梦中|生成中|排队中|排队生成|队列中|等待中|处理中|创作中|排队加速中|排队加速|加速中|会员加速已生效|当前排队\(|预计剩余)/,
          PROGRESS_RE = /(\d{1,2}:\d{2}(?::\d{2})?|预计剩余|当前排队\(|\d+%)/,
          CANCEL_RE = /(取消生成|终止生成|停止生成)/,
          ITEM_SELECTOR = "[id^=\"item_\"][data-id], .item-kc5ZSZ, [data-id][class*=\"item\" i], [class*=\"video-record\" i]",
          PROGRESS_SELECTOR = "[class*=\"progress-badge\" i], [class*=\"progress-tips\" i], [class*=\"loading-container\" i]",
          isVisible = el => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
          candidates = Array.from(document.querySelectorAll(ITEM_SELECTOR)).filter(el => isVisible(el)),
          topLevelItems = candidates.filter(el => !candidates.some(other => other !== el && other.contains(el))),
          strictMap = new Map(),
          looseMap = new Map(),
          keyOf = el => {
            const id = el.getAttribute("data-id") || el.id || "";
            if (id) return "id:" + id;
            const parent = el.closest("[data-id]");
            if (parent?.getAttribute("data-id")) return "id:" + parent.getAttribute("data-id");
            const text = normalize(el.innerText || el.textContent || "");
            return "txt:" + text.slice(0, 80);
          };
        topLevelItems.forEach(item => {
          const badges = Array.from(item.querySelectorAll(PROGRESS_SELECTOR)),
            badgeTexts = badges.filter(b => isVisible(b)).map(b => normalize(b.innerText || b.textContent || "")).filter(Boolean),
            itemText = normalize(item.innerText || item.textContent || ""),
            isGenerating = badgeTexts.some(tx => GENERATING_RE.test(tx)),
            hasProgress = badgeTexts.some(tx => PROGRESS_RE.test(tx)),
            hasCancel = itemText && CANCEL_RE.test(itemText),
            key = keyOf(item);
          if (isGenerating && hasCancel) looseMap.set(key, item);
          if (isGenerating && (hasProgress || hasCancel)) strictMap.set(key, item);
        });
          const modelOf = el => {
            const norm = String(el?.innerText || el?.textContent || "").toLowerCase().replace(/\s+/g, "").replace(/[：:]/g, ".").replace(/[·•]/g, ".").replace(/[_-]/g, ".");
            if (norm.includes("seedance2.5")) return "Seedance 2.5";
            if (norm.includes("seedance2.0fastvip")) return "Seedance 2.0 Fast VIP";
            if (norm.includes("seedance2.0vip")) return "Seedance 2.0 VIP";
            if (norm.includes("seedance2.0fast")) return "Seedance 2.0 Fast";
            if (norm.includes("seedance2.0mini")) return "Seedance 2.0 mini";
            if (norm.includes("seedance2.0")) return "Seedance 2.0";
            return "";
          },
          tally = map => {
            const counts = {
              "Seedance 2.0": 0,
              "Seedance 2.0 Fast": 0,
              "Seedance 2.0 mini": 0,
              "Seedance 2.0 VIP": 0,
              "Seedance 2.0 Fast VIP": 0,
              "Seedance 2.5": 0
            };
            let unknownCount = 0;
            return map.forEach(el => {
              const model = modelOf(el);
              model && Object.prototype.hasOwnProperty.call(counts, model) ? counts[model] += 1 : unknownCount += 1;
            }), {
              total: map.size,
              modelCounts: counts,
              unknownCount: unknownCount
            };
          },
          EMPTY_COUNTS = {
            "Seedance 2.0": 0,
            "Seedance 2.0 Fast": 0,
            "Seedance 2.0 mini": 0,
            "Seedance 2.0 VIP": 0,
            "Seedance 2.0 Fast VIP": 0,
            "Seedance 2.5": 0
          },
          strictTally = tally(strictMap),
          looseTally = tally(looseMap);
        if (strictTally.total > 0 || looseTally.total > 0) return {
          strict: strictTally,
          loose: looseTally
        };
        const fallbackBadges = Array.from(document.querySelectorAll(PROGRESS_SELECTOR)).filter(el => {
          if (!isVisible(el)) return false;
          const text = normalize(el.innerText || el.textContent || "");
          return !!text && GENERATING_RE.test(text);
        });
        if (!fallbackBadges.length) return {
          strict: {
            total: 0,
            modelCounts: {
              ...EMPTY_COUNTS
            },
            unknownCount: 0
          },
          loose: {
            total: 0,
            modelCounts: {
              ...EMPTY_COUNTS
            },
            unknownCount: 0
          }
        };
        const fallbackMap = new Map();
        fallbackBadges.forEach(badge => {
          const container = badge.closest(ITEM_SELECTOR) || badge.closest("[class*=\"task\" i], [class*=\"item\" i], [class*=\"card\" i], [class*=\"row\" i], [class*=\"record\" i], li, tr");
          if (container && isVisible(container)) {
            const key = keyOf(container);
            fallbackMap.set(key, container);
          }
        });
        const fallbackTally = tally(fallbackMap);
        return {
          strict: {
            total: 0,
            modelCounts: {
              ...EMPTY_COUNTS
            },
            unknownCount: 0
          },
          loose: fallbackTally.total > 0 ? fallbackTally : {
            total: 0,
            modelCounts: {
              ...EMPTY_COUNTS
            },
            unknownCount: 0
          }
        };
      }
    });
    if (!injectionResults || !Array.isArray(injectionResults) || !injectionResults[0]) return {
      strict: {
        total: -1,
        modelCounts: {},
        unknownCount: 0
      },
      loose: {
        total: -1,
        modelCounts: {},
        unknownCount: 0
      }
    };
    const result = injectionResults[0].result;
    if (!result || typeof result !== "object") return {
      strict: {
        total: -1,
        modelCounts: {},
        unknownCount: 0
      },
      loose: {
        total: -1,
        modelCounts: {},
        unknownCount: 0
      }
    };
    const strictTotal = finiteOrMinusOne(Number(result.strict?.total ?? 0)),
      strictCounts = sanitizeModelCounts(result.strict?.modelCounts || {}),
      strictUnknown = finiteOrMinusOne(Number(result.strict?.unknownCount ?? 0)),
      looseTotal = finiteOrMinusOne(Number(result.loose?.total ?? 0)),
      looseCounts = sanitizeModelCounts(result.loose?.modelCounts || {}),
      looseUnknown = finiteOrMinusOne(Number(result.loose?.unknownCount ?? 0));
    // 接口生成中数：从 net-hook 抓到的平台记录里数（不受页面滚动/虚拟列表卸载影响）。
    // -1 表示拿不到（net-hook 未装/无数据），此时不参与可靠性闸门。
    let apiGeneratingCount = -1;
    try {
      const apiRes = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: "MAIN",
        func: () => {
          try {
            const cap = window.__jmCap;
            if (!cap || !cap.records || typeof cap.records !== "object") return -1;
            let generating = 0;
            for (const key of Object.keys(cap.records)) {
              const rec = cap.records[key];
              if (rec && rec.isGenerating) generating += 1;
            }
            return generating;
          } catch (e) { return -1; }
        }
      });
      const apiVal = Number(apiRes?.[0]?.result);
      apiGeneratingCount = Number.isFinite(apiVal) && apiVal >= 0 ? apiVal : -1;
    } catch {}
    return {
      strict: {
        total: strictTotal,
        modelCounts: strictCounts,
        unknownCount: Math.max(0, strictUnknown)
      },
      loose: {
        total: looseTotal,
        modelCounts: looseCounts,
        unknownCount: Math.max(0, looseUnknown)
      },
      apiGeneratingCount: apiGeneratingCount
    };
  } catch (err) {
    return {
      strict: {
        total: -1,
        modelCounts: {},
        unknownCount: 0
      },
      loose: {
        total: -1,
        modelCounts: {},
        unknownCount: 0
      }
    };
  }
}
async function runMonitorCheck() {
  const sequence = ++monitorCheckSequence,
    isCurrent = () => sequence === monitorCheckSequence && state.enabled;
  if (!state.enabled) return;
  try {
    const tab = await findGenerateTab();
    if (!isCurrent()) return;
    if (!tab?.id) {
      state.currentCount = -1, state.status = "未找到即梦生成页，请保持页面打开", state.updatedAt = Date.now(), await saveState(), await scheduleMonitorAlarm();
      return;
    }
    const counts = await countConcurrency(tab.id),
      strictTotal = Number(counts?.strict?.total),
      looseTotal = Number(counts?.loose?.total);
    if (!isCurrent()) return;
    let count = strictTotal,
      modelCounts = sanitizeModelCounts(counts?.strict?.modelCounts || {}),
      unknownCount = Math.max(0, finiteOrMinusOne(Number(counts?.strict?.unknownCount ?? 0))),
      mode = "严格";
    if (Number.isFinite(looseTotal) && Number.isFinite(strictTotal) && looseTotal > strictTotal) {
      count = looseTotal;
      modelCounts = sanitizeModelCounts(counts?.loose?.modelCounts || {});
      unknownCount = Math.max(0, finiteOrMinusOne(Number(counts?.loose?.unknownCount ?? 0)));
      mode = "兜底";
    }
    const apiGen = Number(counts?.apiGeneratingCount);
    state.apiGeneratingCount = Number.isFinite(apiGen) && apiGen >= 0 ? apiGen : -1;
    state.currentCount = count, state.modelCounts = modelCounts, state.unknownCount = unknownCount, state.groupLimits = sanitizeGroupLimits(state.groupLimits || {});
    if (!Number.isFinite(count) || count < 0) state.status = "检测失败，稍后自动重试";else {
      const parts = Object.keys(MODEL_GROUP).map(model => {
        const cnt = Number(state.modelCounts?.[model] || 0),
          lim = limitForModel(model);
        return model + " " + cnt + "/" + lim;
      });
      state.status = "模型并发（" + mode + "）：" + parts.join("；") + (unknownCount > 0 ? "；未知模型 " + unknownCount : "");
    }
    state.updatedAt = Date.now(), await saveState();
  } catch (err) {
    if (!isCurrent()) return;
    state.currentCount = -1, state.modelCounts = {}, state.unknownCount = 0, state.apiGeneratingCount = -1, state.status = "监控异常: " + (err.message || err), state.updatedAt = Date.now(), await saveState();
  } finally {
    if (isCurrent()) await scheduleMonitorAlarm();
  }
}
async function init() {
  try {
    const saved = await storageGet(STORAGE_KEY_STATE);
    saved && typeof saved === "object" && (state = {
      ...DEFAULT_STATE,
      ...saved,
      groupLimits: sanitizeGroupLimits(saved.groupLimits || DEFAULT_STATE.groupLimits),
      currentCount: finiteOrMinusOne(saved.currentCount),
      modelCounts: sanitizeModelCounts(saved.modelCounts || {}),
      unknownCount: Number.isFinite(saved.unknownCount) ? Math.max(0, Math.floor(saved.unknownCount)) : 0,
      apiGeneratingCount: Number.isFinite(saved.apiGeneratingCount) ? Math.max(-1, Math.floor(saved.apiGeneratingCount)) : -1,
      limit: clampLimit(saved.limit),
      enabled: !!saved.enabled
    });
  } catch {
    state = {
      ...DEFAULT_STATE
    };
  }
  await scheduleMonitorAlarm(), await scheduleQueueDriverAlarm();
}
chrome.runtime.onInstalled.addListener(() => {
  init();
}), chrome.runtime.onStartup.addListener(() => {
  init();
});
async function openOrFocusPopup() {
  const popupUrl = chrome.runtime.getURL(POPUP_PAGE),
    tabs = await chrome.tabs.query({
      url: popupUrl
    }),
    tab = tabs.find(t => Number.isInteger(t.id));
  if (tab?.id) {
    Number.isInteger(tab.windowId) && (await chrome.windows.update(tab.windowId, {
      focused: true
    }));
    await chrome.tabs.update(tab.id, {
      active: true
    });
    return;
  }
  await chrome.windows.create({
    url: popupUrl,
    type: "popup",
    width: 1328,
    height: 960,
    focused: true
  });
}
chrome.action.onClicked.addListener(() => {
  openOrFocusPopup()["catch"](() => {});
}), chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === MONITOR_ALARM) {
    runMonitorCheck();
    return;
  }
  if (alarm.name === QUEUE_DRIVER_ALARM) {
    driveTaskQueue();
    return;
  }
}), chrome.tabs.onRemoved.addListener(removedTabId => {
  state.targetTabId === removedTabId && (state.targetTabId = null, saveState());
}), chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  return (async () => {
    if (msg?.type === "W4_BG_GET_STATE") {
      sendResponse({
        ok: true,
        state: state
      });
      return;
    }
    if (msg?.type === "W4_BG_START") {
      state.enabled = true, state.limit = clampLimit(msg.limit), state.groupLimits = sanitizeGroupLimits(msg.groupLimits || state.groupLimits);
      if (Number.isInteger(msg.tabId)) state.targetTabId = msg.tabId;
      await saveState(), await runMonitorCheck(), sendResponse({
        ok: true,
        state: state
      });
      return;
    }
    if (msg?.type === "W4_BG_STOP") {
      monitorCheckSequence += 1;
      state.enabled = false, state.unknownCount = 0, state.status = "监控已停止", state.updatedAt = Date.now(), await saveState(), await scheduleMonitorAlarm(), sendResponse({
        ok: true,
        state: state
      });
      return;
    }
    if (msg?.type === "W4_BG_SET_LIMIT") {
      state.limit = clampLimit(msg.limit), state.groupLimits = {
        standard: state.limit,
        vip: state.limit
      }, await saveState(), sendResponse({
        ok: true,
        state: state
      });
      return;
    }
    if (msg?.type === "W4_BG_SET_GROUP_LIMIT") {
      const group = String(msg.group || "").toLowerCase() === "vip" ? "vip" : "standard",
        lim = clampLimit(msg.limit),
        limits = sanitizeGroupLimits(state.groupLimits || {});
      state.groupLimits = {
        ...limits,
        [group]: lim
      }, await saveState(), sendResponse({
        ok: true,
        state: state
      });
      return;
    }
    if (msg?.type === "W4_BG_CHECK_ONCE") {
      if (Number.isInteger(msg.tabId)) state.targetTabId = msg.tabId;
      await runMonitorCheck(), sendResponse({
        ok: true,
        state: state
      });
      return;
    }
    if (msg?.type === "W4_BG_SET_TARGET_TAB") {
      Number.isInteger(msg.tabId) && (state.targetTabId = msg.tabId, await saveState());
      sendResponse({
        ok: true,
        state: state
      });
      return;
    }
    sendResponse({
      ok: false,
      error: "unknown-message"
    });
  })()["catch"](err => {
    sendResponse({
      ok: false,
      error: err.message || String(err)
    });
  }), true;
}), init();
