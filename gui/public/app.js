const token = document.querySelector('meta[name="app-token"]').content;
const state = {
  library: { summary: {}, sources: [], packets: [], items: [] },
  currentView: "overview",
  activeJob: null,
  pollTimer: null,
  selectedFiles: [],
  uploadId: null,
  libraryTab: "packets",
  itemLimit: 100,
  wizardStep: 1,
  diagnostics: null,
  reviewItems: [],
  reviewTotal: 0,
  reviewQueue: "all",
  reviewCounts: {},
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(pathname, options = {}) {
  const headers = { ...(options.headers || {}), "X-App-Token": token };
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(pathname, { ...options, headers });
  const data = await response.json().catch(() => ({ ok: false, error: "服务返回无法解析的内容" }));
  if (!response.ok || data.ok === false) {
    const detail = typeof data.details === "string" ? data.details : "";
    throw new Error(`${data.error || response.statusText}${detail ? `：${detail}` : ""}`);
  }
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function richHtml(value) {
  const text = String(value || "");
  const pattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  let cursor = 0;
  let match;
  const parts = [];
  while ((match = pattern.exec(text))) {
    parts.push(escapeHtml(text.slice(cursor, match.index)).replaceAll("\n", "<br/>"));
    const sourcePath = match[1];
    parts.push(
      `<img class="inline-asset" src="/api/library/asset?path=${encodeURIComponent(sourcePath)}&token=${encodeURIComponent(token)}" data-asset-source="${escapeHtml(sourcePath)}" alt="公式或图形" />`,
    );
    cursor = pattern.lastIndex;
  }
  parts.push(escapeHtml(text.slice(cursor)).replaceAll("\n", "<br/>"));
  return parts.join("");
}

function toast(message, isError = false) {
  const element = $("#toast");
  element.textContent = message;
  element.style.background = isError ? "#7f3028" : "#1c343b";
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 4200);
}

const PAGE_COPY = {
  overview: ["资料库总览", "查看来源、资料包、草稿题和可组卷题。"],
  upload: ["资料入库", "上传后立即持久化，并自动拆分高置信度草稿题。"],
  library: ["资料库", "浏览资料包、来源文件和结构化题目。"],
  pairing: ["配对解析", "确认试卷与答案关系，再补齐答案和难度。"],
  review: ["题目审核", "核对原题、答案、解析和难度档。"],
  generate: ["生成试卷", "从资料库选择内容，完成预检后生成。"],
  history: ["任务历史", "查看解析和组卷任务结果。"],
  settings: ["设置诊断", "检查模型、本地依赖和文件位置。"],
};

function switchView(name, options = {}) {
  state.currentView = name;
  if (name === "review") state.reviewQueue = options.queue || state.reviewQueue || "all";
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  $("#page-title").textContent = PAGE_COPY[name]?.[0] || "";
  $("#page-subtitle").textContent = PAGE_COPY[name]?.[1] || "";
  if (name === "overview") renderOverview();
  if (name === "library") {
    renderLibrary();
    loadLibrary();
  }
  if (name === "pairing") loadPairing();
  if (name === "review") loadReview(true);
  if (name === "generate") prepareWizardOptions();
  if (name === "history") loadJobs();
  if (name === "settings") {
    loadDiagnostics();
    loadAuditState();
  }
}

function empty(message) {
  return `<p class="empty-state">${escapeHtml(message)}</p>`;
}

function statusTag(status) {
  const labels = {
    registered: "已保存",
    grouped: "已分组",
    suggested: "待确认配对",
    needs_review: "需复核",
    awaiting_pairing: "待配对",
    split: "已拆题",
    parsed: "已解析",
    draft: "草稿",
    verified: "可组卷",
    missing: "缺答案",
    answer_only: "题干误为答案",
    administrative_text: "答题说明误拆",
    answer_copy: "参考答案误拆",
    container_parent: "父题容器",
    duplicate: "重复记录",
    incomplete_question: "题干不完整",
    auto_unverified: "自动验证未通过",
    parsed_source: "已拆题",
  };
  const bad = ["missing", "needs_review", "conflicting", "mismatch", "answer_only", "administrative_text", "answer_copy", "container_parent", "duplicate", "incomplete_question", "auto_unverified"].includes(status);
  return `<span class="tag ${bad ? "warn" : ""}">${escapeHtml(labels[status] || status || "未知")}</span>`;
}

function formatDate(value) {
  if (!value) return "";
  try { return new Date(value).toLocaleString(); } catch { return value; }
}

function sourceName(sourceId) {
  return state.library.sources.find((source) => source.source_id === sourceId)?.name || sourceId;
}

function packetSources(packet) {
  const ids = [
    ...(packet.question_source_ids || []),
    ...(packet.answer_source_ids || []),
    ...(packet.solution_source_ids || []),
    ...(packet.rubric_source_ids || []),
    ...(packet.mixed_source_ids || []),
    ...(packet.unknown_source_ids || []),
  ];
  return state.library.sources.filter((source) => ids.includes(source.source_id));
}

function setNavigationBadge(id, value, details, severity = "pending") {
  const element = document.getElementById(id);
  if (!element) return;
  const count = Number(value || 0);
  element.classList.remove("pending", "error", "running");
  element.classList.toggle("hidden", count <= 0);
  if (count > 0) {
    element.textContent = String(count);
    element.classList.add(severity);
  }
  element.title = count > 0 ? details : "";
  element.setAttribute("aria-label", count > 0 ? details : "没有待办");
}

function renderNavigation() {
  const nav = state.library.navigation || {};
  const uploadCount = Number(nav.upload?.running || 0) + Number(nav.upload?.failed || 0);
  setNavigationBadge(
    "nav-upload-badge",
    uploadCount,
    Number(nav.upload?.failed || 0)
      ? `${nav.upload.failed} 个文件保存失败`
      : `${nav.upload?.running || 0} 个上传任务进行中`,
    Number(nav.upload?.failed || 0) ? "error" : "pending",
  );
  const libraryCount = Number(nav.library?.unassigned || 0) + Number(nav.library?.failed || 0);
  setNavigationBadge(
    "nav-library-badge",
    libraryCount,
    `${nav.library?.unassigned || 0} 个来源未分组，${nav.library?.failed || 0} 个来源提取失败`,
    Number(nav.library?.failed || 0) ? "error" : "pending",
  );
  setNavigationBadge(
    "nav-pairing-badge",
    nav.pairing?.pending_packets || 0,
    `${nav.pairing?.pending_packets || 0} 个资料包等待确认配对`,
    "pending",
  );
  const reviewCount =
    Number(nav.review?.human_required || 0) +
    Number(nav.review?.missing_answers || 0) +
    Number(nav.review?.sample_required || 0);
  const reviewElement = document.getElementById("review-count");
  reviewElement.classList.remove("pending", "error", "running");
  reviewElement.classList.toggle("hidden", reviewCount <= 0);
  if (reviewCount > 0) {
    reviewElement.textContent = String(reviewCount);
    reviewElement.classList.add("pending");
  }
  reviewElement.title =
    reviewCount > 0
      ? `${nav.review?.missing_answers || 0} 道缺答案，${nav.review?.human_required || 0} 道结构例外，${nav.review?.sample_required || 0} 道随机抽查`
      : "";
  reviewElement.setAttribute(
    "aria-label",
    reviewCount > 0 ? reviewElement.title : "没有待审核题目",
  );
  const generateState = document.getElementById("nav-generate-state");
  generateState.classList.toggle("hidden", !nav.generate?.blocked);
  generateState.title = nav.generate?.reason || "";
  generateState.setAttribute(
    "aria-label",
    nav.generate?.blocked ? `生成试卷存在阻断项：${nav.generate.reason}` : "可以生成试卷",
  );
  const historyState = document.getElementById("nav-history-state");
  historyState.classList.toggle("hidden", !Number(nav.jobs?.running || 0));
  historyState.title = nav.jobs?.running ? `${nav.jobs.running} 个任务正在运行` : "";
  historyState.setAttribute(
    "aria-label",
    nav.jobs?.running ? `${nav.jobs.running} 个任务正在运行` : "没有运行中的任务",
  );
}

async function loadStatus() {
  try {
    const data = await api("/api/status");
    state.library = data.library || state.library;
    const years = [...new Set(state.library.packets.map((packet) => packet.metadata?.year).filter(Boolean))].sort((a,b) => Number(b) - Number(a));
    const types = [...new Set(state.library.packets.map((packet) => packet.metadata?.paper_type).filter(Boolean))].sort();
    const yearSelect = $("#filter-year");
    const typeSelect = $("#filter-type");
    yearSelect.innerHTML = '<option value="">全部年份</option>' + years.map((year) => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`).join("");
    typeSelect.innerHTML = '<option value="">全部卷型</option>' + types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("");
    state.diagnostics = data;
    $("#service-dot").classList.add("ok");
    $("#model-summary").textContent = data.ollama?.reachable
      ? `本地 ${data.models?.ollama?.simple || "模型"}`
      : "本地模型未连接";
    $("#ollama-summary").textContent = data.ollama?.reachable
      ? `Ollama ${data.ollama.version} · ${data.ollama.models.length} 个模型`
      : "Ollama 未运行";
    $("#ollama-summary").classList.toggle("muted", !data.ollama?.reachable);
    renderNavigation();
    renderOverview();
    return data;
  } catch (error) {
    $("#service-dot").classList.remove("ok");
    $("#model-summary").textContent = "服务连接失败";
    toast(error.message, true);
  }
}

function renderOverview() {
  const summary = state.library.summary || {};
  const metrics = [
    ["来源文件", summary.sources || 0, "原始题卷、答案和解析"],
    ["资料包", summary.packets || 0, "按考试整理的资料来源"],
    ["可组卷题目", summary.ready_items || 0, "答案和复核均通过"],
    ["待配对", summary.unpaired_packets || 0, "需确认题卷与答案"],
    ["待处理题目", Number(summary.human_exceptions || 0) + Number(summary.missing_answers || 0) + Number(summary.sample_review || 0), "结构例外、缺答案和抽查"],
    ["系统排除", summary.excluded_items || 0, "保留原题但不进入正式卷"],
  ];
  $("#overview-stats").innerHTML = metrics
    .map(([label, value, note]) => `<article class="metric-card"><span>${label}</span><strong>${value}</strong><p>${note}</p></article>`)
    .join("");
  const attention = [];
  if (summary.unpaired_packets) attention.push({
    title: "资料包等待配对",
    note: `${summary.unpaired_packets} 个资料包的题卷与答案关系尚未确认`,
    view: "pairing",
  });
  if (summary.missing_answers) attention.push({
    title: "题目缺少可靠答案",
    note: `${summary.missing_answers} 道题可由官方解析或自动求解补齐`,
    view: "review",
    queue: "missing",
  });
  if (summary.human_exceptions) attention.push({
    title: "结构或媒体异常",
    note: `${summary.human_exceptions} 道题需要系统例外处理`,
    view: "review",
    queue: "human",
  });
  if (summary.sample_review) attention.push({
    title: "自动审核随机抽查",
    note: `${summary.sample_review} 道题被抽中复核`,
    view: "review",
    queue: "sample",
  });
  if (summary.excluded_items) attention.push({
    title: "系统已排除题目",
    note: `${summary.excluded_items} 道题保留记录但不会进入正式卷`,
    view: "review",
    queue: "excluded",
  });
  if (!attention.length) attention.push({
    title: "资料库状态正常",
    note: "当前没有必须处理的异常",
    view: "library",
  });
  $("#overview-attention").innerHTML = attention
    .map((item) => `<button class="attention-item" data-go="${item.view}"${item.queue ? ` data-queue="${item.queue}"` : ""}><span><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.note)}</p></span><span>→</span></button>`)
    .join("");
  const recent = [...state.library.packets].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 5);
  $("#overview-recent").innerHTML = recent.length
    ? recent.map((packet) => `<button class="compact-item" data-packet-open="${escapeHtml(packet.packet_id)}"><span><strong>${escapeHtml(packet.title || packet.packet_id)}</strong><p>${packetSources(packet).length} 个来源 · ${packet.item_count || 0} 道题 · ${formatDate(packet.updated_at)}</p></span><span>${statusTag(packet.lifecycle_status)}${packet.pairing_status !== "confirmed" ? statusTag(packet.pairing_status) : ""}</span></button>`).join("")
    : empty("资料库还没有内容。请先上传题卷和答案。");
}

function inferRole(name) {
  if (/原卷版|原卷|（原卷）/.test(name)) return "question";
  if (/解析版|（解析）/.test(name)) return "solution";
  if (/纯答案版|答案版|参考答案|（答案）/.test(name)) return "answer";
  if (/评分|细则/.test(name)) return "rubric";
  if (/试卷|试题|数学/.test(name)) return "question";
  return "unknown";
}

function groupUploadName(name) {
  return name
    .replace(/\.(zip|pdf|docx|md|txt|png|jpe?g|webp)$/i, "")
    .replace(/精品解析[:：_]?|网络\s*收集版|网络收集版/g, "")
    .replace(/[（(](?:原卷版|解析版|纯答案版|答案版|参考答案|原卷|解析|答案)[）)]/g, "")
    .replace(/参考答案|原卷版|解析版|纯答案版|答案版|原卷|答案|解析/g, "")
    .replace(/[_-]+/g, " ")
    .trim() || "未命名资料";
}

function addFiles(fileList) {
  if (state.uploadId) {
    state.uploadId = null;
    state.selectedFiles = [];
    $("#upload-message").textContent = "已开始重新选择，请重新上传整组资料。";
    $("#upload-message").classList.remove("error");
  }
  for (const file of fileList) {
    if (!state.selectedFiles.some((entry) => entry.name === file.name && entry.size === file.size)) {
      state.selectedFiles.push({ file, name: file.name, size: file.size, role: inferRole(file.name) });
    }
  }
  renderUploadSelection();
}

function renderUploadSelection() {
  $("#upload-list").innerHTML = state.selectedFiles
    .map((entry, index) => `
      <div class="upload-row">
        <strong title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</strong>
        <select data-index="${index}" aria-label="文件角色">
          ${[["question","试卷"],["answer","答案"],["solution","详细解析"],["rubric","评分标准"],["mixed","题答合并"],["unknown","未分类"]]
            .map(([value, label]) => `<option value="${value}" ${entry.role === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
        <small>${(entry.size / 1024 / 1024).toFixed(2)} MB</small>
      </div>`)
    .join("");
  $$(".upload-row select").forEach((select) => {
    select.addEventListener("change", (event) => {
      state.selectedFiles[Number(event.target.dataset.index)].role = event.target.value;
      renderUploadPreview();
    });
  });
  $("#upload-button").disabled = !state.selectedFiles.length;
  renderUploadPreview();
}

function renderUploadPreview() {
  if (!state.selectedFiles.length) {
    $("#upload-preview").innerHTML = '<p class="empty-state">选择文件后，这里会显示压缩包和文件角色建议。</p>';
    return;
  }
  const groups = new Map();
  for (const entry of state.selectedFiles) {
    const key = /\.zip$/i.test(entry.name) ? entry.name : groupUploadName(entry.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  $("#upload-preview").innerHTML = [...groups.entries()]
    .map(([name, files]) => `<div class="file-group"><strong>${escapeHtml(name)}</strong>${files.map((file) => `<span class="file-chip">${escapeHtml(file.name)} · ${escapeHtml(file.role)}</span>`).join("")}</div>`)
    .join("");
}

async function saveUploads() {
  if (!state.selectedFiles.length) return;
  const valid = state.selectedFiles.every((entry) => entry.file instanceof Blob);
  if (!valid) {
    toast("文件状态已失效，请清空后重新选择整组资料。", true);
    return;
  }
  const button = $("#upload-button");
  const message = $("#upload-message");
  button.disabled = true;
  button.textContent = "保存并拆题中…";
  message.classList.remove("error");
  message.textContent = "正在保存原始文件，随后自动拆出草稿题。";
  try {
    const form = new FormData();
    for (const entry of state.selectedFiles) form.append("file", entry.file, entry.name);
    const upload = await api("/api/upload", { method: "POST", body: form });
    const roles = Object.fromEntries(state.selectedFiles.map((entry) => [entry.name, entry.role]));
    const imported = await api("/api/library/import", {
      method: "POST",
      body: { upload_id: upload.upload_id, roles },
    });
    state.uploadId = null;
    state.selectedFiles = [];
    renderUploadSelection();
    message.textContent = `已保存 ${imported.result?.summary?.sources || 0} 个来源，形成 ${imported.result?.summary?.packets || 0} 个资料包。`;
    await loadStatus();
    switchView("library");
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
    button.disabled = false;
  } finally {
    button.textContent = "保存到资料库";
  }
}

async function loadLibrary() {
  try {
    const data = await api("/api/library/state");
    state.library = data.library || state.library;
    renderNavigation();
    renderLibrary();
    renderOverview();
  } catch (error) {
    toast(error.message, true);
  }
}

function filteredPackets() {
  const query = $("#library-search").value.trim().toLowerCase();
  const grade = $("#filter-grade").value;
  const year = $("#filter-year").value;
  const type = $("#filter-type").value;
  const status = $("#filter-status").value;
  return state.library.packets.filter((packet) => {
    const haystack = `${packet.title || ""} ${packet.packet_id} ${packetSources(packet).map((source) => source.name).join(" ")}`.toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (grade && packet.metadata?.grade !== grade) return false;
    if (year && String(packet.metadata?.year || "") !== year) return false;
    if (type && packet.metadata?.paper_type !== type) return false;
    if (status === "ready" && !(packet.ready_item_count > 0)) return false;
    if (status && status !== "ready" && packet.lifecycle_status !== status && packet.pairing_status !== status) return false;
    return true;
  });
}

function filteredItems() {
  const query = $("#library-search").value.trim().toLowerCase();
  const grade = $("#filter-grade").value;
  const year = $("#filter-year").value;
  const type = $("#filter-type").value;
  const status = $("#filter-status").value;
  return state.library.items.filter((item) => {
    const haystack = `${item.question_no || ""} ${item.summary || ""} ${(item.topic_codes || []).join(" ")}`.toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (grade && item.grade !== grade) return false;
    const packet = state.library.packets.find((value) => value.packet_id === item.packet_id);
    if (year && String(packet?.metadata?.year || "") !== year) return false;
    if (type && packet?.metadata?.paper_type !== type) return false;
    if (status === "ready" && !(item.review_status === "verified" && ["matched", "verified"].includes(item.answer_status))) return false;
    if (status === "draft" && !["draft", "needs_review"].includes(item.review_status)) return false;
    if (status && !["ready", "draft"].includes(status) && item.split_status !== status) return false;
    return true;
  });
}

function renderLibrary() {
  $("#packet-count").textContent = state.library.packets.length;
  $("#item-count").textContent = state.library.items.length;
  $$("#library-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.libraryTab === state.libraryTab));
  $("#packet-list").classList.toggle("hidden", state.libraryTab !== "packets");
  $("#item-list").classList.toggle("hidden", state.libraryTab !== "items");
  $("#library-bulk").classList.toggle("hidden", state.libraryTab !== "packets");
  if (state.libraryTab === "packets") renderPackets();
  else renderItems();
}

function renderPackets() {
  const packets = filteredPackets();
  $("#library-filter-count").textContent = `${packets.length} 个资料包`;
  $("#library-bulk").innerHTML = packets.length > 1
    ? '<button id="merge-selected" class="secondary small">合并勾选的资料包</button>'
    : "";
  $("#packet-list").innerHTML = packets.length
    ? packets.map((packet) => `
      <article class="packet-card">
        <div class="packet-card-head">
          <div>
            <h3><label><input class="packet-check" type="checkbox" value="${escapeHtml(packet.packet_id)}" /> ${escapeHtml(packet.title || packet.packet_id)}</label></h3>
            <div class="packet-meta">
              <span>${escapeHtml(packet.metadata?.grade || "年级未知")}</span>
              <span>${escapeHtml(packet.metadata?.paper_type || "卷型未知")}</span>
              <span>${packetSources(packet).length} 个来源</span>
              <span>${packet.item_count || 0} 道题</span>
              ${statusTag(packet.lifecycle_status)}
              ${packet.pairing_status !== "confirmed" ? statusTag(packet.pairing_status) : ""}
            </div>
          </div>
          <button class="secondary small show-packet" data-packet="${escapeHtml(packet.packet_id)}">查看详情</button>
        </div>
        <div class="packet-meta" style="margin-top:10px">
          <span>已审核 ${packet.ready_item_count || 0}</span>
          <span class="${packet.missing_answer_count ? "tag warn" : ""}">缺答案 ${packet.missing_answer_count || 0}</span>
          <span>更新 ${formatDate(packet.updated_at)}</span>
        </div>
      </article>`)
      .join("")
    : empty("没有符合条件的资料包。请先上传或在筛选中清除条件。");
  $$(".show-packet").forEach((button) => button.addEventListener("click", () => showPacket(button.dataset.packet)));
  $("#merge-selected")?.addEventListener("click", mergeSelectedPackets);
}

function renderItems() {
  const allItems = filteredItems();
  const items = allItems.slice(0, state.itemLimit);
  $("#library-filter-count").textContent = `${allItems.length} 道题`;
  $("#item-list").innerHTML = items.length
    ? `<table class="item-table"><thead><tr><th>题号</th><th>题干摘要</th><th>资料包</th><th>题型</th><th>专题</th><th>档位</th><th>答案</th><th>审核</th></tr></thead><tbody>${items.map((item) => `
      <tr data-item="${escapeHtml(item.id)}">
        <td>${escapeHtml(item.question_no || "")}${item.subquestion_no ? `(${escapeHtml(item.subquestion_no)})` : ""}</td>
        <td>${escapeHtml(item.summary || "")}</td>
        <td>${escapeHtml(state.library.packets.find((packet) => packet.packet_id === item.packet_id)?.title || item.packet_id || "")}</td>
        <td>${escapeHtml({single_choice:"单选",multiple_choice:"多选",fill_blank:"填空",solution:"解答"}[item.question_type] || item.question_type || "")}</td>
        <td>${escapeHtml((item.topic_codes || []).join("、"))}</td>
        <td>${escapeHtml(item.primary_band || "")}</td>
        <td>${statusTag(item.answer_status)}</td>
        <td>${statusTag(item.review_status)}</td>
      </tr>`).join("")}</tbody></table>${allItems.length > items.length ? `<div class="actions"><button id="load-more-items" class="secondary small">再加载100道（剩余 ${allItems.length - items.length}）</button></div>` : ""}`
    : empty("没有符合条件的题目。");
  $$(".item-table tbody tr").forEach((row) => row.addEventListener("click", () => showItem(row.dataset.item)));
  $("#load-more-items")?.addEventListener("click", () => { state.itemLimit += 100; renderItems(); });
}

async function showPacket(packetId) {
  const packet = state.library.packets.find((value) => value.packet_id === packetId);
  if (!packet) return;
  const sources = packetSources(packet);
  const html = `
    <div class="attention-list">
      ${sources.map((source) => `
        <div class="attention-item" data-source="${escapeHtml(source.source_id)}">
          <span><label><input type="checkbox" class="source-check" data-source="${escapeHtml(source.source_id)}" /> ${escapeHtml(source.name)}</label><p>${escapeHtml(source.extraction_status)} · ${source.asset_count || 0} 个公式/图形资产 · ${source.question_count || 0} 道草稿题</p></span>
          <span class="actions compact">
            <select class="inline-select source-role">
              ${[["question","试卷"],["answer","答案"],["solution","解析"],["rubric","评分标准"],["mixed","混合"],["unknown","未分类"]]
                .map(([value, label]) => `<option value="${value}" ${source.role === value ? "selected" : ""}>${label}</option>`).join("")}
            </select>
            <button class="secondary small view-source">查看文本</button>
            <button class="secondary small open-source">打开原文件</button>
            <button class="secondary small download-source">下载</button>
          </span>
        </div>`).join("")}
    </div>
    <div class="actions">
      <button class="primary process-packet">重新解析并匹配答案</button>
      <button class="secondary split-sources">拆分勾选的来源文件</button>
    </div>
    <label class="hint"><input type="checkbox" id="split-all-sources" /> 选择全部来源用于拆分</label>`;
  openDialog(packet.title || packet.packet_id, html);
  const rows = $$("#dialog-body [data-source]");
  rows.forEach((row) => {
    $(".source-role", row).addEventListener("change", () => changeSourceRole(row.dataset.source, $(".source-role", row).value));
    $(".view-source", row).addEventListener("click", () => showSourceText(row.dataset.source));
    $(".open-source", row).addEventListener("click", () => openSource(row.dataset.source));
    $(".download-source", row).addEventListener("click", () => downloadSource(row.dataset.source));
  });
  $("#split-all-sources").addEventListener("change", (event) => {
    $$(".source-check", $("#dialog-body")).forEach((input) => { input.checked = event.target.checked; });
  });
  $(".process-packet").addEventListener("click", () => processPacket(packet.packet_id));
  $(".split-sources").addEventListener("click", () => {
    const selected = $$(".source-check:checked", $("#dialog-body")).map((input) => input.dataset.source);
    if (!selected.length) return toast("请先勾选要拆出的来源文件", true);
    splitPacket(packet.packet_id, selected);
  });
}

async function showItem(itemId) {
  try {
    const data = await api(`/api/library/item?item_id=${encodeURIComponent(itemId)}`);
    const item = data.item;
    openDialog(
      `题目 ${item.question_no || ""} · ${item.primary_band || "未定档"}`,
      `<div class="review-columns">
        <div><div class="review-box"><strong>题干</strong>${richHtml(item.stem_markdown || "")}${optionRows(item.options || [])}</div></div>
        <div><div class="review-box"><strong>答案与解析</strong>${richHtml([item.answer, item.solution].filter(Boolean).join("\n\n") || "暂无可靠答案")}</div></div>
      </div>
      <p class="hint">来源：${escapeHtml(item.source_location?.source_id || "")} · 拆题置信度 ${Math.round((item.split_confidence || 0) * 100)}% · ${escapeHtml(item.review_status)}</p>`,
    );
  } catch (error) { toast(error.message, true); }
}

function openDialog(title, html) {
  $("#dialog-title").textContent = title;
  $("#dialog-body").innerHTML = html;
  $("#detail-dialog").showModal();
}

async function changeSourceRole(sourceId, role) {
  try {
    await api("/api/library/source/role", { method: "POST", body: { source_id: sourceId, role } });
    toast("文件角色已更新，相关草稿和配对已重新计算。");
    await loadLibrary();
  } catch (error) { toast(error.message, true); }
}

async function showSourceText(sourceId) {
  try {
    const data = await api(`/api/library/source-text?source_id=${encodeURIComponent(sourceId)}`);
    openDialog("提取文本预览", `<div class="source-preview">${richHtml(data.text || "没有可显示的文字层。")}</div>`);
  } catch (error) { toast(error.message, true); }
}

async function openSource(sourceId) {
  try { await api(`/api/library/open-source?source_id=${encodeURIComponent(sourceId)}`); }
  catch (error) { toast(error.message, true); }
}

function downloadSource(sourceId) {
  window.location.href = `/api/library/source-file?source_id=${encodeURIComponent(sourceId)}&download=1&token=${encodeURIComponent(token)}`;
}

async function processPacket(packetId) {
  try {
    await api("/api/library/packet/process", { method: "POST", body: { packet_id: packetId } });
    toast("资料包已重新解析。");
    await loadLibrary();
  } catch (error) { toast(error.message, true); }
}

async function splitPacket(packetId, sourceIds) {
  try {
    await api("/api/library/packets/split", { method: "POST", body: { packet_id: packetId, source_ids: sourceIds } });
    $("#detail-dialog").close();
    toast("资料包已拆分。");
    await loadLibrary();
  } catch (error) { toast(error.message, true); }
}

async function mergeSelectedPackets() {
  const packetIds = $$(".packet-check:checked").map((input) => input.value);
  if (packetIds.length < 2) return toast("至少勾选两个资料包", true);
  try {
    await api("/api/library/packets/merge", { method: "POST", body: { packet_ids: packetIds } });
    toast("资料包已合并。");
    await loadLibrary();
  } catch (error) { toast(error.message, true); }
}

async function loadPairing() {
  await loadLibrary();
  const host = $("#pairing-list");
  const packets = state.library.packets.filter((packet) =>
    (packet.question_source_ids || []).length &&
    (packet.answer_source_ids || []).length + (packet.solution_source_ids || []).length &&
    packet.pairing_status !== "confirmed"
  );
  host.innerHTML = packets.length
    ? packets.map((packet) => {
      const questions = packetSources(packet).filter((source) => source.role === "question");
      const answers = packetSources(packet).filter((source) => ["answer", "solution", "rubric"].includes(source.role));
      const rows = questions.map((question) => {
        const candidates = (packet.pairings || []).filter((pair) => pair.question_source_id === question.source_id);
        const confirmed = candidates.find((pair) => pair.confirmed);
        return `<div class="pair-question" data-question="${escapeHtml(question.source_id)}">
          <div class="pair-question-title"><strong>题卷：${escapeHtml(question.name)}</strong></div>
          <div class="pair-controls">
            <select class="inline-select answer-candidate">
              ${candidates.length
                ? candidates.map((pair) => `<option value="${escapeHtml(pair.answer_source_id)}" ${confirmed?.answer_source_id === pair.answer_source_id ? "selected" : ""}>${escapeHtml(sourceName(pair.answer_source_id))}</option>`).join("")
                : answers.map((answer) => `<option value="${escapeHtml(answer.source_id)}">${escapeHtml(answer.name)}</option>`).join("")}
            </select>
            <span class="confidence">${confirmed ? "已确认" : candidates.length ? `最高 ${Math.round((candidates[0].confidence || 0) * 100)}%` : "无自动建议"}</span>
            <button class="secondary confirm-pair">确认配对</button>
          </div>
        </div>`;
      }).join("");
      return `<article class="packet-card">
        <div class="packet-card-head"><div><h3>${escapeHtml(packet.title || packet.packet_id)}</h3><div class="packet-meta">${statusTag(packet.pairing_status)}<span>${questions.length} 份题卷</span><span>${answers.length} 份答案/解析</span></div></div></div>
        ${rows}
        <div class="actions"><button class="secondary small process-packet" data-packet="${escapeHtml(packet.packet_id)}">解析资料包</button></div>
      </article>`;
    }).join("")
    : `<div class="completion-panel"><strong>题答配对已全部确认</strong><p>已确认资料包已从待确认列表移除，可继续审核题目或生成试卷。</p><div class="actions"><button class="primary small" data-go="review">查看待审核题目</button><button class="secondary small" data-go="generate">生成试卷</button></div></div>`;
  $$("#pairing-list .confirm-pair").forEach((button) => button.addEventListener("click", () => {
    const row = button.closest(".pair-question");
    confirmPairing(row.closest(".packet-card").dataset.packet, row.dataset.question, $(".answer-candidate", row).value);
  }));
  $$("#pairing-list .process-packet").forEach((button) => button.addEventListener("click", () => processPacket(button.dataset.packet)));
  $$("#pairing-list .packet-card").forEach((card, index) => {
    card.dataset.packet = packets[index].packet_id;
  });
  $$("#pairing-list [data-go]").forEach((button) =>
    button.addEventListener("click", () => switchView(button.dataset.go)),
  );
}

async function confirmPairing(packetId, questionSourceId, answerSourceId) {
  try {
    await api(`/api/packets/${encodeURIComponent(packetId)}/pair`, {
      method: "POST",
      body: { question_source_id: questionSourceId, answer_source_id: answerSourceId },
    });
    await api("/api/library/packet/process", { method: "POST", body: { packet_id: packetId } });
    toast("配对已确认，答案已尝试对齐到题目。");
    await loadPairing();
  } catch (error) { toast(error.message, true); }
}

async function confirmSafePairs() {
  const actions = [];
  for (const packet of state.library.packets) {
    const confirmedQuestions = new Set(
      (packet.pairings || []).filter((pair) => pair.confirmed).map((pair) => pair.question_source_id),
    );
    for (const questionSourceId of packet.question_source_ids || []) {
      if (confirmedQuestions.has(questionSourceId)) continue;
      const candidate = (packet.pairings || [])
        .filter((pair) => pair.question_source_id === questionSourceId)
        .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0];
      if (candidate && Number(candidate.confidence) >= 0.9) {
        actions.push([packet.packet_id, questionSourceId, candidate.answer_source_id]);
      }
    }
  }
  if (!actions.length) return toast("没有新的高置信度配对可批量确认。");
  if (!confirm(`将确认 ${actions.length} 组置信度至少 90% 的配对。是否继续？`)) return;
  let completed = 0;
  const touchedPackets = new Set();
  for (const [packetId, questionSourceId, answerSourceId] of actions) {
    try {
      await api(`/api/packets/${encodeURIComponent(packetId)}/pair`, {
        method: "POST",
        body: { question_source_id: questionSourceId, answer_source_id: answerSourceId },
      });
      completed += 1;
      touchedPackets.add(packetId);
    } catch {}
  }
  for (const packetId of touchedPackets) {
    try {
      await api("/api/library/packet/process", { method: "POST", body: { packet_id: packetId } });
    } catch {}
  }
  toast(`已确认 ${completed} / ${actions.length} 组配对。`);
  await loadPairing();
}

async function autoReviewAll() {
  const packets = state.library.packets.filter((packet) => packet.pairing_status === "confirmed");
  if (!packets.length) return toast("请先确认题卷和答案配对。", true);
  if (!confirm(`将对 ${packets.length} 个已配对资料包执行风险分级审核。低风险题自动通过，高风险题进入人工队列。是否继续？`)) return;
  const button = $("#auto-review-all");
  const badge = $("#review-count");
  button.disabled = true;
  button.textContent = "自动审核中…";
  badge.classList.remove("hidden", "pending", "error");
  badge.classList.add("running");
  badge.textContent = "";
  let approved = 0;
  let manual = 0;
  for (const packet of packets) {
    try {
      const data = await api("/api/library/packet/auto-review", {
        method: "POST",
        body: { packet_id: packet.packet_id, sample_ratio: 0.1 },
      });
      approved += Number(data.result?.auto_approved || 0);
      manual += Number(data.result?.manual_required || 0);
    } catch (error) {
      toast(`${packet.title || packet.packet_id}：${error.message}`, true);
    }
  }
  toast(`自动通过 ${approved} 道，需人工处理 ${manual} 道。`);
  await loadStatus();
  await loadReview(true);
  button.disabled = false;
  button.textContent = "自动审核已配对资料包";
}

async function autoTriageReview() {
  const button = $("#auto-triage-review");
  button.disabled = true;
  button.textContent = "自动处理中…";
  try {
    const data = await api("/api/review/auto-triage", { method: "POST", body: {} });
    toast(`自动通过 ${data.result.approved.length} 道，自动排除 ${data.result.excluded.length} 道，抽查归档 ${data.result.sample_cleared.length} 道。`);
    await loadStatus();
    await loadReview(true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "全自动处理待审";
  }
}

async function bulkApproveReview() {
  const labels = { human: "人工例外", missing: "缺答案", sample: "随机抽查", excluded: "系统排除", all: "全部" };
  const count = state.reviewTotal || 0;
  if (!count) return toast("当前筛选没有待审核题目。");
  if (!confirm(`将扫描“${labels[state.reviewQueue] || "全部"}”队列中的全部 ${count} 道题，并批准所有机器已判定合格的题。是否继续？`)) return;
  const button = $("#bulk-approve-review");
  button.disabled = true;
  button.textContent = "跨页审核中…";
  try {
    const data = await api("/api/review/approve-all-qualified", {
      method: "POST",
      body: { queue: state.reviewQueue },
    });
    toast(`扫描 ${data.result.scanned} 道，批准 ${data.result.approved.length} 道，保留例外 ${data.result.skipped.length} 道。`);
    await loadStatus();
    await loadReview(true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "批准当前筛选全部合格题";
  }
}

async function repairAnswers() {
  const button = $("#repair-answers");
  if (!confirm("系统将先恢复官方答案，再自动求解并独立复核剩余缺答案题。无法达成一致的题会自动排除，过程中无需逐题确认。是否继续？")) return;
  button.disabled = true;
  button.textContent = "自动补齐中…";
  try {
    const created = await api("/api/answers/repair", { method: "POST", body: {} });
    const jobId = created.job_id;
    let finalJob = null;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const data = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      finalJob = data.job;
      button.textContent = `${finalJob.message || "自动补齐中"} · ${finalJob.progress || 0}%`;
      if (["completed", "failed", "awaiting_review", "cancelled"].includes(finalJob.status)) break;
    }
    if (!finalJob || finalJob.status === "failed") throw new Error(finalJob?.error || "答案修复任务失败");
    toast(finalJob.message || "答案修复完成。");
    await loadStatus();
    await loadReview(true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "自动补齐缺失答案";
  }
}

function updateReviewCounts(counts = {}) {
  const reviewCounts = counts.review || counts;
  state.reviewCounts = reviewCounts;
  $("#review-human-count").textContent = reviewCounts.human || 0;
  $("#review-missing-count").textContent = reviewCounts.missing || 0;
  $("#review-sample-count").textContent = reviewCounts.sample || 0;
  $("#review-excluded-count").textContent = reviewCounts.excluded || 0;
  $("#review-all-count").textContent = reviewCounts.all || 0;
  $$("#review-tabs button").forEach((button) =>
    button.classList.toggle("active", button.dataset.reviewQueue === state.reviewQueue),
  );
}

function optionRows(options = []) {
  if (!options.length) return "";
  return `<div class="review-options">${options
    .map((option, index) => `<div class="review-option"><b>${String.fromCharCode(65 + index)}</b><div>${richHtml(option)}</div></div>`)
    .join("")}</div>`;
}

async function loadReview(reset = true) {
  try {
    const navReview = state.library.navigation?.review || {};
    const offset = reset ? 0 : state.reviewItems.length;
    const data = await api(`/api/review?queue=${encodeURIComponent(state.reviewQueue)}&offset=${offset}&limit=50`);
    state.reviewTotal = data.total || 0;
    state.reviewItems = reset ? data.items : [...state.reviewItems, ...data.items];
    updateReviewCounts(data.counts || navReview.counts || navReview);
    $("#review-summary").textContent =
      `当前“${$("#review-tabs button.active")?.textContent?.trim() || "全部"}”共 ${state.reviewTotal} 道；批量批准会扫描全部分页。`;
    const host = $("#review-list");
    host.innerHTML = state.reviewItems.length
      ? state.reviewItems.map((item) => `<article class="review-card">
        <div class="packet-card-head"><div><h3>${escapeHtml(item.question_no || "")} · ${escapeHtml(item.id)}</h3><div class="packet-meta">${statusTag(item.primary_band)} ${statusTag(item.question_type)} ${statusTag(item.answer_status)} <span>${escapeHtml(item.paper_type || "")}</span></div></div></div>
        <div class="review-columns">
          <div class="review-box"><strong>原题</strong>${richHtml(item.stem || item.stem_markdown || "")}${optionRows(item.options || [])}${(item.parse_warnings || []).length ? `<div class="review-warnings">解析提示：${item.parse_warnings.map(escapeHtml).join("；")}</div>` : ""}</div>
          <div class="review-box"><strong>答案与解析</strong>${richHtml([item.answer, item.solution].filter(Boolean).join("\n\n") || "暂无可靠答案")}${(item.review_reasons || []).length ? `<div class="review-warnings">${item.review_reasons.map(escapeHtml).join("；")}</div>` : ""}</div>
        </div>
        <p class="hint">来源 ${escapeHtml(item.source_location?.source_id || "")} · 题号 ${escapeHtml(item.source_location?.question_no || item.question_no || "")}${item.subquestion_no ? ` · 小问 ${escapeHtml(item.subquestion_no)}` : ""} · 拆题置信度 ${Math.round(Number(item.split_confidence || 0) * 100)}%</p>
        ${item.exclusion_code ? `<p class="review-warnings">系统排除：${statusTag(item.exclusion_code)} ${escapeHtml(item.excluded_reason || "")}</p>` : ""}
        <div class="review-actions">
          <select class="inline-select review-band">${["L1","L2","L3","L4","L5"].map((band) => `<option ${band === item.primary_band ? "selected" : ""}>${band}</option>`).join("")}</select>
          <button class="secondary approve" ${["matched","verified"].includes(item.answer_status) && item.queue !== "excluded" ? "" : "disabled"}>批准</button>
          <button class="secondary reclassify">改档</button>
          <button class="danger reject">淘汰</button>
        </div>
      </article>`).join("") + (state.reviewItems.length < state.reviewTotal ? `<div class="actions"><button id="load-more-review" class="secondary small">再加载50题（剩余 ${state.reviewTotal - state.reviewItems.length}）</button></div>` : "")
      : empty(state.reviewQueue === "all" ? "当前没有待审核或排除记录。" : "当前筛选没有题目，可切换到其他队列。");
    $$(".review-card").forEach((card, index) => {
      const item = state.reviewItems[index];
      $(".approve", card)?.addEventListener("click", () => reviewAction(item.id, "approve"));
      $(".reject", card).addEventListener("click", () => reviewAction(item.id, "reject"));
      $(".reclassify", card).addEventListener("click", () => reviewAction(item.id, "reclassify", $(".review-band", card).value));
    });
    $("#load-more-review")?.addEventListener("click", () => loadReview(false));
  } catch (error) { toast(error.message, true); }
}

async function reviewAction(itemId, action, band = null) {
  try {
    await api("/api/review", { method: "POST", body: { item_id: itemId, action, band, note: "资料库界面复核" } });
    toast("题目状态已更新。");
    await loadReview(true);
    await loadStatus();
  } catch (error) { toast(error.message, true); }
}

function setWizardStep(step) {
  state.wizardStep = Math.max(1, Math.min(3, step));
  $$("[data-step-panel]").forEach((panel) => panel.classList.toggle("active", Number(panel.dataset.stepPanel) === state.wizardStep));
  $$("#wizard-stepper button").forEach((button) => button.classList.toggle("active", Number(button.dataset.step) <= state.wizardStep));
  $("#wizard-back").disabled = state.wizardStep === 1;
  $("#wizard-next").classList.toggle("hidden", state.wizardStep === 3);
  if (state.wizardStep === 3) updatePreflight();
}

async function prepareWizardOptions() {
  if (!state.library.packets.length) await loadLibrary();
  $("#packet-select").innerHTML = state.library.packets.map((packet) => `<option value="${escapeHtml(packet.packet_id)}">${escapeHtml(packet.title || packet.packet_id)} · ${packet.item_count || 0}题</option>`).join("");
  const ready = state.library.items.filter((item) => item.review_status === "verified" && ["matched","verified"].includes(item.answer_status));
  $("#item-select").innerHTML = ready.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.question_no || "")} · ${escapeHtml(item.summary || "")} · ${escapeHtml(item.primary_band || "")}</option>`).join("");
  setWizardStep(state.wizardStep);
}

function updateSourceScope() {
  const value = $("#source-scope").value;
  $("#packet-select-wrap").classList.toggle("hidden", value !== "packets");
  $("#item-select-wrap").classList.toggle("hidden", value !== "items");
  updatePreflight();
}

function typeCounts() {
  return Object.fromEntries(["single_choice","multiple_choice","fill_blank","solution"].map((type) => [type, Number($(`.type-count[name="${type}"]`).value || 0)]));
}

function scoreBand(score) {
  const value = Number(score);
  if (!Number.isInteger(value) || value < 0 || value > 150) return null;
  if (value <= 44) return "L1";
  if (value <= 74) return "L2";
  if (value <= 104) return "L3";
  if (value <= 127) return "L4";
  return "L5";
}

function updateScoreBands() {
  const current = Number($("#current-score").value);
  const target = Number($("#target-score").value);
  const currentBand = scoreBand(current);
  const targetBand = scoreBand(target);
  $("#current-score-band").textContent = currentBand ? `${current}分 · ${currentBand}` : "请输入 0–150 的整数";
  $("#target-score-band").textContent = targetBand ? `${target}分 · ${targetBand}` : "请输入 0–150 的整数";
  return { current, target, currentBand, targetBand };
}

function updatePreflight() {
  const counts = typeCounts();
  const total = Number($("#question-count").value || 0);
  const sum = Object.values(counts).reduce((value, count) => value + count, 0);
  const delivery = $("#delivery-type").value;
  const score = delivery === "classroom" ? 50 : delivery === "tutoring" ? 75 : 150;
  const minutes = Number($("#paper-minutes").value || (delivery === "classroom" ? 30 : delivery === "tutoring" ? 35 : 120));
  const ability = updateScoreBands();
  const scope = $("#source-scope").value;
  const selectedPackets = [...$("#packet-select").selectedOptions].map((option) => option.value);
  const selectedItems = [...$("#item-select").selectedOptions].map((option) => option.value);
  const scopeValid = scope === "all" || (scope === "packets" && selectedPackets.length) || (scope === "items" && selectedItems.length);
  const weak = $("#weak-topics").value.trim();
  const issues = [];
  if (!ability.currentBand || !ability.targetBand) issues.push("当前分数和目标分数必须是 0–150 的整数");
  if (!Number.isFinite(minutes) || minutes < 20 || minutes > 180) issues.push("建议完成时长必须在 20–180 分钟之间");
  if (sum !== total) issues.push("题型数量之和必须等于顶层题数");
  if (!weak) issues.push("必须填写薄弱专题");
  if (!scopeValid) issues.push("请选择资料包或具体题目");
  if (delivery === "full_exam" && total !== 19) issues.push("新高考标准卷应保持19题，或调整蓝图");
  const ready = state.library.items.filter((item) => item.review_status === "verified" && ["matched","verified"].includes(item.answer_status));
  const availableByType = Object.fromEntries(["single_choice","multiple_choice","fill_blank","solution"].map((type) => [type, ready.filter((item) => item.question_type === type).length]));
  $("#preflight").innerHTML = `
    <div>预计总分<strong>${score}</strong></div><div>建议时长<strong>${minutes} 分钟</strong></div><div>顶层题数<strong class="${sum === total ? "" : "warn"}">${total}</strong></div>
    <div>题型数量合计<strong class="${sum === total ? "" : "warn"}">${sum}</strong></div><div>可用已审核题<strong>${ready.length}</strong></div><div>本地云预算提醒<strong>${delivery === "full_exam" ? "80k" : "40k"} tokens</strong></div>
    <div>当前分数<strong>${ability.currentBand ? `${ability.current}分（${ability.currentBand}）` : "无效"}</strong></div><div>目标分数<strong>${ability.targetBand ? `${ability.target}分（${ability.targetBand}）` : "无效"}</strong></div>
    <div>单选 / 多选<strong>${availableByType.single_choice} / ${availableByType.multiple_choice}</strong></div><div>填空 / 解答<strong>${availableByType.fill_blank} / ${availableByType.solution}</strong></div><div>${issues.length ? `<span class="warn">${issues.map(escapeHtml).join("；")}</span>` : "正在等待后端结构预检…"}</div>`;
  clearTimeout(updatePreflight.timer);
  updatePreflight.timer = setTimeout(() => runBackendPreflight().catch(() => {}), 280);
  return !issues.length;
}

function buildPaperPayload() {
  const form = new FormData($("#paper-form"));
  const weakTopics = String(form.get("weak_topics") || "").split(/[,，、;；]/).map((value) => value.trim()).filter(Boolean);
  const scope = $("#source-scope").value;
  const ability = updateScoreBands();
  return {
    delivery_type: form.get("delivery_type"),
    blueprint_id: form.get("delivery_type") === "classroom" ? "classroom_50" : form.get("delivery_type") === "full_exam" ? "full_new_gaokao_150" : "tutoring_75",
    current_score: ability.current,
    target_score: ability.target,
    current_band: ability.currentBand,
    target_band: ability.targetBand,
    grade: form.get("grade"),
    term: form.get("term"),
    paper_type: form.get("paper_type"),
    weak_topics: weakTopics,
    question_count: Number(form.get("question_count")),
    paper_minutes: Number(form.get("paper_minutes")),
    type_counts: typeCounts(),
    comprehensive: form.get("comprehensive") === "on",
    allow_other_grades: form.get("allow_other_grades") === "on",
    allow_adaptable: form.get("allow_adaptable") === "on",
    seed: form.get("seed") ? Number(form.get("seed")) : null,
    web_search: false,
    source_scope: scope,
    packet_ids: scope === "packets" ? [...$("#packet-select").selectedOptions].map((option) => option.value) : [],
    item_ids: scope === "items" ? [...$("#item-select").selectedOptions].map((option) => option.value) : [],
  };
}

async function runBackendPreflight() {
  if (state.currentView !== "generate") return null;
  const data = await api("/api/plan/preflight", { method: "POST", body: { form: buildPaperPayload() } });
  const result = data.preflight;
  if (!result) return null;
  const errors = result.errors || [];
  const request = result.request || {};
  const currentScore = result.current_score ?? request.current_score ?? "未填";
  const targetScore = result.target_score ?? request.target_score ?? "未填";
  const currentBand = result.current_band || request.current_band || "-";
  const targetBand = result.target_band || request.target_band || "-";
  $("#preflight").innerHTML = `
    <div>总分<strong>${result.total_score ?? "-"}</strong></div><div>预计时长<strong>${result.estimated_minutes || 0} 分钟</strong></div>
    <div>当前 / 目标<strong>${currentScore}（${currentBand}） / ${targetScore}（${targetBand}）</strong></div>
    <div>分差<strong>${result.score_gap == null ? "-" : `${result.score_gap > 0 ? "+" : ""}${result.score_gap}分`}</strong></div>
    <div>可用题量<strong>${result.available_total || 0}</strong></div><div>token 预算<strong>${result.token_budget || 0}</strong></div>
    <div>单选 / 多选<strong>${result.available_by_type?.single_choice || 0} / ${result.available_by_type?.multiple_choice || 0}</strong></div>
    <div>填空 / 解答<strong>${result.available_by_type?.fill_blank || 0} / ${result.available_by_type?.solution || 0}</strong></div>
    <div class="${result.ok ? "" : "warn"}">${result.ok ? "后端预检通过，可创建任务" : errors.map(escapeHtml).join("；")}</div>`;
  return result;
}

function applyBlueprintDefaults() {
  const value = $("#delivery-type").value;
  const defaults = value === "classroom"
    ? [9,4,2,2,1]
    : value === "full_exam"
      ? [19,8,3,3,5]
      : [12,6,2,2,2];
  $("#question-count").value = defaults[0];
  $("#paper-minutes").value = value === "classroom" ? 30 : value === "full_exam" ? 120 : 35;
  ["single_choice","multiple_choice","fill_blank","solution"].forEach((type, index) => {
    $(`.type-count[name="${type}"]`).value = defaults[index + 1];
  });
  updatePreflight();
}

async function submitPaper(event) {
  event.preventDefault();
  if (!updatePreflight()) {
    toast("预检未通过，请修正后再生成。", true);
    return;
  }
  try {
    const preflight = await runBackendPreflight();
    if (!preflight?.ok) {
      toast("后端预检未通过，未创建任务。", true);
      return;
    }
    const payload = { form: buildPaperPayload() };
    const result = await api("/api/jobs", { method: "POST", body: payload });
    state.activeJob = result.job_id;
    toast("任务已创建。");
    await pollJob(result.job_id);
  } catch (error) { toast(error.message, true); }
}

async function pollJob(jobId) {
  clearTimeout(state.pollTimer);
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    state.activeJob = jobId;
    renderJob(data.job, data.log);
    if (["queued", "running"].includes(data.job.status)) {
      state.pollTimer = setTimeout(() => pollJob(jobId), 1800);
    } else {
      await loadStatus();
    }
  } catch (error) { toast(error.message, true); }
}

function statusTitle(status) {
  return {
    queued: "任务排队中",
    running: "正在处理",
    awaiting_pairing: "等待题答配对",
    awaiting_review: "等待人工复核",
    budget_paused: "云端预算已暂停",
    completed: "试卷已完成",
    failed: "任务失败",
    cancelled: "任务已取消",
    archived: "历史任务已归档",
  }[status] || status;
}

function renderJob(job, log) {
  $("#current-job-title").textContent = statusTitle(job.status);
  $("#job-progress").classList.remove("hidden");
  $("#job-progress span").style.width = `${Number(job.progress || 0)}%`;
  $("#job-status").innerHTML = `<div class="attention-item"><span><strong>${escapeHtml(job.stage || job.status)}</strong><p>${escapeHtml(job.message || job.error || "处理中")}</p></span><span>${Number(job.progress || 0)}%</span></div>${job.selected_count ? `<div class="attention-item"><span><strong>本次试卷</strong><p>${job.selected_count} 道题 · ${job.total_score || 0} 分 · 相邻档补足 ${job.band_fallback_count || 0} 道</p></span></div>` : ""}`;
  $("#job-log").classList.remove("hidden");
  $("#job-log").textContent = log || "暂无日志";
  $("#job-actions").classList.remove("hidden");
  const running = ["queued", "running"].includes(job.status);
  const complete = job.status === "completed";
  $("#cancel-job").classList.toggle("hidden", !running);
  $("#continue-job").classList.toggle("hidden", !["awaiting_pairing","awaiting_review","budget_paused","failed"].includes(job.status));
  $("#download-student").classList.toggle("hidden", !complete);
  $("#download-teacher").classList.toggle("hidden", !complete);
  $("#open-folder").classList.toggle("hidden", !complete);
}

async function loadJobs() {
  try {
    const data = await api("/api/jobs");
    $("#job-list").innerHTML = data.jobs.length
      ? data.jobs.map((job) => `<div class="compact-item"><span><strong>${escapeHtml(statusTitle(job.status))} · ${escapeHtml(job.job_id)}</strong><p>${escapeHtml(job.message || job.error || job.stage || "")} · ${formatDate(job.created_at)}</p></span><button class="secondary small inspect-job" data-job="${escapeHtml(job.job_id)}">查看</button></div>`).join("")
      : empty("还没有任务记录。");
    $$(".inspect-job").forEach((button) => button.addEventListener("click", () => {
      switchView("generate");
      pollJob(button.dataset.job);
    }));
  } catch (error) { toast(error.message, true); }
}

async function continueJob() {
  if (!state.activeJob) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.activeJob)}/continue`, { method: "POST", body: {} });
    await pollJob(state.activeJob);
  } catch (error) {
    toast(error.message, true);
    if (/配对/.test(error.message)) switchView("pairing");
  }
}

async function cancelJob() {
  if (!state.activeJob || !confirm("取消当前任务？")) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.activeJob)}/cancel`, { method: "POST", body: {} });
    await pollJob(state.activeJob);
  } catch (error) { toast(error.message, true); }
}

function downloadFile(filename) {
  if (!state.activeJob) return;
  window.location.href = `/api/download?job=${encodeURIComponent(state.activeJob)}&file=${encodeURIComponent(filename)}&token=${encodeURIComponent(token)}`;
}

async function openOutputFolder() {
  if (!state.activeJob) return;
  try { await api(`/api/open-folder?job=${encodeURIComponent(state.activeJob)}`); }
  catch (error) { toast(error.message, true); }
}

async function loadDiagnostics() {
  const data = state.diagnostics || await loadStatus();
  if (!data) return;
  const rows = [
    ["服务状态", "正常", true],
    ["Ollama", data.ollama?.reachable ? `${data.ollama.version} · ${data.ollama.models.length} 模型` : "未运行", Boolean(data.ollama?.reachable)],
    ["本地分类模型", data.models?.ollama?.simple || "未配置", Boolean(data.models?.ollama?.simple)],
    ["向量模型", data.models?.ollama?.embedding || "未配置", Boolean(data.models?.ollama?.embedding)],
    ["数据目录", "bank/", true],
    ["输出目录", "outputs/", true],
  ];
  $("#diagnostics").innerHTML = rows.map(([name, value, ok]) => `<div class="attention-item"><span><strong>${escapeHtml(name)}</strong><p>${escapeHtml(value)}</p></span>${statusTag(ok ? "verified" : "needs_review")}</div>`).join("");
}

async function openDataDirectory() {
  try { await api("/api/library/open-data"); }
  catch (error) { toast(error.message, true); }
}

async function loadAuditState() {
  try {
    const data = await api("/api/maintenance/audit");
    const audit = data.audit || {};
    const settings = data.settings || {};
    const labels = {
      healthy: "题库健康",
      needs_online: "需要线上复核",
      needs_attention: "发现结构问题",
      failed: "巡检失败",
      not_run: "尚未巡检",
      running: "正在巡检",
    };
    const issues = audit.issues || {};
    const quality = audit.quality_audit || {};
    $("#audit-status").innerHTML = `
      <div class="attention-item"><span><strong>${escapeHtml(labels[audit.status] || audit.status || "尚未巡检")}</strong><p>上次巡检：${escapeHtml(formatDate(audit.checked_at || audit.last_run) || "无")} · 下次：${escapeHtml(formatDate(audit.next_run) || "按计划")}</p></span></div>
      <div class="attention-item"><span><strong>三级处理链</strong><p>本地先查：${settings.enabled ? "已启用" : "已关闭"} · 本轮检查 ${Number(quality.checked || 0)} 道 · 本地自行通过 ${Number(quality.local_passed || 0)} 道 · 线上复核 ${Number(quality.online_reviewed || 0)} 道 · 人工 ${Number(quality.human_required || 0)} 道</p></span></div>
      <div class="attention-item"><span><strong>题目检查</strong><p>有效 ${Number(audit.active_count || 0)} 道 · 可组卷 ${Number(audit.ready_count || 0)} 道 · 缺答案 ${(issues.missing_answers || []).length} 道 · 缺媒体 ${(issues.missing_media || []).length} 道 · 结构异常 ${(issues.invalid_items || []).length} 道 · 重复 ${(issues.duplicates || []).length} 组</p></span></div>
      ${audit.stage && audit.status === "running" ? `<div class="attention-item"><span><strong>当前阶段</strong><p>${escapeHtml(audit.stage)}</p></span></div>` : ""}
      ${audit.error ? `<div class="attention-item"><span><strong>错误</strong><p>${escapeHtml(audit.error)}</p></span></div>` : ""}`;
    if (settings.enabled !== undefined) {
      $("#audit-enabled").value = String(Boolean(settings.enabled));
      $("#audit-on-startup").value = String(Boolean(settings.on_startup));
      $("#audit-interval-hours").value = settings.interval_hours ?? 24;
      $("#audit-batch-size").value = settings.batch_size ?? 8;
      $("#audit-recheck-days").value = settings.recheck_days ?? 7;
      $("#audit-human-retry-days").value = settings.retry_human_days ?? 30;
      $("#audit-local-timeout-seconds").value = settings.local_timeout_seconds ?? 20;
      $("#audit-cloud-retries").value = settings.cloud_retries ?? 2;
    }
  } catch (error) {
    $("#audit-status").innerHTML = empty(`读取巡检状态失败：${error.message}`);
  }
}

async function runLibraryAudit() {
  const button = $("#run-library-audit");
  button.disabled = true;
  button.textContent = "巡检中…";
  try {
    const data = await api("/api/maintenance/audit", { method: "POST", body: {} });
    toast(
      data.audit?.job_id
        ? "定时质检已在后台启动；可离开当前页面，任务会继续运行。"
        : "巡检任务已在运行或尚未到期。",
    );
    await loadAuditState();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "立即巡检";
  }
}

async function saveAuditSettings() {
  const button = $("#save-audit-settings");
  button.disabled = true;
  try {
    await api("/api/maintenance/settings", {
      method: "POST",
      body: {
        enabled: $("#audit-enabled").value === "true",
        on_startup: $("#audit-on-startup").value === "true",
        interval_hours: Number($("#audit-interval-hours").value),
        batch_size: Number($("#audit-batch-size").value),
        recheck_days: Number($("#audit-recheck-days").value),
        retry_human_days: Number($("#audit-human-retry-days").value),
        local_timeout_seconds: Number($("#audit-local-timeout-seconds").value),
        cloud_retries: Number($("#audit-cloud-retries").value),
      },
    });
    toast("巡检设置已保存。");
    await loadAuditState();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function previewSplitCleanup() {
  const button = $("#split-preview");
  button.disabled = true;
  button.textContent = "检查中…";
  try {
    const data = await api("/api/library/splits/preview");
    const preview = data.preview;
    const codeLabels = {
      answer_only: "题干实际是答案",
      administrative_text: "答题说明",
      answer_copy: "参考答案附加区",
      container_parent: "父题容器",
      duplicate: "重复记录",
      incomplete_question: "题干不完整",
    };
    const examples = (preview.excluded || []).slice(0, 20).map((item) =>
      `<div class="attention-item"><span><strong>${escapeHtml(item.question_no || "")} · ${escapeHtml(codeLabels[item.code] || item.code)}</strong><p>${richHtml((item.stem || "").slice(0, 260))}</p><small>${escapeHtml(item.id)} · ${escapeHtml(item.packet_id || "")}</small></span></div>`,
    ).join("");
    openDialog(
      "拆题规则 v3 预检",
      `<div class="preflight">${Object.entries(preview.by_code || {}).map(([code, count]) => `<div>${escapeHtml(codeLabels[code] || code)}<strong>${count}</strong></div>`).join("")}<div>本次预计保留<strong>${preview.retained}</strong></div><div>本次预计排除<strong>${preview.excluded?.length || 0}</strong></div><div>此前已逻辑删除<strong>${preview.historical_excluded || 0}</strong></div><div>影响资料包<strong>${preview.affected_packets?.length || 0}</strong></div></div><p class="hint">应用时会先创建快照，并重新解析全部题卷。重复记录将在重新解析后精确定位。</p><div class="attention-list">${examples || empty("没有发现新的答案误拆或答题说明；历史排除记录仍可在“题目审核 → 系统排除”查看。")}</div>`,
    );
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "检查拆题结果";
  }
}

async function applySplitCleanup() {
  if (!confirm("将使用拆题规则 v3 重新解析资料，并逻辑删除答案误拆、答题说明、父题容器和重复记录。原文件和旧记录会保留在快照中。是否继续？")) return;
  const button = $("#split-cleanup");
  button.disabled = true;
  button.textContent = "清理中…";
  try {
    const data = await api("/api/library/splits/apply", { method: "POST", body: {} });
    const result = data.result;
    toast(`已更新 ${result.reconciliation?.updated?.length || 0} 道、新建 ${result.reconciliation?.created?.length || 0} 道、排除 ${result.excluded?.length || 0} 道。`);
    await loadStatus();
    await loadLibrary();
    if (state.currentView === "review") await loadReview(true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "清理误拆题";
  }
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  document.addEventListener("click", (event) => {
    const navigation = event.target.closest("[data-go]");
    if (navigation) {
      switchView(navigation.dataset.go, { queue: navigation.dataset.queue });
      return;
    }
    const packetButton = event.target.closest("[data-packet-open]");
    if (packetButton) {
      showPacket(packetButton.dataset.packetOpen);
      return;
    }
    const queueButton = event.target.closest("[data-review-queue]");
    if (queueButton) {
      state.reviewQueue = queueButton.dataset.reviewQueue;
      loadReview(true);
    }
  });
  $("#dialog-close").addEventListener("click", () => $("#detail-dialog").close());
  $("#detail-dialog").addEventListener("click", (event) => {
    if (event.target === $("#detail-dialog")) $("#detail-dialog").close();
  });
  document.addEventListener("error", (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.classList.contains("inline-asset")) return;
    const fallback = document.createElement("span");
    fallback.className = "asset-error";
    fallback.title = image.dataset.assetSource || "";
    fallback.textContent = "[公式或图形无法显示，请打开原始文件检查]";
    image.replaceWith(fallback);
  }, true);

  const dropZone = $("#drop-zone");
  const fileInput = $("#file-input");
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (event) => { if (["Enter"," "].includes(event.key)) fileInput.click(); });
  dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
  dropZone.addEventListener("drop", (event) => { event.preventDefault(); dropZone.classList.remove("dragging"); addFiles(event.dataTransfer.files); });
  fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
  $("#upload-button").addEventListener("click", saveUploads);
  $("#clear-upload").addEventListener("click", () => { state.selectedFiles = []; state.uploadId = null; fileInput.value = ""; renderUploadSelection(); $("#upload-message").textContent = ""; });

  $$("#library-tabs button").forEach((button) => button.addEventListener("click", () => { state.libraryTab = button.dataset.libraryTab; renderLibrary(); }));
  ["library-search","filter-grade","filter-year","filter-type","filter-status"].forEach((id) => $("#" + id).addEventListener("input", () => { state.itemLimit = 100; renderLibrary(); }));
  $("#refresh-library").addEventListener("click", loadLibrary);
  $("#split-preview").addEventListener("click", previewSplitCleanup);
  $("#split-cleanup").addEventListener("click", applySplitCleanup);
  $("#library-open-data").addEventListener("click", openDataDirectory);
  $("#refresh-pairing").addEventListener("click", loadPairing);
  $("#confirm-safe-pairs").addEventListener("click", confirmSafePairs);
  $("#refresh-review").addEventListener("click", () => loadReview(true));
  $("#repair-answers").addEventListener("click", repairAnswers);
  $("#auto-triage-review").addEventListener("click", autoTriageReview);
  $("#auto-review-all").addEventListener("click", autoReviewAll);
  $("#bulk-approve-review").addEventListener("click", bulkApproveReview);
  $("#refresh-jobs").addEventListener("click", loadJobs);

  $("#source-scope").addEventListener("change", updateSourceScope);
  $("#delivery-type").addEventListener("change", applyBlueprintDefaults);
  $("#question-count").addEventListener("input", updatePreflight);
  $("#paper-minutes").addEventListener("input", updatePreflight);
  $("#weak-topics").addEventListener("input", updatePreflight);
  ["current-score", "target-score"].forEach((id) => $("#" + id).addEventListener("input", updatePreflight));
  $$(".score-preset").forEach((button) => button.addEventListener("click", () => {
    $("#" + button.dataset.scoreTarget).value = button.dataset.score;
    updatePreflight();
  }));
  $$(".type-count").forEach((input) => input.addEventListener("input", updatePreflight));
  $$("#wizard-stepper button").forEach((button) => button.addEventListener("click", () => setWizardStep(Number(button.dataset.step))));
  $("#wizard-next").addEventListener("click", () => setWizardStep(state.wizardStep + 1));
  $("#wizard-back").addEventListener("click", () => setWizardStep(state.wizardStep - 1));
  $("#paper-form").addEventListener("submit", submitPaper);
  $("#open-folder").addEventListener("click", openOutputFolder);
  $("#download-student").addEventListener("click", () => downloadFile("学生卷.pdf"));
  $("#download-teacher").addEventListener("click", () => downloadFile("教师卷.pdf"));
  $("#continue-job").addEventListener("click", continueJob);
  $("#cancel-job").addEventListener("click", cancelJob);
  $("#refresh-diagnostics").addEventListener("click", async () => { state.diagnostics = await loadStatus(); await loadDiagnostics(); });
  $("#run-library-audit").addEventListener("click", runLibraryAudit);
  $("#save-audit-settings").addEventListener("click", saveAuditSettings);
  $("#open-data-dir").addEventListener("click", openDataDirectory);
}

async function heartbeat() {
  try { await api("/api/heartbeat", { method: "POST", body: {} }); } catch {}
}

bindEvents();
applyBlueprintDefaults();
updateSourceScope();
loadStatus();
loadJobs();
heartbeat();
setInterval(heartbeat, 5000);
setInterval(loadStatus, 30000);
setInterval(() => {
  if (state.currentView === "settings") loadAuditState();
}, 15000);
