const saveButton = document.querySelector("#saveButton");
const copyButton = document.querySelector("#copyButton");
const previewButton = document.querySelector("#previewButton");
const previewClose = document.querySelector("#previewClose");
const previewSection = document.querySelector("#previewSection");
const previewArea = document.querySelector("#previewArea");
const previewMeta = document.querySelector("#previewMeta");
const includeLinks = document.querySelector("#includeLinks");
const includeImages = document.querySelector("#includeImages");
const useSelection = document.querySelector("#useSelection");
const frontMatter = document.querySelector("#frontMatter");
const appendDate = document.querySelector("#appendDate");
const filenameTemplate = document.querySelector("#filenameTemplate");
const statusNode = document.querySelector("#status");

const STORAGE_KEY = "pageToMarkdownOptions";
const OPTION_NODES = [includeLinks, includeImages, useSelection, frontMatter, appendDate];

let lastResult = null; // { title, source, markdown }

function setStatus(message) {
  statusNode.textContent = message || "";
}

function sanitizeFilename(name) {
  return (
    String(name || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "page"
  );
}

function formatDateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

function hostFromUrl(url) {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

async function loadOptions() {
  try {
    const data = await chrome.storage?.local.get(STORAGE_KEY);
    const saved = data?.[STORAGE_KEY];
    if (!saved) return;
    if (typeof saved.includeLinks === "boolean") includeLinks.checked = saved.includeLinks;
    if (typeof saved.includeImages === "boolean") includeImages.checked = saved.includeImages;
    if (typeof saved.useSelection === "boolean") useSelection.checked = saved.useSelection;
    if (typeof saved.frontMatter === "boolean") frontMatter.checked = saved.frontMatter;
    if (typeof saved.appendDate === "boolean") appendDate.checked = saved.appendDate;
    if (typeof saved.filenameTemplate === "string" && saved.filenameTemplate.trim()) {
      filenameTemplate.value = saved.filenameTemplate;
    }
  } catch {
    // storage unavailable, ignore
  }
}

async function persistOptions() {
  try {
    await chrome.storage?.local.set({
      [STORAGE_KEY]: {
        includeLinks: includeLinks.checked,
        includeImages: includeImages.checked,
        useSelection: useSelection.checked,
        frontMatter: frontMatter.checked,
        appendDate: appendDate.checked,
        filenameTemplate: filenameTemplate.value.trim() || "{title}"
      }
    });
  } catch {
    // ignore
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 在目标页面内执行的预滚动函数：触发虚拟列表/懒加载渲染后滚回原位
async function primePage() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const scrollers = [document.scrollingElement || document.documentElement];
  try {
    document.querySelectorAll("*").forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      if (el.scrollHeight > el.clientHeight + 40) {
        const style = getComputedStyle(el);
        if (/auto|scroll/.test(style.overflowY)) scrollers.push(el);
      }
    });
  } catch {}

  const memo = scrollers.map((el) => ({ el, top: el.scrollTop || 0 }));
  try {
    for (const el of scrollers) {
      const total = el.scrollHeight;
      const step = Math.max(400, el.clientHeight || 600);
      for (let pos = 0; pos < total; pos += step) {
        el.scrollTop = pos;
        await wait(40);
      }
      el.scrollTop = total;
      await wait(80);
    }
  } catch {}
  for (const { el, top } of memo) {
    try {
      el.scrollTop = top;
    } catch {}
  }
  await wait(50);
}

function currentExtractOptions() {
  return {
    useSelection: useSelection.checked,
    includeFrontMatter: frontMatter.checked
  };
}

async function extractFromPage(tabId, options) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (opts) => {
      window.__pageToMarkdownOptions = opts;
    },
    args: [options || {}]
  });

  if (!options?.useSelection) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: primePage });
    } catch {
      // priming failed, fallback to direct extraction
    }
  }

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          delete window.__pageToMarkdownOptions;
        } catch {
          window.__pageToMarkdownOptions = undefined;
        }
      }
    });
  } catch {
    // ignore cleanup errors
  }

  return result;
}

function applyPostProcessing(markdown) {
  let output = String(markdown || "");
  if (!includeLinks.checked) {
    output = output.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  }
  if (!includeImages.checked) {
    output = output.replace(/!\[[^\]]*]\([^)]+\)\n*/g, "");
  }
  return output;
}

function buildFilename(title, url) {
  const host = hostFromUrl(url);
  const template = (filenameTemplate.value || "{title}").trim() || "{title}";
  const replaced = template
    .replace(/\{title\}/gi, title || "page")
    .replace(/\{host\}/gi, host || "page")
    .replace(/\{date\}/gi, formatDateStamp());

  let base = sanitizeFilename(replaced);
  if (appendDate.checked && !/\{date\}/i.test(template)) {
    base = `${base}-${formatDateStamp()}`;
  }
  return `${base}.md`;
}

async function runExtract() {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("未找到当前标签页");
  if (tab.url && /^(chrome|edge|about|chrome-extension|view-source):/i.test(tab.url)) {
    throw new Error("浏览器内部页面不支持读取");
  }

  setStatus("读取页面内容中…");
  const result = await extractFromPage(tab.id, currentExtractOptions());
  if (!result?.markdown) {
    throw new Error(useSelection.checked ? "未检测到有效选区" : "未能识别到可读的页面内容");
  }
  result.source = result.source || tab.url || "";
  return result;
}

function toggleBusy(busy) {
  saveButton.disabled = busy;
  copyButton.disabled = busy;
  previewButton.disabled = busy;
}

function currentMarkdown() {
  if (previewSection && !previewSection.classList.contains("hidden")) {
    return previewArea.value;
  }
  return lastResult ? applyPostProcessing(lastResult.markdown) : "";
}

function showPreview(result) {
  lastResult = result;
  previewArea.value = applyPostProcessing(result.markdown);
  const title = result.title || "(未命名)";
  const bytes = new Blob([previewArea.value]).size;
  previewMeta.textContent = `${title} · ${previewArea.value.length} 字 · ${formatBytes(bytes)}`;
  previewSection.classList.remove("hidden");
}

function hidePreview() {
  previewSection.classList.add("hidden");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function ensureResult() {
  if (!lastResult) {
    lastResult = await runExtract();
  }
  return lastResult;
}

async function previewMarkdown() {
  toggleBusy(true);
  setStatus("读取页面内容中…");
  try {
    lastResult = await runExtract();
    showPreview(lastResult);
    setStatus(`预览就绪，共 ${previewArea.value.length} 字`);
  } catch (error) {
    setStatus(error?.message || "预览失败");
  } finally {
    toggleBusy(false);
  }
}

async function saveMarkdown() {
  toggleBusy(true);
  setStatus("读取页面内容中…");

  try {
    const result = await ensureResult();
    const markdown = currentMarkdown();
    if (!markdown.trim()) throw new Error("内容为空，无法保存");

    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const filename = buildFilename(result.title, result.source);

    await chrome.downloads.download({
      url,
      filename,
      saveAs: true,
      conflictAction: "uniquify"
    });

    setStatus(`已保存 ${filename}`);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) {
    setStatus(error?.message || "保存失败");
  } finally {
    toggleBusy(false);
  }
}

async function copyMarkdown() {
  toggleBusy(true);
  setStatus("读取页面内容中…");

  try {
    await ensureResult();
    const markdown = currentMarkdown();
    if (!markdown.trim()) throw new Error("内容为空，无法复制");

    await navigator.clipboard.writeText(markdown);
    setStatus(`已复制 ${markdown.length} 个字符到剪贴板`);
  } catch (error) {
    setStatus(error?.message || "复制失败");
  } finally {
    toggleBusy(false);
  }
}

OPTION_NODES.forEach((node) => {
  node.addEventListener("change", () => {
    persistOptions();
    // 重新提取选项变化较大的（选区、front matter）需要重新抓取
    if (node === useSelection || node === frontMatter) {
      lastResult = null;
    } else if (lastResult && !previewSection.classList.contains("hidden")) {
      // 链接/图片/日期开关只影响后处理，重新渲染预览
      previewArea.value = applyPostProcessing(lastResult.markdown);
      previewMeta.textContent = `${lastResult.title || "(未命名)"} · ${previewArea.value.length} 字`;
    }
  });
});

filenameTemplate.addEventListener("change", persistOptions);
filenameTemplate.addEventListener("blur", persistOptions);

previewButton.addEventListener("click", previewMarkdown);
previewClose.addEventListener("click", hidePreview);
saveButton.addEventListener("click", saveMarkdown);
copyButton.addEventListener("click", copyMarkdown);

loadOptions();
