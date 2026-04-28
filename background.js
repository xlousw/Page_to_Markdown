const STORAGE_KEY = "pageToMarkdownOptions";
const DEFAULT_OPTIONS = {
  includeLinks: true,
  includeImages: true,
  useSelection: false,
  frontMatter: false,
  appendDate: false,
  filenameTemplate: "{title}"
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
    includeFrontMatter: options.frontMatter
  };

  const result = await extractFromTab(tab.id, extractOptions);
  if (!result?.markdown) {
    notify("没有内容", extractOptions.useSelection ? "未检测到有效选区" : "未能识别到可读内容");
    return;
  }

  const markdown = applyPostProcessing(result.markdown, options);

  if (action === "save") {
    const filename = buildFilename(result.title, tab.url, options);
    const dataUrl = toDataUrl(markdown);
    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
    notify("已保存", filename);
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

function buildFilename(title, url, options) {
  let host = "";
  try {
    host = url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    host = "";
  }

  const template = options.filenameTemplate?.trim() || "{title}";
  const replaced = template
    .replace(/\{title\}/gi, title || "page")
    .replace(/\{host\}/gi, host || "page")
    .replace(/\{date\}/gi, formatDateStamp());

  let base = sanitizeFilename(replaced);
  if (options.appendDate && !/\{date\}/i.test(template)) {
    base = `${base}-${formatDateStamp()}`;
  }
  return `${base}.md`;
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
