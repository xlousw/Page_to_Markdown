const STORAGE_KEY = "pageToMarkdownOptions";
const DEFAULT_OPTIONS = {
  includeLinks: true,
  includeImages: true,
  useSelection: false,
  frontMatter: false,
  includeSourceInfo: true,
  appendDate: false,
  downloadImages: false,
  filenameTemplate: "{title}",
  seqNumber: 1,
  savePath: ""
};

const MENU_IDS = {
  savePage: "p2m-save-page",
  saveSelection: "p2m-save-selection",
  copyPage: "p2m-copy-page",
  copySelection: "p2m-copy-selection"
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_IDS.savePage,
      title: "保存页面为 Markdown",
      contexts: ["page", "action"]
    });
    chrome.contextMenus.create({
      id: MENU_IDS.saveSelection,
      title: "保存选区为 Markdown",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: MENU_IDS.copyPage,
      title: "复制页面 Markdown",
      contexts: ["page", "action"]
    });
    chrome.contextMenus.create({
      id: MENU_IDS.copySelection,
      title: "复制选区 Markdown",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    switch (info.menuItemId) {
      case MENU_IDS.savePage:
        await handleAction(tab, { action: "save", useSelection: false });
        break;
      case MENU_IDS.saveSelection:
        await handleAction(tab, { action: "save", useSelection: true });
        break;
      case MENU_IDS.copyPage:
        await handleAction(tab, { action: "copy", useSelection: false });
        break;
      case MENU_IDS.copySelection:
        await handleAction(tab, { action: "copy", useSelection: true });
        break;
      default:
        break;
    }
  } catch (error) {
    notify("操作失败", error?.message || String(error));
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    if (command === "save-page") {
      await handleAction(tab, { action: "save", useSelection: false });
    } else if (command === "copy-page") {
      await handleAction(tab, { action: "copy", useSelection: false });
    }
  } catch (error) {
    notify("操作失败", error?.message || String(error));
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

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

async function loadOptions() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return { ...DEFAULT_OPTIONS, ...(data?.[STORAGE_KEY] || {}) };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}

function isRestrictedUrl(url) {
  return !url || /^(chrome|edge|about|chrome-extension|view-source):/i.test(url);
}

async function handleAction(tab, { action, useSelection }) {
  if (isRestrictedUrl(tab.url)) {
    notify("无法读取", "浏览器内部页面不支持读取");
    return;
  }

  const options = await loadOptions();
  const extractOptions = {
    useSelection: !!useSelection || options.useSelection,
    includeFrontMatter: options.frontMatter,
    includeSourceInfo: options.includeSourceInfo !== false
  };

  const result = await extractFromTab(tab.id, extractOptions);
  if (!result?.markdown) {
    notify("没有内容", extractOptions.useSelection ? "未检测到有效选区" : "未能识别到可读内容");
    return;
  }

  let markdown = applyPostProcessing(result.markdown, options);

  if (action === "save") {
    const baseFilename = buildFilename(result.title, tab.url, options);
    const imageBaseName = baseFilename.replace(/\.md$/, "");

    // 如果需要下载图片，先替换 Markdown 中的图片 URL 为本地路径
    if (options.downloadImages && result.images && result.images.length > 0) {
      markdown = replaceImageUrls(markdown, result.images, imageBaseName);
    }
    // 将远程超链接替换为本地相对路径
    markdown = replaceHyperlinks(markdown);

    const configuredPath = (options.savePath || "").trim();

    // 计算相对路径
    let filename = baseFilename;
    let imageRelativeBase = "";
    if (configuredPath) {
      const downloadsDir = await getDownloadsDirectory();
      const relativePath = absoluteToRelativePath(configuredPath, downloadsDir);
      if (relativePath === null) {
        notify("保存失败", "保存路径与下载目录不在同一磁盘");
        return;
      }
      filename = relativePath ? `${relativePath}/${baseFilename}` : baseFilename;
      imageRelativeBase = relativePath;
    }

    const dataUrl = toDataUrl(markdown);
    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
    notify("已保存", baseFilename);

    // 序号自增（仅当模板中使用了 {seq} 时）
    if (/\{seq\}/i.test(options.filenameTemplate || "")) {
      await incrementSeqNumber(options);
    }

    // 下载图片
    if (options.downloadImages && result.images && result.images.length > 0) {
      await downloadAllImages(result.images, imageBaseName, imageRelativeBase);
    }
  } else if (action === "copy") {
    await copyToTab(tab.id, markdown);
    notify("已复制", `共 ${markdown.length} 个字符`);
  }
}

async function extractFromTab(tabId, options) {
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
      // priming failed, continue
    }
  }

  const [entry] = await chrome.scripting.executeScript({
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
    // ignore
  }

  return entry?.result;
}

async function copyToTab(tabId, text) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async (payload) => {
      try {
        await navigator.clipboard.writeText(payload);
      } catch {
        const area = document.createElement("textarea");
        area.value = payload;
        area.style.cssText = "position:fixed;left:-99999px;top:-99999px;";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
    },
    args: [text]
  });
}

function applyPostProcessing(markdown, options) {
  let output = String(markdown || "");
  if (!options.includeLinks) {
    output = output.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  }
  if (!options.includeImages) {
    output = output.replace(/!\[[^\]]*]\([^)]+\)\n*/g, "");
  }
  return output;
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
    await new Promise((resolve, reject) => {
      const listener = (delta) => {
        if (delta.id !== probeId) return;
        if (delta.state?.current === "complete") {
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        } else if (delta.state?.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error("probe failed"));
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
    const [probeItem] = await chrome.downloads.search({ id: probeId });
    const absPath = probeItem?.filename || "";
    const sep = absPath.includes("\\") ? "\\" : "/";
    const lastSepIdx = absPath.lastIndexOf(sep);
    downloadsDir = lastSepIdx > 0 ? absPath.substring(0, lastSepIdx) : "";
    try { await chrome.downloads.removeFile(probeId); } catch {}
    try { await chrome.downloads.erase({ id: probeId }); } catch {}
  } catch {
    // 探测失败
  }
  return downloadsDir;
}

/**
 * 将绝对路径转换为相对于下载目录的相对路径
 */
function absoluteToRelativePath(targetAbs, downloadsDir) {
  if (!targetAbs || !downloadsDir) return "";
  const normalize = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = normalize(targetAbs);
  const base = normalize(downloadsDir);

  const targetDrive = target.match(/^([a-zA-Z]:)/)?.[1]?.toLowerCase() || "";
  const baseDrive = base.match(/^([a-zA-Z]:)/)?.[1]?.toLowerCase() || "";
  if (targetDrive !== baseDrive) return null;

  if (target.toLowerCase().startsWith(base.toLowerCase() + "/")) {
    return target.substring(base.length + 1);
  }
  if (target.toLowerCase() === base.toLowerCase()) return "";

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
  return "../".repeat(upCount) + downParts.join("/");
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

function buildFilename(title, url, options) {
  let host = "";
  try {
    host = url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    host = "";
  }

  const template = options.filenameTemplate?.trim() || "{title}";
  const seq = parseInt(options.seqNumber, 10) || 1;
  const replaced = template
    .replace(/\{title\}/gi, title || "page")
    .replace(/\{host\}/gi, host || "page")
    .replace(/\{date\}/gi, formatDateStamp())
    .replace(/\{seq\}/gi, String(seq).padStart(3, "0"));

  let base = sanitizeFilename(replaced);
  if (options.appendDate && !/\{date\}/i.test(template)) {
    base = `${base}-${formatDateStamp()}`;
  }
  return `${base}.md`;
}

/** 下载成功后序号自增并持久化 */
async function incrementSeqNumber(options) {
  const current = parseInt(options.seqNumber, 10) || 0;
  options.seqNumber = current + 1;
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const saved = data?.[STORAGE_KEY] || {};
    saved.seqNumber = options.seqNumber;
    await chrome.storage.local.set({ [STORAGE_KEY]: saved });
  } catch {}
}

function toDataUrl(markdown) {
  // service worker has no URL.createObjectURL for downloads in MV3, use data URL
  const encoded = encodeURIComponent(markdown)
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  return `data:text/markdown;charset=utf-8,${encoded}`;
}

function notify(title, message) {
  try {
    chrome.notifications?.create({
      type: "basic",
      iconUrl: "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="20" fill="#1769e0"/><text x="50%" y="58%" font-size="48" text-anchor="middle" fill="#fff" font-family="Segoe UI, sans-serif" font-weight="700">MD</text></svg>'
        ),
      title: title || "Page to Markdown",
      message: message || ""
    });
  } catch {
    // notifications not available
  }
}

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
 */
function replaceImageUrls(markdown, images, imageBaseName) {
  if (!images || images.length === 0) return markdown;
  let result = markdown;
  for (let i = 0; i < images.length; i++) {
    const imageUrl = images[i];
    const ext = getImageExtension(imageUrl);
    const localPath = `./images/${imageBaseName}_${i + 1}.${ext}`;
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
  return markdown.replace(/(?<!!)\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, (match, linkText) => {
    const cleanText = linkText.trim().replace(/\s+/g, "");
    return `[${cleanText}](./${cleanText})`;
  });
}

async function downloadAllImages(images, imageBaseName, relativeBase = "") {
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < images.length; i++) {
    const imageUrl = images[i];
    const ext = getImageExtension(imageUrl);
    const imgName = `${imageBaseName}_${i + 1}.${ext}`;
    const filename = relativeBase
      ? `${relativeBase.replace(/[\/\\]+$/, "")}/images/${imgName}`
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
    notify("图片下载", `成功 ${successCount} 张，失败 ${failCount} 张`);
  } else if (successCount > 0) {
    notify("图片下载", `已下载 ${successCount} 张图片`);
  }
}
