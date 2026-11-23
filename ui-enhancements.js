(function () {
  const $ = (id) => document.getElementById(id);
  let promptEditorSyncing = false;
  let promptEditorLastValue = "";
  let promptEditorAtStart = -1;

  let promptEditorExpanded = false;
  let promptInlineHeight = 160;
  let promptResizeHandle = null;
  let promptDropdownHome = null;
  let promptDropdownMouseDown = false;

  function promptWrapper() {
    return promptCodeMirror?.getWrapperElement?.() || null;
  }

  function promptDropdown() {
    return $("atDropdown");
  }

  function placeEditorDropdown(dropdown, startOffset) {
    if (!dropdown || !promptCodeMirror) return;
    const parent = dropdown.offsetParent || dropdown.parentElement;
    const parentRect = parent?.getBoundingClientRect?.();
    if (!parentRect) return;
    const coords = promptCodeMirror.cursorCoords(promptCodeMirror.posFromIndex(startOffset), "window");
    const rect = dropdown.getBoundingClientRect();
    const width = Math.min(360, Math.max(240, parentRect.width - 24));
    const height = Math.max(120, Math.min(rect.height || 180, 260));
    const left = Math.max(8, Math.min(parentRect.width - width - 8, coords.left - parentRect.left));
    const belowTop = coords.bottom - parentRect.top + 8;
    const aboveTop = coords.top - parentRect.top - height - 8;
    const top = (coords.bottom + height + 24 > window.innerHeight && aboveTop > 8) ? aboveTop : belowTop;
    dropdown.style.width = width + "px";
    dropdown.style.left = left + "px";
    dropdown.style.top = top + "px";
  }

  function setPromptEditorHeight(height) {
    if (!promptCodeMirror || promptEditorExpanded) return;
    const nextHeight = Math.max(160, Math.min(560, Math.round(Number(height) || promptInlineHeight)));
    promptInlineHeight = nextHeight;
    promptCodeMirror.setSize("100%", nextHeight);
    const wrapper = promptWrapper();
    if (wrapper) wrapper.style.height = nextHeight + "px";
    window.setTimeout(() => promptCodeMirror.refresh(), 0);
  }

  function closePromptEditor() {
    const modal = $("promptEditorModal");
    const source = $("promptText");
    const wrapper = promptWrapper();
    const shell = source?.closest(".prompt-highlight-shell");
    if (wrapper && shell) {
      shell.appendChild(wrapper);
      wrapper.classList.remove("is-expanded");
      promptEditorExpanded = false;
      setPromptEditorHeight(promptInlineHeight);
    }
    if (promptDropdownHome?.parent && promptDropdown()) {
      promptDropdownHome.parent.insertBefore(promptDropdown(), promptDropdownHome.nextSibling);
    }
    promptEditorExpanded = false;
    if (modal) modal.hidden = true;
    hideEditorDropdown();
    if (promptCodeMirror) window.setTimeout(() => {
      promptCodeMirror.refresh();
      promptCodeMirror.focus();
    }, 0);
  }

  function openPromptEditor() {
    const modal = $("promptEditorModal");
    const mount = $("promptEditorMount");
    const wrapper = promptWrapper();
    const dropdown = promptDropdown();
    if (!modal || !mount || !wrapper || !promptCodeMirror) return;
    if (!promptDropdownHome && dropdown) {
      promptDropdownHome = { parent: dropdown.parentNode, nextSibling: dropdown.nextSibling };
    }
    modal.hidden = false;
    mount.appendChild(wrapper);
    if (dropdown) modal.appendChild(dropdown);
    promptEditorExpanded = true;
    wrapper.classList.add("is-expanded");
    promptCodeMirror.setSize("100%", "100%");
    hideEditorDropdown();
    window.setTimeout(() => {
      promptCodeMirror.refresh();
      promptCodeMirror.focus();
    }, 0);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function stemName(value) {
    return String(value || "").replace(/\.[^./\\\s]+$/g, "");
  }

  // 接受纯字符串或 {name,type}；返回候选词列表 + 候选词→类型 映射。
  function materialCandidatesWithType(names) {
    const seen = new Set();
    const candidates = [];
    const typeOf = new Map();
    (Array.isArray(names) ? names : []).forEach((entry) => {
      const fullName = (typeof entry === "string" ? entry : String(entry?.name || "")).trim();
      const type = typeof entry === "string" ? null : (entry?.type || null);
      const stem = stemName(fullName).trim();
      const compactStem = stem.replace(/[@＠;；]/g, "").replace(/\s+/g, "").trim();
      [fullName, stem, compactStem].forEach((candidate) => {
        if (!candidate || seen.has(candidate)) return;
        seen.add(candidate);
        candidates.push(candidate);
        if (type) typeOf.set(candidate, type);
      });
    });
    candidates.sort((a, b) => b.length - a.length);
    return { candidates, typeOf };
  }
  function materialNameCandidates(names) {
    return materialCandidatesWithType(names).candidates;
  }

  function namesFromPayload(payload) {
    const out = [];
    const append = (type) => (item) => {
      const name = String(item?.name || item || "").trim();
      if (name) out.push({ name, type });
    };
    (payload?.images || payload?.imageFiles || []).forEach(append("img"));
    (payload?.videos || payload?.videoFiles || []).forEach(append("vid"));
    (payload?.audios || payload?.audioFiles || []).forEach(append("aud"));
    return out;
  }

  function namesFromMediaChips() {
    return Array.from(document.querySelectorAll("#mediaChips .media-chip")).flatMap((chip) => {
      const type = chip.classList.contains("vid") ? "vid" : chip.classList.contains("aud") ? "aud" : "img";
      const tag = String(chip.dataset?.tag || chip.textContent || "").trim().replace(/^[@＠]/, "");
      const title = String(chip.getAttribute("title") || "").trim();
      return [tag, title].filter(Boolean).map((name) => ({ name, type }));
    });
  }

  function currentMaterialNames() {
    if (typeof window.jqCurrentPromptMaterialNames === "function") {
      return window.jqCurrentPromptMaterialNames();
    }
    const chipNames = namesFromMediaChips();
    if (chipNames.length) return chipNames;
    try {
      if (typeof jqImageFiles !== "undefined" || typeof jqVideoFiles !== "undefined" || typeof jqAudioFiles !== "undefined") {
        return namesFromPayload({
          images: typeof jqImageFiles !== "undefined" ? jqImageFiles : [],
          videos: typeof jqVideoFiles !== "undefined" ? jqVideoFiles : [],
          audios: typeof jqAudioFiles !== "undefined" ? jqAudioFiles : []
        });
      }
    } catch {}
    return [];
  }

  function taskMaterialNames(card) {
    const taskId = card?.dataset?.taskId || card?.querySelector("[data-task-id]")?.dataset?.taskId || "";
    if (taskId && typeof window.jqTaskPromptMaterialNames === "function") {
      return window.jqTaskPromptMaterialNames(taskId);
    }
    try {
      if (taskId && typeof jqTasks !== "undefined" && Array.isArray(jqTasks)) {
        const numericId = Number(taskId);
        const task = jqTasks.find((item) => Number(item?.id) === numericId);
        return namesFromPayload(task?.payload || {});
      }
    } catch {}
    return [];
  }

  function findPromptRefs(value, names) {
    const source = String(value || "");
    const { candidates, typeOf } = materialCandidatesWithType(names);
    const refs = [];
    if (!source || !candidates.length) return refs;

    for (let index = 0; index < source.length; index += 1) {
      const mark = source[index];
      if (mark !== "@" && mark !== "＠") continue;
      const rest = source.slice(index + 1);
      // Longest exact match wins (candidates are sorted longest-first). '@' is a
      // dedicated reference marker matched against the known material list, so no
      // trailing-delimiter check is needed — this lets refs immediately followed
      // by CJK text (no space) still highlight. (F2)
      const name = candidates.find((candidate) => rest.startsWith(candidate));
      if (!name) continue;
      refs.push({ start: index, end: index + 1 + name.length, name, type: typeOf.get(name) || null, raw: source.slice(index, index + 1 + name.length) });
      index += name.length;
    }
    return refs;
  }

  function highlightPromptRefs(value, names) {
    const source = String(value || "");
    const refs = findPromptRefs(source, names);
    if (!refs.length) return escapeHtml(source);
    let output = "";
    let lastIndex = 0;
    for (const ref of refs) {
      output += escapeHtml(source.slice(lastIndex, ref.start));
      output += '<span class="prompt-ref-token' + (ref.type ? ' prompt-ref-' + ref.type : '') + '">' + escapeHtml(ref.raw) + "</span>";
      lastIndex = ref.end;
    }
    output += escapeHtml(source.slice(lastIndex));
    return output;
  }

      function updatePromptRefSummary(value, names) {
    const summary = $("promptRefSummary");
    if (!summary) return;
    const previousPopover = summary.querySelector(".prompt-ref-popover");
    const wasOpen = summary.classList.contains("open") && previousPopover && !previousPopover.hidden;
    const counts = new Map();
    findPromptRefs(value, names).forEach((ref) => {
      counts.set(ref.name, (counts.get(ref.name) || 0) + 1);
    });
    const refs = [...counts.entries()];
    summary.hidden = refs.length === 0;
    if (!refs.length) {
      summary.classList.remove("open");
      summary.innerHTML = "";
      return;
    }
    const rows = refs
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => '<div class="prompt-ref-row"><span>@' + escapeHtml(name) + '</span><strong>× ' + count + "</strong></div>")
      .join("");
    const total = refs.reduce((sum, item) => sum + item[1], 0);
    summary.innerHTML =
      '<button type="button" class="prompt-ref-trigger">引用 ' + refs.length + ' 个</button>' +
      '<div class="prompt-ref-popover" ' + (wasOpen ? "" : "hidden") + '>' +
      '<div class="prompt-ref-popover-head"><span>已引用素材</span><strong>共 ' + total + " 次</strong></div>" +
      rows +
      "</div>";
    summary.classList.toggle("open", !!wasOpen);
    const trigger = summary.querySelector(".prompt-ref-trigger");
    const popover = summary.querySelector(".prompt-ref-popover");
    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    trigger?.addEventListener("pointerdown", stop);
    trigger?.addEventListener("click", (event) => {
      stop(event);
      const nextOpen = popover.hidden;
      popover.hidden = !nextOpen;
      summary.classList.toggle("open", nextOpen);
    });
    popover?.addEventListener("pointerdown", (event) => event.stopPropagation());
    popover?.addEventListener("click", (event) => event.stopPropagation());
  }

  let promptCodeMirror = null;
  let promptRefMarks = [];
  let promptRefreshTimer = null;

  function markCodeMirrorRefs() {
    if (!promptCodeMirror) return;
    promptRefMarks.forEach((mark) => mark.clear());
    promptRefMarks = [];
    const value = promptCodeMirror.getValue();
    findPromptRefs(value, currentMaterialNames()).forEach((ref) => {
      promptRefMarks.push(promptCodeMirror.markText(
        promptCodeMirror.posFromIndex(ref.start),
        promptCodeMirror.posFromIndex(ref.end),
        { className: "cm-prompt-ref-token" + (ref.type ? " cm-prompt-ref-" + ref.type : "") }
      ));
    });
  }

  function schedulePromptRefresh() {
    window.clearTimeout(promptRefreshTimer);
    promptRefreshTimer = window.setTimeout(() => {
      const value = promptCodeMirror ? promptCodeMirror.getValue() : ($("promptText")?.value || "");
      updatePromptRefSummary(value, currentMaterialNames());
      markCodeMirrorRefs();
      updateCodeMirrorEmptyState();
    }, 40);
  }

  function updateCodeMirrorEmptyState() {
    if (!promptCodeMirror) return;
    promptCodeMirror.getWrapperElement().classList.toggle("CodeMirror-empty", !promptCodeMirror.getValue());
  }

  function syncSourceSelectionFromCodeMirror() {
    const source = $("promptText");
    if (!source || !promptCodeMirror || typeof source.setSelectionRange !== "function") return;
    const index = promptCodeMirror.indexFromPos(promptCodeMirror.getCursor());
    source.setSelectionRange(index, index);
  }

  function syncPromptReferenceView() {
    const source = $("promptText");
    if (!source) return;
    const value = source.value || "";
    if (promptCodeMirror && promptCodeMirror.getValue() !== value && !promptEditorSyncing) {
      promptEditorSyncing = true;
      const cursorIndex = Math.min(promptCodeMirror.indexFromPos(promptCodeMirror.getCursor()), value.length);
      promptCodeMirror.setValue(value);
      promptCodeMirror.setCursor(promptCodeMirror.posFromIndex(cursorIndex));
      promptEditorSyncing = false;
    }
    updatePromptRefSummary(value, currentMaterialNames());
    markCodeMirrorRefs();
    updateCodeMirrorEmptyState();
  }

  function installPromptResizeHandle() {
    const wrapper = promptWrapper();
    if (!wrapper || promptResizeHandle) return;
    if (window.ResizeObserver) {
      let resizeRefreshTimer = null;
      promptResizeHandle = new ResizeObserver(() => {
        // 防抖：composer 展开/收缩做 CSS 过渡时 wrapper 尺寸每帧都变，
        // 不防抖会在 ~180ms 过渡期间触发几十次 getBoundingClientRect + CodeMirror.refresh（强制重排+重渲染），
        // 是动画卡顿的根因；等尺寸变化停下来后只刷新一次。
        clearTimeout(resizeRefreshTimer);
        resizeRefreshTimer = window.setTimeout(() => {
          const height = Math.round(wrapper.getBoundingClientRect().height);
          if (!promptEditorExpanded && Number.isFinite(height) && height > 0) promptInlineHeight = height;
          promptCodeMirror?.refresh();
        }, 200);
      });
      promptResizeHandle.observe(wrapper);
    }
  }

  function mediaReferenceItems() {
    // 权威来源：jqBuildAtItems() 已包含「已上传素材 + 当前项目素材」并按文件名去重，
    // 必须优先用它，否则引用一个项目素材后（chips 里只剩已上传的），未引用的项目素材会从下拉消失。
    try {
      if (typeof jqBuildAtItems === "function") {
        const built = jqBuildAtItems();
        if (built && built.length) return built;
      }
    } catch {}
    const chipItems = Array.from(document.querySelectorAll("#mediaChips .media-chip")).map((chip) => {
      const tag = String(chip.dataset?.tag || chip.textContent || "").trim();
      const label = tag.replace(/^[@＠]/, "");
      return {
        tag,
        label,
        fileName: String(chip.getAttribute("title") || label).trim(),
        icon: chip.classList.contains("vid") ? "视" : chip.classList.contains("aud") ? "音" : "图"
      };
    }).filter((item) => item.tag);
    if (chipItems.length) return chipItems;
    return materialNameCandidates(currentMaterialNames()).map((name) => ({ tag: "@" + name, label: name, fileName: name, icon: "@" }));
  }

  function hideEditorDropdown() {
    const dropdown = $("atDropdown");
    if (dropdown) dropdown.style.display = "none";
    promptEditorAtStart = -1;
  }

  // 项目素材缩略图缓存：matId -> dataUrl（项目素材图片存在 IndexedDB，需异步取）
  const projThumbCache = new Map();
  async function loadProjectThumbs(dropdown) {
    const nodes = dropdown.querySelectorAll(".at-thumb-load[data-matid]");
    for (const node of nodes) {
      const matId = node.dataset.matid;
      if (!matId) continue;
      try {
        let dataUrl = projThumbCache.get(matId);
        if (dataUrl === undefined) {
          const stored = (typeof window.getProjectMaterialBlob === "function") ? await window.getProjectMaterialBlob(matId) : null;
          dataUrl = (stored && stored.dataUrl) ? stored.dataUrl : null;
          projThumbCache.set(matId, dataUrl);
        }
        if (dataUrl) { node.classList.remove("at-thumb-load"); node.innerHTML = '<img src="' + dataUrl + '" alt="">'; }
      } catch (e) {}
    }
  }

  function showEditorDropdown(query, startOffset) {
    const dropdown = $("atDropdown");
    if (!dropdown) return;
    const needle = String(query || "").toLowerCase();
    const items = mediaReferenceItems().filter((item) => {
      return !needle || String(item.label || "").toLowerCase().includes(needle) || String(item.fileName || "").toLowerCase().includes(needle);
    });
    if (!items.length) {
      hideEditorDropdown();
      return;
    }
    promptEditorAtStart = startOffset;
    // 左缩略图 + 名称 + 右类型胶囊；上传素材与项目素材之间插一条分隔线
    let html = "";
    let prevSource = null;
    items.slice(0, 40).forEach((item) => {
      if (prevSource === "upload" && item.source === "project") {
        html += '<div class="at-dropdown-divider"><span>项目素材库</span></div>';
      }
      prevSource = item.source;
      const typ = item.icon === "视" ? "vid" : item.icon === "音" ? "aud" : item.icon === "@" ? "ref" : "img";
      const typeLabel = typ === "vid" ? "视频" : typ === "aud" ? "音频" : typ === "ref" ? "引用" : "图片";
      const isImg = (item.kind === "img" || item.kind === "image");
      let thumb;
      if (item.thumbUrl) {
        thumb = '<span class="at-thumb"><img src="' + escapeHtml(item.thumbUrl) + '" alt=""></span>';
      } else if (isImg && item.matId) {
        thumb = '<span class="at-thumb at-thumb-load" data-matid="' + escapeHtml(item.matId) + '"></span>';
      } else {
        thumb = '<span class="at-thumb at-thumb-icon">' + escapeHtml(item.icon || "图") + '</span>';
      }
      html += '<div class="at-dropdown-item at-type-' + typ + '" data-tag="' + escapeHtml(item.tag) + '" title="' + escapeHtml(item.fileName || item.label || item.tag) + '">' +
        thumb +
        '<span class="at-name">' + escapeHtml(item.label || item.tag) + '</span>' +
        '<span class="at-typepill">' + typeLabel + '</span></div>';
    });
    dropdown.innerHTML = html;
    dropdown.querySelectorAll(".at-dropdown-item").forEach((item) => {
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        promptDropdownMouseDown = true;
        insertEditorReference(item.dataset.tag || "");
        window.setTimeout(() => { promptDropdownMouseDown = false; }, 80);
      });
    });
    loadProjectThumbs(dropdown);
    dropdown.style.display = "block";
    dropdown.style.visibility = "hidden";
    placeEditorDropdown(dropdown, startOffset);
    dropdown.style.visibility = "visible";
  }

  function installLogResizeHandle() {
    const box = $("log")?.closest(".log-resizable");
    if (!box || box.dataset.bound === "1") return;
    box.dataset.bound = "1";
    if (!box.style.height) box.style.height = "42px";
    const sync = () => {
      const height = Math.max(34, Math.round(box.getBoundingClientRect().height));
      box.classList.toggle("is-expanded", height > 58);
      if (typeof window.jqRenderLog === "function") window.jqRenderLog();
    };
    if (window.ResizeObserver) new ResizeObserver(sync).observe(box);
    box.addEventListener("mouseup", () => window.setTimeout(sync, 0));
    sync();
  }

  function refreshProjectTooltips() {
    document.querySelectorAll(".project-item").forEach((item) => {
      const label = item.querySelector("span")?.textContent?.trim() || item.textContent?.trim() || "";
      if (label) item.title = label;
    });
    const activeName = $("activeProjectName");
    if (activeName) activeName.title = activeName.textContent.trim();
  }

  function installProjectTooltipObserver() {
    const projectList = $("projectList");
    if (!projectList || projectList.dataset.tooltipBound === "1") return;
    projectList.dataset.tooltipBound = "1";
    new MutationObserver(refreshProjectTooltips).observe(projectList, { childList: true, subtree: true, characterData: true });
    refreshProjectTooltips();
  }

  function updateEditorDropdown() {
    if (!promptCodeMirror || !promptCodeMirror.hasFocus()) return;
    const value = promptCodeMirror.getValue();
    const caret = promptCodeMirror.indexFromPos(promptCodeMirror.getCursor());
    const before = value.slice(0, caret);
    const atIndex = Math.max(before.lastIndexOf("@"), before.lastIndexOf("＠"));
    if (atIndex < 0) {
      hideEditorDropdown();
      return;
    }
    const query = before.slice(atIndex + 1);
    if (/[\s@＠，。！？；：、,.!?;:]/.test(query)) {
      hideEditorDropdown();
      return;
    }
    showEditorDropdown(query, atIndex);
  }

  function syncSourceFromEditor(dispatchChange = false) {
    const source = $("promptText");
    if (!source || !promptCodeMirror) return;
    const value = promptCodeMirror.getValue();
    const caret = promptCodeMirror.indexFromPos(promptCodeMirror.getCursor());
    promptEditorSyncing = true;
    source.value = value;
    promptEditorLastValue = value;
    if (caret !== null && typeof source.setSelectionRange === "function") source.setSelectionRange(caret, caret);
    source.dispatchEvent(new Event("input", { bubbles: true }));
    if (dispatchChange) source.dispatchEvent(new Event("change", { bubbles: true }));
    promptEditorSyncing = false;
    updatePromptRefSummary(value, currentMaterialNames());
    schedulePromptRefresh();
    updateEditorDropdown();
  }

  function insertEditorReference(tag) {
    const source = $("promptText");
    if (!source || !promptCodeMirror || !tag) return;
    const value = promptCodeMirror.getValue();
    const caret = promptCodeMirror.indexFromPos(promptCodeMirror.getCursor());
    const start = promptEditorAtStart >= 0 ? promptEditorAtStart : caret;
    const nextValue = value.slice(0, start) + tag + value.slice(caret);
    const nextCaret = start + tag.length;
    promptEditorSyncing = true;
    promptCodeMirror.replaceRange(tag, promptCodeMirror.posFromIndex(start), promptCodeMirror.posFromIndex(caret), "+input");
    promptCodeMirror.setCursor(promptCodeMirror.posFromIndex(nextCaret));
    source.value = nextValue;
    if (typeof source.setSelectionRange === "function") source.setSelectionRange(nextCaret, nextCaret);
    source.dispatchEvent(new Event("input", { bubbles: true }));
    source.dispatchEvent(new Event("change", { bubbles: true }));
    promptEditorSyncing = false;
    updatePromptRefSummary(nextValue, currentMaterialNames());
    schedulePromptRefresh();
    window.setTimeout(() => {
      markCodeMirrorRefs();
      updatePromptRefSummary(promptCodeMirror.getValue(), currentMaterialNames());
      promptCodeMirror.refresh();
    }, 0);
    hideEditorDropdown();
    promptCodeMirror.focus();
  }

  function bindEditorDropdownKeys() {
    if (!promptCodeMirror) return;
    promptCodeMirror.on("keydown", (_cm, event) => {
      const dropdown = $("atDropdown");
      if (!dropdown || dropdown.style.display === "none") return;
      const items = Array.from(dropdown.querySelectorAll(".at-dropdown-item"));
      if (!items.length) return;
      if (event.key === "Escape") {
        event.preventDefault();
        hideEditorDropdown();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const active = dropdown.querySelector(".at-dropdown-item.active") || items[0];
        if (active) {
          event.preventDefault();
          insertEditorReference(active.dataset.tag || "");
        }
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const activeIndex = items.findIndex((item) => item.classList.contains("active"));
        if (activeIndex >= 0) items[activeIndex].classList.remove("active");
        const nextIndex = event.key === "ArrowDown" ? (activeIndex + 1 + items.length) % items.length : (activeIndex - 1 + items.length) % items.length;
        items[nextIndex].classList.add("active");
        items[nextIndex].scrollIntoView({ block: "nearest" });
      }
    });
  }

  function bindPromptReferenceView() {
    const source = $("promptText");
    if (!source || source.dataset.refViewBound === "1") return;
    source.dataset.refViewBound = "1";

    if (window.CodeMirror) {
      promptCodeMirror = window.CodeMirror.fromTextArea(source, {
        mode: null,
        lineWrapping: true,
        viewportMargin: Infinity,
        indentUnit: 2,
        smartIndent: false,
        electricChars: false,
        extraKeys: { "Ctrl-Space": updateEditorDropdown }
      });
      promptCodeMirror.getWrapperElement().classList.add("prompt-codemirror");
      promptCodeMirror.getWrapperElement().setAttribute("data-placeholder", source.getAttribute("placeholder") || "");
      setPromptEditorHeight(promptInlineHeight);
      installPromptResizeHandle();
      window.setTimeout(() => promptCodeMirror.refresh(), 0);
      promptCodeMirror.on("change", () => {
        if (promptEditorSyncing) return;
        syncSourceFromEditor(false);
      });
      promptCodeMirror.on("cursorActivity", () => {
        syncSourceSelectionFromCodeMirror();
        updateEditorDropdown();
      });
      promptCodeMirror.on("blur", () => {
        syncSourceFromEditor(true);
        window.setTimeout(() => {
          const dropdown = promptDropdown();
          if (promptDropdownMouseDown || dropdown?.matches?.(":hover")) return;
          hideEditorDropdown();
        }, 120);
      });
      bindEditorDropdownKeys();
    }

    source.addEventListener("input", () => syncPromptReferenceView());
    source.addEventListener("change", () => syncPromptReferenceView());
    ["imageFiles", "videoFiles", "audioFiles"].forEach((id) => $(id)?.addEventListener("change", () => setTimeout(syncPromptReferenceView, 0)));
    ["mediaChips", "imagePreviewGrid"].forEach((id) => {
      const node = $(id);
      if (node) new MutationObserver(() => syncPromptReferenceView()).observe(node, { childList: true, subtree: true });
    });
    document.addEventListener("click", (event) => {
      const chip = event.target?.closest?.(".media-chip");
      if (chip?.dataset?.tag) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        if (promptCodeMirror && !promptCodeMirror.hasFocus()) promptCodeMirror.focus();
        insertEditorReference(chip.dataset.tag);
        return;
      }
      const summary = $("promptRefSummary");
      if (summary && !summary.contains(event.target)) {
        summary.classList.remove("open");
        const popover = summary.querySelector(".prompt-ref-popover");
        if (popover) popover.hidden = true;
      }
    }, true);
    window.setInterval(() => {
      if (!source) return;
      if ((source.value || "") !== promptEditorLastValue) syncPromptReferenceView();
    }, 350);
    syncPromptReferenceView();
    window.jqSyncPromptReferenceView = syncPromptReferenceView;
  }

  function bindPromptEditor() {
    $("promptExpandBtn")?.addEventListener("click", openPromptEditor);
    $("promptEditorCancel")?.addEventListener("click", closePromptEditor);
    $("promptEditorModal")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closePromptEditor();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("promptEditorModal")?.hidden) closePromptEditor();
    });
    installLogResizeHandle();
    installProjectTooltipObserver();
  }

  function enhanceTaskText(card) {
    const media = card.querySelector(".task-card-media");
    const timeMeta = card.querySelector(":scope > .task-card-time-meta");
    if (media && timeMeta && timeMeta.dataset.jqInlined !== "1") {
      timeMeta.dataset.jqInlined = "1";
      media.appendChild(timeMeta);
    }

    const prompt = card.querySelector(".task-card-prompt");
    if (!prompt || prompt.dataset.jqTextEnhanced === "1") return;

    const rawText = prompt.textContent || "";
    prompt.dataset.rawPrompt = rawText;
    prompt.innerHTML = highlightPromptRefs(rawText, taskMaterialNames(card));
    prompt.dataset.jqTextEnhanced = "1";
    const needsToggle = prompt.textContent.trim().length > 160 || prompt.scrollHeight > 136;
    if (!needsToggle) return;

      prompt.classList.add("jq-task-text-collapsed");

      const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "task-text-toggle";
    toggle.textContent = "展开文本";
    toggle.addEventListener("click", () => {
      const collapsed = prompt.classList.toggle("jq-task-text-collapsed");
      toggle.textContent = collapsed ? "展开文本" : "收起文本";
    });

    prompt.insertAdjacentElement("afterend", toggle);
  }

  function enhanceTaskCards(root) {
    (root || document).querySelectorAll(".task-card").forEach(enhanceTaskText);
  }

  function bindTaskObserver() {
    const queue = $("queueCards");
    if (!queue) return;
    enhanceTaskCards(queue);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.matches?.(".task-card")) enhanceTaskText(node);
          enhanceTaskCards(node);
        });
      }
    });
    observer.observe(queue, { childList: true, subtree: true });
  }

  function bindFaceToolPanel() {
    const toggle = $("faceToolToggle");
    const panel = $("faceToolPanel");
    if (!toggle || !panel) return;
    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      const statsToggle = $("statsToolToggle");
      const statsPanel = $("statsToolPanel");
      if (!panel.hidden && statsPanel && statsToggle) {
        statsPanel.hidden = true;
        statsToggle.classList.remove("active");
        statsToggle.textContent = "效率统计";
      }
      toggle.classList.toggle("active", !panel.hidden);
      toggle.textContent = panel.hidden ? "人脸分割" : "收起人脸分割";
    });
  }

  function bindStatsToolPanel() {
    const toggle = $("statsToolToggle");
    const panel = $("statsToolPanel");
    if (!toggle || !panel) return;
    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      const faceToggle = $("faceToolToggle");
      const facePanel = $("faceToolPanel");
      if (!panel.hidden && facePanel && faceToggle) {
        facePanel.hidden = true;
        faceToggle.classList.remove("active");
        faceToggle.textContent = "人脸分割";
      }
      toggle.classList.toggle("active", !panel.hidden);
      toggle.textContent = panel.hidden ? "效率统计" : "收起统计";
      if (!panel.hidden && typeof window.jqRenderStatsPanel === "function") {
        window.jqRenderStatsPanel();
      }
    });
  }

  // ===== 提示词模板 =====
  const PROMPT_TPL_KEY = "workspace3PromptTemplatesV1";
  function loadPromptTemplates() {
    return new Promise((resolve) => {
      try { chrome.storage.local.get([PROMPT_TPL_KEY], (r) => resolve(Array.isArray(r?.[PROMPT_TPL_KEY]) ? r[PROMPT_TPL_KEY] : [])); }
      catch { resolve([]); }
    });
  }
  function savePromptTemplates(list) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set({ [PROMPT_TPL_KEY]: list }, () => resolve()); }
      catch { resolve(); }
    });
  }
  async function renderPromptTemplatePopover() {
    const pop = $("promptTplPopover");
    if (!pop) return;
    const list = await loadPromptTemplates();
    if (!list.length) {
      pop.innerHTML = "<div class=\"prompt-tpl-empty\">还没有模板。在「放大编辑」里点「保存提示词」即可保存当前内容。</div>";
      return;
    }
    pop.innerHTML = list.slice().reverse().map((t) => {
      const name = escapeHtml(t.taskName || "未命名");
      const preview = escapeHtml(String(t.prompt || "").replace(/\s+/g, " ").trim().slice(0, 60));
      return "<div class=\"prompt-tpl-row\" data-id=\"" + escapeHtml(t.id) + "\" title=\"点击插入到输入框\">" +
        "<div class=\"prompt-tpl-main\"><div class=\"prompt-tpl-name\">" + name + "</div><div class=\"prompt-tpl-preview\">" + preview + "</div></div>" +
        "<button type=\"button\" class=\"prompt-tpl-del\" data-id=\"" + escapeHtml(t.id) + "\" title=\"删除\">×</button>" +
        "</div>";
    }).join("");
  }
  async function insertPromptTemplate(id) {
    const list = await loadPromptTemplates();
    const t = list.find((x) => String(x.id) === String(id));
    if (!t) return;
    const src = $("promptText");
    if (src) {
      src.value = String(t.prompt || "");
      src.dispatchEvent(new Event("input", { bubbles: true }));
      src.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // 回填任务名：仅当当前为空时
    const nameInput = $("taskNameInput");
    if (nameInput && !String(nameInput.value || "").trim() && t.taskName) {
      nameInput.value = t.taskName;
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      nameInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (promptCodeMirror) { promptEditorSyncing = true; promptCodeMirror.setValue(String(t.prompt || "")); promptEditorSyncing = false; }
    if (typeof window.jqSyncPromptReferenceView === "function") window.jqSyncPromptReferenceView();
    const pop = $("promptTplPopover"); if (pop) pop.hidden = true;
  }
  async function deletePromptTemplate(id) {
    const list = await loadPromptTemplates();
    await savePromptTemplates(list.filter((x) => String(x.id) !== String(id)));
    renderPromptTemplatePopover();
  }
  async function savePromptAsTemplate() {
    const prompt = promptCodeMirror ? promptCodeMirror.getValue() : ($("promptText")?.value || "");
    if (!String(prompt || "").trim()) return;
    const taskName = String($("taskNameInput")?.value || "").trim();
    const list = await loadPromptTemplates();
    list.push({ id: "tpl_" + Date.now() + "_" + Math.random().toString(16).slice(2, 8), taskName, prompt, createdAt: Date.now() });
    await savePromptTemplates(list);
    const btn = $("promptTplSaveBtn");
    if (btn) { const o = btn.textContent; btn.textContent = "已保存 ✓"; window.setTimeout(() => { btn.textContent = o; }, 1200); }
  }
  function bindPromptTemplates() {
    const btn = $("promptTplBtn"), pop = $("promptTplPopover");
    if (btn && pop) {
      btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (pop.hidden) { renderPromptTemplatePopover(); pop.hidden = false; } else pop.hidden = true;
      });
      pop.addEventListener("click", (e) => {
        const del = e.target.closest?.(".prompt-tpl-del");
        if (del) { e.preventDefault(); e.stopPropagation(); deletePromptTemplate(del.dataset.id); return; }
        const row = e.target.closest?.(".prompt-tpl-row");
        if (row && row.dataset.id) { e.preventDefault(); e.stopPropagation(); insertPromptTemplate(row.dataset.id); return; }
      });
      document.addEventListener("click", (e) => {
        if (!pop.hidden && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) pop.hidden = true;
      });
    }
    $("promptTplSaveBtn")?.addEventListener("click", (e) => { e.preventDefault(); savePromptAsTemplate(); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      bindPromptEditor();
      bindPromptReferenceView();
      bindTaskObserver();
      bindFaceToolPanel();
      bindStatsToolPanel();
      bindPromptTemplates();
    });
  } else {
    bindPromptEditor();
    bindPromptReferenceView();
    bindTaskObserver();
    bindFaceToolPanel();
    bindStatsToolPanel();
    bindPromptTemplates();
  }
})();
