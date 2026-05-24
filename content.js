(() => {
  const OPTIONS = (typeof window !== "undefined" && window.__pageToMarkdownOptions) || {};

  // 收集页面中所有有效内容图片 URL
  const __collectedImages = [];

  const SKIP_TAGS = new Set([
    "BUTTON",
    "CANVAS",
    "DIALOG",
    "EMBED",
    "IFRAME",
    "INPUT",
    "MENU",
    "NAV",
    "NOSCRIPT",
    "OBJECT",
    "SCRIPT",
    "SELECT",
    "STYLE",
    "SVG",
    "TEMPLATE",
    "TEXTAREA",
    "VIDEO"
  ]);

  const INLINE_TAGS = new Set([
    "A",
    "ABBR",
    "B",
    "BDI",
    "BDO",
    "CITE",
    "CODE",
    "DATA",
    "DEL",
    "DFN",
    "EM",
    "I",
    "INS",
    "KBD",
    "MARK",
    "Q",
    "S",
    "SAMP",
    "SMALL",
    "SPAN",
    "STRIKE",
    "STRONG",
    "SUB",
    "SUP",
    "TIME",
    "U",
    "VAR"
  ]);

  const BLOCK_SELECTOR = [
    "article",
    "aside",
    "blockquote",
    "details",
    "div",
    "dl",
    "figure",
    "footer",
    "header",
    "li",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "ul",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "[class*='ne-']",
    "[class*='lake-']"
  ].join(",");

  const WHITELIST_SELECTORS = [
    ".ne-viewer-body",
    ".ne-viewer",
    ".ne-engine",
    ".ne-typography",
    ".lake-content",
    ".lake-engine",
    ".doc-reader",
    ".reader-content",
    ".article-content",
    ".article-body",
    ".doc-content",
    "[data-testid='doc-reader']"
  ];

  function detectPseudoHeadingLevel(element) {
    if (!(element instanceof Element)) return 0;
    const tag = element.tagName;
    const tagMatch = /^H([1-6])$/.exec(tag);
    if (tagMatch) return Number(tagMatch[1]);

    // 自定义标题标签（NE-H1 ~ NE-H6）
    const customMatch = tag.match(/^(?:NE-|LAKE-)H([1-6])$/);
    if (customMatch) return Number(customMatch[1]);

    const className = typeof element.className === "string" ? element.className : "";
    const neMatch = className.match(/\bne-h([1-6])\b/i) || className.match(/\blake-heading-?([1-6])\b/i);
    if (neMatch) return Number(neMatch[1]);

    if (element.getAttribute("role") === "heading") {
      const level = Number.parseInt(element.getAttribute("aria-level") || "", 10);
      if (level >= 1 && level <= 6) return level;
    }
    return 0;
  }

  function isPseudoCodeBlock(element) {
    if (!(element instanceof Element)) return false;
    const className = typeof element.className === "string" ? element.className : "";
    return /(ne-codeblock|lake-codeblock)/i.test(className);
  }

  function isPseudoList(element) {
    if (!(element instanceof Element)) return false;
    // 先检查自定义标签名
    const tag = (element.tagName || "").toUpperCase();
    if (/^(NE-OL|NE-UL|LAKE-OL|LAKE-UL)$/.test(tag)) return true;
    
    const className = typeof element.className === "string" ? element.className : "";
    // 排除列表子组件（body/prefix/item/number/content），这些不是列表容器
    if (/list-(body|prefix|item|number|content)/i.test(className)) return false;
    // 匹配列表容器类名
    return /(ne-list|lake-list|ne-ol|ne-ul|lake-ol|lake-ul)/i.test(className);
  }

  function isPseudoQuote(element) {
    if (!(element instanceof Element)) return false;
    const className = typeof element.className === "string" ? element.className : "";
    return /(ne-quote|ne-blockquote|lake-quote|lake-blockquote)/i.test(className);
  }

  function absoluteUrl(value) {
    if (!value) return "";
    try {
      const full = new URL(value, location.href).href;
      // 处理代理图片 URL（如语雀 /api/filetransfer/images?url=实际URL）
      // 提取 url 参数中的真实图片地址
      try {
        const parsed = new URL(full);
        if (parsed.pathname.includes('/api/filetransfer/images') || 
            parsed.pathname.includes('/api/image')) {
          const realUrl = parsed.searchParams.get('url');
          if (realUrl && /^https?:\/\//i.test(realUrl)) return realUrl;
        }
      } catch {}
      return full;
    } catch {
      return value;
    }
  }

  function resolveImageSource(element) {
    const isPlaceholder = (value) =>
      !value ||
      /^data:image\/(gif|svg\+xml);/i.test(value) ||
      /^(?:blank|placeholder|loading)$/i.test(value);

    const direct = element.currentSrc || element.getAttribute("src");
    if (direct && !isPlaceholder(direct)) return direct;

    const attrs = [
      "data-src",
      "data-original",
      "data-actualsrc",
      "data-lazy-src",
      "data-origin-src",
      "data-canonical-src",
      "data-url",
      "data-hires",
      "data-original-src",
      "data-echo",
      "data-lazyload",
      "data-hi-res",
      "_src",
      "data-thumb",
      "data-raw-src",
      "data-img-src"
    ];
    for (const name of attrs) {
      const value = element.getAttribute(name);
      if (value && !isPlaceholder(value)) return value;
    }

    const srcset = element.getAttribute("srcset") || element.getAttribute("data-srcset");
    if (srcset) {
      const parts = srcset.split(",").map((s) => s.trim()).filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last.split(/\s+/)[0];
    }

    return direct || "";
  }

  function normalizeSpaces(text) {
    return String(text || "").replace(/\u00a0/g, " ").replace(/[ \t\r\n]+/g, " ");
  }

  function escapeInline(text) {
    return normalizeSpaces(text).replace(/([\\`[\]])/g, "\\$1");
  }

  function cleanInline(text) {
    return String(text || "")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .trim();
  }

  function splitFenced(markdown, transform) {
    return String(markdown)
      .split(/(```[\s\S]*?```)/g)
      .map((part) => (part.startsWith("```") ? part : transform(part)))
      .join("");
  }

  function cleanMarkdown(markdown) {
    return splitFenced(markdown, (part) =>
      part
        .replace(/^(?: {4,}|\t+)(?=\S)/gm, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
    ).trim();
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return true;
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;

    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function textLength(element) {
    return normalizeSpaces(element.innerText || element.textContent || "").trim().length;
  }

  function elementFingerprint(element) {
    const className = typeof element.className === "string" ? element.className : "";
    const attrs = Array.from(element.attributes || [])
      .map((attribute) => `${attribute.name}=${attribute.value}`)
      .join(" ");
    return `${element.tagName || ""} ${className} ${element.id || ""} ${attrs}`.toLowerCase();
  }

  function isNonContentElement(element) {
    if (!(element instanceof Element)) return false;

    const fingerprint = elementFingerprint(element);
    if (
      /(comments?|replies|reply|likes?|votes?|praise|reward|share|collect|favorite|bookmark|follow|avatar|user-card|profile|recommend|related|action|operation|toolbar|sidebar|catalog|toc|site-footer|page-footer|footer|breadcrumb|crumbs|pagination|pager|paywall|paid-wall|subscribe|newsletter|cookie-banner|cookie-consent|gdpr|advert|advertis|promo-|promotion|banner-ad|qrcode|qr-code|scan-code|app-download|download-app|copyright|disclaimer|statement|report-btn|copy-btn|toc-wrapper)/.test(
        fingerprint
      )
    ) {
      return true;
    }

    const text = normalizeSpaces(element.innerText || "");
    if (/^\d+\s*(\u4eba)?(\u70b9\u8d5e|\u559c\u6b22)$/.test(text)) return true;
    if (/^(\u70b9\u8d5e|\u8bc4\u8bba|\u5206\u4eab|\u6536\u85cf|\u8d5e\u8d4f|\u5173\u6ce8|\u4e09\u8fde|\u4e00\u952e\u4e09\u8fde|\u6253\u8d4f|\u6295\u5e01|\u9605\u8bfb\u5168\u6587|\u5c55\u5f00\u5168\u6587|\u67e5\u770b\u66f4\u591a|\u7248\u6743\u58f0\u660e|\u626b\u7801\u5173\u6ce8|\u5173\u6ce8\u516c\u4f17\u53f7|\u4e0b\u8f7d\u5ba2\u6237\u7aef|\u5e7f\u544a)$/.test(text)) return true;

    const imgCount = element.querySelectorAll("img").length;
    const paragraphCount = element.querySelectorAll("p, h1, h2, h3, h4, pre, code, li").length;
    if (imgCount >= 2 && paragraphCount === 0 && textLength(element) < 80) return true;

    return false;
  }

  function contentScore(element) {
    const text = textLength(element);
    const blockCount = element.querySelectorAll("p, li, blockquote, pre, br").length;
    const headingCount = element.querySelectorAll("h1, h2, h3").length;
    const codeCount = element.querySelectorAll("pre, code, [class*='code'], [class*='Code']").length;
    const linkCount = element.querySelectorAll("a").length;
    const imageCount = element.querySelectorAll("img").length;
    const nonContentCount = Array.from(element.querySelectorAll("*")).filter(isNonContentElement).length;

    return text + blockCount * 90 + headingCount * 140 + codeCount * 120 - linkCount * 10 - imageCount * 30 - nonContentCount * 250;
  }

  function findContentRoot() {
    if (OPTIONS && OPTIONS.useSelection) {
      const host = selectionRoot();
      if (host) return host;
    }

    // 1. 白名单容器优先，门槛更低
    const whitelisted = WHITELIST_SELECTORS.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
    ).filter((element) => isVisible(element) && textLength(element) > 40);
    if (whitelisted.length > 0) {
      return whitelisted
        .map((element) => ({ element, score: contentScore(element) }))
        .sort((a, b) => b.score - a.score)[0].element;
    }

    const selectors = [
      "article",
      "main",
      "[role='main']",
      ".article",
      ".post",
      ".entry-content",
      ".post-content",
      ".content",
      "#content"
    ];

    const candidates = selectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((element) => isVisible(element) && !isNonContentElement(element))
      .filter((element) => textLength(element) > 120);

    const deepCandidates = Array.from(document.querySelectorAll("article, main, section, div"))
      .filter((element) => isVisible(element) && !isNonContentElement(element) && textLength(element) > 300)
      .filter((element) => element.querySelectorAll("p, h1, h2, h3, li, pre, code").length >= 3);

    candidates.push(...deepCandidates);

    if (candidates.length === 0) return document.body;

    return Array.from(new Set(candidates))
      .map((element) => ({ element, score: contentScore(element) }))
      .sort((a, b) => b.score - a.score)[0].element;
  }

  function selectionRoot() {
    try {
      const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
      if (!selection || selection.rangeCount === 0) return null;
      if (!selection.toString().trim()) return null;

      const range = selection.getRangeAt(0);
      const fragment = range.cloneContents();
      if (!fragment.childNodes.length) return null;

      const host = document.createElement("div");
      host.setAttribute("data-page-to-markdown-host", "1");
      host.style.cssText =
        "position:absolute;left:-99999px;top:-99999px;width:1024px;visibility:hidden;pointer-events:none;";
      host.appendChild(fragment);
      document.body.appendChild(host);
      return host;
    } catch {
      return null;
    }
  }

  function fontWeightNumber(value) {
    if (value === "bold" || value === "bolder") return 700;
    if (value === "normal" || value === "lighter") return 400;

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 400;
  }

  function isBoldElement(element) {
    if (!(element instanceof Element)) return false;
    if (element.tagName === "B" || element.tagName === "STRONG") return true;
    return fontWeightNumber(getComputedStyle(element).fontWeight) >= 600;
  }

  function bold(text) {
    const cleaned = cleanInline(text);
    if (!cleaned) return "";
    return cleaned.startsWith("**") && cleaned.endsWith("**") ? cleaned : `**${cleaned}**`;
  }

  function isInlineLike(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    const element = node;
    if (INLINE_TAGS.has(element.tagName)) return true;
    if (element.tagName === "BR" || element.tagName === "IMG") return true;

    return getComputedStyle(element).display.includes("inline");
  }

  function hasOnlyInlineChildren(element) {
    return Array.from(element.childNodes).every(isInlineLike);
  }

  function hasMeaningfulDirectText(element) {
    return Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && normalizeSpaces(node.nodeValue).trim()
    );
  }

  function inlineChildren(element, state) {
    return Array.from(element.childNodes)
      .map((node) => inlineNode(node, state))
      .join("");
  }

  function inlineNode(node, state) {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeInline(node.nodeValue || "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const element = node;
    const tag = element.tagName;
    if (SKIP_TAGS.has(tag) || !isVisible(element) || isNonContentElement(element)) return "";

    // 跳过列表前缀元素（数字、bullet 符号等）
    const elClass = typeof element.className === "string" ? element.className : "";
    if (/(ne-list-prefix|lake-list-prefix|list-prefix|list-number)/i.test(elClass)) return "";
    // 也按 tagName 跳过自定义前缀元素
    const elTag = element.tagName || "";
    if (/^(NE-LIST-PREFIX|LAKE-LIST-PREFIX)$/i.test(elTag)) return "";
    // 跳过列表项前缀容器（数字/bullet 符号区域）
    if (/^(NE-OLI-I|NE-ULI-I)$/i.test(elTag)) return "";
    // 跳过视觉填充元素（仅用于编辑器渲染的占位元素）
    if (element.hasAttribute("ne-filler") || /ne-viewer-b-filler/i.test(elClass)) return "";

    // 行内代码识别（class 含 ne-code 或 lake-code）
    if (/(^|\s)(ne-code|lake-code)(\s|$)/i.test(elClass)) {
      const content = element.textContent || "";
      return content ? `\`${content.replace(/`/g, "\\`")}\`` : "";
    }

    if (tag === "BR") return "\n\n";

    if (tag === "IMG") {
      const src = absoluteUrl(resolveImageSource(element));
      if (!src) return "";
      const alt = escapeInline(element.getAttribute("alt") || "");
      
      // 仅过滤尺寸极小且无 alt 的图片（装饰性图标等）
      const width = element.naturalWidth || element.width || parseInt(element.getAttribute("width") || "0", 10);
      const height = element.naturalHeight || element.height || parseInt(element.getAttribute("height") || "0", 10);
      if (!alt && width > 0 && width < 50 && height > 0 && height < 50) return "";
      
      // 仅检查图片自身的 class 和 src，不检查父容器
      const imgClass = (typeof element.className === "string" ? element.className : "").toLowerCase();
      const imgSrc = src.toLowerCase();
      if (/(avatar|emoji|icon|logo|badge|favicon)/.test(imgClass) || /(avatar|emoji|icon|favicon)/.test(imgSrc)) return "";
      
      // 跳过文档卡片的装饰图片（背景图和图标图）
      if (/ne-yuque-doc-(card-view-bg|icon)/i.test(imgClass)) return "";
      
      // 收集图片 URL
      if (!__collectedImages.includes(src)) {
        __collectedImages.push(src);
      }
      return `![${alt}](${src})`;
    }

    if (tag === "PICTURE") {
      // 尝试从 source 标签获取最佳图片
      const img = element.querySelector("img");
      if (img) return inlineNode(img, state);
      
      const sources = Array.from(element.querySelectorAll("source"));
      for (const source of sources) {
        const srcset = source.getAttribute("srcset");
        if (srcset) {
          const parts = srcset.split(",").map(s => s.trim()).filter(Boolean);
          const last = parts[parts.length - 1];
          if (last) {
            const url = absoluteUrl(last.split(/\s+/)[0]);
            if (url) return `![](${url})`;
          }
        }
      }
      return "";
    }

    // 行内代码标签（<ne-code> → <ne-code-content> → <ne-text>）
    if (tag === "NE-CODE" || tag === "LAKE-CODE") {
      const content = element.textContent || "";
      return content ? `\`${content.replace(/`/g, "\\`")}\`` : "";
    }

    if (tag === "CODE") {
      const content = element.textContent || "";
      return `\`${content.replace(/`/g, "\\`")}\``;
    }

    const startsBold = isBoldElement(element) && !state.bold;
    const childState = startsBold ? { ...state, bold: true } : state;
    let content = inlineChildren(element, childState);

    if (tag === "EM" || tag === "I") {
      content = cleanInline(content);
      return content ? `*${content}*` : "";
    }

    if (tag === "DEL" || tag === "S" || tag === "STRIKE") {
      content = cleanInline(content);
      return content ? `~~${content}~~` : "";
    }

    if (tag === "MARK") {
      content = cleanInline(content);
      return content ? `==${content}==` : "";
    }

    if (tag === "SUP") {
      const text = cleanInline(content);
      return text ? `<sup>${text}</sup>` : "";
    }

    if (tag === "SUB") {
      const text = cleanInline(content);
      return text ? `<sub>${text}</sub>` : "";
    }

    if (tag === "A") {
      const text = cleanInline(content);
      const href = absoluteUrl(element.getAttribute("href"));
      if (!text) return "";
      if (!href || href.startsWith("javascript:") || href.startsWith("#")) {
        content = text;
      } else {
        content = `[${text}](${href})`;
      }
    }

    return startsBold ? bold(content) : content;
  }

  function inlineParagraphs(element, state) {
    const startsBold = isBoldElement(element) && !state.bold;
    const childState = startsBold ? { ...state, bold: true } : state;
    const content = inlineChildren(element, childState);

    return content
      .split(/\n{2,}/)
      .map(cleanInline)
      .filter(Boolean)
      .map((part) => (startsBold ? bold(part) : part));
  }

  function classAndAttributes(element) {
    const className = typeof element.className === "string" ? element.className : "";
    const attrs = Array.from(element.attributes || [])
      .map((attribute) => `${attribute.name}=${attribute.value}`)
      .join(" ");
    return `${className} ${element.id || ""} ${attrs}`.toLowerCase();
  }

  function codeSyntaxSignals(text) {
    return (
      String(text || "").match(
        /[{}();=]|\b(class|public|private|protected|static|void|int|string|new|return|function|const|let|var|import|package|extends|implements)\b/gi
      ) || []
    ).length;
  }

  function looksLikeCodeText(text) {
    const lines = String(text || "")
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2) return false;

    const codeLines = lines.filter((line) => codeSyntaxSignals(line) > 0).length;
    const proseLines = lines.filter((line) => /[\u4e00-\u9fff]/.test(line) && !/^\s*\/\//.test(line) && codeSyntaxSignals(line) === 0)
      .length;

    return codeLines >= 2 && codeLines >= proseLines;
  }

  function startsWithCodeContent(text) {
    const lines = String(text || "")
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6);

    if (lines.length === 0) return false;

    return lines.some((line) => {
      if (/^\d+(\s+\S)?$/.test(line)) return true;
      if (/^(\u8fd0\u884c\u4ee3\u7801|run code|copy|java|javascript|typescript|python|go|rust|cpp|csharp|bash|shell|json|xml)$/i.test(line)) {
        return true;
      }
      return codeSyntaxSignals(line) >= 2;
    });
  }

  function isExplicitCodeBlock(element) {
    if (!(element instanceof Element)) return false;
    // 行内 code 标签不是代码块（未被 pre 包裹的 code 是行内代码）
    if (element.tagName === "CODE" && !element.closest("pre")) return false;
    if (element.tagName === "PRE") return true;

    const text = classAndAttributes(element);
    const hasCodeClass = /(codemirror|cm-editor|monaco-editor|highlight|language-|lang-|ne-codeblock|lake-codeblock|code-block|codeblock|hljs|prism-|syntax-|crayon-|prettyprint|wp-block-code|bytemd|markdown-body pre|juejin|v-md-editor)/.test(text);
    const hasCodeData = /(data-language|data-lang|data-code)/.test(text);

    if (!hasCodeClass && !hasCodeData) return false;

    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 32) return false;

    const proseBlocks = element.querySelectorAll("p, h1, h2, h3, h4, li, blockquote").length;
    if (proseBlocks > 2) return false;

    // 有明确代码类名时不再要求 looksLikeCodeText
    return true;
  }

  function inferCodeLanguage(element) {
    const dataLanguage = element.getAttribute("data-language") || element.getAttribute("data-lang");
    if (dataLanguage) return cleanLanguage(dataLanguage);

    const classMatch = String(element.className || "").match(/(?:language|lang)-([a-z0-9_+-]+)/i);
    if (classMatch) return cleanLanguage(classMatch[1]);

    const text = normalizeSpaces(element.innerText || "");
    const languageMatch = text.match(
      /\b(JavaScript|TypeScript|Java|Python|Go|Rust|C\+\+|C#|CSS|HTML|SQL|Shell|Bash|JSON|XML|YAML|TOML|INI|Markdown|Dockerfile|Makefile|Nginx|Ruby|PHP|Kotlin|Swift|Scala|Lua|Perl|R|Dart|GraphQL|Protobuf|SCSS|LESS|Diff)\b/i
    );
    return languageMatch ? cleanLanguage(languageMatch[1]) : "";
  }

  function cleanLanguage(value) {
    const language = String(value).trim().toLowerCase();
    const aliases = { "c++": "cpp", "c#": "csharp", shell: "bash", yml: "yaml", dockerfile: "docker", makefile: "make" };
    return (aliases[language] || language).replace(/[^a-z0-9_+-]/g, "");
  }

  function extractCodeText(element) {
    // 尝试逐行提取（自定义代码编辑器）
    const lineSelectors = [
      '[class*="code-line"]',
      '[class*="code_line"]',
      '.cm-line',
      '[class*="ne-code-line"]',
      '[class*="view-line"]',
      '[class*="CodeMirror-line"]',
      '[data-line-number]'
    ];

    for (const selector of lineSelectors) {
      const lines = element.querySelectorAll(selector);
      if (lines.length >= 2) {
        const text = Array.from(lines).map(line => line.textContent || "").join("\n");
        if (text.trim()) return text;
      }
    }

    // 回退：检查直接 div 子元素是否构成代码行
    const directDivs = Array.from(element.querySelectorAll(":scope > div, :scope > p, :scope > span[style*='display']"));
    if (directDivs.length >= 2) {
      const text = directDivs.map(d => d.textContent || "").join("\n");
      if (text.trim() && text.includes("\n")) return text;
    }

    // 最终回退到 innerText
    return element.innerText || element.textContent || "";
  }

  function codeCandidates(element) {
    const selectors = [
      "pre code",
      "pre",
      "code",
      "[class*='code-content']",
      "[class*='code_body']",
      "[class*='code-body']",
      "[class*='code-line']",
      "[class*='code_line']",
      "[class*='view-lines']",
      "[class*='cm-content']",
      "[class*='highlight']",
      "[class*='prism-']",
      "[class*='hljs']",
      "[class*='crayon-']",
      "[class*='prettyprint']",
      "[class*='syntaxhighlighter']"
    ];

    const candidates = selectors.flatMap((selector) => Array.from(element.querySelectorAll(selector)));
    candidates.push(element);

    return Array.from(new Set(candidates))
      .filter((candidate) => candidate instanceof Element && isVisible(candidate))
      .map((candidate) => ({
        element: candidate,
        text: extractCodeText(candidate)
      }))
      .filter((candidate) => candidate.text.trim())
      .sort((a, b) => codeScore(b.text) - codeScore(a.text));
  }

  function codeScore(text) {
    const value = String(text || "");
    const lines = value.split(/\n/).filter((line) => line.trim());
    return value.length + lines.length * 20 + codeSyntaxSignals(value) * 20;
  }

  function stripCodeChrome(text, language) {
    let lines = String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n");

    const languagePattern = language ? new RegExp(`^${escapeRegExp(language)}$`, "i") : null;
    const toolbarPattern =
      /^(run code|copy|copied|expand|collapse|wrap|unwrap|plain text|javascript|typescript|java|python|go|rust|cpp|csharp|css|html|sql|bash|shell|json|xml|\u8fd0\u884c\u4ee3\u7801|\u590d\u5236)$/i;

    lines = lines.filter((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || index > 5) return true;
      if (languagePattern && languagePattern.test(trimmed)) return false;
      return !toolbarPattern.test(trimmed);
    });

    lines = removeLineNumbers(lines);

    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

    return lines.join("\n");
  }

  function removeLineNumbers(lines) {
    const prefixed = lines.filter((line) => /^[\s\u25be\u25b8]*\d+\s+\S/.test(line)).length;
    if (prefixed >= Math.max(3, Math.floor(lines.length * 0.35))) {
      return lines.map((line) => line.replace(/^[\s\u25be\u25b8]*\d+\s/, ""));
    }

    const standaloneIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter((item) => /^\s*\d+\s*$/.test(item.line))
      .map((item) => item.index);

    if (standaloneIndexes.length >= Math.max(3, Math.floor(lines.length * 0.25))) {
      const indexes = new Set(standaloneIndexes);
      return lines.filter((_, index) => !indexes.has(index));
    }

    return lines;
  }

  function codeBlockMarkdown(element, requireCodeCheck) {
    const candidates = codeCandidates(element);
    const best = candidates[0];
    if (!best) return "";

    const language = inferCodeLanguage(element) || inferCodeLanguage(best.element);
    const code = stripCodeChrome(best.text, language);

    if (!code.trim()) return "";
    // 仅在隐式检测时要求 looksLikeCodeText
    if (requireCodeCheck && !looksLikeCodeText(code)) return "";
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }

  function findItemTaskCheckbox(item) {
    const boxes = item.querySelectorAll("input[type=checkbox]");
    for (const box of boxes) {
      let parent = box.parentElement;
      let depth = 0;
      while (parent && parent !== item && depth < 3) {
        if (parent.tagName === "LI" && parent !== item) return null;
        parent = parent.parentElement;
        depth += 1;
      }
      if (parent === item) return box;
    }
    const role = item.getAttribute("role");
    if (role === "checkbox" || item.hasAttribute("aria-checked")) {
      const checked = item.getAttribute("aria-checked") === "true";
      return { checked };
    }
    return null;
  }

  function listMarkdown(list, state) {
    const ordered = list.tagName === "OL";
    let items = Array.from(list.children).filter((child) => child.tagName === "LI");
    // 如果没有直接 LI 子元素，递归查找被 div/span 包裹的 LI
    if (items.length === 0) {
      items = Array.from(list.querySelectorAll(":scope > * > li, :scope > li"));
      // 去重
      items = [...new Set(items)];
    }

    return items
      .map((item, index) => {
        const checkbox = findItemTaskCheckbox(item);
        let marker = ordered ? `${index + 1}. ` : "- ";
        if (checkbox) {
          marker = `- [${checkbox.checked ? "x" : " "}] `;
        }

        // 分离行内内容和块级子元素
        const inlineParts = [];
        const blockChildren = [];
        for (const child of item.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const text = normalizeSpaces(child.nodeValue).trim();
            if (text) inlineParts.push(escapeInline(child.nodeValue));
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            const el = child;
            if (el.tagName === "UL" || el.tagName === "OL") {
              blockChildren.push(el);
            } else if (el.tagName === "P" || el.tagName === "DIV" || el.tagName === "BLOCKQUOTE" || el.tagName === "PRE" || el.tagName === "TABLE" || el.tagName === "DL") {
              blockChildren.push(el);
            } else {
              // 行内元素
              const inlineText = inlineNode(el, state);
              if (inlineText.trim()) inlineParts.push(inlineText);
            }
          }
        }

        // 构建行内文本
        let firstLine = cleanInline(inlineParts.join(""));

        // 构建块级子内容
        const subBlocks = [];
        for (const blockChild of blockChildren) {
          if (blockChild.tagName === "UL" || blockChild.tagName === "OL") {
            // 嵌套列表 — 使用 listMarkdown，深度 +1，不额外缩进
            const nestedList = listMarkdown(blockChild, { ...state, listDepth: state.listDepth + 1 });
            if (nestedList) subBlocks.push(nestedList);
          } else {
            const blocks = collectBlocks(blockChild, { ...state, listDepth: state.listDepth + 1 });
            subBlocks.push(...blocks);
          }
        }

        // 如果没有行内内容但有块级内容，取第一个块作为首行
        if (!firstLine && subBlocks.length > 0) {
          firstLine = subBlocks.shift() || "";
        }

        const indent = "  ".repeat(state.listDepth);
        const continuation = "  ".repeat(state.listDepth) + "  ";
        
        let result = `${indent}${marker}${firstLine}`;
        for (const block of subBlocks) {
          const blockLines = block.split("\n");
          // 嵌套列表已有自己的缩进，其他块内容需要添加续行缩进
          const isNestedList = /^\s*[-*+\d]/.test(blockLines[0]);
          if (isNestedList) {
            result += "\n" + block;
          } else {
            result += "\n" + blockLines.map(line => `${continuation}${line}`).join("\n");
          }
        }

        return result;
      })
      .join("\n");
  }

  function pseudoListMarkdown(element, state) {
    // 查找所有直接列表项：支持扁平结构（所有 ne-li 同级，通过 data-level 区分嵌套）
    const items = Array.from(element.children).filter(child => {
      if (!(child instanceof Element)) return false;
      // 匹配：有 data-list-type 属性
      if (child.hasAttribute("data-list-type")) return true;
      // 匹配：tagName 含 "li"（如 NE-LI、LAKE-LI）
      if (child.tagName && /li$/i.test(child.tagName)) return true;
      // 匹配：class 含 list-item / ne-li / lake-li
      const cls = typeof child.className === "string" ? child.className : "";
      return /list-item|ne-li|lake-li/i.test(cls);
    });

    if (items.length === 0) return "";

    // 按层级维护有序列表序号
    const orderedCounters = {};

    return items.map((item) => {
      const listType = item.getAttribute("data-list-type") || "";
      // 判断有序/无序：属性优先，其次检查父容器或自身类名
      const parentTag = (element.tagName || "").toUpperCase();
      const itemCls = typeof item.className === "string" ? item.className : "";
      const isOrdered = /ordered|number|decimal/i.test(listType) ||
        (!listType && (/^(NE-OL|OL|LAKE-OL)$/i.test(parentTag) || /ne-ol|lake-ol/i.test(itemCls)));

      const dataLevel = parseInt(item.getAttribute("data-level") || "0", 10);
      const depth = state.listDepth + dataLevel;
      const indent = "  ".repeat(depth);

      // 维护有序列表序号（per-level）
      if (isOrdered) {
        orderedCounters[dataLevel] = (orderedCounters[dataLevel] || 0) + 1;
      } else {
        // 无序项重置该层级的有序计数
        orderedCounters[dataLevel] = 0;
      }
      // 更深层级计数也重置
      for (const key of Object.keys(orderedCounters)) {
        if (parseInt(key) > dataLevel) orderedCounters[key] = 0;
      }

      const marker = isOrdered ? `${orderedCounters[dataLevel]}. ` : "- ";

      // 提取内容：优先从 list-body 中取，跳过 list-prefix
      const bodyEl = item.querySelector('[class*="list-body"], [class*="list-content"]') ||
        Array.from(item.children).find(c => {
          const t = (c.tagName || "").toUpperCase();
          return t === "NE-LIST-BODY" || t === "LAKE-LIST-BODY";
        });
      const contentElement = bodyEl || item;

      // 收集内容，跳过 prefix 和嵌套列表
      const parts = [];
      for (const child of contentElement.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = normalizeSpaces(child.nodeValue).trim();
          if (text) parts.push(escapeInline(child.nodeValue));
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const el = child;
          const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
          const childTag = (el.tagName || "").toUpperCase();
          // 跳过列表前缀
          if (cls.includes("list-prefix") || cls.includes("list-number") ||
              /^(NE-LIST-PREFIX|LAKE-LIST-PREFIX)$/i.test(childTag)) continue;
          // 跳过嵌套列表容器
          if (isPseudoList(el) || el.tagName === "UL" || el.tagName === "OL" ||
              cls.includes("list-wrap")) continue;
          // 行内内容用 inlineNode 处理
          if (hasOnlyInlineChildren(el) || INLINE_TAGS.has(el.tagName)) {
            const text = inlineNode(el, state);
            if (text.trim()) parts.push(text);
          } else {
            // 块级子元素（段落等）
            const blocks = collectBlocks(el, state);
            parts.push(...blocks);
          }
        }
      }

      const content = parts.length > 0 ? parts.join("") : "";
      if (!content.trim()) return null;

      // 按换行拆分，首行跟 marker，后续行加缩进
      const lines = content.split("\n").filter(Boolean);
      const first = lines.shift() || "";
      const rest = lines.map(line => `${indent}  ${line}`).join("\n");

      return rest ? `${indent}${marker}${first}\n${rest}` : `${indent}${marker}${first}`;
    }).filter(Boolean).join("\n");
  }

  function definitionListMarkdown(list, state) {
    const parts = [];
    for (const child of list.children) {
      if (!(child instanceof Element)) continue;
      if (child.tagName === "DT") {
        const term = cleanInline(inlineChildren(child, state));
        if (term) parts.push(`**${term}**`);
      } else if (child.tagName === "DD") {
        const desc = cleanInline(inlineChildren(child, state));
        if (desc) parts.push(`: ${desc}`);
      }
    }
    return parts.join("\n");
  }

  function tableMarkdown(table, state) {
    // 1. 构建二维网格，支持 colspan/rowspan
    const rawRows = Array.from(table.querySelectorAll("tr"));
    if (rawRows.length === 0) return "";

    // 先确定最大列数（考虑 colspan）
    let maxCols = 0;
    for (const row of rawRows) {
      let count = 0;
      for (const cell of row.children) {
        if (/^(TH|TD)$/.test(cell.tagName)) {
          count += Math.max(1, parseInt(cell.getAttribute("colspan") || "1", 10));
        }
      }
      if (count > maxCols) maxCols = count;
    }
    if (maxCols === 0) return "";

    // 构建网格
    const grid = [];
    for (let r = 0; r < rawRows.length; r++) {
      if (!grid[r]) grid[r] = new Array(maxCols).fill("");
      const cells = Array.from(rawRows[r].children).filter(c => /^(TH|TD)$/.test(c.tagName));
      let col = 0;
      for (const cell of cells) {
        // 跳过已被 rowspan 占据的位置
        while (col < maxCols && grid[r][col] !== "") col++;
        if (col >= maxCols) break;

        const colspan = Math.max(1, parseInt(cell.getAttribute("colspan") || "1", 10));
        const rowspan = Math.max(1, parseInt(cell.getAttribute("rowspan") || "1", 10));
        // 清洗单元格内容：替换换行为空格，转义管道符
        const content = cleanInline(inlineChildren(cell, state)).replace(/\n/g, " ").replace(/\|/g, "\\|");

        for (let dr = 0; dr < rowspan; dr++) {
          for (let dc = 0; dc < colspan; dc++) {
            const targetRow = r + dr;
            const targetCol = col + dc;
            if (targetRow < rawRows.length) {
              if (!grid[targetRow]) grid[targetRow] = new Array(maxCols).fill("");
              // 仅第一个位置放内容，其余留空
              grid[targetRow][targetCol] = (dr === 0 && dc === 0) ? content : "";
            }
          }
        }
        col += colspan;
      }
    }

    if (grid.length === 0) return "";

    // 补齐不足的列
    const normalized = grid.map(row => {
      while (row.length < maxCols) row.push("");
      return row;
    });

    // 2. 区分表头和表体
    let headerRow;
    let bodyRows;
    
    const thead = table.querySelector("thead");
    if (thead) {
      const theadRows = normalized.filter((_, i) => {
        const tr = rawRows[i];
        return tr && (tr.parentElement === thead || tr.closest("thead") === thead);
      });
      headerRow = theadRows.length > 0 ? theadRows[0] : normalized[0];
      const headerCount = theadRows.length || 1;
      bodyRows = normalized.slice(headerCount);
    } else {
      // 检查首行是否全是 TH
      const firstRowCells = Array.from(rawRows[0]?.children || []);
      const allTh = firstRowCells.length > 0 && firstRowCells.every(c => c.tagName === "TH");
      if (allTh) {
        headerRow = normalized[0];
        bodyRows = normalized.slice(1);
      } else {
        // 生成空表头
        headerRow = new Array(maxCols).fill("");
        bodyRows = normalized;
      }
    }

    const lines = [
      `| ${headerRow.join(" | ")} |`,
      `| ${headerRow.map(() => "---").join(" | ")} |`,
      ...bodyRows.map(row => `| ${row.join(" | ")} |`)
    ];
    return lines.join("\n");
  }

  function isCustomListItem(element) {
    if (!(element instanceof Element)) return false;
    return /^(NE-OLI|NE-ULI|LAKE-OLI|LAKE-ULI)$/i.test(element.tagName);
  }

  function customListItemMarkdown(element, state) {
    const tag = element.tagName.toUpperCase();
    const isOrdered = /OLI$/i.test(tag);

    let level = 0;
    let marker = "- ";

    if (isOrdered) {
      const symbolSpan = element.querySelector(".ne-list-symbol");
      if (symbolSpan) {
        level = parseInt(symbolSpan.getAttribute("data-level") || "0", 10);
        const numText = (symbolSpan.textContent || "").trim();
        const num = parseInt(numText, 10);
        marker = num > 0 ? `${num}. ` : "1. ";
      } else {
        marker = "1. ";
      }
    } else {
      level = parseInt(element.getAttribute("ne-level") || "0", 10);
    }

    const contentEl = element.querySelector("ne-oli-c, ne-uli-c");
    if (!contentEl) return [];

    const text = cleanInline(inlineChildren(contentEl, state));
    if (!text) return [];

    const indent = "    ".repeat(level);
    return [indent + marker + text];
  }

  function collectBlocks(element, state = { bold: false, listDepth: 0 }) {
    if (!(element instanceof Element) || SKIP_TAGS.has(element.tagName) || !isVisible(element) || isNonContentElement(element)) {
      return [];
    }

    const tag = element.tagName;

    if (isExplicitCodeBlock(element) || isPseudoCodeBlock(element)) {
      const code = codeBlockMarkdown(element, false);
      if (code) return [code];
    }

    const headingLevel = detectPseudoHeadingLevel(element);
    if (headingLevel > 0) {
      const text = cleanInline(inlineChildren(element, state));
      return text ? [`${"#".repeat(headingLevel)} ${text}`] : [];
    }

    // 文档引用卡片（ne-hole 包含 ne-card[data-card-name="yuque"]）→ 转为 markdown 链接
    if (/^(NE-HOLE|NE-CARD)$/i.test(tag)) {
      const card = tag === "NE-CARD" ? element : element.querySelector('ne-card[data-card-name="yuque"]');
      if (card && card.getAttribute("data-card-name") === "yuque") {
        const anchor = card.querySelector("a[href]");
        const titleEl = card.querySelector(".ne-yuque-doc-title");
        if (anchor && titleEl) {
          const url = anchor.getAttribute("href") || "";
          const title = (titleEl.textContent || "").trim();
          if (title && url) return [`[${title}](${url})`];
        }
        // 如果无法提取链接信息，返回空（不要渲染内部的大图片）
        return [];
      }
      // 非文档卡片的 ne-hole，透传子元素处理
      return collectChildBlocks(element, state);
    }

    if (tag === "FIGURE") {
      const img = element.querySelector("img, picture");
      const figcaption = element.querySelector("figcaption");
      if (img) {
        const src = absoluteUrl(img.tagName === "IMG" ? resolveImageSource(img) : (() => {
          const innerImg = img.querySelector("img");
          return innerImg ? resolveImageSource(innerImg) : "";
        })());
        const caption = figcaption ? cleanInline(inlineChildren(figcaption, state)) : "";
        const alt = img.tagName === "IMG" ? escapeInline(img.getAttribute("alt") || "") : "";
        const finalAlt = caption || alt;
        if (src) {
          if (!__collectedImages.includes(src)) {
            __collectedImages.push(src);
          }
          return [`![${finalAlt}](${src})`];
        }
      }
      // 非图片 figure（如代码等），常规处理
      return collectChildBlocks(element, state);
    }

    if (tag === "P" || tag === "FIGCAPTION" || /^(NE-P|LAKE-P)$/i.test(tag)) return inlineParagraphs(element, state);

    if (tag === "PRE") {
      const code = codeBlockMarkdown(element, false);
      if (code) return [code];
      // PRE 兆底：即使 codeBlockMarkdown 无法提取，也输出为代码块
      const fallbackText = (element.textContent || "").replace(/\r\n?/g, "\n").trim();
      return fallbackText ? [`\`\`\`\n${fallbackText}\n\`\`\``] : [];
    }

    if (tag === "BLOCKQUOTE" || /^(NE-QUOTE|LAKE-QUOTE)$/i.test(tag) || isPseudoQuote(element)) {
      const blocks = collectChildBlocks(element, state);
      const quote = blocks
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return quote ? [quote] : [];
    }

    if (tag === "UL" || tag === "OL") {
      const list = listMarkdown(element, state);
      return list ? [list] : [];
    }

    // 有序/无序列表项（NE-OLI/NE-ULI 是扁平同级结构，无容器元素）
    if (isCustomListItem(element)) {
      return customListItemMarkdown(element, state);
    }

    if (isPseudoList(element)) {
      const list = pseudoListMarkdown(element, state);
      return list ? [list] : collectChildBlocks(element, state);
    }

    if (tag === "DL") {
      const list = definitionListMarkdown(element, state);
      return list ? [list] : [];
    }

    // 表格容器（ne-table-hole → 内部有真正的 <table>）
    if (/^(NE-TABLE-HOLE|NE-TABLE-WRAP|NE-TABLE-INNER-WRAP|NE-TABLE-BOX)$/i.test(tag)) {
      const innerTable = element.querySelector("table");
      if (innerTable) {
        const table = tableMarkdown(innerTable, state);
        return table ? [table] : [];
      }
      return collectChildBlocks(element, state);
    }

    if (tag === "TABLE") {
      const result = [];
      // caption 支持
      const caption = element.querySelector("caption");
      if (caption) {
        const captionText = cleanInline(inlineChildren(caption, state));
        if (captionText) result.push(`**${captionText}**`);
      }
      const table = tableMarkdown(element, state);
      if (table) result.push(table);
      return result;
    }

    if (tag === "HR") return ["---"];

    if (tag === "LI") {
      // LI 在列表上下文中由 listMarkdown 处理
      // 单独出现的 LI（如被 collectChildBlocks 递归到）按段落处理
      if (hasOnlyInlineChildren(element)) {
        return inlineParagraphs(element, state);
      }
      return collectChildBlocks(element, state);
    }

    if (hasOnlyInlineChildren(element) && (hasMeaningfulDirectText(element) || textLength(element) > 0)) {
      return inlineParagraphs(element, state);
    }

    return collectChildBlocks(element, state);
  }

  function collectChildBlocks(element, state) {
    const blocks = [];
    const children = Array.from(element.children).filter(c => c instanceof Element);
    let i = 0;
    while (i < children.length) {
      const child = children[i];
      // 扁平列表：将连续的 NE-OLI/NE-ULI 分组为单个列表块（用单换行连接，保持列表连续性）
      if (isCustomListItem(child)) {
        const listLines = [];
        while (i < children.length && isCustomListItem(children[i])) {
          const items = customListItemMarkdown(children[i], state);
          listLines.push(...items);
          i++;
        }
        if (listLines.length > 0) {
          blocks.push(listLines.join("\n"));
        }
        continue;
      }
      blocks.push(...collectBlocks(child, state));
      i++;
    }
    return blocks;
  }

  function readableDate() {
    const date = new Date();
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
    return `${date.toISOString().replace(/\.\d{3}Z$/, "")}${sign}${hours}:${minutes}`;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalizeMarkdown(markdown) {
    return splitFenced(markdown, (part) =>
      part
        .replace(/^(?: {4,}|\t+)(?=\S)/gm, "")
        .replace(/([:\uff1a;\uff1b\u3002])\s*[\u2022\u25cf\u25cb\u25a0\u25aa\u25b8\u25c6]\s*/g, "$1\n- ")
        .replace(/[ \t]+[\u2022\u25cf\u25cb\u25a0\u25aa\u25b8\u25c6]\s*/g, "\n- ")
        .replace(/^([ \t]*)[\u2022\u25cf\u00b7\u25cb\u25a0\u25a1\u25aa\u25ab\u25b8\u25b9\u25c6\u25c7\u25e6\u2023\u2043\u204d\u2219\u29bf]\s*/gm, "$1- ")
        .replace(/^\s*[-*+]\s*\n+([^\n]+)/gm, "- $1")
        .replace(/\n{3,}/g, "\n\n")
    ).trim();
  }

  function trimTrailingNonArticleBlocks(blocks) {
    const tailPatterns = [
      /^\s*(\u7248\u6743\u58f0\u660e|\u514d\u8d23\u58f0\u660e|\u8f6c\u8f7d\u8bf7\u6ce8\u660e|\u6ce8\uff1a\u8f6c\u8f7d)/,
      /(\u8bf7\u70b9\u51fb|\u70b9\u51fb.*(\u67e5\u770b|\u9605\u8bfb|\u8fdb\u5165)|\u8bf7\u626b\u7801|\u626b\u7801\u5173\u6ce8|\u626b\u63cf\u4e0b\u65b9\u4e8c\u7ef4\u7801|\u5173\u6ce8(\u6211\u4eec|\u516c\u4f17\u53f7))/,
      /(\u5982\u679c.*\u6709\u5e2e\u52a9|\u8d5e\u8d4f|\u6253\u8d4f|\u4e00\u952e\u4e09\u8fde|\u70b9\u8d5e\u6536\u85cf|\u70b9\u8d5e\u5173\u6ce8|\u6211\u662f.*\u4e00\u540d.*\u7a0b\u5e8f\u5458)/,
      /(\u7559\u8a00\u4e92\u52a8|\u672a\u7ecf\u6388\u6743|\u8f6c\u8f7d\u81ea)/
    ];

    let end = blocks.length;
    while (end > 0) {
      const block = blocks[end - 1];
      const text = cleanInline(String(block).replace(/!\[[^\]]*]\([^)]+\)/g, ""));
      if (!text) {
        end -= 1;
        continue;
      }
      if (tailPatterns.some((pattern) => pattern.test(text)) && text.length < 200) {
        end -= 1;
        continue;
      }
      break;
    }
    return end < blocks.length ? blocks.slice(0, end) : blocks;
  }

  function trimLeadingNonArticleBlocks(blocks) {
    const index = blocks.findIndex((block) => {
      const text = cleanInline(block.replace(/!\[[^\]]*]\([^)]+\)/g, ""));
      if (/^#{1,6}\s+\S+/.test(block)) return true;
      if (/^```/.test(block)) return false;
      if (/^\d+\s*(\u4eba)?\u70b9\u8d5e/.test(text)) return false;
      if (/^[-*]\s*$/.test(text)) return false;
      return text.length >= 40;
    });

    return index > 0 ? blocks.slice(index) : blocks;
  }

  function unwrapProseCodeBlocks(markdown) {
    return String(markdown).replace(/```([a-z0-9_+-]*)\n([\s\S]*?)```/gi, (match, language, code) => {
      // 有语言标签的代码块保持不变
      if (language) return match;
      // 无语言标签时，检查内容是否像代码
      if (looksLikeCodeText(code) || startsWithCodeContent(code)) return match;
      return cleanMarkdown(code);
    });
  }

  const root = findContentRoot();
  const isSelectionRoot =
    root instanceof Element && root.getAttribute && root.getAttribute("data-page-to-markdown-host") === "1";

  let title = document.title || location.hostname || "page";
  if (isSelectionRoot) {
    const firstHeading = root.querySelector("h1, h2, h3");
    if (firstHeading) {
      const headingText = normalizeSpaces(firstHeading.innerText || firstHeading.textContent || "").trim();
      if (headingText) title = headingText.slice(0, 120);
    } else {
      title = `${title} - \u9009\u533a`;
    }
  }

  const escapedTitle = escapeInline(title);
  const savedAt = readableDate();
  const blocks = trimTrailingNonArticleBlocks(trimLeadingNonArticleBlocks(collectBlocks(root)));
  const body = cleanMarkdown(blocks.join("\n\n")).replace(
    new RegExp(`^#\\s+${escapeRegExp(escapedTitle)}\\s*\\n+`),
    ""
  );

  const yamlEscape = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const frontMatter = [
    "---",
    `title: "${yamlEscape(title)}"`,
    `source: "${yamlEscape(location.href)}"`,
    `saved: "${yamlEscape(savedAt)}"`,
    "---",
    "",
    ""
  ].join("\n");

  const header = OPTIONS.includeFrontMatter
    ? `${frontMatter}# ${escapedTitle}\n\n`
    : [`# ${escapedTitle}`, "", `Source: ${location.href}`, `Saved: ${savedAt}`, ""].join("\n");

  const markdown = normalizeMarkdown(unwrapProseCodeBlocks(cleanMarkdown(`${header}${body}`)));

  if (isSelectionRoot && root.parentNode) {
    root.parentNode.removeChild(root);
  }

  return {
    title,
    source: location.href,
    markdown,
    images: __collectedImages
  };
})();
