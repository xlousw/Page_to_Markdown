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
const includeSourceInfo = document.querySelector("#includeSourceInfo");
const appendDate = document.querySelector("#appendDate");
const downloadImages = document.querySelector("#downloadImages");
const filenameTemplate = document.querySelector("#filenameTemplate");
const seqNumber = document.querySelector("#seqNumber");
const savePath = document.querySelector("#savePath");
const statusNode = document.querySelector("#status");

const STORAGE_KEY = "pageToMarkdownOptions";
const OPTION_NODES = [includeLinks, includeImages, useSelection, frontMatter, includeSourceInfo, appendDate, downloadImages];

let lastResult = null; // { title, source, markdown }

function setStatus(message) {
  statusNode.textContent = message || "";
}

function sanitizeFilename(name) {
  return (
    String(name || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, "")
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
    if (typeof saved.includeSourceInfo === "boolean") includeSourceInfo.checked = saved.includeSourceInfo;
    if (typeof saved.appendDate === "boolean") appendDate.checked = saved.appendDate;
    if (typeof saved.downloadImages === "boolean") downloadImages.checked = saved.downloadImages;
    if (typeof saved.filenameTemplate === "string" && saved.filenameTemplate.trim()) {
      filenameTemplate.value = saved.filenameTemplate;
    }
    if (typeof saved.savePath === "string") {
      savePath.value = saved.savePath;
    }
    if (typeof saved.seqNumber === "number") {
      seqNumber.value = saved.seqNumber;
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
        includeSourceInfo: includeSourceInfo.checked,
        appendDate: appendDate.checked,
        downloadImages: downloadImages.checked,
        filenameTemplate: filenameTemplate.value.trim() || "{title}",
        seqNumber: parseInt(seqNumber.value, 10) || 1,
        savePath: savePath.value.trim()
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
    includeFrontMatter: frontMatter.checked,
    includeSourceInfo: includeSourceInfo.checked
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
  const seq = parseInt(seqNumber.value, 10) || 1;
  const replaced = template
    .replace(/\{title\}/gi, title || "page")
    .replace(/\{host\}/gi, host || "page")
    .replace(/\{date\}/gi, formatDateStamp())
    .replace(/\{seq\}/gi, String(seq).padStart(3, "0"));

  let base = sanitizeFilename(replaced);
  if (appendDate.checked && !/\{date\}/i.test(template)) {
    base = `${base}-${formatDateStamp()}`;
  }
  return `${base}.md`;
}

/** 下载成功后序号自增 */
function incrementSeqNumber() {
  const current = parseInt(seqNumber.value, 10) || 0;
  seqNumber.value = current + 1;
  persistOptions();
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

/**
 * 将用户配置的绝对路径转换为相对于浏览器下载目录的相对路径
 * 例如：
 *   downloadsDir = "C:\\Users\\x\\Downloads"
 *   targetAbs    = "C:\\Users\\x\\Documents\\notes"
 *   返回 "../Documents/notes"
 */
function absoluteToRelativePath(targetAbs, downloadsDir) {
  if (!targetAbs || !downloadsDir) return "";

  // 统一用正斜杠并移除末尾斜杠
  const normalize = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = normalize(targetAbs);
  const base = normalize(downloadsDir);

  // Windows 下检查是否在同一盘符
  const targetDrive = target.match(/^([a-zA-Z]:)/)?.[1]?.toLowerCase() || "";
  const baseDrive = base.match(/^([a-zA-Z]:)/)?.[1]?.toLowerCase() || "";
  if (targetDrive !== baseDrive) {
    return null; // 不同盘符，无法计算相对路径
  }

  // 如果目标已经在下载目录下，直接返回子路径
  if (target.toLowerCase().startsWith(base.toLowerCase() + "/")) {
    return target.substring(base.length + 1);
  }
  if (target.toLowerCase() === base.toLowerCase()) {
    return "";
  }

  // 计算需要回退的层数
  const targetParts = target.split("/");
  const baseParts = base.split("/");
  let commonLen = 0;
  for (let i = 0; i < Math.min(targetParts.length, baseParts.length); i++) {
    if (targetParts[i].toLowerCase() === baseParts[i].toLowerCase()) {
      commonLen = i + 1;
    } else {
      break;
    }
  }

  const upCount = baseParts.length - commonLen;
  const downParts = targetParts.slice(commonLen);
  const relative = "../".repeat(upCount) + downParts.join("/");
  return relative;
}

async function saveMarkdown() {
  toggleBusy(true);
  setStatus("读取页面内容中…");

  try {
    const result = await ensureResult();
    let markdown = currentMarkdown();
    if (!markdown.trim()) throw new Error("内容为空，无法保存");

    // 如果需要下载图片，先探测默认下载目录（在打开保存对话框之前）
    let downloadsDir = "";
    const shouldDownloadImages = downloadImages.checked && result.images && result.images.length > 0;
    const configuredPath = savePath.value.trim();
    const baseFilename = buildFilename(result.title, result.source);
    const imageBaseName = baseFilename.replace(/\.md$/, "");

    // 有预设路径或需要下载图片时都需要探测下载目录
    if (configuredPath || shouldDownloadImages) {
      setStatus("准备中…");
      downloadsDir = await getDownloadsDirectory();
    }

    if (shouldDownloadImages) {
      // 替换 Markdown 中的远程图片 URL 为本地相对路径
      markdown = replaceImageUrls(markdown, result.images, imageBaseName);
    }

    // 将远程超链接替换为本地相对路径
    markdown = replaceHyperlinks(markdown);

    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    // 计算保存路径
    let filename = baseFilename;
    let useSaveAs = true;

    if (configuredPath) {
      const relativePath = absoluteToRelativePath(configuredPath, downloadsDir);
      if (relativePath === null) {
        throw new Error(`保存路径与下载目录不在同一磁盘，无法保存。\n下载目录：${downloadsDir}`);
      }
      filename = relativePath
        ? `${relativePath}/${baseFilename}`
        : baseFilename;
      useSaveAs = false;
    }

    setStatus(useSaveAs ? "等待选择保存位置…" : "保存中…");
    const mdDownloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: useSaveAs,
      conflictAction: "uniquify"
    });

    // 等待用户选择保存路径并完成下载
    await waitForDownloadComplete(mdDownloadId);
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    // 获取 MD 文件的实际保存路径
    const [mdItem] = await chrome.downloads.search({ id: mdDownloadId });
    const mdAbsPath = mdItem?.filename || "";
    setStatus(`已保存 ${baseFilename}`);

    // 序号自增（仅当模板中使用了 {seq} 时）
    if (/\{seq\}/i.test(filenameTemplate.value)) {
      incrementSeqNumber();
    }

    // 下载图片到同一目录下的 images/ 子文件夹
    if (shouldDownloadImages && mdAbsPath) {
      const relativeBase = getRelativeBase(mdAbsPath, downloadsDir);
      await downloadAllImages(result.images, imageBaseName, relativeBase);
    }
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
savePath.addEventListener("change", persistOptions);
savePath.addEventListener("blur", persistOptions);
seqNumber.addEventListener("change", persistOptions);
seqNumber.addEventListener("blur", persistOptions);

previewButton.addEventListener("click", previewMarkdown);
previewClose.addEventListener("click", hidePreview);
saveButton.addEventListener("click", saveMarkdown);
copyButton.addEventListener("click", copyMarkdown);

loadOptions();

// ===== 下载等待与路径计算工具 =====

/**
 * 等待指定下载完成（用户确认保存对话框后）
 */
function waitForDownloadComplete(downloadId) {
  return new Promise((resolve, reject) => {
    // 监听状态变化（先注册监听，避免竞态）
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state) {
        if (delta.state.current === "complete") {
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        } else if (delta.state.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error("下载已取消"));
        }
      }
    };
    chrome.downloads.onChanged.addListener(listener);

    // 再检查是否已经完成（防止在注册监听前就完成的情况）
    chrome.downloads.search({ id: downloadId }).then(items => {
      if (items && items.length > 0) {
        if (items[0].state === "complete") {
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        } else if (items[0].state === "interrupted") {
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error("下载已取消"));
        }
      }
    });
  });
}

/**
 * 通过探测文件确定浏览器默认下载目录的绝对路径
 */
async function getDownloadsDirectory() {
  let downloadsDir = "";
  try {
    const probeId = await chrome.downloads.download({
      url: "data:text/plain;charset=utf-8,.",
      filename: ".p2m_probe",
      saveAs: false,
      conflictAction: "overwrite"
    });
    await waitForDownloadComplete(probeId);
    const [probeItem] = await chrome.downloads.search({ id: probeId });
    const absPath = probeItem?.filename || "";
    // 提取目录部分（支持 / 和 \ 路径分隔符）
    const sep = absPath.includes("\\") ? "\\" : "/";
    const lastSepIdx = absPath.lastIndexOf(sep);
    downloadsDir = lastSepIdx > 0 ? absPath.substring(0, lastSepIdx) : "";
    // 清理探测文件（从磁盘和下载记录中都删除）
    try { await chrome.downloads.removeFile(probeId); } catch {}
    try { await chrome.downloads.erase({ id: probeId }); } catch {}
  } catch {
    // 探测失败，回退到空字符串（图片将保存到默认下载目录/images/）
  }
  return downloadsDir;
}

/**
 * 根据 MD 绝对路径和已知的下载目录，计算相对子路径
 * 例如：
 *   downloadsDir = "/Users/x/Downloads"
 *   mdAbsPath    = "/Users/x/Downloads/Redis/article.md"
 *   返回 "Redis"
 */
function getRelativeBase(mdAbsPath, downloadsDir) {
  if (!mdAbsPath || !downloadsDir) return "";
  // 提取 MD 文件所在目录
  const sep = mdAbsPath.includes("\\") ? "\\" : "/";
  const lastSepIdx = mdAbsPath.lastIndexOf(sep);
  const mdDir = lastSepIdx > 0 ? mdAbsPath.substring(0, lastSepIdx) : "";
  // MD 直接保存在下载目录根下
  if (mdDir === downloadsDir) return "";
  // MD 保存在下载目录的子文件夹中
  if (mdDir.startsWith(downloadsDir + sep)) {
    return mdDir.substring(downloadsDir.length + 1);
  }
  // MD 保存在下载目录外（无法计算相对路径）
  return "";
}

// ===== 图片下载功能 =====

function getImageExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    if (match) {
      const ext = match[1].toLowerCase();
      if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(ext)) {
        return ext;
      }
    }
  } catch {}
  return "png";
}

/**
 * 将 Markdown 中的远程图片 URL 替换为本地相对路径
 * ![alt](https://remote.com/img.png) → ![alt](./images/10-标题_1.png)
 */
function replaceImageUrls(markdown, images, imageBaseName) {
  if (!images || images.length === 0) return markdown;
  let result = markdown;
  for (let i = 0; i < images.length; i++) {
    const imageUrl = images[i];
    const ext = getImageExtension(imageUrl);
    const localPath = `./images/${imageBaseName}_${i + 1}.${ext}`;
    // 替换 Markdown 图片语法中的 URL（处理 URL 中可能的特殊字符）
    const escapedUrl = imageUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(!\\[[^\\]]*\\])\\(${escapedUrl}\\)`, "g");
    result = result.replace(pattern, `$1(${localPath})`);
  }
  return result;
}

/**
 * 将 Markdown 中的远程超链接替换为本地相对路径
 * [标题](https://example.com/page) → [标题](./标题)
 */
function replaceHyperlinks(markdown) {
  // 匹配非图片的 Markdown 链接：[text](http...)
  // 使用否定前瞻确保不匹配 ![alt](url)
  return markdown.replace(/(?<!!)\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, (match, linkText) => {
    const cleanText = linkText.trim().replace(/\s+/g, "");
    return `[${cleanText}](./${cleanText})`;
  });
}

/**
 * 下载所有图片到指定相对路径下的 images/ 子文件夹
 * @param {string[]} images - 图片 URL 列表
 * @param {string} imageBaseName - 图片基础名称（与 Markdown 文件名一致，不含扩展名）
 * @param {string} relativeBase - 相对于下载目录的子路径（如 "notes/sub"）
 */
async function downloadAllImages(images, imageBaseName, relativeBase = "") {
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < images.length; i++) {
    const imageUrl = images[i];
    const ext = getImageExtension(imageUrl);
    const imgName = `${imageBaseName}_${i + 1}.${ext}`;
    const filename = relativeBase
      ? `${relativeBase}/images/${imgName}`
      : `images/${imgName}`;

    try {
      await chrome.downloads.download({
        url: imageUrl,
        filename: filename,
        saveAs: false,
        conflictAction: "uniquify"
      });
      successCount++;
    } catch {
      failCount++;
    }
  }

  if (failCount > 0) {
    setStatus(`图片下载完成：成功 ${successCount} 张，失败 ${failCount} 张`);
  } else {
    setStatus(`已保存 Markdown 及 ${successCount} 张图片`);
  }
}
