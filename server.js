const express = require("express");
const dns = require("dns").promises;
const url = require("url");
const zlib = require("zlib");

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
    throw new Error(`Failed to resolve domain after ${failed.count} attempts`);
  }

  try {
    const addresses = await dns.resolve4(domain);
    if (addresses && addresses.length > 0) {
      const ip = addresses[0];
      dnsCache.set(domain, { ip, timestamp: Date.now() });
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
  return patterns.some((pattern) => pattern.test(checkText));
}

function rewriteLocationHeader(location, target, proxyHost, protocol = "http") {
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
        const newLocation = `${protocol}://${proxyHost}${locationUrl.pathname}${locationUrl.search}${separator}hmtarget=${target}&hmtype=1`;
        console.log("🔍 DEBUGGING: Rewritten Location:", newLocation);
        return newLocation;
      }
    } catch (e) {
      console.log("🔍 DEBUGGING: Error parsing Location URL:", e);
    }
  } else if (location.startsWith("/")) {
    // Relative URL
    const separator = location.includes("?") ? "&" : "?";
    const newLocation = `${protocol}://${proxyHost}${location}${separator}hmtarget=${target}&hmtype=1`;
    console.log("🔍 DEBUGGING: Rewritten relative Location:", newLocation);
    return newLocation;
  }

  console.log("🔍 DEBUGGING: Location unchanged:", location);
  return location;
}

// FIXED: URL rewriting function with loop prevention
function rewriteUrls(body, target, proxyHost, protocol = "http") {
  if (!body) return body;

  let content = body.toString();

  console.log("=== Starting URL Rewriting ===");
  console.log(
    "Input target:",
    target,
    "Input proxyHost:",
    proxyHost,
    "Protocol:",
    protocol
  );

  const domainLockScript = `
    <script>
(function() {
    'use strict';
       console.log('🛡️ SUPER EARLY DOMAIN LOCK ACTIVATED');
    console.log('🛡️ Current location:', window.location.href);
    console.log('🛡️ Current host:', window.location.host);
    console.log('🛡️ Current hostname:', window.location.hostname);
    
    const TARGET_DOMAIN = '${target}';
    const PROXY_HOST = '${proxyHost}';
    const PROXY_PROTOCOL = '${protocol}:';
    
    // NUCLEAR OPTION: Override ALL location properties immediately
    const originalLocation = window.location;
    
    // Create a completely locked location object
    const lockedLocation = {
        href: originalLocation.href,
        protocol: PROXY_PROTOCOL,
        host: PROXY_HOST,
        hostname: PROXY_HOST.split(':')[0],
        port: PROXY_HOST.includes(':') ? PROXY_HOST.split(':')[1] : '',
        pathname: originalLocation.pathname,
        search: originalLocation.search,
        hash: originalLocation.hash,
        origin: PROXY_PROTOCOL + '//' + PROXY_HOST,
        
        toString: function() { return this.href; },
        
        assign: function(url) {
            console.warn('🛡️ BLOCKED location.assign to:', url);
            if (url.includes(TARGET_DOMAIN) && !url.includes(PROXY_HOST)) {
                console.warn('🛡️ Prevented domain hijack via assign');
                return false;
            } return originalLocation.assign(url);
        },
        
        replace: function(url) {
            console.warn('🛡️ BLOCKED location.replace to:', url);
            if (url.includes(TARGET_DOMAIN) && !url.includes(PROXY_HOST)) {
                console.warn('🛡️ Prevented domain hijack via replace');
                return false;
            }
            return originalLocation.replace(url);
        },
        reload: function() {
            return originalLocation.reload();
        }// NUCLEAR: Override getters/setters for location properties
    
        Object.defineProperty(lockedLocation, 'href', {
        get: function() {
            const current = originalLocation.href;
            if (current.includes(TARGET_DOMAIN) && !current.includes(PROXY_HOST)) {
                console.warn('🛡️ Detected domain hijack in href getter, correcting...');
                return current.replace(TARGET_DOMAIN, PROXY_HOST);
            }return current;
        },
        set: function(value) {
            console.warn('🛡️ BLOCKED href set to:', value);
            if (value.includes(TARGET_DOMAIN) && !value.includes(PROXY_HOST)) {
                console.warn('🛡️ Prevented domain hijack via href setter');
                return;
            }
            originalLocation.href = value;
        }
        
        Object.defineProperty(lockedLocation, 'hostname', {
            get: function() { return PROXY_HOST.split(':')[0]; },
            set: function(value) {
                console.warn('🛡️ BLOCKED hostname set to:', value);
                return PROXY_HOST.split(':')[0];
            }});

             Object.defineProperty(lockedLocation, 'host', {
        get: function() { return PROXY_HOST; },
        set: function(value) {
            console.warn('🛡️ BLOCKED host set to:', value);
            return PROXY_HOST;
        } });

        // NUCLEAR: Replace window.location entirely
    try {
        Object.defineProperty(window, 'location', {
            get: function() { return lockedLocation; },
            set: function(value) {
                console.warn('🛡️ BLOCKED window.location set to:', value);
                if (typeof value === 'string' && value.includes(TARGET_DOMAIN) && !value.includes(PROXY_HOST)) {
                    console.warn('🛡️ Prevented domain hijack via window.location setter');
                    return;
                }
                if (typeof value === 'string') {
                    lockedLocation.href = value;
                }
            },
            configurable: false,
            writable: false
        });
    } catch (e) {
        console.error('🛡️ Could not lock window.location:', e);
    }// NUCLEAR: Monitor for any changes to location
    let lastHref = window.location.href;
    setInterval(function() {
        const currentHref = originalLocation.href;
        if (currentHref !== lastHref) {
            console.warn('🛡️ DETECTED LOCATION CHANGE:', lastHref, '->', currentHref);
            if (currentHref.includes(TARGET_DOMAIN + ':') && !currentHref.includes(PROXY_HOST)) {
                console.error('🛡️ CRITICAL: Domain hijack detected! Attempting to correct...');
                try {
                    const correctedUrl = currentHref.replace(TARGET_DOMAIN, PROXY_HOST);
                    console.log('🛡️ Attempting to correct to:', correctedUrl);
                    originalLocation.replace(correctedUrl);
                } catch (e) {
                    console.error('🛡️ Could not correct domain hijack:', e);
                }
            }
            lastHref = currentHref;
        }}, 100); // Check every 100ms
        console.log('🛡️ SUPER EARLY DOMAIN LOCK COMPLETED');
})();
</script>
    `;

  // FIXED: Enhanced JavaScript proxy interceptor with better loop prevention
  const proxyInterceptorScript = `
<script>
(function() {
    'use strict';
    
    // Prevent multiple initializations
    if (window.proxyInterceptorLoaded) {
        console.log('🔧 Proxy interceptor already loaded, skipping...');
        return;
    }
    window.proxyInterceptorLoaded = true;
    
    // Extract proxy parameters from current URL
    const urlParams = new URLSearchParams(window.location.search);
    const hmtarget = urlParams.get('hmtarget') || '${target}';
    const hmtype = urlParams.get('hmtype') || '1';
    const proxyHost = window.location.host;
    const proxyProtocol = window.location.protocol;
    
    console.log('🔧 Proxy interceptor loaded for target:', hmtarget);
    
    // FIXED: Enhanced URL rewriting with better loop detection
    function rewriteUrl(url, baseUrl) {
        if (!url || typeof url !== 'string') return url;
        
        // Skip data URLs, blob URLs, and fragment-only URLs
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) {
            return url;
        }
        
        // FIXED: More robust check for already proxied URLs
        if (url.includes('hmtarget=') && url.includes(proxyHost + '/')) {
            console.log('🔄 URL already proxied, skipping:', url);
            return url;
        }
        
        let targetUrl;
        
        try {
            if (url.startsWith('//')) {
                // Protocol-relative URL: //domain.com/path
                const domain = url.split('/')[2];
                if (domain === proxyHost) return url; // Skip if already our proxy
                
                const path = url.substring(2 + domain.length);
                const separator = path.includes('?') ? '&' : '?';
                targetUrl = \`//\${proxyHost}\${path}\${separator}hmtarget=\${domain}&hmtype=1\`;
            } else if (url.match(/^https?:\\/\\//)) {
                // Absolute URL: https://domain.com/path
                const urlObj = new URL(url);
                if (urlObj.host === proxyHost) return url; // Already our proxy
                
                const separator = (urlObj.pathname + urlObj.search).includes('?') ? '&' : '?';
                targetUrl = \`\${proxyProtocol}//\${proxyHost}\${urlObj.pathname}\${urlObj.search}\${separator}hmtarget=\${urlObj.host}&hmtype=1\`;
            } else if (url.startsWith('/')) {
                // Relative URL: /path
                const separator = url.includes('?') ? '&' : '?';
                targetUrl = \`\${proxyProtocol}//\${proxyHost}\${url}\${separator}hmtarget=\${hmtarget}&hmtype=1\`;
            } else {
                // Other relative URLs: path
                const currentPath = window.location.pathname;
                const basePath = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);
                const fullPath = basePath + url;
                const separator = fullPath.includes('?') ? '&' : '?';
                targetUrl = \`\${proxyProtocol}//\${proxyHost}\${fullPath}\${separator}hmtarget=\${hmtarget}&hmtype=1\`;
            }
            
            console.log('🔄 URL rewritten:', url, '→', targetUrl);
            return targetUrl;
        } catch (e) {
            console.error('🔄 Error rewriting URL:', url, e);
            return url;
        }
    }
    
    // FIXED: Enhanced fetch override with request deduplication
    const originalFetch = window.fetch;
    const pendingRequests = new Map();
    
    window.fetch = function(input, init) {
        let url = input;
        if (input instanceof Request) {
            url = input.url;
        }
        
        // FIXED: Prevent duplicate requests
        const requestKey = \`\${init?.method || 'GET'}:\${url}\`;
        if (pendingRequests.has(requestKey)) {
            console.log('🌐 Duplicate request prevented:', url);
            return pendingRequests.get(requestKey);
        }
        
        const rewrittenUrl = rewriteUrl(url);
        console.log('🌐 Fetch intercepted:', url, '→', rewrittenUrl);
        
        let requestPromise;
        if (input instanceof Request) {
            // Create new Request object with rewritten URL
            const newRequest = new Request(rewrittenUrl, {
                method: input.method,
                headers: input.headers,
                body: input.body,
                mode: input.mode,
                credentials: input.credentials,
                cache: input.cache,
                redirect: input.redirect,
                referrer: input.referrer,
                integrity: input.integrity
            });
            requestPromise = originalFetch.call(this, newRequest, init);
        } else {
            requestPromise = originalFetch.call(this, rewrittenUrl, init);
        }
        
        // Store the promise to prevent duplicates
        pendingRequests.set(requestKey, requestPromise);
        
        // Clean up after request completes
        requestPromise.finally(() => {
            pendingRequests.delete(requestKey);
        });
        
        return requestPromise;
    };
    
    // FIXED: Enhanced XMLHttpRequest override with better error handling
    const OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        const xhr = new OriginalXHR();
        const originalOpen = xhr.open;
        
        xhr.open = function(method, url, async, user, password) {
            try {
                const rewrittenUrl = rewriteUrl(url);
                console.log('📡 XHR intercepted:', url, '→', rewrittenUrl);
                return originalOpen.call(this, method, rewrittenUrl, async, user, password);
            } catch (e) {
                console.error('📡 XHR open error:', e);
                return originalOpen.call(this, method, url, async, user, password);
            }
        };
        
        return xhr;
    };
    
    // Copy static properties
    Object.setPrototypeOf(window.XMLHttpRequest, OriginalXHR);
    Object.setPrototypeOf(window.XMLHttpRequest.prototype, OriginalXHR.prototype);
    
    // FIXED: Enhanced form submission handling with rate limiting
    let lastFormSubmission = 0;
    const FORM_SUBMISSION_COOLDOWN = 1000; // 1 second
    
    document.addEventListener('submit', function(event) {
        const now = Date.now();
        if (now - lastFormSubmission < FORM_SUBMISSION_COOLDOWN) {
            console.log('📝 Form submission rate limited');
            event.preventDefault();
            return false;
        }
        lastFormSubmission = now;
        
        const form = event.target;
        if (form.action) {
            const rewrittenAction = rewriteUrl(form.action);
            if (rewrittenAction !== form.action) {
                console.log('📝 Form action rewritten:', form.action, '→', rewrittenAction);
                form.action = rewrittenAction;
            }
        }
    }, true);
    
    // Override history methods
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    
    history.pushState = function(state, title, url) {
        if (url) {
            const rewrittenUrl = rewriteUrl(url);
            console.log('🔗 PushState intercepted:', url, '→', rewrittenUrl);
            return originalPushState.call(this, state, title, rewrittenUrl);
        }
        return originalPushState.call(this, state, title, url);
    };
    
    history.replaceState = function(state, title, url) {
        if (url) {
            const rewrittenUrl = rewriteUrl(url);
            console.log('🔗 ReplaceState intercepted:', url, '→', rewrittenUrl);
            return originalReplaceState.call(this, state, title, rewrittenUrl);
        }
        return originalReplaceState.call(this, state, title, url);
    };
    
    // FIXED: Enhanced anchor link handling with click rate limiting
    let lastAnchorClick = 0;
    const ANCHOR_CLICK_COOLDOWN = 300; // 300ms
    
    document.addEventListener('click', function(event) {
        const now = Date.now();
        if (now - lastAnchorClick < ANCHOR_CLICK_COOLDOWN) {
            console.log('🔗 Anchor click rate limited');
            return;
        }
        
        const anchor = event.target.closest('a');
        if (anchor && anchor.href && !anchor.target) {
            lastAnchorClick = now;
            const rewrittenHref = rewriteUrl(anchor.href);
            if (rewrittenHref !== anchor.href) {
                console.log('🔗 Anchor click intercepted:', anchor.href, '→', rewrittenHref);
                anchor.href = rewrittenHref;
            }
        }
    }, true);
    
    console.log('✅ Proxy interceptor fully loaded and active');
})();
</script>`;

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

  // CRITICAL: Remove/neutralize JavaScript that changes location
  const locationChangePatterns = [
    /window\.location\s*=\s*["'][^"']*["']/gi,
    /document\.location\s*=\s*["'][^"']*["']/gi,
    /location\.href\s*=\s*["'][^"']*["']/gi,
    /location\.replace\s*\([^)]*\)/gi,
    /location\.assign\s*\([^)]*\)/gi,
    /window\.location\.href\s*=\s*["'][^"']*["']/gi,
    /window\.location\.replace\s*\([^)]*\)/gi,
    /window\.location\.assign\s*\([^)]*\)/gi,
  ];

  locationChangePatterns.forEach((pattern, index) => {
    let matches = content.match(pattern);
    if (matches) {
      console.log(
        `🔍 DEBUGGING: Found location change pattern ${index}:`,
        matches
      );
      content = content.replace(pattern, (match) => {
        console.log("🛡️ NEUTRALIZED location change:", match);
        return `console.warn('🛡️ Blocked location change: ${match.replace(
          /'/g,
          "\\'"
        )}');`;
      });
    }
  });

  // SUPER AGGRESSIVE: Remove any script tags that mention the target domain
  const targetDomainScriptRegex = new RegExp(
    `<script[^>]*>[^<]*${target.replace(".", "\\.")}[^<]*</script>`,
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
 if (content.includes('<!DOCTYPE')) {
    content = content.replace('<!DOCTYPE', domainLockScript + proxyInterceptorScript + '<!DOCTYPE');
} else if (content.includes('<html')) {
    content = content.replace('<html', domainLockScript + proxyInterceptorScript + '<html');
} else if (content.includes('<head>')) {
    content = content.replace('<head>', '<head>' + domainLockScript + proxyInterceptorScript);
} else {
    // Fallback: prepend to the beginning
    content = domainLockScript + proxyInterceptorScript + content;
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
    (match, prefix, domain, path, suffix) => {
      if (domain === proxyHost || path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenUrl = `//${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
      return `${prefix}${rewrittenUrl}${suffix}`;
    }
  );

  // 2. Absolute URLs (https://domain.com/path)
  content = content.replace(
    /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])https?:\/\/([^\/\s"']+)(\/[^"']*)(["'])/gi,
    (match, prefix, domain, path, suffix) => {
      if (domain === proxyHost || path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenUrl = `${protocol}://${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
      return `${prefix}${rewrittenUrl}${suffix}`;
    }
  );

  // 3. Relative URLs starting with /
  content = content.replace(
    /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])(\/[^\/\s"'][^"']*)(["'])/gi,
    (match, prefix, path, suffix) => {
      if (path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenUrl = `${protocol}://${proxyHost}${path}${separator}hmtarget=${target}&hmtype=1`;
      return `${prefix}${rewrittenUrl}${suffix}`;
    }
  );

  // 4. FIXED: Enhanced srcset handling with better loop detection
  content = content.replace(
    /((?:srcset|data-srcset|dt)\s*=\s*["'])([^"']+)(["'])/gi,
    (match, prefix, urls, suffix) => {
      // Skip if already processed
      if (urls.includes("hmtarget=")) return match;

      const rewrittenUrls = urls
        .replace(
          /https?:\/\/([^\/\s,]+)([^\s,]*)/g,
          (urlMatch, domain, path) => {
            if (domain === proxyHost || path.includes("hmtarget="))
              return urlMatch;
            const separator = path.includes("?") ? "&" : "?";
            return `${protocol}://${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
          }
        )
        .replace(/\/\/([^\/\s,]+)([^\s,]*)/g, (urlMatch, domain, path) => {
          if (domain === proxyHost || path.includes("hmtarget="))
            return urlMatch;
          const separator = path.includes("?") ? "&" : "?";
          return `//${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
        });

      return `${prefix}${rewrittenUrls}${suffix}`;
    }
  );

  // 5. CSS url() functions
  content = content.replace(
    /url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi,
    (match, url) => {
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
        const rewrittenUrl = `//${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
        return `url("${rewrittenUrl}")`;
      } else if (url.match(/^https?:\/\//)) {
        try {
          const urlObj = new URL(url);
          if (urlObj.host === proxyHost) return match;

          const separator = (urlObj.pathname + urlObj.search).includes("?")
            ? "&"
            : "?";
          const rewrittenUrl = `${protocol}://${proxyHost}${urlObj.pathname}${urlObj.search}${separator}hmtarget=${urlObj.host}&hmtype=1`;
          return `url("${rewrittenUrl}")`;
        } catch (e) {
          return match;
        }
      } else if (url.startsWith("/")) {
        const separator = url.includes("?") ? "&" : "?";
        const rewrittenUrl = `${protocol}://${proxyHost}${url}${separator}hmtarget=${target}&hmtype=1`;
        return `url("${rewrittenUrl}")`;
      }
      return match;
    }
  );

  // 6. FIXED: Enhanced JavaScript string literal rewriting
  content = content.replace(
    /(['"`])\/\/([^\/\s'"`]+)([^'"`]*)\1/g,
    (match, quote, domain, path) => {
      if (
        match.includes("/*") ||
        match.includes("//") ||
        domain === proxyHost ||
        path.includes("hmtarget=")
      ) {
        return match;
      }

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenUrl = `//${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
      return `${quote}${rewrittenUrl}${quote}`;
    }
  );

  // 7. FIXED: Template literals with better detection
  content = content.replace(
    /(\$\{window\.location\.origin\})(\/[^`'"}\s]*)/gi,
    (match, originPart, path) => {
      if (path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenPath = `${path}${separator}hmtarget=${target}&hmtype=1`;
      return `${originPart}${rewrittenPath}`;
    }
  );

  // 8. FIXED: Window.location concatenation
  content = content.replace(
    /(window\.location\.origin\s*\+\s*['"`])(\/[^'"`]*?)(['"`])/gi,
    (match, prefix, path, suffix) => {
      if (path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenPath = `${path}${separator}hmtarget=${target}&hmtype=1`;
      return `${prefix}${rewrittenPath}${suffix}`;
    }
  );

  // 9. FIXED: Enhanced fetch() rewriting
  content = content.replace(
    /(fetch\s*\(\s*[`'"])(\/.+?)([`'"]\s*\))/gi,
    (match, prefix, path, suffix) => {
      if (path.includes("hmtarget=")) return match;

      const separator = path.includes("?") ? "&" : "?";
      const rewrittenPath = `${path}${separator}hmtarget=${target}&hmtype=1`;
      return `${prefix}${rewrittenPath}${suffix}`;
    }
  );

  // 10. Root URL (just "/")
  content = content.replace(
    /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])(\/)(["'])/gi,
    (match, prefix, path, suffix) => {
      console.log("🔍 DEBUGGING: Found root URL:", match);
      const rewrittenUrl = `${protocol}://${proxyHost}/?hmtarget=${target}&hmtype=1`;
      console.log(
        "🔍 DEBUGGING: Rewritten root URL to:",
        `${prefix}${rewrittenUrl}${suffix}`
      );
      return `${prefix}${rewrittenUrl}${suffix}`;
    }
  );

  // 11. Query-only URLs (just "?")
  content = content.replace(
    /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])(\?)([^"']*)(["'])/gi,
    (match, prefix, questionMark, query, suffix) => {
      if (query.includes("hmtarget=")) return match;

      console.log("🔍 DEBUGGING: Found query-only URL:", match);
      const separator = query ? "&" : "";
      const rewrittenUrl = `${protocol}://${proxyHost}/?${query}${separator}hmtarget=${target}&hmtype=1`;
      console.log(
        "🔍 DEBUGGING: Rewritten query-only URL to:",
        `${prefix}${rewrittenUrl}${suffix}`
      );
      return `${prefix}${rewrittenUrl}${suffix}`;
    }
  );

  // 12. Empty URLs (href="" or src="")
  content = content.replace(
    /((?:href|action)\s*=\s*["'])(["'])/gi,
    (match, prefix, suffix) => {
      console.log("🔍 DEBUGGING: Found empty URL:", match);
      const rewrittenUrl = `${protocol}://${proxyHost}/?hmtarget=${target}&hmtype=1`;
      console.log(
        "🔍 DEBUGGING: Rewritten empty URL to:",
        `${prefix}${rewrittenUrl}${suffix}`
      );
      return `${prefix}${rewrittenUrl}${suffix}`;
    }
  );

  console.log("URL rewriting completed");
  return content;
}

// Function to rewrite Location headers
function rewriteLocationHeader(location, target, proxyHost, protocol = "http") {
  if (!location) return null;

  // If it's a full URL, rewrite it
  if (location.match(/^https?:\/\//)) {
    const locationUrl = new URL(location);
    const separator = (locationUrl.pathname + locationUrl.search).includes("?")
      ? "&"
      : "?";
    return `${protocol}://${proxyHost}${locationUrl.pathname}${locationUrl.search}${separator}hmtarget=${locationUrl.host}&hmtype=1`;
  } else {
    // If it's a relative URL, make it absolute through our proxy
    if (location.startsWith("/")) {
      const separator = location.includes("?") ? "&" : "?";
      return `${protocol}://${proxyHost}${location}${separator}hmtarget=${target}&hmtype=1`;
    }
  }
  return location;
}

// FIXED: Enhanced cart JSON URL rewriting
function rewriteCartJsonUrls(body, target, proxyHost, protocol = "http") {
  if (!body) return body;

  let content = body.toString();
  console.log("Rewriting cart JSON URLs with protocol:", protocol);

  // FIXED: Better JSON URL rewriting with loop detection
  content = content.replace(/"url"\s*:\s*"(\/[^"]*)"/gi, (match, url) => {
    if (url.includes("hmtarget=")) return match;

    const separator = url.includes("?") ? "&" : "?";
    return `"url":"${url}${separator}hmtarget=${target}&hmtype=1"`;
  });

  // FIXED: Better CDN URL rewriting
  content = content.replace(
    /"(https:\/\/cdn\.shopify\.com\/[^"]*)"/gi,
    (match, cdnUrl) => {
      if (cdnUrl.includes("hmtarget=")) return match;

      try {
        const urlObj = new URL(cdnUrl);
        const separator = (urlObj.pathname + urlObj.search).includes("?")
          ? "&"
          : "?";
        return `"${protocol}://${proxyHost}${urlObj.pathname}${urlObj.search}${separator}hmtarget=${urlObj.host}&hmtype=1"`;
      } catch (e) {
        const encodedUrl = encodeURIComponent(cdnUrl);
        return `"${protocol}://${proxyHost}/asset?hmtarget=${target}&hmtype=2&hmurl=${encodedUrl}"`;
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
  const requestId = `${options.method}:${targetUrl}`;
  const now = Date.now();

  if (requestTracker.has(requestId)) {
    const lastRequest = requestTracker.get(requestId);
    if (now - lastRequest < 200) {
      // 1 second cooldown
      console.log("Request blocked - too frequent:", requestId);
      throw new Error("Request rate limited");
    }
  }
  requestTracker.set(requestId, now);

  while (redirects < MAX_REDIRECTS && retries < MAX_RETRIES) {
    try {
      // Clean up headers
      const cleanHeaders = {};
      Object.keys(options.headers).forEach((key) => {
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
          console.log('🔍 DEBUGGING: Made redirect absolute:', newUrl);
        }

         // CRITICAL: Check if redirect is trying to hijack domain
         try {
            const redirectUrl = new URL(newUrl);
            const originalUrl = new URL(currentUrl);
            
            if (redirectUrl.hostname !== originalUrl.hostname) {
                console.warn('🛡️ SUSPICIOUS: Cross-domain redirect detected');
                console.warn('🛡️ From:', originalUrl.hostname, 'to:', redirectUrl.hostname);
            }
        } catch (e) {
            console.log('🔍 DEBUGGING: Could not parse redirect URLs for analysis');
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
      console.error(`Request attempt ${retries} failed:`, error.message);

      if (retries >= MAX_RETRIES) {
        throw error;
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
    }
  }

  throw new Error("Maximum retries exceeded");
}

// FIXED: Enhanced main request handler with better error handling
async function handleRequest(req, res, next) {
  try {
    console.log("=== New Request ===");
    console.log("Request URL:", req.url);
    console.log("Request method:", req.method);
    console.log("Request path:", req.path);
    console.log("Query params:", req.query);

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

    // Extract target from query parameters
    const target = req.query.hmtarget;
    if (!target) {
      return res.status(400).send("No target specified");
    }

    // Clean up target
    const cleanTarget = target.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    console.log("Clean target:", cleanTarget);

    const requestPath = req.path;

    // Remove proxy-specific parameters from query
    const cleanQuery = { ...req.query };
    delete cleanQuery.hmtarget;
    delete cleanQuery.hmtype;
    delete cleanQuery.hmurl;

    // Build the target URL
    const queryString = new URLSearchParams(cleanQuery).toString();
    const targetUrl = `https://${cleanTarget}${requestPath}${
      queryString ? "?" + queryString : ""
    }`;

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
    if (proxyRes.headers['location']) {
        const originalLocation = proxyRes.headers['location'];
        const rewrittenLocation = rewriteLocationHeader(originalLocation, cleanTarget, req.get('host'), req.protocol || 'http');
        if (rewrittenLocation !== originalLocation) {
            proxyRes.headers['location'] = rewrittenLocation;
            console.log('🛡️ REWRITTEN Location header:', originalLocation, '->', rewrittenLocation);
        }
    }

    // Set response status and headers
    res.status(proxyRes.status);

    // Copy response headers
    Object.keys(proxyRes.headers).forEach((key) => {
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
          res.set(key, "frame-ancestors *");
        } else if (lowerKey !== "x-frame-options") {
          res.set(key, proxyRes.headers[key]);
        }
      }
    });

   // Force our own CSP
   res.set('Content-Security-Policy', 'frame-ancestors *');
        
   // CRITICAL: Add no-cache headers to prevent caching issues
   res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
   res.set('Pragma', 'no-cache');
   res.set('Expires', '0');

    // Process response body
    const contentType = proxyRes.headers["content-type"] || "";
    const isHtml =
      contentType.includes("text/html") || looksLikeHTML(proxyRes.body);

    console.log("Content-Type:", contentType);
    console.log("Is HTML:", isHtml);

    if (isHtml) {
      console.log("Processing HTML content with URL rewriting");
      const protocol = req.protocol || req.get("x-forwarded-proto") || "http";
      const rewrittenBody = rewriteUrls(
        proxyRes.body,
        cleanTarget,
        req.get("host"),
        protocol
      );
      res.send(rewrittenBody);
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
      res.status(500).send(`Request failed: ${error.message}`);
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

      const cleanQuery = { ...urlParts.query };
      delete cleanQuery.hmtarget;
      delete cleanQuery.hmtype;
      delete cleanQuery.hmurl;

      const queryString = new URLSearchParams(cleanQuery).toString();
      targetUrl = `https://${cleanTarget}${targetPath}${
        queryString ? "?" + queryString : ""
      }`;
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

    Object.keys(proxyRes.headers).forEach((key) => {
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
    res.status(500).send(`Asset request failed: ${error.message}`);
  }
}

// Screenshot proxy handler (unchanged)
async function handleScreenshotProxy(req, res) {
  try {
    console.log("=== Screenshot Proxy Request ===");
    const {
      initialMutationUrl,
      idSite,
      idSiteHsr,
      deviceType,
      baseUrl = "",
    } = req.query;

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
      throw new Error(`HTTP ${response.status}`);
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

    const html = `
<!DOCTYPE html>
<html>
    <head>
		<script type="text/javascript" src="/screenshot-scripts/javascripts/jquery.min.js"></script>
        <script type="text/javascript">
            if ('undefined' === typeof window.$) {
                window.$ = jQuery;
            }
        </script>
		<script type="text/javascript" src="/screenshot-scripts/libs/MutationObserver.js/MutationObserver.js"></script>
		<script type="text/javascript" src="/screenshot-scripts/libs/mutation-summary/src/mutation-summary.js"></script>
		<script type="text/javascript" src="/screenshot-scripts/libs/mutation-summary/util/code-detection.js"></script>
		<script type="text/javascript" src="/screenshot-scripts/libs/mutation-summary/util/tree-mirror.js"></script>
		<script type="text/javascript" src="/screenshot-scripts/libs/svg.js/dist/svg.min.js"></script>
		<script type="text/javascript" src="/screenshot-scripts/javascripts/recording.js"></script>
        <script type="text/javascript">
            window.XMLHttpRequest.prototype.open = function () {};
            window.XMLHttpRequest = function () {};
            window.fetch = function () {};
            window.addEventListener(
                'submit',
                function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                },
                true
            );
        </script>
        <script type="text/javascript">
            const baseUrl = '${encodeURIComponent(baseUrl)}';
            window.recordingFrame = new HsrRecordingIframe(baseUrl);
            const initialMutation = \`${encodedInitialMutation}\`;
			const heatmapBaseUrl = \`\${window.location.origin}/screenshot-scripts\`;

            try {
                let decodedResponseText = decodeURIComponent(initialMutation)
                    .replace(/&#39;/g, "'")
                    .replace(/&quot;/g, '"')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>');
                generateTreeMirror(decodedResponseText);
            } catch (error) {
                console.log('Could not decode the string');
                generateTreeMirror(initialMutation);
            }
			
            function generateTreeMirror(blobData) {
                if (!window.recordingFrame.isSupportedBrowser()) {
                    var notSupportedMessage = 'Browser not supported';
                    console.log('browser not supported');
                } else {
                    window.recordingFrame.initialMutation(JSON.parse(blobData.replace(/^"|"$/g, '')));
                }
            }
        </script>
    </head>
</html>`;

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (error) {
    console.error("Screenshot proxy failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// Routes
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

// FIXED: Enhanced test POST endpoint
app.post("/test-post", (req, res) => {
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
app.use("/cart", (req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const key = `${clientIp}:${req.method}:${req.path}`;

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
app.use((error, req, res, next) => {
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
setInterval(() => {
  const now = Date.now();

  // Clean request tracker
  for (const [key, timestamp] of requestTracker.entries()) {
    if (now - timestamp > 60000) {
      // 1 minute
      requestTracker.delete(key);
    }
  }

  // Clean cart request tracker
  for (const [key, timestamp] of cartRequestTracker.entries()) {
    if (now - timestamp > 60000) {
      // 1 minute
      cartRequestTracker.delete(key);
    }
  }
}, 60000); // Clean every minute

// Start server
app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`FIXED Proxy server running on port ${PORT}`);
  console.log(`=================================`);
  console.log(`🚀 FIXES APPLIED:`);
  console.log(`✅ Request rate limiting and loop prevention`);
  console.log(`✅ Enhanced cart request handling`);
  console.log(`✅ Better error handling for cart operations`);
  console.log(`✅ Improved URL rewriting with loop detection`);
  console.log(`✅ JavaScript interceptor enhancements`);
  console.log(`✅ Request deduplication`);
  console.log(`=================================`);
  console.log(`Usage examples:`);
  console.log(
    `Main proxy: http://localhost:${PORT}/?hmtarget=example.com&hmtype=1`
  );
  console.log(
    `Asset proxy: http://localhost:${PORT}/asset?hmtarget=example.com&hmtype=2`
  );
  console.log(`=================================`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  process.exit(0);
});

module.exports = app;
