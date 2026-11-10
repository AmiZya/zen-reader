import { KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ePub from "epubjs";
import "./App.css";
import {
  ClearSession,
  LoadEpubFromPath,
  LoadSession,
  OpenEpubDialog,
  SaveSession,
} from "../wailsjs/go/main/App";
import { BrowserOpenURL } from "../wailsjs/runtime/runtime";
import { main } from "../wailsjs/go/models";

type TocNode = {
  id: string;
  label: string;
  href: string;
  children: TocNode[];
};

type ReaderLocation = {
  start?: {
    href?: string;
    cfi?: string;
  };
};

type SearchMatch = {
  cfi: string;
  excerpt: string;
};

type SpineEntry = {
  id: string;
  base: string;
  target: string;
  label: string;
};

type ThemePreset = "paper" | "sepia" | "night";

type ReaderSettings = {
  fontSize: number;
  lineHeight: number;
  sidePadding: number;
  theme: ThemePreset;
};

const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 19,
  lineHeight: 1.65,
  sidePadding: 8,
  theme: "paper",
};

const SETTINGS_STORAGE_KEY = "zen-reader:settings";

const THEME_STYLES: Record<ThemePreset, { background: string; color: string; link: string; visited: string }> = {
  paper: {
    background: "#f6f1e6",
    color: "#2f2718",
    link: "#8e1f1f",
    visited: "#651616",
  },
  sepia: {
    background: "#efe2c8",
    color: "#3a2c19",
    link: "#8a2a1f",
    visited: "#612018",
  },
  night: {
    background: "#151a22",
    color: "#d7e0ef",
    link: "#d36f6f",
    visited: "#a95757",
  },
};

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, stepName: string): Promise<T> => {
  let timeoutId: number | null = null;

  return new Promise<T>((resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${stepName} timed out after ${Math.floor(timeoutMs / 1000)}s`));
    }, timeoutMs);

    promise
      .then((value) => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        resolve(value);
      })
      .catch((error) => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        reject(error);
      });
  });
};

type EpubContents = {
  document: Document;
};

type EpubBook = {
  ready: Promise<unknown>;
  loaded: {
    navigation: Promise<unknown>;
  };
  navigation?: {
    toc?: unknown[] | null;
  };
  spine?: {
    spineItems?: Array<{ href?: string; canonical?: string; url?: string }>;
  };
  renderTo: (element: Element | string, options?: Record<string, unknown>) => EpubRendition;
  section: (target: string) => EpubSection;
  load: (path: string) => Promise<unknown>;
  resolve?: (path: string, absolute?: boolean) => string;
  archive?: {
    createUrl: (url: string, options?: { base64?: boolean }) => Promise<string>;
  };
  destroy: () => void;
};

type EpubRendition = {
  display: (target?: string) => Promise<unknown>;
  on: (event: string, callback: (location?: ReaderLocation | unknown) => void) => void;
  hooks: {
    content: {
      register: (callback: (contents: EpubContents) => void) => void;
    };
  };
  themes: {
    fontSize: (size: string) => void;
    override: (name: string, value: string) => void;
  };
  annotations?: {
    highlight: (
      cfiRange: string,
      data?: Record<string, unknown>,
      callback?: () => void,
      className?: string,
      styles?: Record<string, string>,
    ) => void;
    remove: (cfiRange: string, type: string) => void;
  };
  getContents: () => EpubContents[];
  destroy: () => void;
};

type EpubSection = {
  load: (request?: (path: string) => Promise<unknown>) => Promise<unknown>;
  find: (query: string) => Array<{ cfi: string; excerpt: string }>;
  unload: () => void;
};

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const SESSION_DEBOUNCE_MS = 600;
const BOOK_OPEN_TIMEOUT_MS = 60000;
const CHAPTER_RENDER_TIMEOUT_MS = 45000;
const TOC_LOAD_TIMEOUT_MS = 20000;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const normalizeHref = (href: string): string => {
  const trimmed = href.trim();
  if (!trimmed) {
    return "";
  }

  const [path, fragment] = trimmed.split("#", 2);
  const normalizedPath = path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^\//, "");

  if (!fragment) {
    return normalizedPath;
  }

  return `${normalizedPath}#${fragment}`;
};

const baseHref = (href: string): string => normalizeHref(href).split("#", 1)[0];

const compareHref = (href: string): string => {
  const normalized = baseHref(href)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .toLowerCase();

  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
};

const hrefFileName = (href: string): string => {
  const compared = compareHref(href);
  return compared.split("/").pop() ?? "";
};

const findSpineEntryForHref = (href: string, entries: SpineEntry[]): SpineEntry | null => {
  const query = compareHref(href);
  if (!query) {
    return null;
  }

  const exact = entries.find((entry) => compareHref(entry.base) === query || compareHref(entry.target) === query);
  if (exact) {
    return exact;
  }

  const suffix = entries.find((entry) => {
    const base = compareHref(entry.base);
    const target = compareHref(entry.target);
    return (
      base.endsWith(`/${query}`) ||
      query.endsWith(`/${base}`) ||
      target.endsWith(`/${query}`) ||
      query.endsWith(`/${target}`)
    );
  });
  if (suffix) {
    return suffix;
  }

  const fileName = hrefFileName(query);
  if (!fileName) {
    return null;
  }

  const fileMatches = entries.filter(
    (entry) => hrefFileName(entry.base) === fileName || hrefFileName(entry.target) === fileName,
  );
  return fileMatches.length === 1 ? fileMatches[0] : null;
};

const resolveToSpineTarget = (href: string, entries: SpineEntry[]): string | null => {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("epubcfi(")) {
    return null;
  }

  const normalized = normalizeHref(trimmed);
  const fragment = normalized.includes("#") ? normalized.split("#").slice(1).join("#") : "";
  const match = findSpineEntryForHref(normalized, entries);
  if (!match) {
    return null;
  }

  const targetBase = match.target.split("#", 1)[0] ?? match.target;
  return fragment ? `${targetBase}#${fragment}` : targetBase;
};

const getString = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.id === "string") {
      return record.id;
    }
  }

  return "Untitled";
};

const parseToc = (raw: unknown[], prefix = "node"): TocNode[] => {
  return raw
    .map((item, index) => {
      const record = item as Record<string, unknown>;
      const href = typeof record.href === "string" ? record.href : "";
      const label = getString(record.label ?? record.title);
      const childrenRaw = Array.isArray(record.subitems) ? record.subitems : [];
      const id = `${prefix}-${index}-${normalizeHref(href)}`;
      return {
        id,
        label,
        href,
        children: parseToc(childrenRaw, id),
      };
    })
    .filter((node) => Boolean(node.href));
};

const labelFromHref = (href: string): string => {
  const normalized = normalizeHref(href);
  const fileName = normalized.split("/").pop() ?? normalized;
  const withoutExt = fileName.replace(/\.[^.]+$/, "");
  const decoded = decodeURIComponent(withoutExt);
  return decoded || "Section";
};

const buildSpineEntries = (
  rawItems: Array<{ href?: string; canonical?: string; url?: string }>,
): SpineEntry[] => {
  return rawItems
    .map((item, index) => {
      const candidates = [item.href, item.canonical, item.url]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

      if (candidates.length === 0) {
        return null;
      }

      const target = candidates[0];
      const normalizedBaseCandidates = candidates
        .map((value) => baseHref(value))
        .filter((value) => value.length > 0);
      const base = normalizedBaseCandidates[0] || baseHref(target) || normalizeHref(target);
      const idSeed = normalizeHref(base || target) || `section-${index + 1}`;

      return {
        id: `spine-${index}-${idSeed}`,
        base,
        target,
        label: `${index + 1}. ${labelFromHref(base || target)}`,
      };
    })
    .filter((entry): entry is SpineEntry => entry !== null);
};

const buildFallbackToc = (spineEntries: SpineEntry[]): TocNode[] => {
  return spineEntries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    href: entry.target,
    children: [],
  }));
};

const ABSOLUTE_ASSET_REF = /^[a-z][a-z0-9+.-]*:|^\/\//i;
const NON_ARCHIVE_ASSET_REF = /^(?:data:|blob:|javascript:|mailto:|tel:)/i;
const EXTERNAL_LINK_REF = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const UNSAFE_LINK_REF = /^(?:javascript:|data:|blob:)/i;

const readLinkHref = (element: Element): string => {
  const hrefBase = (
    element as unknown as {
      href?: {
        baseVal?: string;
      };
    }
  ).href?.baseVal;

  const attrHref = element.getAttribute("href");
  const xlinkHref = element.getAttribute("xlink:href");
  const namespacedHref = element.getAttributeNS("http://www.w3.org/1999/xlink", "href");

  const href =
    (typeof hrefBase === "string" && hrefBase.length > 0 ? hrefBase : null) ??
    attrHref ??
    xlinkHref ??
    namespacedHref ??
    "";

  return href.trim();
};

const toEventElement = (target: EventTarget | null): Element | null => {
  if (!target || typeof target !== "object") {
    return null;
  }

  const asNode = target as {
    nodeType?: number;
    parentElement?: Element | null;
  };

  if (asNode.nodeType === 1) {
    return target as Element;
  }

  if (asNode.parentElement && asNode.parentElement.nodeType === 1) {
    return asNode.parentElement;
  }

  return null;
};

const findLinkElement = (target: EventTarget | null): Element | null => {
  let node = toEventElement(target);

  while (node) {
    const tagName = node.tagName.toLowerCase();
    if (tagName === "a" || tagName === "area") {
      const href = readLinkHref(node);
      if (href.length > 0) {
        return node;
      }
    }

    if (readLinkHref(node).length > 0) {
      return node;
    }

    node = node.parentElement;
  }

  return null;
};

const decodeURIComponentSafe = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const resolveInternalBookTarget = (href: string, doc: Document): string | null => {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || UNSAFE_LINK_REF.test(trimmed)) {
    return null;
  }

  const base = doc.querySelector("base")?.getAttribute("href") ?? doc.baseURI ?? "wails://wails/";

  try {
    const parsed = new URL(trimmed, base);
    if (parsed.protocol.toLowerCase() !== "wails:") {
      return null;
    }

    const path = parsed.pathname.replace(/^\/+/, "");
    if (!path) {
      return parsed.hash || null;
    }

    return parsed.hash ? `${path}${parsed.hash}` : path;
  } catch {
    if (EXTERNAL_LINK_REF.test(trimmed)) {
      return null;
    }
    return trimmed;
  }
};

const routeLinkHref = (
  href: string,
  doc: Document,
  navigate: (target: string) => Promise<void>,
  onError: (message: string) => void,
  event: Event,
) => {
  const tracked = event as Event & { __zenReaderHandledLink?: boolean };
  if (tracked.__zenReaderHandledLink) {
    return;
  }
  tracked.__zenReaderHandledLink = true;

  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") {
    event.stopImmediatePropagation();
  }

  if (href.startsWith("#")) {
    const fragment = href.slice(1);
    const candidates = [fragment, decodeURIComponentSafe(fragment)];
    for (const id of candidates) {
      if (!id) {
        continue;
      }

      const element = doc.getElementById(id);
      if (element) {
        element.scrollIntoView({ block: "start" });
        return;
      }
    }

    void navigate(href).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      onError(`Could not open link: ${message}`);
    });
    return;
  }

  const internalTarget = resolveInternalBookTarget(href, doc);
  if (internalTarget) {
    void navigate(internalTarget).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      onError(`Could not open link: ${message}`);
    });
    return;
  }

  if (EXTERNAL_LINK_REF.test(href) && !href.startsWith("/")) {
    if (UNSAFE_LINK_REF.test(href)) {
      return;
    }

    const externalTarget = href.startsWith("//") ? `https:${href}` : href;
    BrowserOpenURL(externalTarget);
    return;
  }

  void navigate(href).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    onError(`Could not open link: ${message}`);
  });
};

const collectImageCandidates = (rawValue: string, resolve?: (path: string, absolute?: boolean) => string): string[] => {
  const values: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "#" || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    values.push(trimmed);
  };

  add(rawValue);

  try {
    add(decodeURIComponent(rawValue));
  } catch {
    // keep raw value only
  }

  add(encodeURI(rawValue));

  if (!ABSOLUTE_ASSET_REF.test(rawValue) && !rawValue.startsWith("#") && resolve) {
    try {
      add(resolve(rawValue, false));
    } catch {
      // keep local candidates only
    }
  }

  return values;
};

const toArchivePathCandidates = (
  rawValue: string,
  doc: Document,
  resolve?: (path: string, absolute?: boolean) => string,
): string[] => {
  const values: string[] = [];
  const seen = new Set<string>();

  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "#" || NON_ARCHIVE_ASSET_REF.test(trimmed)) {
      return;
    }

    let localPath = trimmed;

    try {
      const parsed = new URL(trimmed);
      localPath = parsed.pathname + parsed.search;
    } catch {
      // keep raw path candidate
    }

    localPath = localPath
      .split("#", 1)[0]
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");

    if (!localPath || ABSOLUTE_ASSET_REF.test(localPath)) {
      return;
    }

    const addVariant = (pathValue: string) => {
      const prefixed = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
      if (!prefixed || seen.has(prefixed)) {
        return;
      }
      seen.add(prefixed);
      values.push(prefixed);
    };

    addVariant(localPath);

    try {
      addVariant(decodeURIComponent(localPath));
    } catch {
      // keep encoded variant only
    }
  };

  add(rawValue);

  if (!ABSOLUTE_ASSET_REF.test(rawValue) && !rawValue.startsWith("#") && resolve) {
    try {
      add(resolve(rawValue, false));
    } catch {
      // keep local candidates only
    }
  }

  const baseHref = doc.querySelector("base")?.getAttribute("href") ?? doc.baseURI;
  if (baseHref) {
    try {
      add(new URL(rawValue, baseHref).toString());
    } catch {
      // ignore invalid URL resolution
    }
  }

  return values;
};

const patchContentImages = async (contents: EpubContents, book: EpubBook): Promise<void> => {
  const doc = contents.document;

  doc
    .querySelectorAll(
      'meta[http-equiv="Content-Security-Policy"], meta[http-equiv="content-security-policy"], meta[http-equiv="Content-Security-Policy-Report-Only"], meta[http-equiv="content-security-policy-report-only"]',
    )
    .forEach((node) => node.remove());

  doc.querySelectorAll("image").forEach((node) => {
    const href = node.getAttribute("href");
    const xlinkHref = node.getAttribute("xlink:href");

    if (href && !xlinkHref) {
      node.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
    }

    if (!href && xlinkHref) {
      node.setAttribute("href", xlinkHref);
    }
  });

  const archiveUrlCache = new Map<string, string | null>();
  const resolveArchiveUrl = async (rawValue: string): Promise<string | null> => {
    if (!book.archive?.createUrl) {
      return null;
    }

    const pathCandidates = toArchivePathCandidates(rawValue, doc, book.resolve);
    for (const candidate of pathCandidates) {
      if (archiveUrlCache.has(candidate)) {
        const cached = archiveUrlCache.get(candidate) ?? null;
        if (cached) {
          return cached;
        }
        continue;
      }

      try {
        const created = await book.archive.createUrl(candidate, { base64: false });
        if (typeof created === "string" && created.length > 0) {
          archiveUrlCache.set(candidate, created);
          return created;
        }
      } catch {
        // try next candidate
      }

      archiveUrlCache.set(candidate, null);
    }

    return null;
  };

  const initialPatches: Array<Promise<void>> = [];
  const imageNodes = doc.querySelectorAll("img");
  imageNodes.forEach((img) => {
    const image = img as HTMLImageElement;
    image.removeAttribute("width");
    image.removeAttribute("height");
    image.style.maxWidth = "100%";
    image.style.width = "auto";
    image.style.height = "auto";
    image.style.objectFit = "contain";

    const currentSrc = image.getAttribute("src") ?? "";
    const firstSrcset = (image.getAttribute("srcset") ?? "").split(",")[0]?.trim().split(/\s+/)[0] ?? "";
    const lazySources = [
      image.getAttribute("data-src") ?? "",
      image.getAttribute("data-lazy-src") ?? "",
      image.getAttribute("data-original") ?? "",
      image.getAttribute("data-url") ?? "",
      image.getAttribute("data-image") ?? "",
      firstSrcset,
    ].filter((value) => value.trim().length > 0);

    const candidateValues: string[] = [];
    const candidateSet = new Set<string>();
    const addCandidate = (value: string) => {
      const candidates = collectImageCandidates(value, book.resolve);
      candidates.forEach((candidate) => {
        if (candidateSet.has(candidate)) {
          return;
        }
        candidateSet.add(candidate);
        candidateValues.push(candidate);
      });
    };

    if (currentSrc) {
      addCandidate(currentSrc);
    }
    lazySources.forEach(addCandidate);

    if (candidateValues.length === 0) {
      return;
    }

    if (!currentSrc) {
      image.setAttribute("src", candidateValues[0]);
    }

    if (image.dataset.zenReaderImagePatched === "1") {
      return;
    }
    image.dataset.zenReaderImagePatched = "1";

    const attemptedValues = new Set<string>();
    let candidateIndex = Math.max(0, candidateValues.indexOf(image.getAttribute("src") ?? ""));

    const tryArchiveFallback = async (): Promise<boolean> => {
      for (const candidate of candidateValues) {
        const resolved = await resolveArchiveUrl(candidate);
        if (!resolved || attemptedValues.has(resolved)) {
          continue;
        }

        attemptedValues.add(resolved);
        if (resolved !== image.getAttribute("src")) {
          image.setAttribute("src", resolved);
          return true;
        }
      }

      return false;
    };

    const handleLoadError = () => {
      while (candidateIndex + 1 < candidateValues.length) {
        candidateIndex += 1;
        const next = candidateValues[candidateIndex];
        if (next !== image.getAttribute("src")) {
          attemptedValues.add(next);
          image.setAttribute("src", next);
          return;
        }
      }

      void tryArchiveFallback();
    };

    image.addEventListener("error", handleLoadError);

    const current = image.getAttribute("src") ?? "";
    if (current.length > 0 && !NON_ARCHIVE_ASSET_REF.test(current)) {
      initialPatches.push(
        (async () => {
          const resolved = await resolveArchiveUrl(current);
          if (resolved && resolved !== image.getAttribute("src")) {
            attemptedValues.add(resolved);
            image.setAttribute("src", resolved);
          }
        })(),
      );
    }

    if (image.complete && typeof image.naturalWidth !== "undefined" && image.naturalWidth === 0) {
      handleLoadError();
    }
  });

  if (initialPatches.length > 0) {
    await Promise.allSettled(initialPatches);
  }
};

const bindContentLinks = (
  contents: EpubContents,
  navigate: (target: string) => Promise<void>,
  onError: (message: string) => void,
) => {
  const doc = contents.document;

  doc.querySelectorAll("a, area").forEach((node) => {
    node.setAttribute("target", "_self");
    if (node.getAttribute("data-zen-reader-link-bound") === "1") {
      return;
    }
    node.setAttribute("data-zen-reader-link-bound", "1");

    node.addEventListener(
      "click",
      (event) => {
        const href = readLinkHref(node);
        if (!href) {
          return;
        }
        routeLinkHref(href, doc, navigate, onError, event);
      },
      true,
    );
  });

  if ((doc as Document & { __zenReaderLinksBound?: string }).__zenReaderLinksBound === "1") {
    return;
  }
  (doc as Document & { __zenReaderLinksBound?: string }).__zenReaderLinksBound = "1";

  doc.addEventListener(
    "click",
    (event) => {
      const linkElement = findLinkElement(event.target);
      if (!linkElement) {
        return;
      }

      const href = readLinkHref(linkElement);
      if (!href) {
        return;
      }

      routeLinkHref(href, doc, navigate, onError, event);
    },
    true,
  );
};

const findPathToBase = (nodes: TocNode[], targetBase: string, path: string[] = []): string[] | null => {
  for (const node of nodes) {
    const nodeBase = baseHref(node.href);
    const nextPath = [...path, node.id];

    if (nodeBase === targetBase) {
      return nextPath;
    }

    const nested = findPathToBase(node.children, targetBase, nextPath);
    if (nested) {
      return nested;
    }
  }

  return null;
};

const applyContentSettings = (contents: EpubContents, settings: ReaderSettings) => {
  const doc = contents.document;
  const body = doc.body;
  if (!body) {
    return;
  }

  const theme = THEME_STYLES[settings.theme];

  const style = body.style;
  style.fontSize = `${settings.fontSize}px`;
  style.lineHeight = `${settings.lineHeight}`;
  style.paddingLeft = `${settings.sidePadding}%`;
  style.paddingRight = `${settings.sidePadding}%`;
  style.marginTop = "0";
  style.marginBottom = "0";
  style.background = theme.background;
  style.color = theme.color;

  const overrideId = "zen-reader-color-normalize";
  const selector = [
    "p",
    "span",
    "div",
    "li",
    "dd",
    "dt",
    "td",
    "th",
    "blockquote",
    "figcaption",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "em",
    "strong",
    "small",
    "code",
    "pre",
  ].join(", ");

  let override = doc.getElementById(overrideId) as HTMLStyleElement | null;
  if (!override) {
    override = doc.createElement("style");
    override.id = overrideId;
    doc.head.appendChild(override);
  }

  override.textContent = `
    :root, body {
      color: ${theme.color} !important;
      background: ${theme.background} !important;
    }
    ${selector} {
      color: ${theme.color} !important;
    }
    a:not([href]), a:not([href]) * {
      color: ${theme.color} !important;
      text-decoration: none !important;
    }
    a[href], a[href] * {
      color: ${theme.link} !important;
      text-decoration-color: ${theme.link} !important;
      text-decoration-thickness: 1px !important;
    }
    a[href]:visited, a[href]:visited * {
      color: ${theme.visited} !important;
      text-decoration-color: ${theme.visited} !important;
    }
    img, svg, video, canvas, picture {
      max-width: 100% !important;
      height: auto !important;
    }
    img {
      width: auto !important;
      max-height: 78vh !important;
      object-fit: contain !important;
      display: block;
      margin-inline: auto;
    }
    svg {
      max-height: 78vh !important;
      overflow: visible !important;
    }
    figure {
      max-width: 100% !important;
      margin-inline: auto;
    }
  `;
};

const loadSettingsFromStorage = (): ReaderSettings => {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    return {
      fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : DEFAULT_SETTINGS.fontSize,
      lineHeight: typeof parsed.lineHeight === "number" ? parsed.lineHeight : DEFAULT_SETTINGS.lineHeight,
      sidePadding: typeof parsed.sidePadding === "number" ? parsed.sidePadding : DEFAULT_SETTINGS.sidePadding,
      theme:
        parsed.theme === "paper" || parsed.theme === "sepia" || parsed.theme === "night"
          ? parsed.theme
          : DEFAULT_SETTINGS.theme,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
};

function App() {
  const readerHostRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const bookRef = useRef<EpubBook | null>(null);
  const renditionRef = useRef<EpubRendition | null>(null);
  const openBookRef = useRef<main.EpubPayload | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const previousChapterRef = useRef("");
  const highlightedCfisRef = useRef<string[]>([]);
  const spineEntriesRef = useRef<SpineEntry[]>([]);
  const settingsRef = useRef<ReaderSettings>(DEFAULT_SETTINGS);
  const paintSearchHighlightsRef = useRef<() => void>(() => {});

  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [isDragging, setIsDragging] = useState(false);
  const [statusText, setStatusText] = useState("Open an EPUB to begin reading.");
  const [errorText, setErrorText] = useState("");
  const [tocTree, setTocTree] = useState<TocNode[]>([]);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(new Set());
  const [currentChapterBase, setCurrentChapterBase] = useState("");
  const [currentCfi, setCurrentCfi] = useState("");
  const [spineEntries, setSpineEntries] = useState<SpineEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchIndex, setSearchIndex] = useState(-1);
  const [readerSettings, setReaderSettings] = useState<ReaderSettings>(() => loadSettingsFromStorage());
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);

  useEffect(() => {
    settingsRef.current = readerSettings;
  }, [readerSettings]);

  useEffect(() => {
    spineEntriesRef.current = spineEntries;
  }, [spineEntries]);

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const clearSearchHighlights = useCallback(() => {
    const annotations = renditionRef.current?.annotations;
    if (annotations && highlightedCfisRef.current.length > 0) {
      highlightedCfisRef.current.forEach((cfi) => {
        try {
          annotations.remove(cfi, "highlight");
        } catch {
          // Keep going, stale highlights may fail removal.
        }
      });
    }
    highlightedCfisRef.current = [];

    const contents = renditionRef.current?.getContents() ?? [];
    contents.forEach((content) => {
      const nodes = content.document.querySelectorAll("mark.zen-search-hit");
      nodes.forEach((node) => {
        const parent = node.parentNode;
        if (!parent) {
          return;
        }
        while (node.firstChild) {
          parent.insertBefore(node.firstChild, node);
        }
        parent.removeChild(node);
      });
    });
  }, []);

  const applySettingsToVisibleContents = useCallback(() => {
    const contents = renditionRef.current?.getContents() ?? [];
    contents.forEach((content) => applyContentSettings(content, readerSettings));

    const themes = renditionRef.current?.themes;
    if (themes) {
      themes.fontSize(`${readerSettings.fontSize}px`);
      themes.override("line-height", `${readerSettings.lineHeight}`);
      themes.override("padding-left", `${readerSettings.sidePadding}%`);
      themes.override("padding-right", `${readerSettings.sidePadding}%`);
      themes.override("background", THEME_STYLES[readerSettings.theme].background);
      themes.override("color", THEME_STYLES[readerSettings.theme].color);
      themes.override("text-rendering", "optimizeLegibility");
    }
  }, [readerSettings]);

  const paintSearchHighlights = useCallback(() => {
    clearSearchHighlights();
    const contents = renditionRef.current?.getContents() ?? [];
    if (contents.length === 0 || searchMatches.length === 0) {
      return;
    }

    const annotations = renditionRef.current?.annotations;
    if (annotations) {
      highlightedCfisRef.current = [];
      searchMatches.forEach((match) => {
        try {
          annotations.highlight(match.cfi, {}, undefined, "zen-search-hit", {
            fill: "#f7d983",
            "fill-opacity": "0.45",
            "mix-blend-mode": "multiply",
          });
          highlightedCfisRef.current.push(match.cfi);
        } catch {
          // Fall back to mark wrapping below.
        }
      });
      return;
    }

    contents.forEach((content) => {
      const doc = content.document;
      searchMatches.forEach((match) => {
        try {
          const rangeResult = (bookRef.current as unknown as { getRange?: (cfi: string) => Range | null })?.getRange?.(
            match.cfi,
          );
          const range = rangeResult && rangeResult.startContainer.ownerDocument === doc ? rangeResult : null;
          if (!range || range.collapsed) {
            return;
          }

          const wrapper = doc.createElement("mark");
          wrapper.className = "zen-search-hit";
          range.surroundContents(wrapper);
        } catch {
          // Ignore ranges that cannot be surrounded.
        }
      });
    });
  }, [clearSearchHighlights, searchMatches]);

  useEffect(() => {
    paintSearchHighlightsRef.current = paintSearchHighlights;
  }, [paintSearchHighlights]);

  const scheduleSessionSave = useCallback(
    (chapterHref: string, cfi: string) => {
      const currentBook = openBookRef.current;
      if (!currentBook) {
        return;
      }

      clearSaveTimer();

      saveTimerRef.current = window.setTimeout(() => {
        const payload = {
          bookPath: currentBook.path,
          bookHash: currentBook.bookHash,
          chapterHref,
          cfi,
          updatedAt: "",
        };

        SaveSession(payload).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setErrorText(`Could not save reading session: ${message}`);
        });
      }, SESSION_DEBOUNCE_MS);
    },
    [clearSaveTimer],
  );

  const destroyReader = useCallback(() => {
    clearSaveTimer();
    clearSearchHighlights();

    if (renditionRef.current) {
      renditionRef.current.destroy();
      renditionRef.current = null;
    }

    if (bookRef.current) {
      bookRef.current.destroy();
      bookRef.current = null;
    }

    if (readerHostRef.current) {
      readerHostRef.current.innerHTML = "";
    }
  }, [clearSaveTimer, clearSearchHighlights]);

  const resetSearch = useCallback(() => {
    clearSearchHighlights();
    setSearchMatches([]);
    setSearchIndex(-1);
  }, [clearSearchHighlights]);

  const updateLocation = useCallback(
    (location?: ReaderLocation | unknown) => {
      const record = (location ?? {}) as ReaderLocation;
      const start = record.start;
      const href = typeof start?.href === "string" ? start.href : "";
      const cfi = typeof start?.cfi === "string" ? start.cfi : "";

      const chapter = baseHref(href);
      setCurrentChapterBase(chapter);
      setCurrentCfi(cfi);
      if (chapter) {
        scheduleSessionSave(chapter, cfi);
      }
    },
    [scheduleSessionSave],
  );

  const autoExpandForActiveChapter = useCallback((tree: TocNode[], chapterBase: string) => {
    const path = findPathToBase(tree, chapterBase);
    if (!path || path.length === 0) {
      return;
    }

    const keepExpanded = new Set(path.slice(0, -1));
    setCollapsedNodeIds((previous) => {
      const next = new Set(previous);
      keepExpanded.forEach((nodeId) => next.delete(nodeId));
      return next;
    });
  }, []);

  const loadBook = useCallback(
    async (payload: main.EpubPayload, restoreSession?: main.SessionState | null) => {
      if (!readerHostRef.current) {
        throw new Error("Reader host is unavailable");
      }

      destroyReader();
      setErrorText("");
      setStatusText(`Loading ${payload.name}...`);
      setSearchQuery("");
      resetSearch();
      setTocTree([]);
      setCollapsedNodeIds(new Set());
      setSpineEntries([]);
      setCurrentChapterBase("");
      setCurrentCfi("");
      openBookRef.current = payload;

      const book = ePub(payload.url, {
        openAs: "epub",
        replacements: "blobUrl",
      }) as unknown as EpubBook;

      bookRef.current = book;

      setStatusText(`Opening ${payload.name}...`);
      try {
        await withTimeout(book.ready, BOOK_OPEN_TIMEOUT_MS, "Opening EPUB (ready stage)");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Open stage failed: ${message}`);
      }

      const rawSpineItems = book.spine?.spineItems;
      const spineItems = Array.isArray(rawSpineItems) ? rawSpineItems : [];
      const parsedSpineEntries = buildSpineEntries(spineItems);

      setSpineEntries(parsedSpineEntries);
      spineEntriesRef.current = parsedSpineEntries;
      setTocTree(buildFallbackToc(parsedSpineEntries));

      const rendition = book.renderTo(readerHostRef.current, {
        width: "100%",
        height: "100%",
        method: "default",
        flow: "scrolled-doc",
        spread: "none",
        allowScriptedContent: false,
      });

      rendition.hooks.content.register(async (contents) => {
        await patchContentImages(contents, book);
        bindContentLinks(contents, displayTarget, (message) => setErrorText(message));
        applyContentSettings(contents, settingsRef.current);
      });

      rendition.on("rendered", () => {
        const visible = rendition.getContents();
        visible.forEach((content) => applyContentSettings(content, settingsRef.current));
        paintSearchHighlightsRef.current();
      });

      rendition.on("relocated", updateLocation);
      renditionRef.current = rendition;

      const sameBook =
        restoreSession &&
        restoreSession.bookHash.length > 0 &&
        restoreSession.bookHash === payload.bookHash;

      const restoreChapterBase =
        sameBook && typeof restoreSession?.chapterHref === "string"
          ? baseHref(restoreSession.chapterHref)
          : "";
      const restoreSpineTarget = restoreChapterBase
        ? parsedSpineEntries.find((entry) => entry.base === restoreChapterBase)?.target
        : undefined;
      const restoreTarget =
        (sameBook ? restoreSession?.cfi || restoreSpineTarget || restoreSession?.chapterHref : undefined) || undefined;
      const firstSpineTarget = parsedSpineEntries[0]?.target;
      const renderAttempts: Array<{ stage: string; target?: string }> = [];

      if (restoreTarget) {
        renderAttempts.push({
          stage: "restore target",
          target: restoreTarget,
        });
      }

      if (firstSpineTarget && firstSpineTarget !== restoreTarget) {
        renderAttempts.push({
          stage: "first spine section",
          target: firstSpineTarget,
        });
      }

      renderAttempts.push({ stage: "default section" });

      setStatusText(`Rendering ${payload.name}...`);
      const renderErrors: string[] = [];
      let rendered = false;

      for (const attempt of renderAttempts) {
        try {
          if (attempt.target) {
            await withTimeout(
              rendition.display(attempt.target),
              CHAPTER_RENDER_TIMEOUT_MS,
              `Rendering chapter (${attempt.stage})`,
            );
          } else {
            await withTimeout(rendition.display(), CHAPTER_RENDER_TIMEOUT_MS, "Rendering chapter (default)");
          }
          rendered = true;
          break;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          renderErrors.push(`${attempt.stage}: ${message}`);
        }
      }

      if (!rendered) {
        const details = renderErrors.length > 0 ? renderErrors.join(" | ") : "unknown render error";
        throw new Error(`Render stage failed: ${details}`);
      }

      void withTimeout(book.loaded.navigation, TOC_LOAD_TIMEOUT_MS, "Loading table of contents")
        .then(() => {
          const tocItems = book.navigation?.toc;
          const parsedToc = parseToc(Array.isArray(tocItems) ? tocItems : []);
          if (parsedToc.length > 0) {
            setTocTree(parsedToc);
          }
        })
        .catch(() => {
          setStatusText(`${payload.name} (TOC fallback mode)`);
        });

      setStatusText(payload.name);
    },
    [
      destroyReader,
      resetSearch,
      updateLocation,
    ],
  );

  const openBookFromDialog = useCallback(async () => {
    try {
      setErrorText("");
      const selected = await OpenEpubDialog();
      if (!selected) {
        setStatusText("Open canceled.");
        return;
      }

      await loadBook(selected, null);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(`Could not open EPUB: ${message}`);
    }
  }, [loadBook]);

  const currentSpineIndex = useMemo(() => {
    if (!currentChapterBase) {
      return -1;
    }
    return spineEntries.findIndex((entry) => entry.base === currentChapterBase);
  }, [currentChapterBase, spineEntries]);

  const currentSpineEntry = useMemo(() => {
    if (currentSpineIndex < 0) {
      return null;
    }
    return spineEntries[currentSpineIndex] ?? null;
  }, [currentSpineIndex, spineEntries]);

  const canGoToPreviousChapter = currentSpineIndex > 0;
  const canGoToNextChapter = currentSpineIndex >= 0 && currentSpineIndex < spineEntries.length - 1;

  const displayTarget = useCallback(async (target: string) => {
    const rendition = renditionRef.current;
    if (!rendition) {
      return;
    }

    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (value: string | null) => {
      if (!value) {
        return;
      }
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) {
        return;
      }
      seen.add(trimmed);
      candidates.push(trimmed);
    };

    addCandidate(target);
    addCandidate(resolveToSpineTarget(target, spineEntriesRef.current));

    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        await rendition.display(candidate);
        return;
      } catch (error: unknown) {
        lastError = error;
      }
    }

    if (lastError instanceof Error) {
      if (candidates.length > 1) {
        throw new Error(`${lastError.message} (resolved from TOC: ${candidates.join(" -> ")})`);
      }
      throw lastError;
    }

    throw new Error("Unknown section navigation error");
  }, []);

  const goToPreviousChapter = useCallback(async () => {
    if (!canGoToPreviousChapter) {
      return;
    }
    const previousTarget = spineEntries[currentSpineIndex - 1]?.target;
    if (!previousTarget) {
      return;
    }
    await displayTarget(previousTarget);
  }, [canGoToPreviousChapter, currentSpineIndex, displayTarget, spineEntries]);

  const goToNextChapter = useCallback(async () => {
    if (!canGoToNextChapter) {
      return;
    }
    const nextTarget = spineEntries[currentSpineIndex + 1]?.target;
    if (!nextTarget) {
      return;
    }
    await displayTarget(nextTarget);
  }, [canGoToNextChapter, currentSpineIndex, displayTarget, spineEntries]);

  const runInChapterSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query) {
      resetSearch();
      return;
    }

    if (!bookRef.current || !renditionRef.current || !currentChapterBase) {
      return;
    }

    try {
      const sectionTarget = currentSpineEntry?.target || currentChapterBase;
      const section = bookRef.current.section(sectionTarget);
      await section.load(bookRef.current.load.bind(bookRef.current));
      const matches = section.find(query).map((entry) => ({
        cfi: entry.cfi,
        excerpt: entry.excerpt,
      }));
      section.unload();

      setSearchMatches(matches);
      if (matches.length === 0) {
        setSearchIndex(-1);
        clearSearchHighlights();
        return;
      }

      setSearchIndex(0);
      await renditionRef.current.display(matches[0].cfi);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(`Search failed: ${message}`);
    }
  }, [clearSearchHighlights, currentChapterBase, currentSpineEntry, resetSearch, searchQuery]);

  const goToMatch = useCallback(
    async (delta: number) => {
      if (!renditionRef.current || searchMatches.length === 0) {
        return;
      }

      const nextIndex =
        searchIndex < 0
          ? 0
          : (searchIndex + delta + searchMatches.length) % searchMatches.length;

      setSearchIndex(nextIndex);
      await renditionRef.current.display(searchMatches[nextIndex].cfi);
    },
    [searchIndex, searchMatches],
  );

  const adjustFontSize = useCallback((delta: number) => {
    setReaderSettings((prev) => ({
      ...prev,
      fontSize: clamp(prev.fontSize + delta, 14, 30),
    }));
  }, []);

  const adjustLineHeight = useCallback((delta: number) => {
    setReaderSettings((prev) => ({
      ...prev,
      lineHeight: clamp(Number((prev.lineHeight + delta).toFixed(2)), 1.2, 2.1),
    }));
  }, []);

  const adjustMargin = useCallback((delta: number) => {
    setReaderSettings((prev) => ({
      ...prev,
      sidePadding: clamp(prev.sidePadding + delta, 2, 16),
    }));
  }, []);

  const handleClearSession = useCallback(() => {
    ClearSession()
      .then(() => setStatusText("Session cleared."))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setErrorText(`Could not clear session: ${message}`);
      });
  }, []);

  const toggleNode = useCallback((nodeId: string) => {
    setCollapsedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const renderTocNodes = useCallback(
    (nodes: TocNode[], depth = 0): JSX.Element[] => {
      return nodes.flatMap((node) => {
        const normalizedNodeBase = baseHref(node.href);
        const isActive = normalizedNodeBase === currentChapterBase;
        const hasActiveDescendant = findPathToBase(node.children, currentChapterBase) !== null;
        const isCollapsed = collapsedNodeIds.has(node.id);
        const hasChildren = node.children.length > 0;

        const row = (
          <div key={node.id} className={`toc-branch ${hasActiveDescendant ? "branch-active" : ""}`}>
            <button
              className={`toc-row ${isActive ? "active" : ""} ${hasActiveDescendant ? "active-path" : ""}`}
              style={{ paddingLeft: `${12 + depth * 16}px` }}
              onClick={() => {
                setErrorText("");
                displayTarget(node.href).catch((error: unknown) => {
                  const message = error instanceof Error ? error.message : String(error);
                  setErrorText(`Could not open section: ${message}`);
                });
              }}
            >
              <span
                className={`toc-caret ${hasChildren ? "visible" : "hidden"}`}
                onClick={(event) => {
                  if (!hasChildren) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  toggleNode(node.id);
                }}
                role={hasChildren ? "button" : undefined}
                tabIndex={hasChildren ? 0 : -1}
              >
                {hasChildren ? (isCollapsed ? "▸" : "▾") : ""}
              </span>
              <span className="toc-label">{node.label}</span>
            </button>
            {hasChildren && !isCollapsed ? renderTocNodes(node.children, depth + 1) : null}
          </div>
        );

        return [row];
      });
    },
    [collapsedNodeIds, currentChapterBase, displayTarget, toggleNode],
  );

  useEffect(() => {
    let mounted = true;

    const restoreLastSession = async () => {
      try {
        const session = await LoadSession();
        if (!session || !session.bookPath) {
          return;
        }

        const payload = await LoadEpubFromPath(session.bookPath);
        if (mounted) {
          await loadBook(payload, session);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (mounted) {
          setErrorText(`Session restore failed: ${message}`);
        }
      }
    };

    restoreLastSession();

    return () => {
      mounted = false;
      destroyReader();
    };
  }, [destroyReader, loadBook]);

  useEffect(() => {
    if (!currentChapterBase || tocTree.length === 0) {
      return;
    }
    autoExpandForActiveChapter(tocTree, currentChapterBase);
  }, [autoExpandForActiveChapter, currentChapterBase, tocTree]);

  useEffect(() => {
    if (!currentChapterBase) {
      previousChapterRef.current = "";
      return;
    }

    if (previousChapterRef.current !== "" && previousChapterRef.current !== currentChapterBase) {
      resetSearch();
    }

    previousChapterRef.current = currentChapterBase;
  }, [currentChapterBase, resetSearch]);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const onMouseMove = (event: MouseEvent) => {
      const nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, Math.floor(event.clientX)),
      );
      setSidebarWidth(nextWidth);
    };

    const onMouseUp = () => setIsDragging(false);

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        void goToPreviousChapter();
        return;
      }

      if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        void goToNextChapter();
        return;
      }

      if (event.key === "Escape") {
        setShowSettingsPanel(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goToNextChapter, goToPreviousChapter]);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(readerSettings));
    applySettingsToVisibleContents();
  }, [applySettingsToVisibleContents, readerSettings]);

  useEffect(() => {
    paintSearchHighlights();
  }, [paintSearchHighlights, searchMatches, searchIndex]);

  return (
    <div id="app-shell" className={`theme-${readerSettings.theme}`}>
      <header className="top-bar">
        <div className="top-group">
          <button className="action-btn primary" onClick={() => void openBookFromDialog()}>
            Open EPUB
          </button>
          <button
            className="action-btn"
            onClick={() => void goToPreviousChapter()}
            disabled={!canGoToPreviousChapter}
          >
            Prev Chapter
          </button>
          <button
            className="action-btn"
            onClick={() => void goToNextChapter()}
            disabled={!canGoToNextChapter}
          >
            Next Chapter
          </button>
        </div>

        <div className="top-group search">
          <input
            ref={searchInputRef}
            className="search-input"
            value={searchQuery}
            placeholder="Search chapter"
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void runInChapterSearch();
              }
            }}
          />
          <button className="action-btn compact" onClick={() => void runInChapterSearch()}>
            Go
          </button>
          <button
            className="action-btn compact"
            disabled={searchMatches.length === 0}
            onClick={() => void goToMatch(-1)}
          >
            ◀
          </button>
          <button
            className="action-btn compact"
            disabled={searchMatches.length === 0}
            onClick={() => void goToMatch(1)}
          >
            ▶
          </button>
          <span className="search-count">
            {searchMatches.length > 0 ? `${searchIndex + 1}/${searchMatches.length}` : "0/0"}
          </span>
        </div>

        <div className="top-group utility">
          <button
            className={`action-btn compact ${showSettingsPanel ? "active" : ""}`}
            onClick={() => setShowSettingsPanel((current) => !current)}
          >
            Reader
          </button>
        </div>
      </header>

      <div className="sr-status" aria-live="polite">
        {statusText}
      </div>

      {showSettingsPanel ? (
        <section className="settings-popover">
          <label className="settings-item">
            <span>Font</span>
            <button className="mini-btn" onClick={() => adjustFontSize(-1)} aria-label="Decrease font size">
              -
            </button>
            <strong>{readerSettings.fontSize}px</strong>
            <button className="mini-btn" onClick={() => adjustFontSize(1)} aria-label="Increase font size">
              +
            </button>
          </label>

          <label className="settings-item">
            <span>Line</span>
            <button className="mini-btn" onClick={() => adjustLineHeight(-0.05)} aria-label="Decrease line height">
              -
            </button>
            <strong>{readerSettings.lineHeight.toFixed(2)}</strong>
            <button className="mini-btn" onClick={() => adjustLineHeight(0.05)} aria-label="Increase line height">
              +
            </button>
          </label>

          <label className="settings-item">
            <span>Margin</span>
            <button className="mini-btn" onClick={() => adjustMargin(-1)} aria-label="Decrease side margin">
              -
            </button>
            <strong>{readerSettings.sidePadding}%</strong>
            <button className="mini-btn" onClick={() => adjustMargin(1)} aria-label="Increase side margin">
              +
            </button>
          </label>

          <label className="theme-select-wrap">
            <span>Theme</span>
            <select
              value={readerSettings.theme}
              onChange={(event) =>
                setReaderSettings((prev) => ({
                  ...prev,
                  theme: event.target.value as ThemePreset,
                }))
              }
            >
              <option value="paper">Paper</option>
              <option value="sepia">Sepia</option>
              <option value="night">Night</option>
            </select>
          </label>

          <button className="action-btn link clear-session-inline" onClick={handleClearSession}>
            Clear Session
          </button>
        </section>
      ) : null}

      {errorText ? <div className="error-strip">{errorText}</div> : null}

      <div className="content-shell">
        <aside className="toc-pane" style={{ width: `${sidebarWidth}px` }}>
          <div className="pane-title">Contents</div>
          <div className="toc-scroll">
            {tocTree.length === 0 ? (
              <div className="empty-message">No table of contents loaded.</div>
            ) : (
              renderTocNodes(tocTree)
            )}
          </div>
        </aside>

        <div
          className={`splitter ${isDragging ? "dragging" : ""}`}
          onMouseDown={() => setIsDragging(true)}
        />

        <main className="reader-pane">
          <div ref={readerHostRef} className="reader-host" />
          {searchMatches.length > 0 && searchIndex >= 0 ? (
            <div className="search-excerpt">{searchMatches[searchIndex].excerpt}</div>
          ) : null}
          {currentCfi ? <div className="cfi-pill">{currentCfi}</div> : null}
        </main>
      </div>
    </div>
  );
}

export default App;
