const express = require("express");
const dns = require("dns").promises;
const url = require("url");
const zlib = require("zlib");
const fs = require("fs");
const WebSocket = require('ws');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration constants
const DNS_TIMEOUT = 2000;
const DNS_RETRIES = 2;
const CACHE_TTL = 300000; // 5 minutes in milliseconds
const MAX_REDIRECTS = 5;
const MAX_RETRIES = 3;

// In-memory caches (in production, consider using Redis)
const dnsCache = new Map();
const failedDomains = new Map();

// Request tracking to prevent infinite loops
const requestTracker = new Map();

// Middleware for parsing request bodies
app.use(express.json({ limit: "50mb" })); // For JSON payloads
app.use(express.urlencoded({ extended: true, limit: "50mb" })); // For form data
app.use(express.raw({ type: "*/*", limit: "50mb" })); // For other content types

// Helper function to get common headers
function getCommonHeaders(target, originalHeaders = {}, hasBody = false) {
  const headers = {
    Host: target,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Ch-Ua":
      '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
    "X-Forwarded-For": originalHeaders["x-forwarded-for"] || "127.0.0.1",
    "X-Forwarded-Proto": "https",
  };

  // Only preserve important headers when appropriate
  if (originalHeaders["cookie"]) {
    headers["Cookie"] = originalHeaders["cookie"];
  }

  // Only include content-type for requests with body
  if (hasBody && originalHeaders["content-type"]) {
    headers["Content-Type"] = originalHeaders["content-type"];
  }

  return headers;
}

// DNS resolution with caching and failure tracking
async function resolveDomain(domain) {
  // Check cache first
  const cached = dnsCache.get(domain);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.ip;
  }

  // Check failed domains
  const failed = failedDomains.get(domain);
  if (failed && failed.count > 3 && Date.now() - failed.time < 10000) {
    throw new Error("Failed to resolve domain after " + failed.count + " attempts");
  }

  try {
    const addresses = await dns.resolve4(domain);
    if (addresses && addresses.length > 0) {
      const ip = addresses[0];
      dnsCache.set(domain, { ip: ip, timestamp: Date.now() });
      // Clear any failure records
      failedDomains.delete(domain);
      return ip;
    }
    throw new Error("No A records found");
  } catch (error) {
    // Track failures
    const currentFailed = failedDomains.get(domain) || {
      count: 0,
      time: Date.now(),
    };
    failedDomains.set(domain, {
      count: currentFailed.count + 1,
      time: Date.now(),
    });
    throw error;
  }
}

// Function to check if content looks like HTML
function looksLikeHTML(body) {
  if (!body) return false;

  const patterns = [
    /^\s*<!DOCTYPE/i,
    /^\s*<html/i,
    /<head[^>]*>/i,
    /<body[^>]*>/i,
    /<div[^>]*>/i,
    /<script[^>]*>/i,
    /<meta[^>]*>/i,
    /<title[^>]*>/i,
    /<link[^>]*>/i,
  ];

  const checkText = body.toString().substring(0, 1000).toLowerCase();
  return patterns.some(function(pattern) { return pattern.test(checkText); });
}

function rewriteLocationHeader(location, target, proxyHost, protocol) {
  if (!location) return null;

  console.log("🔍 DEBUGGING: Original Location header:", location);

  // If it's a full URL, rewrite it completely
  if (location.match(/^https?:\/\//)) {
    try {
      const locationUrl = new URL(location);
      console.log(
        "🔍 DEBUGGING: Parsed Location URL - host:",
        locationUrl.host,
        "pathname:",
        locationUrl.pathname
      );

      // CRITICAL: Block any redirects to the target domain
      if (locationUrl.host === target) {
        console.log(
          "🛡️ CRITICAL: Blocked redirect to target domain:",
          location
        );
        const separator = (locationUrl.pathname + locationUrl.search).includes(
          "?"
        )
          ? "&"
          : "?";
        const newLocation = protocol + "://" + proxyHost + locationUrl.pathname + locationUrl.search + separator + "hmtarget=" + target + "&hmtype=1";
        console.log("🔍 DEBUGGING: Rewritten Location:", newLocation);
        return newLocation;
      }
    } catch (e) {
      console.log("🔍 DEBUGGING: Error parsing Location URL:", e);
    }
  } else if (location.startsWith("/")) {
    // Relative URL
    const separator = location.includes("?") ? "&" : "?";
    const newLocation = protocol + "://" + proxyHost + location + separator + "hmtarget=" + target + "&hmtype=1";
    console.log("🔍 DEBUGGING: Rewritten relative Location:", newLocation);
    return newLocation;
  }

  console.log("🔍 DEBUGGING: Location unchanged:", location);
  return location;
}

async function getSiteSpecificScriptContent(fileName) {
  try {
    const scriptPath = require("path").join(
      __dirname,
      "site-specific-scripts",
      fileName
    );
    const scriptContent = await fs.promises.readFile(scriptPath, "utf8");
    return "<script>" + scriptContent + "</script>";
  } catch (e) {
    console.error("Failed to load " + fileName + ":", e);
    return "";
  }
}

// =================
// ORIGINAL IMPLEMENTATION (hmtype=1)
// =================

// FIXED: URL rewriting function with loop prevention (ORIGINAL)
async function rewriteUrls(
  body,
  target,
  proxyHost,
  protocol,
  fileType
) {
  if (!body) return body;

  let content = body.toString();

  console.log("=== Starting Original URL Rewriting ===");
  console.log(
    "Input target:",
    target,
    "Input proxyHost:",
    proxyHost,
    "Protocol:",
    protocol
  );

  let siteSpecificScript = "";

  if (target && target.includes("buddynutrition")) {
    siteSpecificScript = "<script>\n      window.T4Srequest = {};\n      window.T4Sroutes = {};\n    </script>";
  } else if (target && target.includes("carnivoresnax")) {
      siteSpecificScript = await getSiteSpecificScriptContent("carnivoresnacks.js");
  } else if (target && target.includes("byltbasics")) {
    siteSpecificScript = await getSiteSpecificScriptContent("byltbasics.js");
  }

  const domainLockScript = "\n<script>\n(function() {\n    'use strict';\n    \n    // ENHANCED: Multiple-layer protection approach\n    console.log('🛡️ SUPER EARLY DOMAIN LOCK ACTIVATED');\n    console.log('🛡️ Current location:', window.location.href);\n    console.log('🛡️ Current host:', window.location.host);\n    console.log('🛡️ Current hostname:', window.location.hostname);\n    \n    const TARGET_DOMAIN = '" + target + "';\n    const PROXY_HOST = '" + proxyHost + "';\n    const PROXY_PROTOCOL = '" + protocol + ":';\n    \n    // STRATEGY 1: Override critical location methods immediately\n    const originalAssign = window.location.assign;\n    const originalReplace = window.location.replace;\n    \n    \n    // STRATEGY 3: Override document.domain\n    try {\n        Object.defineProperty(document, 'domain', {\n            get: function() { return PROXY_HOST.split(':')[0]; },\n            set: function(value) {\n                console.warn('🛡️ BLOCKED document.domain set to:', value);\n                return PROXY_HOST.split(':')[0];\n            },\n            configurable: false\n        });\n        console.log('✅ Successfully locked document.domain');\n    } catch (e) {\n        console.error('❌ Could not lock document.domain:', e);\n    }\n    \n    // STRATEGY 4: Aggressive monitoring and correction\n    let lastHref = window.location.href;\n    let monitoringActive = true;\n    \n    const locationMonitor = setInterval(function() {\n        if (!monitoringActive) return;\n        \n        const currentHref = window.location.href;\n        if (currentHref !== lastHref) {\n            console.warn('🛡️ DETECTED LOCATION CHANGE:', lastHref, '->', currentHref);\n            \n            // Check for domain hijacking pattern: target.com:3000\n            if (currentHref.includes(TARGET_DOMAIN + ':') && !currentHref.includes(PROXY_HOST)) {\n                console.error('🛡️ CRITICAL: Domain hijack detected! Pattern:', TARGET_DOMAIN + ':3000');\n                console.log('🛡️ Attempting immediate correction...');\n                \n                try {\n                    monitoringActive = false; // Prevent recursive corrections\n                    const correctedUrl = currentHref.replace(TARGET_DOMAIN + ':', PROXY_HOST.split(':')[0] + ':');\n                    console.log('🛡️ Correcting to:', correctedUrl);\n                    window.location.replace(correctedUrl);\n                } catch (e) {\n                    console.error('🛡️ Could not correct domain hijack:', e);\n                    monitoringActive = true; // Re-enable monitoring\n                }\n            } else if (currentHref.includes(TARGET_DOMAIN) && !currentHref.includes('hmtarget=')) {\n                console.error('🛡️ CRITICAL: Direct target domain access detected!');\n                console.log('🛡️ Attempting to add proxy parameters...');\n                \n                try {\n                    monitoringActive = false;\n                    const separator = currentHref.includes('?') ? '&' : '?';\n                    const correctedUrl = currentHref + separator + 'hmtarget=' + TARGET_DOMAIN + '&hmtype=1';\n                    console.log('🛡️ Correcting to:', correctedUrl);\n                    window.location.replace(correctedUrl);\n                } catch (e) {\n                    console.error('🛡️ Could not add proxy parameters:', e);\n                    monitoringActive = true;\n                }\n            }\n            \n            lastHref = currentHref;\n        }\n    }, 50); // Check every 50ms for faster detection\n    \n    // STRATEGY 5: Override common redirect methods\n    const originalSetTimeout = window.setTimeout;\n    window.setTimeout = function(callback, delay) {\n        if (typeof callback === 'string' && callback.includes('location') && callback.includes(TARGET_DOMAIN)) {\n            console.warn('🛡️ BLOCKED malicious setTimeout with location change:', callback);\n            return;\n        }\n        return originalSetTimeout.apply(this, arguments);\n    };\n    \n    const originalSetInterval = window.setInterval;\n    window.setInterval = function(callback, delay) {\n        if (typeof callback === 'string' && callback.includes('location') && callback.includes(TARGET_DOMAIN)) {\n            console.warn('🛡️ BLOCKED malicious setInterval with location change:', callback);\n            return;\n        }\n        return originalSetInterval.apply(this, arguments);\n    };\n    \n    console.log('🛡️ MULTI-LAYER DOMAIN PROTECTION COMPLETED');\n    console.log('🛡️ Active protections: location.assign, location.replace, href setter, domain lock, monitoring');\n})();\n</script>";

  // FIXED: Enhanced JavaScript proxy interceptor with better loop prevention
  const proxyInterceptorScript = "\n<script>\n(function() {\n    'use strict';\n    \n    // Prevent multiple initializations\n    if (window.proxyInterceptorLoaded) {\n        console.log('🔧 Proxy interceptor already loaded, skipping...');\n        return;\n    }\n    window.proxyInterceptorLoaded = true;\n    \n    // Extract proxy parameters from current URL\n    const urlParams = new URLSearchParams(window.location.search);\n    const hmtarget = urlParams.get('hmtarget') || '" + target + "';\n    const hmtype = urlParams.get('hmtype') || '1';\n    const proxyHost = window.location.host;\n    const proxyProtocol = window.location.protocol;\n    \n    console.log('🔧 Proxy interceptor loaded for target:', hmtarget);\n    \n    // FIXED: Enhanced URL rewriting with better loop detection\n    function rewriteUrl(url, baseUrl) {\n        if (!url || typeof url !== 'string') return url;\n        \n        // Skip data URLs, blob URLs, and fragment-only URLs\n        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) {\n            return url;\n        }\n        \n        // FIXED: More robust check for already proxied URLs\n        if (url.includes('hmtarget=') && url.includes(proxyHost + '/')) {\n            console.log('🔄 URL already proxied, skipping:', url);\n            return url;\n        }\n        \n        let targetUrl;\n        \n        try {\n            if (url.startsWith('//')) {\n                // Protocol-relative URL: //domain.com/path\n                const domain = url.split('/')[2];\n                if (domain === proxyHost) return url; // Skip if already our proxy\n                \n                const path = url.substring(2 + domain.length);\n                const separator = path.includes('?') ? '&' : '?';\n                targetUrl = '//' + proxyHost + path + separator + 'hmtarget=' + domain + '&hmtype=1';\n            } else if (url.match(/^https?:\\/\\//)) {\n                // Absolute URL: https://domain.com/path\n                const urlObj = new URL(url);\n                if (urlObj.host === proxyHost) return url; // Already our proxy\n                \n                const separator = (urlObj.pathname + urlObj.search).includes('?') ? '&' : '?';\n                targetUrl = proxyProtocol + '//' + proxyHost + urlObj.pathname + urlObj.search + separator + 'hmtarget=' + urlObj.host + '&hmtype=1';\n            } else if (url.startsWith('/')) {\n                // Relative URL: /path\n                const separator = url.includes('?') ? '&' : '?';\n                targetUrl = proxyProtocol + '//' + proxyHost + url + separator + 'hmtarget=' + hmtarget + '&hmtype=1';\n            } else {\n                // Other relative URLs: path\n                const currentPath = window.location.pathname;\n                const basePath = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);\n                const fullPath = basePath + url;\n                const separator = fullPath.includes('?') ? '&' : '?';\n                targetUrl = proxyProtocol + '//' + proxyHost + fullPath + separator + 'hmtarget=' + hmtarget + '&hmtype=1';\n            }\n            \n            console.log('🔄 URL rewritten:', url, '→', targetUrl);\n            return targetUrl;\n        } catch (e) {\n            console.error('🔄 Error rewriting URL:', url, e);\n            return url;\n        }\n    }\n    \n    // FIXED: Enhanced fetch override with request deduplication\n    const originalFetch = window.fetch;\n    const pendingRequests = new Map();\n    \n    window.fetch = function(input, init) {\n        let url = input;\n        if (input instanceof Request) {\n            url = input.url;\n        }\n        \n        // FIXED: Prevent duplicate requests\n        const requestKey = (init && init.method || 'GET') + ':' + url;\n        if (pendingRequests.has(requestKey)) {\n            console.log('🌐 Duplicate request prevented:', url);\n            return pendingRequests.get(requestKey);\n        }\n        \n        const rewrittenUrl = rewriteUrl(url);\n        console.log('🌐 Fetch intercepted:', url, '→', rewrittenUrl);\n        \n        let requestPromise;\n        if (input instanceof Request) {\n            // Create new Request object with rewritten URL\n            const newRequest = new Request(rewrittenUrl, {\n                method: input.method,\n                headers: input.headers,\n                body: input.body,\n                mode: input.mode,\n                credentials: input.credentials,\n                cache: input.cache,\n                redirect: input.redirect,\n                referrer: input.referrer,\n                integrity: input.integrity\n            });\n            requestPromise = originalFetch.call(this, newRequest, init);\n        } else {\n            requestPromise = originalFetch.call(this, rewrittenUrl, init);\n        }\n        \n        // Store the promise to prevent duplicates\n        pendingRequests.set(requestKey, requestPromise);\n        \n        // Clean up after request completes\n        requestPromise.finally(function() {\n            pendingRequests.delete(requestKey);\n        });\n        \n        return requestPromise;\n    };\n    \n    // FIXED: Enhanced XMLHttpRequest override with better error handling\n    const OriginalXHR = window.XMLHttpRequest;\n    window.XMLHttpRequest = function() {\n        const xhr = new OriginalXHR();\n        const originalOpen = xhr.open;\n        \n        xhr.open = function(method, url, async, user, password) {\n            try {\n                const rewrittenUrl = rewriteUrl(url);\n                console.log('📡 XHR intercepted:', url, '→', rewrittenUrl);\n                return originalOpen.call(this, method, rewrittenUrl, async, user, password);\n            } catch (e) {\n                console.error('📡 XHR open error:', e);\n                return originalOpen.call(this, method, url, async, user, password);\n            }\n        };\n        \n        return xhr;\n    };\n    \n    // Copy static properties\n    Object.setPrototypeOf(window.XMLHttpRequest, OriginalXHR);\n    Object.setPrototypeOf(window.XMLHttpRequest.prototype, OriginalXHR.prototype);\n    \n    // FIXED: Enhanced form submission handling with rate limiting\n    let lastFormSubmission = 0;\n    const FORM_SUBMISSION_COOLDOWN = 1000; // 1 second\n    \n    document.addEventListener('submit', function(event) {\n        const now = Date.now();\n        if (now - lastFormSubmission < FORM_SUBMISSION_COOLDOWN) {\n            console.log('📝 Form submission rate limited');\n            event.preventDefault();\n            return false;\n        }\n        lastFormSubmission = now;\n        \n        const form = event.target;\n        if (form.action) {\n            const rewrittenAction = rewriteUrl(form.action);\n            if (rewrittenAction !== form.action) {\n                console.log('📝 Form action rewritten:', form.action, '→', rewrittenAction);\n                form.action = rewrittenAction;\n            }\n        }\n    }, true);\n    \n    // Override history methods\n    const originalPushState = history.pushState;\n    const originalReplaceState = history.replaceState;\n    \n    history.pushState = function(state, title, url) {\n        if (url) {\n            const rewrittenUrl = rewriteUrl(url);\n            console.log('🔗 PushState intercepted:', url, '→', rewrittenUrl);\n            return originalPushState.call(this, state, title, rewrittenUrl);\n        }\n        return originalPushState.call(this, state, title, url);\n    };\n    \n    history.replaceState = function(state, title, url) {\n        if (url) {\n            const rewrittenUrl = rewriteUrl(url);\n            console.log('🔗 ReplaceState intercepted:', url, '→', rewrittenUrl);\n            return originalReplaceState.call(this, state, title, rewrittenUrl);\n        }\n        return originalReplaceState.call(this, state, title, url);\n    };\n    \n    // FIXED: Enhanced anchor link handling with click rate limiting\n    let lastAnchorClick = 0;\n    const ANCHOR_CLICK_COOLDOWN = 300; // 300ms\n    \n    document.addEventListener('click', function(event) {\n        const now = Date.now();\n        if (now - lastAnchorClick < ANCHOR_CLICK_COOLDOWN) {\n            console.log('🔗 Anchor click rate limited');\n            return;\n        }\n        \n        const anchor = event.target.closest('a');\n        if (anchor && anchor.href && !anchor.target) {\n            lastAnchorClick = now;\n            const rewrittenHref = rewriteUrl(anchor.href);\n            if (rewrittenHref !== anchor.href) {\n                console.log('🔗 Anchor click intercepted:', anchor.href, '→', rewrittenHref);\n                anchor.href = rewrittenHref;\n            }\n        }\n    }, true);\n    \n    console.log('✅ Proxy interceptor fully loaded and active');\n\n    (function patchElementCreation() {\n    const originalCreateElement = Document.prototype.createElement;\n\n    Document.prototype.createElement = function(tagName) {\n        var args = Array.prototype.slice.call(arguments);\n        const element = originalCreateElement.apply(this, args);\n        const lowerTag = tagName.toLowerCase();\n\n        // Patch <script> tags\n        if (lowerTag === 'script') {\n            const originalSetAttribute = element.setAttribute.bind(element);\n\n            Object.defineProperty(element, 'src', {\n                get: function() {\n                    return element.getAttribute('src');\n                },\n                set: function(value) {\n                    const rewritten = rewriteUrl(value);\n                    console.log('🧠 [createElement] Script src rewritten:', value, '→', rewritten);\n                    originalSetAttribute('src', rewritten);\n                },\n                configurable: true,\n                enumerable: true,\n            });\n\n            element.setAttribute = function(name, value) {\n                if (name === 'src') {\n                    const rewritten = rewriteUrl(value);\n                    console.log('🧠 [setAttribute] Script src rewritten:', value, '→', rewritten);\n                    return originalSetAttribute(name, rewritten);\n                }\n                return originalSetAttribute(name, value);\n            };\n        }\n\n        // Patch <link rel=\"stylesheet\">\n        if (lowerTag === 'link') {\n            const originalSetAttribute = element.setAttribute.bind(element);\n\n            Object.defineProperty(element, 'href', {\n                get: function() {\n                    return element.getAttribute('href');\n                },\n                set: function(value) {\n                    const rewritten = rewriteUrl(value);\n                    console.log('🎨 [createElement] Link href rewritten:', value, '→', rewritten);\n                    originalSetAttribute('href', rewritten);\n                },\n                configurable: true,\n                enumerable: true,\n            });\n\n            element.setAttribute = function(name, value) {\n                if (name === 'href') {\n                    const rewritten = rewriteUrl(value);\n                    console.log('🎨 [setAttribute] Link href rewritten:', value, '→', rewritten);\n                    return originalSetAttribute(name, rewritten);\n                }\n                return originalSetAttribute(name, value);\n            };\n        }\n\n        return element;\n    };\n    })();\n\n\n})();\n\n  \n\n</script>";

  // CRITICAL: Remove ALL meta refresh tags
  const metaRefreshRegex =
    /<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi;
  let metaMatches = content.match(metaRefreshRegex);
  if (metaMatches) {
    console.log("🔍 DEBUGGING: Found meta refresh tags:", metaMatches);
    content = content.replace(
      metaRefreshRegex,
      "<!-- Meta refresh removed by proxy -->"
    );
    console.log("🛡️ REMOVED", metaMatches.length, "meta refresh tags");
  }

  // CRITICAL: Remove ALL base href tags
  const baseHrefRegex = /<base[^>]*href[^>]*>/gi;
  let baseMatches = content.match(baseHrefRegex);
  if (baseMatches) {
    console.log("🔍 DEBUGGING: Found base href tags:", baseMatches);
    content = content.replace(
      baseHrefRegex,
      "<!-- Base href removed by proxy -->"
    );
    console.log("🛡️ REMOVED", baseMatches.length, "base href tags");
  }

  if (target && target.includes("jerusalemsandals.com")) {
    // CRITICAL: Remove/neutralize JavaScript that changes location
    const locationChangePatterns = [
      /window\.location\s*=\s*["'][^"']*["']/gi,
      /document\.location\s*=\s*["'][^"']*["']/gi,
      /location\.href\s*=\s*["'][^"']*["']/gi,
      /location\.replace\s*\([^)]*\)/gi,
      /location\.assign\s*\([^)]*\)/gi,
      /window\.location\.href\s*=\s*["'][^"']*["']/gi,
      /window\.location\.replace\s*\([^)]*\)\)/gi,
      /window\.location\.replace\s*\([^)]*\)/gi,
      /window\.location\.assign\s*\([^)]*\)/gi,
    ];
    locationChangePatterns.forEach(function(pattern, index) {
      let matches = content.match(pattern);
      if (matches) {
        console.log(
          "🔍 DEBUGGING: Found location change pattern " + index + ":",
          matches
        );
        content = content.replace(pattern, function(match) {
          console.log("🛡️ NEUTRALIZED location change:", match);
          return "console.warn('🛡️ Blocked location change: " + match.replace(
            /'/g,
            "\\'"
          ) + "')";
        });
      }
    });
  }

  // SUPER AGGRESSIVE: Remove any script tags that mention the target domain
  const targetDomainScriptRegex = new RegExp(
    "<script[^>]*>[^<]*" + target.replace(".", "\\.") + "[^<]*</script>",
    "gi"
  );
  let scriptMatches = content.match(targetDomainScriptRegex);
  if (scriptMatches) {
    console.log(
      "🔍 DEBUGGING: Found scripts mentioning target domain:",
      scriptMatches.length
    );
    content = content.replace(
      targetDomainScriptRegex,
      "<!-- Script mentioning target domain removed -->"
    );
    console.log(
      "🛡️ REMOVED",
      scriptMatches.length,
      "scripts mentioning target domain"
    );
  }

  // Inject the script right after <head> or at the beginning of <body>
  // INJECT THE DOMAIN LOCK SCRIPT AT THE VERY BEGINNING
  if (content.includes("<html")) {
    if (content.includes("<head>")) {
      content = content.replace(
        "<head>",
        "<head>" + siteSpecificScript + domainLockScript + proxyInterceptorScript
      );
    }else{
      content = content.replace(
        "<html",
        siteSpecificScript + domainLockScript + proxyInterceptorScript + "<html"
      );
    }
  }

  // Remove problematic scripts
  content = content.replace(
    /<script[^>]*?data-locksmith[^>]*?>.*?<\/script>/gis,
    ""
  );
  content = content.replace(
    /<script[^>]*?type="application\/vnd\.locksmith\+json"[^>]*?>.*?<\/script>/gis,
    ""
  );

  // FIXED: More robust URL rewriting with better loop detection

  // 1. Protocol-relative URLs (//domain.com/path)
  content = content.replace(
    /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])\/\/([^\/\s"']+)(\/[^"']*)(["'])/gi,
    function(match, prefix, domain, path, suffix) {
      if (domain === proxyHost || path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenUrl = "//" + proxyHost + path + separator + "hmtarget=" + domain + "&hmtype=1";
      return prefix + rewrittenUrl + suffix;
    }
  );

  // 2. Absolute URLs (https://domain.com/path)
  content = content.replace(
    /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])https?:\/\/([^\/\s"']+)(\/[^"']*)(["'])/gi,
    function(match, prefix, domain, path, suffix) {
      if (domain === proxyHost || path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenUrl = protocol + "://" + proxyHost + path + separator + "hmtarget=" + domain + "&hmtype=1";
      return prefix + rewrittenUrl + suffix;
    }
  );

  // 3. Relative URLs starting with /
  content = content.replace(
    /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])(\/[^\/\s"'][^"']*)(["'])/gi,
    function(match, prefix, path, suffix) {
      if (path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenUrl = protocol + "://" + proxyHost + path + separator + "hmtarget=" + target + "&hmtype=1";
      return prefix + rewrittenUrl + suffix;
    }
  );

  // 4. FIXED: Enhanced srcset handling with better loop detection
  content = content.replace(
    /((?:srcset|data-srcset|dt)\s*=\s*["'])([^"']+)(["'])/gi,
    function(match, prefix, urls, suffix) {
      // Skip if already processed
      if (urls.includes("hmtarget=")) return match;

      const rewrittenUrls = urls
        .replace(
          /https?:\/\/([^\/\s,]+)([^\s,]*)/g,
          function(urlMatch, domain, path) {
            if (domain === proxyHost || path.includes("hmtarget="))
              return urlMatch;
            const separator = path.includes("?") ? "&" : "?";
            return protocol + "://" + proxyHost + path + separator + "hmtarget=" + domain + "&hmtype=1";
          }
        )
        .replace(/\/\/([^\/\s,]+)([^\s,]*)/g, function(urlMatch, domain, path) {
          if (domain === proxyHost || path.includes("hmtarget="))
            return urlMatch;
          const separator = path.includes("?") ? "&" : "?";
          return "//" + proxyHost + path + separator + "hmtarget=" + domain + "&hmtype=1";
        });

      return prefix + rewrittenUrls + suffix;
    }
  );

  // 5. CSS url() functions
  content = content.replace(
    /url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi,
    function(match, url) {
      if (
        url.startsWith("data:") ||
        url.startsWith("#") ||
        url.includes("hmtarget=")
      )
        return match;

      if (url.startsWith("//")) {
        const parts = url.substring(2).split("/");
        const domain = parts[0];
        const path = url.substring(2 + domain.length);
        if (domain === proxyHost) return match;

        const separator = path.includes("?") ? "&" : "?";
        const rewrittenUrl = "//" + proxyHost + path + separator + "hmtarget=" + domain + "&hmtype=1";
        return "url('" + rewrittenUrl + "')";
      } else if (url.match(/^https?:\/\//)) {
        try {
          const urlObj = new URL(url);
          if (urlObj.host === proxyHost) return match;

          const separator = (urlObj.pathname + urlObj.search).includes("?")
            ? "&"
            : "?";
          const rewrittenUrl = protocol + "://" + proxyHost + urlObj.pathname + urlObj.search + separator + "hmtarget=" + urlObj.host + "&hmtype=1";
          return "url('" + rewrittenUrl + "')";
        } catch (e) {
          return match;
        }
      } else if (url.startsWith("/")) {
        const separator = url.includes("?") ? "&" : "?";
        const rewrittenUrl = protocol + "://" + proxyHost + url + separator + "hmtarget=" + target + "&hmtype=1";
        return "url('" + rewrittenUrl + "')";
      }
      return match;
    }
  );

  // 6. FIXED: Enhanced JavaScript string literal rewriting
  content = content.replace(
    /(['"`])\/\/([^\/\s'"`]+)([^'"`]*)\1/g,
    function(match, quote, domain, path) {
      if (
        match.includes("/*") ||
        match.includes("//") ||
        domain === proxyHost ||
        path.includes("hmtarget=")
      ) {
        return match;
      }

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenUrl = "//" + proxyHost + path + separator + "hmtarget=" + domain + "&hmtype=1";
      return quote + rewrittenUrl + quote;
    }
  );

  // 7. FIXED: Template literals with better detection
  content = content.replace(
    /(\$\{window\.location\.origin\})(\/[^`'"}\s]*)/gi,
    function(match, originPart, path) {
      if (path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenPath = path + separator + "hmtarget=" + target + "&hmtype=1";
      return originPart + rewrittenPath;
    }
  );

  // 8. FIXED: Window.location concatenation
  content = content.replace(
    /(window\.location\.origin\s*\+\s*['"`])(\/[^'"`]*?)(['"`])/gi,
    function(match, prefix, path, suffix) {
      if (path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenPath = path + separator + "hmtarget=" + target + "&hmtype=1";
      return prefix + rewrittenPath + suffix;
    }
  );

  // 9. FIXED: Enhanced fetch() rewriting
  content = content.replace(
    /(fetch\s*\(\s*[`'"])(\/.+?)([`'"]\s*\))/gi,
    function(match, prefix, path, suffix) {
      if (path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenPath = path + separator + "hmtarget=" + target + "&hmtype=1";
      return prefix + rewrittenPath + suffix;
    }
  );

  // 10. Root URL (just "/")
  content = content.replace(
    /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])(\/)(["'])/gi,
    function(match, prefix, path, suffix) {
      console.log("🔍 DEBUGGING: Found root URL:", match);
      const rewrittenUrl = protocol + "://" + proxyHost + "/?hmtarget=" + target + "&hmtype=1";
      console.log(
        "🔍 DEBUGGING: Rewritten root URL to:",
        prefix + rewrittenUrl + suffix
      );
      return prefix + rewrittenUrl + suffix;
    }
  );

  // 11. Query-only URLs (just "?")
  content = content.replace(
    /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])(\?)([^"']*)(["'])/gi,
    function(match, prefix, questionMark, query, suffix) {
      if (query.includes("hmtarget=")) return match;

      console.log("🔍 DEBUGGING: Found query-only URL:", match);
      const separator = query ? "&" : "";
      const rewrittenUrl = protocol + "://" + proxyHost + "/?" + query + separator + "hmtarget=" + target + "&hmtype=1";
      console.log(
        "🔍 DEBUGGING: Rewritten query-only URL to:",
        prefix + rewrittenUrl + suffix
      );
      return prefix + rewrittenUrl + suffix;
    }
  );

  // 12. Empty URLs (href="" or src="")
  content = content.replace(
    /((?:href|action)\s*=\s*["'])(["'])/gi,
    function(match, prefix, suffix) {
      console.log("🔍 DEBUGGING: Found empty URL:", match);
      const rewrittenUrl = protocol + "://" + proxyHost + "/?hmtarget=" + target + "&hmtype=1";
      console.log(
        "🔍 DEBUGGING: Rewritten empty URL to:",
        prefix + rewrittenUrl + suffix
      );
      return prefix + rewrittenUrl + suffix;
    }
  );

  console.log("URL rewriting completed");
  return content;
}

// =================
// ENHANCED SPA IMPLEMENTATION (hmtype=2)
// =================

// Enhanced SPA-specific JavaScript interceptor
function generateSPAInterceptorScript(target, proxyHost, protocol) {
  return "\n<script type=\"module\">\n(function() {\n    'use strict';\n    \n    console.log('🚀 Enhanced SPA Proxy Interceptor Loading...');\n    \n    const TARGET_DOMAIN = '" + target + "';\n    const PROXY_HOST = '" + proxyHost + "';\n    const PROXY_PROTOCOL = '" + protocol + ":';\n    \n    function rewriteUrl(url, baseUrl) {\n        if (!url || typeof url !== 'string') return url;\n        \n        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#') || url.startsWith('javascript:')) {\n            return url;\n        }\n        \n        if (url.includes('hmtarget=') && url.includes(PROXY_HOST)) {\n            return url;\n        }\n        \n        try {\n            let targetUrl;\n            \n            if (url.startsWith('//')) {\n                const domain = url.split('/')[2];\n                if (domain === PROXY_HOST) return url;\n                \n                const path = url.substring(2 + domain.length);\n                const separator = path.includes('?') ? '&' : '?';\n                targetUrl = '//' + PROXY_HOST + path + separator + 'hmtarget=' + domain + '&hmtype=2';\n            } else if (url.match(/^https?:\\/\\//)) {\n                const urlObj = new URL(url);\n                if (urlObj.host === PROXY_HOST) return url;\n                \n                const separator = (urlObj.pathname + urlObj.search).includes('?') ? '&' : '?';\n                targetUrl = PROXY_PROTOCOL + '//' + PROXY_HOST + urlObj.pathname + urlObj.search + separator + 'hmtarget=' + urlObj.host + '&hmtype=2';\n            } else if (url.startsWith('/')) {\n                const separator = url.includes('?') ? '&' : '?';\n                targetUrl = PROXY_PROTOCOL + '//' + PROXY_HOST + url + separator + 'hmtarget=' + TARGET_DOMAIN + '&hmtype=2';\n            } else if (!url.includes('://')) {\n                const currentPath = window.location.pathname;\n                const basePath = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);\n                const fullPath = basePath + url;\n                const separator = fullPath.includes('?') ? '&' : '?';\n                targetUrl = PROXY_PROTOCOL + '//' + PROXY_HOST + fullPath + separator + 'hmtarget=' + TARGET_DOMAIN + '&hmtype=2';\n            } else {\n                return url;\n            }\n            \n            console.log('🔄 SPA URL rewritten:', url, '→', targetUrl);\n            return targetUrl;\n        } catch (e) {\n            console.error('🔄 Error rewriting SPA URL:', url, e);\n            return url;\n        }\n    }\n    \n    // Enhanced fetch override\n    const originalFetch = window.fetch;\n    \n    window.fetch = function(input, init) {\n        init = init || {};\n        let url = input;\n        if (input instanceof Request) {\n            url = input.url;\n        }\n        \n        const rewrittenUrl = rewriteUrl(url);\n        \n        const enhancedInit = Object.assign({}, init);\n        if (!enhancedInit.headers) {\n            enhancedInit.headers = {};\n        }\n        \n        if (typeof enhancedInit.headers === 'object' && !enhancedInit.headers['X-Requested-With']) {\n            enhancedInit.headers['X-Requested-With'] = 'XMLHttpRequest';\n        }\n        \n        console.log('🌐 SPA fetch:', url, '→', rewrittenUrl);\n        \n        if (input instanceof Request) {\n            const newRequest = new Request(rewrittenUrl, {\n                method: input.method,\n                headers: Object.assign({}, Object.fromEntries(input.headers.entries()), enhancedInit.headers),\n                body: input.body,\n                mode: 'cors',\n                credentials: input.credentials || 'same-origin',\n                cache: input.cache,\n                redirect: input.redirect,\n                referrer: input.referrer,\n                integrity: input.integrity\n            });\n            return originalFetch.call(this, newRequest, enhancedInit);\n        } else {\n            return originalFetch.call(this, rewrittenUrl, enhancedInit);\n        }\n    };\n    \n    // Enhanced XMLHttpRequest\n    const OriginalXHR = window.XMLHttpRequest;\n    window.XMLHttpRequest = function() {\n        const xhr = new OriginalXHR();\n        const originalOpen = xhr.open;\n        \n        xhr.open = function(method, url, async, user, password) {\n            const rewrittenUrl = rewriteUrl(url);\n            console.log('📡 SPA XHR intercepted:', url, '→', rewrittenUrl);\n            return originalOpen.call(this, method, rewrittenUrl, async, user, password);\n        };\n        \n        return xhr;\n    };\n    \n    Object.setPrototypeOf(window.XMLHttpRequest, OriginalXHR);\n    Object.setPrototypeOf(window.XMLHttpRequest.prototype, OriginalXHR.prototype);\n    \n    // Enhanced History API for SPA routing\n    const originalPushState = history.pushState;\n    const originalReplaceState = history.replaceState;\n    \n    history.pushState = function(state, title, url) {\n        if (url && !url.startsWith('#')) {\n            const rewrittenUrl = rewriteUrl(url);\n            console.log('🔗 SPA PushState intercepted:', url, '→', rewrittenUrl);\n            return originalPushState.call(this, state, title, rewrittenUrl);\n        }\n        return originalPushState.call(this, state, title, url);\n    };\n    \n    history.replaceState = function(state, title, url) {\n        if (url && !url.startsWith('#')) {\n            const rewrittenUrl = rewriteUrl(url);\n            console.log('🔗 SPA ReplaceState intercepted:', url, '→', rewrittenUrl);\n            return originalReplaceState.call(this, state, title, rewrittenUrl);\n        }\n        return originalReplaceState.call(this, state, title, url);\n    };\n    \n    // Service Worker registration interception\n    if ('serviceWorker' in navigator) {\n        const originalRegister = navigator.serviceWorker.register;\n        navigator.serviceWorker.register = function(scriptURL, options) {\n            const rewrittenURL = rewriteUrl(scriptURL);\n            console.log('⚙️ SPA Service Worker registration intercepted:', scriptURL, '→', rewrittenURL);\n            return originalRegister.call(this, rewrittenURL, options);\n        };\n    }\n    \n    // WebSocket proxying\n    if (window.WebSocket) {\n        const OriginalWebSocket = window.WebSocket;\n        window.WebSocket = function(url, protocols) {\n            let wsUrl = url;\n            \n            if (url.startsWith('ws://') || url.startsWith('wss://')) {\n                try {\n                    const urlObj = new URL(url);\n                    if (urlObj.host === TARGET_DOMAIN) {\n                        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';\n                        wsUrl = protocol + '//' + PROXY_HOST + '/ws-proxy?hmtarget=' + TARGET_DOMAIN + '&hmws=' + encodeURIComponent(url);\n                        console.log('🔌 SPA WebSocket URL rewritten:', url, '→', wsUrl);\n                    }\n                } catch (e) {\n                    console.error('🔌 Error rewriting WebSocket URL:', url, e);\n                }\n            }\n            \n            return new OriginalWebSocket(wsUrl, protocols);\n        };\n        \n        Object.setPrototypeOf(window.WebSocket, OriginalWebSocket);\n        Object.setPrototypeOf(window.WebSocket.prototype, OriginalWebSocket.prototype);\n    }\n    \n    console.log('✅ Enhanced SPA Proxy Interceptor fully loaded');\n    window.proxyRewriteUrl = rewriteUrl;\n    \n})();\n</script>";
}

// Enhanced URL rewriting for SPA content (hmtype=2)
async function rewriteUrlsSPA(body, target, proxyHost, protocol) {
  if (!body) return body;

  let content = body.toString();
  
  console.log("=== Enhanced SPA URL Rewriting (hmtype=2) ===");
  
  const spaScript = generateSPAInterceptorScript(target, proxyHost, protocol);
  
  if (content.includes('<head>')) {
    content = content.replace('<head>', '<head>' + spaScript);
  } else if (content.includes('<html')) {
    content = content.replace('<html', spaScript + '<html');
  } else if (content.includes('<body')) {
    content = content.replace('<body', spaScript + '<body');
  }
  
  // Remove problematic meta tags
  content = content.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '<!-- Meta refresh removed -->');
  content = content.replace(/<base[^>]*href[^>]*>/gi, '<!-- Base href removed -->');
  
  // Enhanced URL rewriting patterns for SPA (using hmtype=2)
  
  // 1. ES Module imports
  content = content.replace(
    /(<script[^>]*type\s*=\s*["']module["'][^>]*src\s*=\s*["'])([^"']+)(["'][^>]*>)/gi,
    function(match, prefix, url, suffix) {
      if (url.includes('hmtarget=')) return match;
      const rewrittenUrl = rewriteUrlHelperSPA(url, target, proxyHost, protocol);
      console.log('📦 Module script rewritten:', url, '→', rewrittenUrl);
      return prefix + rewrittenUrl + suffix;
    }
  );
  
  // 2. Dynamic import() statements
  content = content.replace(
    /import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gi,
    function(match, url) {
      if (url.includes('hmtarget=')) return match;
      const rewrittenUrl = rewriteUrlHelperSPA(url, target, proxyHost, protocol);
      console.log('📦 Dynamic import rewritten:', url, '→', rewrittenUrl);
      return 'import("' + rewrittenUrl + '")';
    }
  );
  
  // 3. API endpoints
  content = content.replace(
    /(['"`])\/api\/([^'"`]*)\1/gi,
    function(match, quote, path) {
      const fullPath = '/api/' + path;
      const separator = fullPath.includes('?') ? '&' : '?';
      const rewrittenUrl = protocol + '://' + proxyHost + fullPath + separator + 'hmtarget=' + target + '&hmtype=2';
      console.log('🔌 API endpoint rewritten:', fullPath, '→', rewrittenUrl);
      return quote + rewrittenUrl + quote;
    }
  );
  
  // 4. Standard URL rewriting with hmtype=2
  content = content.replace(
    /((?:src|href|action|data-src|data-href|poster|background|cite|formaction)\s*=\s*["'])https?:\/\/([^\/\s"']+)(\/[^"']*)(["'])/gi,
    function(match, prefix, domain, path, suffix) {
      if (domain === proxyHost || path.includes("hmtarget=")) return match;
      const separator = path.includes("?") ? "&" : "?";
      const rewrittenUrl = protocol + "://" + proxyHost + path + separator + "hmtarget=" + domain + "&hmtype=2";
      return prefix + rewrittenUrl + suffix;
    }
  );
  
  content = content.replace(
    /((?:src|href|action|data-src|data-href|poster|background|cite|formaction)\s*=\s*["'])(\/[^\/\s"'][^"']*)(["'])/gi,
    function(match, prefix, path, suffix) {
      if (path.includes("hmtarget=")) return match;
      const separator = path.includes("?") ? "&" : "?";
      const rewrittenUrl = protocol + "://" + proxyHost + path + separator + "hmtarget=" + target + "&hmtype=2";
      return prefix + rewrittenUrl + suffix;
    }
  );
  
  console.log("Enhanced SPA URL rewriting completed");
  return content;
}

// Helper function for SPA URL rewriting
function rewriteUrlHelperSPA(url, target, proxyHost, protocol) {
  if (!url || url.includes('hmtarget=')) return url;
  
  if (url.startsWith('http')) {
    try {
      const urlObj = new URL(url);
      const separator = (urlObj.pathname + urlObj.search).includes("?") ? "&" : "?";
      return protocol + "://" + proxyHost + urlObj.pathname + urlObj.search + separator + "hmtarget=" + urlObj.host + "&hmtype=2";
    } catch (e) {
      return url;
    }
  } else if (url.startsWith('/')) {
    const separator = url.includes("?") ? "&" : "?";
    return protocol + "://" + proxyHost + url + separator + "hmtarget=" + target + "&hmtype=2";
  }
  
  return url;
}

// =================
// SHARED HELPER FUNCTIONS (ALL YOUR ORIGINAL FUNCTIONS)
// =================

// FIXED: Enhanced cart JSON URL rewriting
function rewriteCartJsonUrls(body, target, proxyHost, protocol) {
  if (!body) return body;

  let content = body.toString();
  console.log("Rewriting cart JSON URLs with protocol:", protocol);

  // Determine hmtype from context - check if this is an SPA request
  // For now, we'll default to hmtype=1 for cart JSON, but this could be enhanced
  const hmtype = '1'; // You can make this dynamic based on the original request

  // FIXED: Better JSON URL rewriting with loop detection
  content = content.replace(/"url"\s*:\s*"(\/[^"]*)"/gi, function(match, url) {
    if (url.includes("hmtarget=")) return match;

    const separator = url.includes("?") ? "&" : "?";
    return '"url":"' + url + separator + 'hmtarget=' + target + '&hmtype=' + hmtype + '"';
  });

  // FIXED: Better CDN URL rewriting
  content = content.replace(
    /"(https:\/\/cdn\.shopify\.com\/[^"]*)"/gi,
    function(match, cdnUrl) {
      if (cdnUrl.includes("hmtarget=")) return match;

      try {
        const urlObj = new URL(cdnUrl);
        const separator = (urlObj.pathname + urlObj.search).includes("?")
          ? "&"
          : "?";
        return '"' + protocol + "://" + proxyHost + urlObj.pathname + urlObj.search + separator + "hmtarget=" + urlObj.host + "&hmtype=" + hmtype + '"';
      } catch (e) {
        const encodedUrl = encodeURIComponent(cdnUrl);
        return '"' + protocol + "://" + proxyHost + "/asset?hmtarget=" + target + "&hmtype=2&hmurl=" + encodedUrl + '"';
      }
    }
  );

  return content;
}

// FIXED: Enhanced request maker with better error handling and loop prevention
async function makeProxyRequest(targetUrl, options) {
  let redirects = 0;
  let retries = 0;
  let currentUrl = targetUrl;

  // FIXED: Request tracking to prevent loops
  const requestId = options.method + ":" + targetUrl;
  const now = Date.now();

  if (requestTracker.has(requestId)) {
    const lastRequest = requestTracker.get(requestId);
    if (now - lastRequest < 50) {
      console.log("Request blocked - too frequent:", requestId);
      //throw new Error("Request rate limited");
    }
  }
  requestTracker.set(requestId, now);

  while (redirects < MAX_REDIRECTS && retries < MAX_RETRIES) {
    try {
      // Clean up headers
      const cleanHeaders = {};
      Object.keys(options.headers).forEach(function(key) {
        const value = options.headers[key];
        if (value !== undefined && value !== null && value !== "") {
          const lowerKey = key.toLowerCase();
          if (
            ![
              "content-length",
              "transfer-encoding",
              "connection",
              "accept-encoding",
            ].includes(lowerKey)
          ) {
            cleanHeaders[key] = value;
          }
        }
      });

      cleanHeaders["Accept-Encoding"] = "identity";

      const requestOptions = {
        method: options.method,
        headers: cleanHeaders,
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      };

      // FIXED: Better body handling for POST requests
      if (
        options.body &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(
          options.method.toUpperCase()
        )
      ) {
        requestOptions.body = options.body;

        if (!cleanHeaders["Content-Length"]) {
          if (typeof options.body === "string") {
            cleanHeaders["Content-Length"] = Buffer.byteLength(
              options.body,
              "utf8"
            ).toString();
          } else if (Buffer.isBuffer(options.body)) {
            cleanHeaders["Content-Length"] = options.body.length.toString();
          }
        }
      }

      console.log("Making request to:", currentUrl);
      console.log("Request method:", requestOptions.method);

      const response = await fetch(currentUrl, requestOptions);

      // CRITICAL: Handle redirects aggressively
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        redirects++;
        if (redirects >= MAX_REDIRECTS) {
          throw new Error("Too many redirects");
        }

        let newUrl = response.headers.get("location");
        if (!newUrl.match(/^https?:\/\//)) {
          const baseUrl = new URL(currentUrl);
          newUrl = baseUrl.origin + newUrl;
          console.log("🔍 DEBUGGING: Made redirect absolute:", newUrl);
        }

        // CRITICAL: Check if redirect is trying to hijack domain
        try {
          const redirectUrl = new URL(newUrl);
          const originalUrl = new URL(currentUrl);

          if (redirectUrl.hostname !== originalUrl.hostname) {
            console.warn("🛡️ SUSPICIOUS: Cross-domain redirect detected");
            console.warn(
              "🛡️ From:",
              originalUrl.hostname,
              "to:",
              redirectUrl.hostname
            );
          }
        } catch (e) {
          console.log(
            "🔍 DEBUGGING: Could not parse redirect URLs for analysis"
          );
        }

        currentUrl = newUrl;
        console.log("Following redirect to:", currentUrl);
        continue;
      }

      // Get response body
      let body;
      const contentType = response.headers.get("content-type") || "";

      try {
        if (
          contentType.includes("text/") ||
          contentType.includes("application/json") ||
          contentType.includes("application/javascript")
        ) {
          body = Buffer.from(await response.text(), "utf8");
        } else {
          body = Buffer.from(await response.arrayBuffer());
        }
      } catch (bodyError) {
        console.error("Error reading response body:", bodyError);
        body = Buffer.alloc(0);
      }

      console.log("Response status:", response.status);
      console.log("Response Content-Type:", contentType);
      console.log("Response body length:", body.length);

      // Clean response headers
      const responseHeaders = Object.fromEntries(response.headers.entries());
      delete responseHeaders["content-encoding"];
      delete responseHeaders["content-length"];

      return {
        status: response.status,
        headers: responseHeaders,
        body: body,
      };
    } catch (error) {
      retries++;
      console.error("Request attempt " + retries + " failed:", error.message);

      if (retries >= MAX_RETRIES) {
        throw error;
      }

      // Wait before retrying
      await new Promise(function(resolve) { setTimeout(resolve, 1000 * retries); });
    }
  }

  throw new Error("Maximum retries exceeded");
}

function movePayloadBeforeHmtarget(url) {
  const _url = url && url.toLowerCase();
  if (!_url || !_url.includes("hmtarget=")) return url;
  else if (url.includes("hmtarget=") && url.endsWith("=1")) return url;

  const match = url.match(/hmtype=1([^&]*)/);
  if (!match) return url; // nothing to do

  const payload = match[1]; // everything after 'hmtype=1'
  if (!payload) return url; // no payload, leave unchanged

  // Remove the payload from hmtype
  let updated = url.replace(/hmtype=1[^&]*/, "hmtype=1");

  // Insert the payload before ?hmtarget or &hmtarget
  updated = updated.replace(/([?&])hmtarget=/, payload + "&hmtarget=");

  return updated;
}

// FIXED: Enhanced main request handler with better error handling
async function handleRequest(req, res, next) {
  try {
    const sanitizedUrl = movePayloadBeforeHmtarget(req.url);
    req.url = sanitizedUrl;
    req.originalUrl = sanitizedUrl;

    // Parse the new URL and update query parameters
    const urlParts = url.parse(sanitizedUrl, true);
    req.path = urlParts.pathname;
    req.query = urlParts.query;
    req._parsedUrl = urlParts;

    console.log("=== New Request ===");
    console.log("Request URL:", req.url);
    console.log("Request method:", req.method);
    console.log("Request path:", req.path);
    console.log("Query params:", req.query);

    // Extract hmtype to determine which implementation to use
    const hmtype = req.query.hmtype || '1'; // Default to original implementation
    console.log("hmtype:", hmtype);

    // FIXED: Better handling of cart requests
    if (req.path.includes("/cart/") || req.path.includes("cart.js")) {
      console.log("=== CART REQUEST DETECTED ===");
      console.log("Method:", req.method);
      console.log("Path:", req.path);
      console.log("Headers:", req.headers);
      if (req.method === "POST" && req.body) {
        console.log("Body:", req.body);
      }
    }

    let refererHmtarget;
    const referer = req.headers["referer"];
    const requestHost = req.get("host");
    if (referer && !req.query.hmtarget && referer.includes(requestHost)) {
      try {
        const refererUrl = new URL(referer);
        const urlParams = new URLSearchParams(refererUrl.search);
        refererHmtarget = urlParams.get("hmtarget");
      } catch (e) {
        // Invalid referer URL, ignore
      }
    }

    // Extract target from query parameters
    const target = req.query.hmtarget || refererHmtarget;
    if (!target) {
      return res.status(400).send("No target specified");
    }

    // Clean up target
    const cleanTarget = target.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    console.log("Clean target:", cleanTarget);

    const requestPath = req.path;

    // Remove proxy-specific parameters from query
    const cleanQuery = Object.assign({}, req.query);
    delete cleanQuery.hmtarget;
    delete cleanQuery.hmtype;
    delete cleanQuery.hmurl;

    // Build the target URL
    let queryString = new URLSearchParams(cleanQuery).toString();

    const targetUrl = "https://" + cleanTarget + requestPath + (queryString ? "?" + queryString : "");

    console.log("Final target URL:", targetUrl);

    // Prepare headers and body
    const hasBody =
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.body;
    const headers = getCommonHeaders(cleanTarget, req.headers, hasBody);

    // FIXED: Better body handling for cart requests
    let requestBody = null;
    if (hasBody) {
      const contentType = req.get("content-type") || "";

      if (contentType.includes("application/json")) {
        requestBody = JSON.stringify(req.body);
        console.log("Using JSON body:", requestBody);
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        if (typeof req.body === "object") {
          requestBody = new URLSearchParams(req.body).toString();
        } else {
          requestBody = req.body;
        }
        console.log("Using form-encoded body:", requestBody);
      } else if (Buffer.isBuffer(req.body)) {
        requestBody = req.body;
        console.log("Using buffer body, length:", req.body.length);
      } else if (typeof req.body === "string") {
        requestBody = req.body;
        console.log("Using string body:", requestBody.substring(0, 200));
      } else {
        requestBody = JSON.stringify(req.body);
        console.log("Using fallback JSON body:", requestBody);
      }
    }

    // FIXED: Special handling for cart requests - disable caching and add anti-CSRF headers
    if (req.url.includes("cart") || req.url.includes("sections=cart")) {
      delete headers["If-Modified-Since"];
      delete headers["If-None-Match"];
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
      headers["Pragma"] = "no-cache";
      headers["X-Requested-With"] = "XMLHttpRequest";
      console.log("Applied cart-specific headers");
    }

    // Make request to target
    console.log("Making proxy request...");
    const proxyRes = await makeProxyRequest(targetUrl, {
      method: req.method,
      headers: headers,
      body: requestBody,
    });

    console.log("Proxy response received, status:", proxyRes.status);

    // FIXED: Better error handling for cart responses
    if (proxyRes.status >= 400 && req.path.includes("/cart/")) {
      console.log("Cart request failed with status:", proxyRes.status);
      console.log("Response body:", proxyRes.body.toString());
    }

    // CRITICAL: Check for Location header and rewrite it
    if (proxyRes.headers["location"]) {
      const originalLocation = proxyRes.headers["location"];
      const rewrittenLocation = rewriteLocationHeader(
        originalLocation,
        cleanTarget,
        req.get("host"),
        req.protocol || "http"
      );
      if (rewrittenLocation !== originalLocation) {
        proxyRes.headers["location"] = rewrittenLocation;
        console.log(
          "🛡️ REWRITTEN Location header:",
          originalLocation,
          "->",
          rewrittenLocation
        );
      }
    }

    // Set response status and headers
    res.status(proxyRes.status);

    // Copy response headers
    Object.keys(proxyRes.headers).forEach(function(key) {
      const lowerKey = key.toLowerCase();
      if (
        ![
          "connection",
          "transfer-encoding",
          "content-encoding",
          "content-length",
        ].includes(lowerKey)
      ) {
        if (lowerKey === "content-security-policy") {
          if (hmtype === '2') {
            // Relax CSP for SPA operation
            res.set(key, "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors *;");
          } else {
            res.set(key, "frame-ancestors *");
          }
        } else if (lowerKey !== "x-frame-options") {
          res.set(key, proxyRes.headers[key]);
        }
      }
    });

    // Force our own CSP
    res.set("Content-Security-Policy", "frame-ancestors *");

    // Enhanced CORS headers for SPA compatibility (hmtype=2)
    if (hmtype === '2') {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
      res.set("Access-Control-Allow-Credentials", "true");
    }

    // CRITICAL: Add no-cache headers to prevent caching issues
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    // Process response body based on hmtype
    const contentType = proxyRes.headers["content-type"] || "";
    let shouldReplaceUrls =
      contentType.includes("text/html") || looksLikeHTML(proxyRes.body);

    const binaryContentTypes = [
      "image/",
      "video/",
      "audio/",
      "application/octet-stream",
      "application/pdf",
      "application/zip",
      "font/",
      "application/font",
    ];

    shouldReplaceUrls = !binaryContentTypes.some(function(type) {
      return contentType.startsWith(type);
    });

    if (shouldReplaceUrls) {
      const protocol = req.protocol || req.get("x-forwarded-proto") || "http";
      
      if (hmtype === '2') {
        console.log("Processing with SPA implementation (hmtype=2)");
        const rewrittenBody = await rewriteUrlsSPA(proxyRes.body, cleanTarget, req.get("host"), protocol);
        res.send(rewrittenBody);
      } else {
        console.log("Processing with original implementation (hmtype=1)");
        const rewrittenBody = await rewriteUrls(proxyRes.body, cleanTarget, req.get("host"), protocol);
        res.send(rewrittenBody);
      }
    } else if (
      contentType.includes("application/json") &&
      (req.path.includes("/cart/") || req.path.includes("cart.js"))
    ) {
      console.log("Processing JSON cart response");
      const protocol = req.protocol || req.get("x-forwarded-proto") || "http";
      const rewrittenBody = rewriteCartJsonUrls(
        proxyRes.body,
        cleanTarget,
        req.get("host"),
        protocol
      );
      res.send(rewrittenBody);
    } else {
      console.log("Passing through content as-is");
      res.send(proxyRes.body);
    }
  } catch (error) {
    console.error("Request failed:", error);

    // FIXED: Better error responses for cart requests
    if (req.path.includes("/cart/") || req.path.includes("cart.js")) {
      res.status(500).json({
        error: "Cart request failed",
        message: error.message,
        description: "Please try again in a moment",
      });
    } else {
      res.status(500).send("Request failed: " + error.message);
    }
  }
}

// Asset handler (unchanged)
async function handleAsset(req, res) {
  try {
    console.log("=== Asset Request ===");
    console.log("Asset URL:", req.url);

    const target = req.query.hmtarget;
    const assetUrl = req.query.hmurl;

    if (!target) {
      return res.status(400).send("No target specified for asset");
    }

    let targetUrl;
    if (assetUrl) {
      targetUrl = decodeURIComponent(assetUrl);
      console.log("Using decoded asset URL:", targetUrl);
    } else {
      const cleanTarget = target
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "");
      const urlParts = url.parse(req.url, true);
      const targetPath = urlParts.pathname.replace("/asset", "") || "/";

      const cleanQuery = Object.assign({}, urlParts.query);
      delete cleanQuery.hmtarget;
      delete cleanQuery.hmtype;
      delete cleanQuery.hmurl;

      const queryString = new URLSearchParams(cleanQuery).toString();
      targetUrl = "https://" + cleanTarget + targetPath + (queryString ? "?" + queryString : "");
      console.log("Constructed asset URL:", targetUrl);
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body;
    const headers = getCommonHeaders(
      target.replace(/^https?:\/\//, ""),
      req.headers,
      hasBody
    );

    console.log("Making asset request...");
    const proxyRes = await makeProxyRequest(targetUrl, {
      method: req.method,
      headers: headers,
      body: hasBody ? req.body : undefined,
    });

    console.log("Asset response received, status:", proxyRes.status);

    res.status(proxyRes.status);

    Object.keys(proxyRes.headers).forEach(function(key) {
      const lowerKey = key.toLowerCase();
      if (
        ![
          "connection",
          "transfer-encoding",
          "content-encoding",
          "content-length",
        ].includes(lowerKey)
      ) {
        res.set(key, proxyRes.headers[key]);
      }
    });

    res.send(proxyRes.body);
  } catch (error) {
    console.error("Asset request failed:", error);
    res.status(500).send("Asset request failed: " + error.message);
  }
}

// Screenshot proxy handler (unchanged)
async function handleScreenshotProxy(req, res) {
  try {
    console.log("=== Screenshot Proxy Request ===");
    const initialMutationUrl = req.query.initialMutationUrl;
    const idSite = req.query.idSite;
    const idSiteHsr = req.query.idSiteHsr;
    const deviceType = req.query.deviceType;
    const baseUrl = req.query.baseUrl || "";

    if (!initialMutationUrl) {
      return res.status(400).json({
        error: "invalid url, please check if the url contains initialMutation",
      });
    }

    console.log("Fetching initial mutation from:", initialMutationUrl);

    const response = await fetch(initialMutationUrl, {
      headers: getCommonHeaders(req.get("host"), req.headers),
      timeout: 10000,
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    let body = await response.text();

    if (initialMutationUrl.endsWith(".gz")) {
      try {
        body = zlib.gunzipSync(Buffer.from(body, "binary")).toString();
      } catch (error) {
        console.warn("Failed to gunzip response, using raw body");
      }
    }

    const encodedInitialMutation =
      "%7B%22rootId%22%3A1%2C%22children%22%3A%5B%7B%22nodeType%22%3A10%2C%22id%22%3A2%2C%22name%22%3A%22html%22%2C%22publicId%22%3A%22%22%2C%22systemId%22%3A%22%22%7D%2C%7B%22nodeType%22%3A1%2C%22id%22%3A3%2C%22tagName%22%3A%22HTML%22%2C%22attributes%22%3A%7B%7D%2C%22childNodes%22%3A%5B%7B%22nodeType%22%3A1%2C%22id%22%3A4%2C%22tagName%22%3A%22HEAD%22%2C%22attributes%22%3A%7B%7D%2C%22childNodes%22%3A%5B%7B%22nodeType%22%3A3%2C%22id%22%3A5%2C%22textContent%22%3A%22%5Cn%20%20%22%7D%2C%7B%22nodeType%22%3A1%2C%22id%22%3A6%2C%22tagName%22%3A%22STYLE%22%2C%22attributes%22%3A%7B%7D%2C%22childNodes%22%3A%5B%7B%22nodeType%22%3A3%2C%22id%22%3A7%2C%22textContent%22%3A%22%5Cn%20%20%20%20body%20%7B%5Cn%20%20%20%20%20%20margin%3A%200%3B%5Cn%20%20%20%20%20%20padding%3A%200%3B%5Cn%20%20%20%20%20%20display%3A%20flex%3B%5Cn%20%20%20%20%20%20justify-content%3A%20center%3B%5Cn%20%20%20%20%20%20align-items%3A%20center%3B%5Cn%20%20%20%20%20%20min-height%3A%20100vh%3B%5Cn%20%20%20%20%20%20background-color%3A%20%231a1a1a%3B%5Cn%20%20%20%20%20%20font-family%3A%20Arial%2C%20sans-serif%3B%5Cn%20%20%20%20%7D%22%7D%5D%7D%2C%7B%22nodeType%22%3A3%2C%22id%22%3A8%2C%22textContent%22%3A%22%5Cn%22%7D%5D%7D%2C%7B%22nodeType%22%3A3%2C%22id%22%3A9%2C%22textContent%22%3A%22%5Cn%22%7D%2C%7B%22nodeType%22%3A1%2C%22id%22%3A10%2C%22tagName%22%3A%22BODY%22%2C%22attributes%22%3A%7B%7D%2C%22childNodes%22%3A%5B%5D%7D%5D%7D%5D%7D";

    const html = "\n<!DOCTYPE html>\n<html>\n    <head>\n\t\t<script type=\"text/javascript\" src=\"/screenshot-scripts/javascripts/jquery.min.js\"></script>\n        <script type=\"text/javascript\">\n            if ('undefined' === typeof window.$) {\n                window.$ = jQuery;\n            }\n        </script>\n\t\t<script type=\"text/javascript\" src=\"/screenshot-scripts/libs/MutationObserver.js/MutationObserver.js\"></script>\n\t\t<script type=\"text/javascript\" src=\"/screenshot-scripts/libs/mutation-summary/src/mutation-summary.js\"></script>\n\t\t<script type=\"text/javascript\" src=\"/screenshot-scripts/libs/mutation-summary/util/code-detection.js\"></script>\n\t\t<script type=\"text/javascript\" src=\"/screenshot-scripts/libs/mutation-summary/util/tree-mirror.js\"></script>\n\t\t<script type=\"text/javascript\" src=\"/screenshot-scripts/libs/svg.js/dist/svg.min.js\"></script>\n\t\t<script type=\"text/javascript\" src=\"/screenshot-scripts/javascripts/recording.js\"></script>\n        <script type=\"text/javascript\">\n            window.XMLHttpRequest.prototype.open = function () {};\n            window.XMLHttpRequest = function () {};\n            window.fetch = function () {};\n            window.addEventListener(\n                'submit',\n                function (e) {\n                    e.preventDefault();\n                    e.stopPropagation();\n                    return false;\n                },\n                true\n            );\n        </script>\n        <script type=\"text/javascript\">\n            const baseUrl = '" + encodeURIComponent(baseUrl) + "';\n            window.recordingFrame = new HsrRecordingIframe(baseUrl);\n            const initialMutation = '" + encodedInitialMutation + "';\n\t\t\tconst heatmapBaseUrl = window.location.origin + '/screenshot-scripts';\n\n            try {\n                let decodedResponseText = decodeURIComponent(initialMutation)\n                    .replace(/&#39;/g, \"'\")\n                    .replace(/&quot;/g, '\"')\n                    .replace(/&amp;/g, '&')\n                    .replace(/&lt;/g, '<')\n                    .replace(/&gt;/g, '>');\n                generateTreeMirror(decodedResponseText);\n            } catch (error) {\n                console.log('Could not decode the string');\n                generateTreeMirror(initialMutation);\n            }\n\t\t\t\n            function generateTreeMirror(blobData) {\n                if (!window.recordingFrame.isSupportedBrowser()) {\n                    var notSupportedMessage = 'Browser not supported';\n                    console.log('browser not supported');\n                } else {\n                    window.recordingFrame.initialMutation(JSON.parse(blobData.replace(/^\"|\"$/g, '')));\n                }\n            }\n        </script>\n    </head>\n</html>";

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (error) {
    console.error("Screenshot proxy failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// WebSocket proxy handler (only for hmtype=2)
function setupWebSocketProxy(server) {
  const wss = new WebSocket.Server({ server: server, path: '/ws-proxy' });
  
  wss.on('connection', function connection(ws, req) {
    try {
      const reqUrl = new URL(req.url, 'http://localhost');
      const targetDomain = reqUrl.searchParams.get('hmtarget');
      const wsUrl = reqUrl.searchParams.get('hmws');
      
      if (!targetDomain || !wsUrl) {
        ws.close(1002, 'Missing target domain or WebSocket URL');
        return;
      }
      
      console.log('🔌 WebSocket proxy connection:', wsUrl);
      
      const targetWs = new WebSocket(wsUrl);
      
      ws.on('message', function message(data) {
        if (targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(data);
        }
      });
      
      targetWs.on('message', function message(data) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });
      
      targetWs.on('open', function open() {
        console.log('🔌 Target WebSocket connected');
      });
      
      targetWs.on('close', function close() {
        console.log('🔌 Target WebSocket closed');
        ws.close();
      });
      
      targetWs.on('error', function error(err) {
        console.error('🔌 Target WebSocket error:', err);
        ws.close(1011, 'Target WebSocket error');
      });
      
      ws.on('close', function close() {
        console.log('🔌 Client WebSocket closed');
        targetWs.close();
      });
      
    } catch (error) {
      console.error('🔌 WebSocket proxy error:', error);
      ws.close(1011, 'Proxy error');
    }
  });
}

// Routes
app.options('*', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.send();
});

app.get("/favicon.ico", function(req, res) {
  res.status(204).end();
});

// FIXED: Enhanced test POST endpoint
app.post("/test-post", function(req, res) {
  console.log("=== TEST POST ENDPOINT ===");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  console.log("Body type:", typeof req.body);
  res.json({
    message: "POST test successful",
    receivedBody: req.body,
    bodyType: typeof req.body,
    contentType: req.get("content-type"),
  });
});

// FIXED: Add rate limiting middleware for cart requests
const cartRequestTracker = new Map();
app.use("/cart", function(req, res, next) {
  const clientIp = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const key = clientIp + ":" + req.method + ":" + req.path;

  if (cartRequestTracker.has(key)) {
    const lastRequest = cartRequestTracker.get(key);
    if (now - lastRequest < 500) {
      // 500ms cooldown for cart requests
      return res.status(429).json({
        error: "Too many requests",
        message: "Please wait a moment before trying again",
      });
    }
  }

  cartRequestTracker.set(key, now);
  next();
});

app.get("/asset", handleAsset);
app.post("/asset", handleAsset);
app.put("/asset", handleAsset);
app.patch("/asset", handleAsset);
app.delete("/asset", handleAsset);

app.get("/screenshot-proxy", handleScreenshotProxy);

// Main proxy route
app.use("/", handleRequest);

// Error handling middleware
app.use(function(error, req, res, next) {
  console.error("Unhandled error:", error);
  if (!res.headersSent) {
    if (req.path.includes("/cart/") || req.path.includes("cart.js")) {
      res.status(500).json({
        error: "Server error",
        message: "Please try again in a moment",
      });
    } else {
      res.status(500).send("Internal server error");
    }
  }
});

// FIXED: Clean up tracking maps periodically
setInterval(function() {
  const now = Date.now();

  // Clean request tracker
  for (const entry of requestTracker.entries()) {
    const key = entry[0];
    const timestamp = entry[1];
    if (now - timestamp > 60000) {
      // 1 minute
      requestTracker.delete(key);
    }
  }

  // Clean cart request tracker
  for (const entry of cartRequestTracker.entries()) {
    const key = entry[0];
    const timestamp = entry[1];
    if (now - timestamp > 60000) {
      // 1 minute
      cartRequestTracker.delete(key);
    }
  }
}, 60000); // Clean every minute

// Create HTTP server and setup WebSocket proxy
const server = http.createServer(app);
setupWebSocketProxy(server);

// Start server
server.listen(PORT, function() {
  console.log("=================================");
  console.log("🚀 ENHANCED Dual-Mode Proxy Server running on port " + PORT);
  console.log("=================================");
  console.log("📋 AVAILABLE MODES:");
  console.log("🔧 hmtype=1: Complete original implementation (DEFAULT)");
  console.log("⚡ hmtype=2: Enhanced SPA implementation + WebSockets");
  console.log("=================================");
  console.log("✅ ORIGINAL FEATURES PRESERVED:");
  console.log("🛡️ Domain lock and protection scripts");
  console.log("🔄 Complete URL rewriting (srcset, CSS, JS literals)");
  console.log("📝 Form submission handling and rate limiting");
  console.log("🛒 Cart request processing and JSON rewriting");
  console.log("📸 Screenshot proxy functionality");
  console.log("🧹 Memory cleanup and request tracking");
  console.log("🏗️ Site-specific script injection");
  console.log("=================================");
  console.log("✅ NEW SPA FEATURES (hmtype=2):");
  console.log("📦 ES Module and dynamic import() support");
  console.log("🛤️ Client-side routing (History API)");
  console.log("🔌 WebSocket proxying for real-time features");
  console.log("⚙️ Service Worker interception");
  console.log("🌐 Enhanced CORS and relaxed CSP");
  console.log("=================================");
  console.log("Usage examples:");
  console.log("Original: http://localhost:" + PORT + "/?hmtarget=example.com&hmtype=1");
  console.log("Or simply: http://localhost:" + PORT + "/?hmtarget=example.com");
  console.log("SPA Mode: http://localhost:" + PORT + "/?hmtarget=spa-site.com&hmtype=2");
  console.log("Asset: http://localhost:" + PORT + "/asset?hmtarget=example.com&hmtype=1");
  console.log("WebSocket: ws://localhost:" + PORT + "/ws-proxy?hmtarget=spa-site.com&hmws=wss://spa-site.com/ws");
  console.log("=================================");
});

// Graceful shutdown
process.on("SIGTERM", function() {
  console.log("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", function() {
  console.log("SIGINT received, shutting down gracefully");
  process.exit(0);
});

module.exports = app;