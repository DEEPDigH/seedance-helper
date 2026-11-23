/**
 * net-hook.js — MAIN world 持久网络钩子
 *
 * 职责：在即梦页面包裹 fetch / XMLHttpRequest，捕获 `get_history_by_ids` 响应里的平台
 * record，写入 window.__jmCap，供 popup 读取：
 *   - 受理判定（quickCheckSubmitAccepted/confirmSubmitAcceptedByMonitor）：提交后是否出现"新生成中记录" → window.__jmCap.acceptedSinceMark
 *   - 终态同步（jqScrapeTaskRecords 合并）：每条 record 的 statusCode / isGenerating / createdTime
 *
 * 页面会轮询 get_history_by_ids 渲染结果；有些结果卡 DOM 扫描看不到（如被滚动卸载/虚拟列表），
 * 必须靠接口数据兜住。
 *
 * statusCode 对齐 React record 枚举（jqScrapeTaskRecords 用 50=成功）：
 *   生成中(finish_time==0)=30；完成且有产出项=50；完成但无产出项(失败)=0。
 */
(() => {
  if (window.__jmCapHooked) return;
  window.__jmCapHooked = true;

  const cap = window.__jmCap = window.__jmCap || {
    installedAt: Date.now(),
    submitMark: 0,            // popup 在每次提交前置为 Date.now()
    acceptedSinceMark: false, // 标记后出现"新生成中记录"则置 true
    acceptedRecords: [],      // 本次提交标记之后确认的新生成记录
    acceptSeq: 0,             // 见过的不同 record 数（单调递增，调试用）
    records: {}               // id -> { id, createdTime, isGenerating, statusCode, items, finished, ts }
  };

  function ingest(json) {
    try {
      const data = json && json.data;
      if (!data || typeof data !== "object") return;
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (!v || typeof v !== "object") continue;
        const task = v.task || {};
        const id = String(v.history_record_id || task.history_id || k || "");
        if (!id) continue;
        const finish = Number(task.finish_time) || 0;
        const finished = finish !== 0;
        const items = Array.isArray(v.item_list) ? v.item_list.length : 0;
        const statusCode = finished ? (items > 0 ? 50 : 0) : 30;
        const ctRaw = Number(v.created_time || task.create_time || 0);
        // created_time 可能是秒(小数)或毫秒，统一成毫秒
        const createdTime = ctRaw > 0 ? (ctRaw < 1e12 ? Math.round(ctRaw * 1000) : Math.round(ctRaw)) : 0;
        // 即时失败信号：已结束(finish_time≠0)却无产出项(item_list 空) = 生成失败。
        // 成功时 finish_time 与 item_list 同一响应一起返回，故不会把成功误判为失败。
        const failed = finished && items === 0;
        const isNew = !cap.records[id];
        cap.records[id] = { id, createdTime, isGenerating: !finished, statusCode, items, finished, failed, ts: Date.now() };
        if (isNew) {
          cap.acceptSeq += 1;
          // 只有"提交标记之后出现的、仍在生成中的新记录"才算受理；
          // 已完成的旧记录被重新渲染不会误判。
          const createdAfterSubmit = createdTime > 0 && createdTime >= cap.submitMark - 120000;
          if (!finished && cap.submitMark && Date.now() >= cap.submitMark && createdAfterSubmit) {
            cap.acceptedSinceMark = true;
            if (!Array.isArray(cap.acceptedRecords)) cap.acceptedRecords = [];
            cap.acceptedRecords.push({ id, createdTime, ts: Date.now() });
          }
        }
      }
    } catch (e) {}
  }

  function maybe(url, text) {
    try {
      if (!/\/mweb\/v1\/get_history_by_ids/.test(String(url || ""))) return;
      ingest(JSON.parse(text));
    } catch (e) {}
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      const url = (args[0] && args[0].url) ? args[0].url : args[0];
      return origFetch.apply(this, args).then((resp) => {
        try {
          if (/\/mweb\/v1\/get_history_by_ids/.test(String(url || ""))) {
            resp.clone().text().then((t) => maybe(url, t)).catch(() => {});
          }
        } catch (e) {}
        return resp;
      });
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__jmUrl = url; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", () => { try { maybe(this.__jmUrl, this.responseText || ""); } catch (e) {} });
    return origSend.apply(this, arguments);
  };
})();
