const body = `<script type="text/javascript" async="" src="https://s3-us-west-2.amazonaws.com/b2bjsstore/b/DNXY8HK7KEO0/reb2b.js.gz"></script>`;
const target = "s3-us-west-2.amazonaws.com";
const proxyHost = "localhost:3000";
const protocol = "http";
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
  
    const domainLockScript = "\n<script>\n(function() {\n    'use strict';\n    \n    // ENHANCED: Multiple-layer protection approach\n    console.log('🛡️ SUPER EARLY DOMAIN LOCK ACTIVATED');\n    console.log('🛡️ Current location:', window.location.href);\n    console.log('🛡️ Current host:', window.location.host);\n    console.log('🛡️ Current hostname:', window.location.hostname);\n    \n    const TARGET_DOMAIN = '" + target + "';\n    const PROXY_HOST = '" + proxyHost + "';\n    const PROXY_PROTOCOL = '" + protocol + ":';\n    \n    // STRATEGY 1: Override critical location methods immediately\n    const originalAssign = window.location.assign;\n    const originalReplace = window.location.replace;\n    \n    \n    // STRATEGY 3: Override document.domain\n    try {\n        Object.defineProperty(document, 'domain', {\n            get: function() { return PROXY_HOST.split(':')[0]; },\n            set: function(value) {\n                console.warn('🛡️ BLOCKED document.domain set to:', value);\n                return PROXY_HOST.split(':')[0];\n            },\n            configurable: false\n        });\n        console.log('✅ Successfully locked document.domain');\n    } catch (e) {\n        console.error('❌ Could not lock document.domain:', e);\n    }\n    \n    // STRATEGY 4: Aggressive monitoring and correction\n    let lastHref = window.location.href;\n    let monitoringActive = true;\n    \n    const locationMonitor = setInterval(function() {\n        if (!monitoringActive) return;\n        \n        const currentHref = window.location.href;\n        if (currentHref !== lastHref) {\n            console.warn('🛡️ DETECTED LOCATION CHANGE:', lastHref, '->', currentHref);\n            \n            // Check for domain hijacking pattern: target.com:3000\n            if (currentHref.includes(TARGET_DOMAIN + ':') && !currentHref.includes(PROXY_HOST)) {\n                console.error('🛡️ CRITICAL: Domain hijack detected! Pattern:', TARGET_DOMAIN + ':3000');\n                console.log('🛡️ Attempting immediate correction...');\n                \n                try {\n                    monitoringActive = false; // Prevent recursive corrections\n                    const correctedUrl = currentHref.replace?.(TARGET_DOMAIN + ':', PROXY_HOST.split(':')[0] + ':');\n                    console.log('🛡️ Correcting to:', correctedUrl);\n                    window.location.replace?.(correctedUrl);\n                } catch (e) {\n                    console.error('🛡️ Could not correct domain hijack:', e);\n                    monitoringActive = true; // Re-enable monitoring\n                }\n            } else if (currentHref.includes(TARGET_DOMAIN) && !currentHref.includes('hmtarget=')) {\n                console.error('🛡️ CRITICAL: Direct target domain access detected!');\n                console.log('🛡️ Attempting to add proxy parameters...');\n                \n                try {\n                    monitoringActive = false;\n                    const separator = currentHref.includes('?') ? '&' : '?';\n                    const correctedUrl = currentHref + separator + 'hmtarget=' + TARGET_DOMAIN + '&hmtype=1';\n                    console.log('🛡️ Correcting to:', correctedUrl);\n                    window.location.replace?.(correctedUrl);\n                } catch (e) {\n                    console.error('🛡️ Could not add proxy parameters:', e);\n                    monitoringActive = true;\n                }\n            }\n            \n            lastHref = currentHref;\n        }\n    }, 50); // Check every 50ms for faster detection\n    \n    // STRATEGY 5: Override common redirect methods\n    const originalSetTimeout = window.setTimeout;\n    window.setTimeout = function(callback, delay) {\n        if (typeof callback === 'string' && callback.includes('location') && callback.includes(TARGET_DOMAIN)) {\n            console.warn('🛡️ BLOCKED malicious setTimeout with location change:', callback);\n            return;\n        }\n        return originalSetTimeout.apply(this, arguments);\n    };\n    \n    const originalSetInterval = window.setInterval;\n    window.setInterval = function(callback, delay) {\n        if (typeof callback === 'string' && callback.includes('location') && callback.includes(TARGET_DOMAIN)) {\n            console.warn('🛡️ BLOCKED malicious setInterval with location change:', callback);\n            return;\n        }\n        return originalSetInterval.apply(this, arguments);\n    };\n    \n    console.log('🛡️ MULTI-LAYER DOMAIN PROTECTION COMPLETED');\n    console.log('🛡️ Active protections: location.assign, location.replace, href setter, domain lock, monitoring');\n})();\n</script>";
  
    // FIXED: Enhanced JavaScript proxy interceptor with better loop prevention
    const proxyInterceptorScript = "\n<script>\n(function() {\n    'use strict';\n    \n    // Prevent multiple initializations\n    if (window.proxyInterceptorLoaded) {\n        console.log('🔧 Proxy interceptor already loaded, skipping...');\n        return;\n    }\n    window.proxyInterceptorLoaded = true;\n    \n    // Extract proxy parameters from current URL\n    const urlParams = new URLSearchParams(window.location.search);\n    const hmtarget = urlParams.get('hmtarget') || '" + target + "';\n    const hmtype = urlParams.get('hmtype') || '1';\n    const proxyHost = window.location.host;\n    const proxyProtocol = window.location.protocol;\n    \n    console.log('🔧 Proxy interceptor loaded for target:', hmtarget);\n    \n    // FIXED: Enhanced URL rewriting with better loop detection\n    function rewriteUrl(url, baseUrl) {\n        if (!url || typeof url !== 'string') return url;\n        \n        // Skip data URLs, blob URLs, and fragment-only URLs\n        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) {\n            return url;\n        }\n        \n        // FIXED: More robust check for already proxied URLs\n        if (url.includes('hmtarget=') && url.includes(proxyHost + '/')) {\n            console.log('🔄 URL already proxied, skipping:', url);\n            return url;\n        }\n        \n        let targetUrl;\n        \n        try {\n            if (url.startsWith('//')) {\n                // Protocol-relative URL: //domain.com/path\n                const domain = url.split('/')[2];\n                if (domain === proxyHost) return url; // Skip if already our proxy\n                \n                const path = url.substring(2 + domain.length);\n                const separator = path.includes('?') ? '&' : '?';\n                targetUrl = '//' + proxyHost + path + separator + 'hmtarget=' + domain + '&hmtype=1';\n            } else if (url.match(/^https?:\\/\\//)) {\n                // Absolute URL: https://domain.com/path\n                const urlObj = new URL(url);\n                if (urlObj.host === proxyHost) return url; // Already our proxy\n                \n                const separator = (urlObj.pathname + urlObj.search).includes('?') ? '&' : '?';\n                targetUrl = proxyProtocol + '//' + proxyHost + urlObj.pathname + urlObj.search + separator + 'hmtarget=' + urlObj.host + '&hmtype=1';\n            } else if (url.startsWith('/')) {\n                // Relative URL: /path\n                const separator = url.includes('?') ? '&' : '?';\n                targetUrl = proxyProtocol + '//' + proxyHost + url + separator + 'hmtarget=' + hmtarget + '&hmtype=1';\n            } else {\n                // Other relative URLs: path\n                const currentPath = window.location.pathname;\n                const basePath = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);\n                const fullPath = basePath + url;\n                const separator = fullPath.includes('?') ? '&' : '?';\n                targetUrl = proxyProtocol + '//' + proxyHost + fullPath + separator + 'hmtarget=' + hmtarget + '&hmtype=1';\n            }\n            \n            console.log('🔄 URL rewritten:', url, '→', targetUrl);\n            return targetUrl;\n        } catch (e) {\n            console.error('🔄 Error rewriting URL:', url, e);\n            return url;\n        }\n    }\n    \n    // FIXED: Enhanced fetch override with request deduplication\n    const originalFetch = window.fetch;\n    const pendingRequests = new Map();\n    \n    window.fetch = function(input, init) {\n        let url = input;\n        if (input instanceof Request) {\n            url = input.url;\n        }\n        \n        // FIXED: Prevent duplicate requests\n        const requestKey = (init && init.method || 'GET') + ':' + url;\n        if (pendingRequests.has(requestKey)) {\n            console.log('🌐 Duplicate request prevented:', url);\n            return pendingRequests.get(requestKey);\n        }\n        \n        const rewrittenUrl = rewriteUrl(url);\n        console.log('🌐 Fetch intercepted:', url, '→', rewrittenUrl);\n        \n        let requestPromise;\n        if (input instanceof Request) {\n            // Create new Request object with rewritten URL\n            const newRequest = new Request(rewrittenUrl, {\n                method: input.method,\n                headers: input.headers,\n                body: input.body,\n                mode: input.mode,\n                credentials: input.credentials,\n                cache: input.cache,\n                redirect: input.redirect,\n                referrer: input.referrer,\n                integrity: input.integrity\n            });\n            requestPromise = originalFetch.call(this, newRequest, init);\n        } else {\n            requestPromise = originalFetch.call(this, rewrittenUrl, init);\n        }\n        \n        // Store the promise to prevent duplicates\n        pendingRequests.set(requestKey, requestPromise);\n        \n        // Clean up after request completes\n        requestPromise.finally(function() {\n            pendingRequests.delete(requestKey);\n        });\n        \n        return requestPromise;\n    };\n    \n    // FIXED: Enhanced XMLHttpRequest override with better error handling\n    const OriginalXHR = window.XMLHttpRequest;\n    window.XMLHttpRequest = function() {\n        const xhr = new OriginalXHR();\n        const originalOpen = xhr.open;\n        \n        xhr.open = function(method, url, async, user, password) {\n            try {\n                const rewrittenUrl = rewriteUrl(url);\n                console.log('📡 XHR intercepted:', url, '→', rewrittenUrl);\n                return originalOpen.call(this, method, rewrittenUrl, async, user, password);\n            } catch (e) {\n                console.error('📡 XHR open error:', e);\n                return originalOpen.call(this, method, url, async, user, password);\n            }\n        };\n        \n        return xhr;\n    };\n    \n    // Copy static properties\n    Object.setPrototypeOf(window.XMLHttpRequest, OriginalXHR);\n    Object.setPrototypeOf(window.XMLHttpRequest.prototype, OriginalXHR.prototype);\n    \n    // FIXED: Enhanced form submission handling with rate limiting\n    let lastFormSubmission = 0;\n    const FORM_SUBMISSION_COOLDOWN = 1000; // 1 second\n    \n    document.addEventListener('submit', function(event) {\n        const now = Date.now();\n        if (now - lastFormSubmission < FORM_SUBMISSION_COOLDOWN) {\n            console.log('📝 Form submission rate limited');\n            event.preventDefault();\n            return false;\n        }\n        lastFormSubmission = now;\n        \n        const form = event.target;\n        if (form.action) {\n            const rewrittenAction = rewriteUrl(form.action);\n            if (rewrittenAction !== form.action) {\n                console.log('📝 Form action rewritten:', form.action, '→', rewrittenAction);\n                form.action = rewrittenAction;\n            }\n        }\n    }, true);\n    \n    // Override history methods\n    const originalPushState = history.pushState;\n    const originalReplaceState = history.replaceState;\n    \n    history.pushState = function(state, title, url) {\n        if (url) {\n            const rewrittenUrl = rewriteUrl(url);\n            console.log('🔗 PushState intercepted:', url, '→', rewrittenUrl);\n            return originalPushState.call(this, state, title, rewrittenUrl);\n        }\n        return originalPushState.call(this, state, title, url);\n    };\n    \n    history.replaceState = function(state, title, url) {\n        if (url) {\n            const rewrittenUrl = rewriteUrl(url);\n            console.log('🔗 ReplaceState intercepted:', url, '→', rewrittenUrl);\n            return originalReplaceState.call(this, state, title, rewrittenUrl);\n        }\n        return originalReplaceState.call(this, state, title, url);\n    };\n    \n    // FIXED: Enhanced anchor link handling with click rate limiting\n    let lastAnchorClick = 0;\n    const ANCHOR_CLICK_COOLDOWN = 300; // 300ms\n    \n    document.addEventListener('click', function(event) {\n        const now = Date.now();\n        if (now - lastAnchorClick < ANCHOR_CLICK_COOLDOWN) {\n            console.log('🔗 Anchor click rate limited');\n            return;\n        }\n        \n        const anchor = event.target.closest('a');\n        if (anchor && anchor.href && !anchor.target) {\n            lastAnchorClick = now;\n            const rewrittenHref = rewriteUrl(anchor.href);\n            if (rewrittenHref !== anchor.href) {\n                console.log('🔗 Anchor click intercepted:', anchor.href, '→', rewrittenHref);\n                anchor.href = rewrittenHref;\n            }\n        }\n    }, true);\n    \n    console.log('✅ Proxy interceptor fully loaded and active');\n\n    (function patchElementCreation() {\n    const originalCreateElement = Document.prototype.createElement;\n\n    Document.prototype.createElement = function(tagName) {\n        var args = Array.prototype.slice.call(arguments);\n        const element = originalCreateElement.apply(this, args);\n        const lowerTag = tagName.toLowerCase();\n\n        // Patch <script> tags\n        if (lowerTag === 'script') {\n            const originalSetAttribute = element.setAttribute.bind(element);\n\n            Object.defineProperty(element, 'src', {\n                get: function() {\n                    return element.getAttribute('src');\n                },\n                set: function(value) {\n                    const rewritten = rewriteUrl(value);\n                    console.log('🧠 [createElement] Script src rewritten:', value, '→', rewritten);\n                    originalSetAttribute('src', rewritten);\n                },\n                configurable: true,\n                enumerable: true,\n            });\n\n            element.setAttribute = function(name, value) {\n                if (name === 'src') {\n                    const rewritten = rewriteUrl(value);\n                    console.log('🧠 [setAttribute] Script src rewritten:', value, '→', rewritten);\n                    return originalSetAttribute(name, rewritten);\n                }\n                return originalSetAttribute(name, value);\n            };\n        }\n\n        // Patch <link rel=\"stylesheet\">\n        if (lowerTag === 'link') {\n            const originalSetAttribute = element.setAttribute.bind(element);\n\n            Object.defineProperty(element, 'href', {\n                get: function() {\n                    return element.getAttribute('href');\n                },\n                set: function(value) {\n                    const rewritten = rewriteUrl(value);\n                    console.log('🎨 [createElement] Link href rewritten:', value, '→', rewritten);\n                    originalSetAttribute('href', rewritten);\n                },\n                configurable: true,\n                enumerable: true,\n            });\n\n            element.setAttribute = function(name, value) {\n                if (name === 'href') {\n                    const rewritten = rewriteUrl(value);\n                    console.log('🎨 [setAttribute] Link href rewritten:', value, '→', rewritten);\n                    return originalSetAttribute(name, rewritten);\n                }\n                return originalSetAttribute(name, value);\n            };\n        }\n\n        return element;\n    };\n    })();\n\n\n})();\n\n  \n\n</script>";
  
    // CRITICAL: Remove ALL meta refresh tags
    const metaRefreshRegex =
      /<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi;
    let metaMatches = content.match(metaRefreshRegex);
    if (metaMatches) {
      console.log("🔍 DEBUGGING: Found meta refresh tags:", metaMatches);
      content = content.replace?.(
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
      content = content.replace?.(
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
          content = content.replace?.(pattern, function(match) {
            console.log("🛡️ NEUTRALIZED location change:", match);
            return "console.warn('🛡️ Blocked location change: " + match.replace?.(
              /'/g,
              "\\'"
            ) + "')";
          });
        }
      });
    }
  
    // SUPER AGGRESSIVE: Remove any script tags that mention the target domain
    const targetDomainScriptRegex = new RegExp(
      "<script[^>]*>[^<]*" + target.replace?.(".", "\\.") + "[^<]*</script>",
      "gi"
    );
    let scriptMatches = content.match(targetDomainScriptRegex);
    if (scriptMatches) {
      console.log(
        "🔍 DEBUGGING: Found scripts mentioning target domain:",
        scriptMatches.length
      );
      content = content.replace?.(
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
        content = content.replace?.(
          "<head>",
          "<head>" + siteSpecificScript + domainLockScript + proxyInterceptorScript
        );
      }else{
        content = content.replace?.(
          "<html",
          siteSpecificScript + domainLockScript + proxyInterceptorScript + "<html"
        );
      }
    }
  
    // Remove problematic scripts
    content = content.replace?.(
      /<script[^>]*?data-locksmith[^>]*?>.*?<\/script>/gis,
      ""
    );
    content = content.replace?.(
      /<script[^>]*?type="application\/vnd\.locksmith\+json"[^>]*?>.*?<\/script>/gis,
      ""
    );
  
    // FIXED: More robust URL rewriting with better loop detection
  
    // 1. Protocol-relative URLs (//domain.com/path)
    content = content.replace?.(
      /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])\/\/([^\/\s"']+)(\/[^"']*)(["'])/gi,
      function(match, prefix, domain, path, suffix) {
        if (domain === proxyHost || path.includes("hmtarget=")) return match;
  
        const separator = path.includes("?") ? "&" : "?";
        const rewrittenUrl = "//" + proxyHost + path + separator + "hmtarget=" + domain + "&hmtype=1";
        return prefix + rewrittenUrl + suffix;
      }
    );
  
    // 2. Absolute URLs (https://domain.com/path)
    content = content.replace?.(
      /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])https?:\/\/([^\/\s"']+)(\/[^"']*)(["'])/gi,
      function(match, prefix, domain, path, suffix) {
        if (domain === proxyHost || path.includes("hmtarget=")) return match;
  
        const separator = path.includes("?") ? "&" : "?";
        const rewrittenUrl = protocol + "://" + proxyHost + path + separator + "hmtarget=" + domain + "&hmtype=1";
        return prefix + rewrittenUrl + suffix;
      }
    );
  
    // 3. Relative URLs starting with /
    content = content.replace?.(
      /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])(\/[^\/\s"'][^"']*)(["'])/gi,
      function(match, prefix, path, suffix) {
        if (path.includes("hmtarget=")) return match;
  
        const separator = path.includes("?") ? "&" : "?";
        const rewrittenUrl = protocol + "://" + proxyHost + path + separator + "hmtarget=" + target + "&hmtype=1";
        return prefix + rewrittenUrl + suffix;
      }
    );
  
    // 4. FIXED: Enhanced srcset handling with better loop detection
    content = content.replace?.(
      /((?:srcset|data-srcset|dt)\s*=\s*["'])([^"']+)(["'])/gi,
      function(match, prefix, urls, suffix) {
        // Skip if already processed
        if (urls.includes("hmtarget=")) return match;
  
        const rewrittenUrls = urls
          .replace?.(
            /https?:\/\/([^\/\s,]+)([^\s,]*)/g,
            function(urlMatch, domain, path) {
              if (domain === proxyHost || path.includes("hmtarget="))
                return urlMatch;
              const separator = path.includes("?") ? "&" : "?";
              return protocol + "://" + proxyHost + path + separator + "hmtarget=" + domain + "&hmtype=1";
            }
          )
          .replace?.(/\/\/([^\/\s,]+)([^\s,]*)/g, function(urlMatch, domain, path) {
            if (domain === proxyHost || path.includes("hmtarget="))
              return urlMatch;
            const separator = path.includes("?") ? "&" : "?";
            return "//" + proxyHost + path + separator + "hmtarget=" + domain + "&hmtype=1";
          });
  
        return prefix + rewrittenUrls + suffix;
      }
    );
  
    // 5. CSS url() functions
    content = content.replace?.(
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
    content = content.replace?.(
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
    content = content.replace?.(
      /(\$\{window\.location\.origin\})(\/[^`'"}\s]*)/gi,
      function(match, originPart, path) {
        if (path.includes("hmtarget=")) return match;
  
        const separator = path.includes("?") ? "&" : "?";
        const rewrittenPath = path + separator + "hmtarget=" + target + "&hmtype=1";
        return originPart + rewrittenPath;
      }
    );
  
    // 8. FIXED: Window.location concatenation
    content = content.replace?.(
      /(window\.location\.origin\s*\+\s*['"`])(\/[^'"`]*?)(['"`])/gi,
      function(match, prefix, path, suffix) {
        if (path.includes("hmtarget=")) return match;
  
        const separator = path.includes("?") ? "&" : "?";
        const rewrittenPath = path + separator + "hmtarget=" + target + "&hmtype=1";
        return prefix + rewrittenPath + suffix;
      }
    );
  
    // 9. FIXED: Enhanced fetch() rewriting
    content = content.replace?.(
      /(fetch\s*\(\s*[`'"])(\/.+?)([`'"]\s*\))/gi,
      function(match, prefix, path, suffix) {
        if (path.includes("hmtarget=")) return match;
  
        const separator = path.includes("?") ? "&" : "?";
        const rewrittenPath = path + separator + "hmtarget=" + target + "&hmtype=1";
        return prefix + rewrittenPath + suffix;
      }
    );
  
    // 10. Root URL (just "/")
    content = content.replace?.(
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
    content = content.replace?.(
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
    content = content.replace?.(
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

  const m = rewriteUrls(body,target,proxyHost,protocol);
  console.log(m);
