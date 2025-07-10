const express = require('express');
const dns = require('dns').promises;
const url = require('url');
const zlib = require('zlib');

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

// Middleware for parsing request bodies
app.use(express.json({ limit: '50mb' })); // For JSON payloads
app.use(express.urlencoded({ extended: true, limit: '50mb' })); // For form data
app.use(express.raw({ type: '*/*', limit: '50mb' })); // For other content types

// Helper function to get common headers
function getCommonHeaders(target, originalHeaders = {}, hasBody = false) {
    const headers = {
        'Host': target,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'X-Forwarded-For': originalHeaders['x-forwarded-for'] || '127.0.0.1',
        'X-Forwarded-Proto': 'https'
    };

    // Only preserve important headers when appropriate
    if (originalHeaders['cookie']) {
        headers['Cookie'] = originalHeaders['cookie'];
    }
    
    // Only include content-type for requests with body
    if (hasBody && originalHeaders['content-type']) {
        headers['Content-Type'] = originalHeaders['content-type'];
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
        throw new Error('No A records found');
    } catch (error) {
        // Track failures
        const currentFailed = failedDomains.get(domain) || { count: 0, time: Date.now() };
        failedDomains.set(domain, { count: currentFailed.count + 1, time: Date.now() });
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
        /<link[^>]*>/i
    ];
    
    const checkText = body.toString().substring(0, 1000).toLowerCase();
    return patterns.some(pattern => pattern.test(checkText));
}

// URL rewriting function for HTML content
function rewriteUrls(body, target, proxyHost, protocol = 'http') {
    if (!body) return body;
    
    let content = body.toString();
    
    console.log('=== Starting URL Rewriting ===');
    console.log('Input target:', target, 'Input proxyHost:', proxyHost, 'Protocol:', protocol);
    
    // INJECT JAVASCRIPT PROXY INTERCEPTOR AT THE BEGINNING
    const proxyInterceptorScript = `
<script>
(function() {
    'use strict';
    
    // Extract proxy parameters from current URL
    const urlParams = new URLSearchParams(window.location.search);
    const hmtarget = urlParams.get('hmtarget') || '${target}';
    const hmtype = urlParams.get('hmtype') || '1';
    const proxyHost = window.location.host;
    const proxyProtocol = window.location.protocol;
    
    console.log('🔧 Proxy interceptor loaded for target:', hmtarget);
    
    // Function to rewrite URLs to go through proxy
    function rewriteUrl(url, baseUrl) {
        if (!url || typeof url !== 'string') return url;
        
        // Skip data URLs, blob URLs, and fragment-only URLs
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) {
            return url;
        }
        
        // Skip if already proxied
        if (url.includes('hmtarget=')) {
            return url;
        }
        
        let targetUrl;
        
        if (url.startsWith('//')) {
            // Protocol-relative URL: //domain.com/path
            const domain = url.split('/')[2];
            const path = url.substring(2 + domain.length);
            const separator = path.includes('?') ? '&' : '?';
            targetUrl = \`//\${proxyHost}\${path}\${separator}hmtarget=\${domain}&hmtype=1\`;
        } else if (url.match(/^https?:\\/\\//)) {
            // Absolute URL: https://domain.com/path
            try {
                const urlObj = new URL(url);
                if (urlObj.host === proxyHost) return url; // Already our proxy
                const separator = (urlObj.pathname + urlObj.search).includes('?') ? '&' : '?';
                targetUrl = \`\${proxyProtocol}//\${proxyHost}\${urlObj.pathname}\${urlObj.search}\${separator}hmtarget=\${urlObj.host}&hmtype=1\`;
            } catch (e) {
                return url;
            }
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
    }
    
    // Override fetch()
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        let url = input;
        if (input instanceof Request) {
            url = input.url;
        }
        
        const rewrittenUrl = rewriteUrl(url);
        console.log('🌐 Fetch intercepted:', url, '→', rewrittenUrl);
        
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
            return originalFetch.call(this, newRequest, init);
        } else {
            return originalFetch.call(this, rewrittenUrl, init);
        }
    };
    
    // Override XMLHttpRequest
    const OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        const xhr = new OriginalXHR();
        const originalOpen = xhr.open;
        
        xhr.open = function(method, url, async, user, password) {
            const rewrittenUrl = rewriteUrl(url);
            console.log('📡 XHR intercepted:', url, '→', rewrittenUrl);
            return originalOpen.call(this, method, rewrittenUrl, async, user, password);
        };
        
        return xhr;
    };
    
    // Copy static properties
    Object.setPrototypeOf(window.XMLHttpRequest, OriginalXHR);
    Object.setPrototypeOf(window.XMLHttpRequest.prototype, OriginalXHR.prototype);
    
    // Override form submissions
    document.addEventListener('submit', function(event) {
        const form = event.target;
        if (form.action) {
            const rewrittenAction = rewriteUrl(form.action);
            if (rewrittenAction !== form.action) {
                console.log('📝 Form action rewritten:', form.action, '→', rewrittenAction);
                form.action = rewrittenAction;
            }
        }
    }, true);
    
    // Override window.location changes
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
    
    // Override anchor link clicks
    document.addEventListener('click', function(event) {
        const anchor = event.target.closest('a');
        if (anchor && anchor.href && !anchor.target) {
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

    // Inject the script right after <head> or at the beginning of <body>
    if (content.includes('<head>')) {
        content = content.replace('<head>', '<head>' + proxyInterceptorScript);
    } else if (content.includes('<html>')) {
        content = content.replace('<html>', '<html>' + proxyInterceptorScript);
    } else {
        // Fallback: prepend to the beginning
        content = proxyInterceptorScript + content;
    }
    
    // Remove all data-locksmith scripts
    content = content.replace(/<script[^>]*?data-locksmith[^>]*?>.*?<\/script>/gis, '');
    
    // Remove application/vnd.locksmith+json scripts
    content = content.replace(/<script[^>]*?type="application\/vnd\.locksmith\+json"[^>]*?>.*?<\/script>/gis, '');

    // Modify scripts that check hostname
    content = content.replace(
        /(<script[^>]*>\s*\(\(\)\s*=>\s*{\s*const\s+hosts\s*=\s*\[)([^\]]+)(\].+?window\.location\.hostname[^<]*<\/script>)/gis,
        (match, start, hosts, end) => {
            return start + hosts + ",'" + proxyHost + "','heatmap.com','heatmapcore.com'" + end;
        }
    );

    // 1. MOST IMPORTANT: Rewrite protocol-relative URLs (//domain.com/path)
    // Example: //thejellybee.com/cdn/shop/t/94/assets/vendor.min.js?v=123
    // Should become: //localhost:3000/cdn/shop/t/94/assets/vendor.min.js?v=123&hmtarget=thejellybee.com&hmtype=1
    content = content.replace(
        /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])\/\/([^\/\s"']+)(\/[^"']*)(["'])/gi,
        (match, prefix, domain, path, suffix) => {
            if (domain === proxyHost) return match; // Skip if already our proxy
            
            console.log('=== Protocol-relative URL match ===');
            console.log('Full match:', match);
            console.log('Prefix:', prefix);
            console.log('Domain:', domain);
            console.log('Path:', path);
            console.log('Suffix:', suffix);
            console.log('ProxyHost:', proxyHost);
            
            // Check if path already has query parameters
            const separator = path.includes('?') ? '&' : '?';
            const rewrittenUrl = `//${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
            
            console.log('Separator used:', separator);
            console.log('Final rewritten URL:', rewrittenUrl);
            console.log('Complete result:', prefix + rewrittenUrl + suffix);
            console.log('=== End match ===');
            
            return `${prefix}${rewrittenUrl}${suffix}`;
        }
    );

    // 2. Rewrite absolute URLs (https://domain.com/path or http://domain.com/path)
    // Example: https://thejellybee.com/cdn/shop/assets/file.css?v=123
    // Should become: http://localhost:3000/cdn/shop/assets/file.css?v=123&hmtarget=thejellybee.com&hmtype=1 (if server is HTTP)
    content = content.replace(
        /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])https?:\/\/([^\/\s"']+)(\/[^"']*)(["'])/gi,
        (match, prefix, domain, path, suffix) => {
            if (domain === proxyHost) return match; // Skip if already our proxy
            
            // Check if path already has query parameters
            const separator = path.includes('?') ? '&' : '?';
            const rewrittenUrl = `${protocol}://${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
            
            console.log('Rewriting absolute URL:', `https://${domain}${path}`, '→', rewrittenUrl);
            return `${prefix}${rewrittenUrl}${suffix}`;
        }
    );

    // 3. Rewrite relative URLs that start with / (but not //)
    // Example: /assets/file.js?v=123
    // Should become: http://localhost:3000/assets/file.js?v=123&hmtarget=target&hmtype=1 (if server is HTTP)
    content = content.replace(
        /((?:src|href|action|data-src|data-href|d-src|poster|background|cite|formaction)\s*=\s*["'])(\/[^\/\s"'][^"']*)(["'])/gi,
        (match, prefix, path, suffix) => {
            if (path.includes('hmtarget=')) return match; // Skip if already proxied
            
            // Check if path already has query parameters
            const separator = path.includes('?') ? '&' : '?';
            const rewrittenUrl = `${protocol}://${proxyHost}${path}${separator}hmtarget=${target}&hmtype=1`;
            
            console.log('Rewriting relative URL:', path, '→', rewrittenUrl);
            return `${prefix}${rewrittenUrl}${suffix}`;
        }
    );

    // 4. Handle srcset and similar multi-URL attributes specially (can contain multiple URLs)
    content = content.replace(/((?:srcset|data-srcset|dt)\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, urls, suffix) => {
        console.log('Processing multi-URL attribute:', prefix.trim(), 'with URLs:', urls);
        
        // Process each URL in the attribute (separated by commas)
        const rewrittenUrls = urls.replace(/https?:\/\/([^\/\s,]+)([^\s,]*)/g, (urlMatch, domain, path) => {
            // Handle absolute URLs (https://domain.com/path)
            if (domain === proxyHost) return urlMatch;
            const separator = path.includes('?') ? '&' : '?';
            return `${protocol}://${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
        }).replace(/\/\/([^\/\s,]+)([^\s,]*)/g, (urlMatch, domain, path) => {
            // Handle protocol-relative URLs (//domain.com/path) - but only if not already processed
            if (domain === proxyHost || urlMatch.includes('hmtarget=')) return urlMatch;
            const separator = path.includes('?') ? '&' : '?';
            return `//${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
        });
        
        console.log('Multi-URL attribute rewritten from:', urls);
        console.log('Multi-URL attribute rewritten to:', rewrittenUrls);
        return `${prefix}${rewrittenUrls}${suffix}`;
    });

    // 5. Rewrite CSS url() functions in style tags and inline styles
    content = content.replace(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, url) => {
        if (url.startsWith('data:') || url.startsWith('#')) return match;
        
        if (url.startsWith('//')) {
            // Protocol-relative URL
            const parts = url.substring(2).split('/');
            const domain = parts[0];
            const path = url.substring(2 + domain.length);
            if (domain === proxyHost) return match;
            
            const separator = path.includes('?') ? '&' : '?';
            const rewrittenUrl = `//${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
            
            console.log('Rewriting CSS protocol-relative URL:', url, '→', rewrittenUrl);
            return `url("${rewrittenUrl}")`;
        } else if (url.match(/^https?:\/\//)) {
            // Absolute URL
            try {
                const urlObj = new URL(url);
                if (urlObj.host === proxyHost) return match;
                
                const separator = (urlObj.pathname + urlObj.search).includes('?') ? '&' : '?';
                const rewrittenUrl = `${protocol}://${proxyHost}${urlObj.pathname}${urlObj.search}${separator}hmtarget=${urlObj.host}&hmtype=1`;
                
                console.log('Rewriting CSS absolute URL:', url, '→', rewrittenUrl);
                return `url("${rewrittenUrl}")`;
            } catch (e) {
                return match;
            }
        } else if (url.startsWith('/')) {
            // Absolute path
            const separator = url.includes('?') ? '&' : '?';
            const rewrittenUrl = `${protocol}://${proxyHost}${url}${separator}hmtarget=${target}&hmtype=1`;
            
            console.log('Rewriting CSS relative URL:', url, '→', rewrittenUrl);
            return `url("${rewrittenUrl}")`;
        }
        return match;
    });

    // 6. Rewrite JavaScript fetch, XMLHttpRequest, and other dynamic URLs in string literals
    content = content.replace(/(['"`])\/\/([^\/\s'"`]+)([^'"`]*)\1/g, (match, quote, domain, path) => {
        // Skip if it looks like a comment
        if (match.includes('/*') || match.includes('//')) {
            return match;
        }
        if (domain === proxyHost) return match;
        
        const separator = path.includes('?') ? '&' : '?';
        const rewrittenUrl = `//${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
        
        console.log('Rewriting JS protocol-relative URL:', '//' + domain + path, '→', rewrittenUrl);
        return `${quote}${rewrittenUrl}${quote}`;
    });

    // 7. Update main.js script tags with proper rewriting
    content = content.replace(
        /(<script[^>]*src=["'])((?:\/\/|https?:\/\/)([^\/]+))(\/[^"']*main\.js[^"']*)(["'][^>]*)(>)/gi,
        (match, prefix, fullDomain, domain, path, suffix, closing) => {
            if (domain === proxyHost) return match;
            
            const separator = path.includes('?') ? '&' : '?';
            let rewrittenUrl;
            
            if (fullDomain.startsWith('//')) {
                rewrittenUrl = `//${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
            } else {
                rewrittenUrl = `${protocol}://${proxyHost}${path}${separator}hmtarget=${domain}&hmtype=1`;
            }
            
            console.log('Rewriting main.js script:', fullDomain + path, '→', rewrittenUrl);
            return `${prefix}${rewrittenUrl}${suffix} data-original-domain="${domain}"${closing}`;
        }
    );
    
    console.log('URL rewriting completed');
    return content;
}

// Function to rewrite Location headers
function rewriteLocationHeader(location, target, proxyHost, protocol = 'http') {
    if (!location) return null;
    
    // If it's a full URL, rewrite it
    if (location.match(/^https?:\/\//)) {
        const locationUrl = new URL(location);
        const separator = (locationUrl.pathname + locationUrl.search).includes('?') ? '&' : '?';
        return `${protocol}://${proxyHost}${locationUrl.pathname}${locationUrl.search}${separator}hmtarget=${locationUrl.host}&hmtype=1`;
    } else {
        // If it's a relative URL, make it absolute through our proxy
        if (location.startsWith('/')) {
            const separator = location.includes('?') ? '&' : '?';
            return `${protocol}://${proxyHost}${location}${separator}hmtarget=${target}&hmtype=1`;
        }
    }
    return location;
}

// Function to rewrite cart JSON URLs
function rewriteCartJsonUrls(body, target, proxyHost, protocol = 'http') {
    if (!body) return body;
    
    let content = body.toString();
    console.log('Rewriting cart JSON URLs with protocol:', protocol);
    
    // Rewrite relative URLs in JSON
    content = content.replace(/"url"\s*:\s*"(\/[^"]*)"/gi, (match, url) => {
        const separator = url.includes('?') ? '&' : '?';
        return `"url":"${url}${separator}hmtarget=${target}&hmtype=1"`;
    });
    
    // Rewrite CDN URLs
    content = content.replace(/"(https:\/\/cdn\.shopify\.com\/[^"]*)"/gi, (match, cdnUrl) => {
        try {
            const urlObj = new URL(cdnUrl);
            const separator = (urlObj.pathname + urlObj.search).includes('?') ? '&' : '?';
            return `"${protocol}://${proxyHost}${urlObj.pathname}${urlObj.search}${separator}hmtarget=${urlObj.host}&hmtype=1"`;
        } catch (e) {
            // Fallback to asset proxy
            const encodedUrl = encodeURIComponent(cdnUrl);
            return `"${protocol}://${proxyHost}/asset?hmtarget=${target}&hmtype=2&hmurl=${encodedUrl}"`;
        }
    });
    
    // Rewrite other external URLs
    content = content.replace(/"(https:\/\/[^"]*)"/gi, (match, externalUrl) => {
        if (externalUrl.includes(proxyHost)) {
            return match;
        }
        try {
            const urlObj = new URL(externalUrl);
            const separator = (urlObj.pathname + urlObj.search).includes('?') ? '&' : '?';
            return `"${protocol}://${proxyHost}${urlObj.pathname}${urlObj.search}${separator}hmtarget=${urlObj.host}&hmtype=1"`;
        } catch (e) {
            // Fallback to asset proxy
            const encodedUrl = encodeURIComponent(externalUrl);
            return `"${protocol}://${proxyHost}/asset?hmtarget=${target}&hmtype=2&hmurl=${encodedUrl}"`;
        }
    });
    
    return content;
}

// Make proxy request with retry logic
async function makeProxyRequest(targetUrl, options) {
    let redirects = 0;
    let retries = 0;
    let currentUrl = targetUrl;

    while (redirects < MAX_REDIRECTS && retries < MAX_RETRIES) {
        try {
            // Clean up headers - remove undefined values and problematic headers
            const cleanHeaders = {};
            Object.keys(options.headers).forEach(key => {
                const value = options.headers[key];
                if (value !== undefined && value !== null && value !== '') {
                    // Skip headers that should not be set manually or that cause issues
                    const lowerKey = key.toLowerCase();
                    if (!['content-length', 'transfer-encoding', 'connection', 'accept-encoding'].includes(lowerKey)) {
                        cleanHeaders[key] = value;
                    }
                }
            });

            // Force no compression to avoid decoding issues
            cleanHeaders['Accept-Encoding'] = 'identity';

            const requestOptions = {
                method: options.method,
                headers: cleanHeaders,
                redirect: 'manual', // Handle redirects manually
                signal: AbortSignal.timeout(15000) // 15 second timeout
            };

            // Add body for methods that support it
            if (options.body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method.toUpperCase())) {
                requestOptions.body = options.body;
                
                // Set Content-Length if body is provided and not already set
                if (!cleanHeaders['Content-Length']) {
                    if (typeof options.body === 'string') {
                        cleanHeaders['Content-Length'] = Buffer.byteLength(options.body, 'utf8').toString();
                    } else if (Buffer.isBuffer(options.body)) {
                        cleanHeaders['Content-Length'] = options.body.length.toString();
                    }
                }
                
                console.log('POST request body type:', typeof options.body);
                console.log('POST request body length:', cleanHeaders['Content-Length']);
                if (typeof options.body === 'string') {
                    console.log('POST request body preview:', options.body.substring(0, 200));
                }
            }

            console.log('Making request to:', currentUrl);
            console.log('Request method:', requestOptions.method);
            console.log('Request headers:', cleanHeaders);

            const response = await fetch(currentUrl, requestOptions);

            // Handle redirects
            if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
                redirects++;
                if (redirects >= MAX_REDIRECTS) {
                    throw new Error('Too many redirects');
                }

                let newUrl = response.headers.get('location');
                if (!newUrl.match(/^https?:\/\//)) {
                    const baseUrl = new URL(currentUrl);
                    newUrl = baseUrl.origin + newUrl;
                }
                currentUrl = newUrl;
                console.log('Following redirect to:', currentUrl);
                continue;
            }

            // Get response body as text first, then convert to buffer
            let body;
            const contentType = response.headers.get('content-type') || '';
            
            try {
                if (contentType.includes('text/') || contentType.includes('application/json') || contentType.includes('application/javascript')) {
                    body = Buffer.from(await response.text(), 'utf8');
                } else {
                    body = Buffer.from(await response.arrayBuffer());
                }
            } catch (bodyError) {
                console.error('Error reading response body:', bodyError);
                body = Buffer.alloc(0); // Empty buffer as fallback
            }

            console.log('Response status:', response.status);
            console.log('Response Content-Type:', contentType);
            console.log('Response body length:', body.length);
            
            // Log response for POST requests
            if (options.method === 'POST') {
                console.log('=== POST RESPONSE ===');
                console.log('Status:', response.status);
                console.log('Headers:', Object.fromEntries(response.headers.entries()));
                if (body.length > 0 && body.length < 1000) {
                    console.log('Response body:', body.toString());
                } else if (body.length > 0) {
                    console.log('Response body preview:', body.toString().substring(0, 500));
                }
                console.log('=== END POST RESPONSE ===');
            }

            // Clean response headers - remove compression-related headers since we're not using compression
            const responseHeaders = Object.fromEntries(response.headers.entries());
            delete responseHeaders['content-encoding'];
            delete responseHeaders['content-length']; // Let Express handle this

            return {
                status: response.status,
                headers: responseHeaders,
                body: body
            };

        } catch (error) {
            retries++;
            console.error(`Request attempt ${retries} failed:`, error.message);
            
            // Special handling for POST request errors
            if (options.method === 'POST') {
                console.error('POST request failed with error:', error);
                console.error('Target URL:', currentUrl);
                console.error('Body type:', typeof options.body);
                console.error('Headers:', options.headers);
            }
            
            if (retries >= MAX_RETRIES) {
                throw error;
            }
            
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        }
    }

    throw new Error('Maximum retries exceeded');
}

// Main request handler
async function handleRequest(req, res, next) {
    try {
        console.log('=== New Request ===');
        console.log('Request URL:', req.url);
        console.log('Request method:', req.method);
        console.log('Request path:', req.path);
        console.log('Query params:', req.query);
        console.log('Content-Type:', req.get('content-type'));
        
        // Special logging for POST requests
        if (req.method === 'POST') {
            console.log('=== POST REQUEST DETECTED ===');
            console.log('Raw body type:', typeof req.body);
            console.log('Raw body length:', req.body ? (req.body.length || Object.keys(req.body).length || 'unknown') : 0);
            console.log('Content-Type:', req.get('content-type'));
            console.log('Content-Length:', req.get('content-length'));
            console.log('Request headers:', JSON.stringify(req.headers, null, 2));
            
            if (req.body) {
                if (typeof req.body === 'string') {
                    console.log('Body (string):', req.body.substring(0, 500));
                } else if (Buffer.isBuffer(req.body)) {
                    console.log('Body (buffer):', req.body.toString().substring(0, 500));
                } else if (typeof req.body === 'object') {
                    console.log('Body (object):', JSON.stringify(req.body, null, 2));
                }
            } else {
                console.log('No body found in request');
            }
            console.log('=== END POST DEBUG ===');
        }
        
        // Extract target from query parameters
        const target = req.query.hmtarget;
        if (!target) {
            return res.status(400).send('No target specified');
        }

        // Clean up target
        const cleanTarget = target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        console.log('Clean target:', cleanTarget);

        // For the new URL structure, we need to use the actual request path
        const requestPath = req.path; // This will be /cdn/shop/assets/file.js
        
        // Remove proxy-specific parameters from query
        const cleanQuery = { ...req.query };
        delete cleanQuery.hmtarget;
        delete cleanQuery.hmtype;
        delete cleanQuery.hmurl;
        
        // Build the target URL using the actual request path
        const queryString = new URLSearchParams(cleanQuery).toString();
        const targetUrl = `https://${cleanTarget}${requestPath}${queryString ? '?' + queryString : ''}`;
        
        console.log('Request path:', requestPath);
        console.log('Clean query params:', cleanQuery);
        console.log('Final target URL:', targetUrl);

        // Prepare headers and body
        const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.body;
        const headers = getCommonHeaders(cleanTarget, req.headers, hasBody);
        
        // Handle different content types for POST requests
        let requestBody = null;
        if (hasBody) {
            if (req.get('content-type')?.includes('application/json')) {
                requestBody = JSON.stringify(req.body);
                console.log('Using JSON body:', requestBody);
            } else if (req.get('content-type')?.includes('application/x-www-form-urlencoded')) {
                // Express already parsed this into an object, convert back to form data
                requestBody = new URLSearchParams(req.body).toString();
                console.log('Using form-encoded body:', requestBody);
            } else if (Buffer.isBuffer(req.body)) {
                requestBody = req.body;
                console.log('Using buffer body, length:', req.body.length);
            } else if (typeof req.body === 'string') {
                requestBody = req.body;
                console.log('Using string body:', requestBody.substring(0, 200));
            } else {
                // Fallback: try to JSON stringify
                requestBody = JSON.stringify(req.body);
                console.log('Using fallback JSON body:', requestBody);
            }
        }
        
        // Handle cart section requests - remove caching headers
        if (req.url.includes('sections=cart')) {
            delete headers['If-Modified-Since'];
            delete headers['If-None-Match'];
            headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
            headers['Pragma'] = 'no-cache';
            console.log('Disabled caching for cart section request');
        }

        // Make request to target
        console.log('Making proxy request...');
        const proxyRes = await makeProxyRequest(targetUrl, {
            method: req.method,
            headers: headers,
            body: requestBody
        });

        console.log('Proxy response received, status:', proxyRes.status);

        // Set response status and headers
        res.status(proxyRes.status);
        
        // Copy response headers, filtering out problematic ones
        Object.keys(proxyRes.headers).forEach(key => {
            const lowerKey = key.toLowerCase();
            if (!['connection', 'transfer-encoding', 'content-encoding', 'content-length'].includes(lowerKey)) {
                if (lowerKey === 'content-security-policy') {
                    res.set(key, 'frame-ancestors *');
                } else if (lowerKey !== 'x-frame-options') {
                    res.set(key, proxyRes.headers[key]);
                }
            }
        });

        // Always set our CSP
        res.set('Content-Security-Policy', 'frame-ancestors *');

        // Process response body
        const contentType = proxyRes.headers['content-type'] || '';
        const isHtml = contentType.includes('text/html') || looksLikeHTML(proxyRes.body);
        
        console.log('Content-Type:', contentType);
        console.log('Is HTML:', isHtml);
        console.log('Request path:', req.path);

        if (isHtml) {
            console.log('Processing HTML content with URL rewriting');
            // Determine protocol based on the incoming request
            const protocol = req.protocol || (req.get('x-forwarded-proto')) || 'http';
            console.log('Using protocol:', protocol);
            
            const rewrittenBody = rewriteUrls(proxyRes.body, cleanTarget, req.get('host'), protocol);
            res.send(rewrittenBody);
        } else if (contentType.includes('application/json') && (req.path.includes('/cart/') || req.path.includes('cart.js'))) {
            console.log('Processing JSON cart response');
            const protocol = req.protocol || (req.get('x-forwarded-proto')) || 'http';
            const rewrittenBody = rewriteCartJsonUrls(proxyRes.body, cleanTarget, req.get('host'), protocol);
            res.send(rewrittenBody);
        } else if (contentType.includes('javascript') && req.path.includes('main.js')) {
            console.log('Processing main.js file');
            let body = proxyRes.body.toString();
            
            // Modify domain array in main.js
            body = body.replace(/(e\.exports\s*=\s*\[)([^\]]+)(\])/, (match, start, domains, end) => {
                // Parse existing domains
                const domainList = domains.replace(/["'\s]/g, '').split(',').filter(d => d);
                
                // Add our domains if not present
                const ourDomains = [req.get('host'), 'heatmap.com', 'heatmapcore.com', 'portal.heatmap.com'];
                ourDomains.forEach(domain => {
                    if (!domainList.includes(domain)) {
                        domainList.push(domain);
                    }
                });
                
                return start + '"' + domainList.join('", "') + '"' + end;
            });
            
            res.send(body);
        } else {
            console.log('Passing through content as-is');
            res.send(proxyRes.body);
        }
        
    } catch (error) {
        console.error('Request failed:', error);
        res.status(500).send(`Request failed: ${error.message}`);
    }
}

// Asset handler
async function handleAsset(req, res) {
    try {
        console.log('=== Asset Request ===');
        console.log('Asset URL:', req.url);
        
        const target = req.query.hmtarget;
        const assetUrl = req.query.hmurl;
        
        if (!target) {
            return res.status(400).send('No target specified for asset');
        }

        let targetUrl;
        if (assetUrl) {
            targetUrl = decodeURIComponent(assetUrl);
            console.log('Using decoded asset URL:', targetUrl);
        } else {
            const cleanTarget = target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            const urlParts = url.parse(req.url, true);
            const targetPath = urlParts.pathname.replace('/asset', '') || '/';
            
            const cleanQuery = { ...urlParts.query };
            delete cleanQuery.hmtarget;
            delete cleanQuery.hmtype;
            delete cleanQuery.hmurl;
            
            const queryString = new URLSearchParams(cleanQuery).toString();
            targetUrl = `https://${cleanTarget}${targetPath}${queryString ? '?' + queryString : ''}`;
            console.log('Constructed asset URL:', targetUrl);
        }

        const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body;
        const headers = getCommonHeaders(target.replace(/^https?:\/\//, ''), req.headers, hasBody);
        
        console.log('Making asset request...');
        const proxyRes = await makeProxyRequest(targetUrl, {
            method: req.method,
            headers: headers,
            body: hasBody ? req.body : undefined
        });

        console.log('Asset response received, status:', proxyRes.status);

        res.status(proxyRes.status);
        
        Object.keys(proxyRes.headers).forEach(key => {
            const lowerKey = key.toLowerCase();
            if (!['connection', 'transfer-encoding', 'content-encoding', 'content-length'].includes(lowerKey)) {
                res.set(key, proxyRes.headers[key]);
            }
        });

        res.send(proxyRes.body);
        
    } catch (error) {
        console.error('Asset request failed:', error);
        res.status(500).send(`Asset request failed: ${error.message}`);
    }
}

// Screenshot proxy handler
async function handleScreenshotProxy(req, res) {
    try {
        console.log('=== Screenshot Proxy Request ===');
        const { initialMutationUrl, idSite, idSiteHsr, deviceType, baseUrl = '' } = req.query;
        
        if (!initialMutationUrl) {
            return res.status(400).json({
                error: "invalid url, please check if the url contains initialMutation"
            });
        }

        console.log('Fetching initial mutation from:', initialMutationUrl);

        // Fetch initial mutation
        const response = await fetch(initialMutationUrl, {
            headers: getCommonHeaders(req.get('host'), req.headers),
            timeout: 10000
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        let body = await response.text();

        // Handle gzipped content if URL ends with .gz
        if (initialMutationUrl.endsWith('.gz')) {
            try {
                body = zlib.gunzipSync(Buffer.from(body, 'binary')).toString();
            } catch (error) {
                console.warn('Failed to gunzip response, using raw body');
            }
        }

        const encodedInitialMutation = "%7B%22rootId%22%3A1%2C%22children%22%3A%5B%7B%22nodeType%22%3A10%2C%22id%22%3A2%2C%22name%22%3A%22html%22%2C%22publicId%22%3A%22%22%2C%22systemId%22%3A%22%22%7D%2C%7B%22nodeType%22%3A1%2C%22id%22%3A3%2C%22tagName%22%3A%22HTML%22%2C%22attributes%22%3A%7B%7D%2C%22childNodes%22%3A%5B%7B%22nodeType%22%3A1%2C%22id%22%3A4%2C%22tagName%22%3A%22HEAD%22%2C%22attributes%22%3A%7B%7D%2C%22childNodes%22%3A%5B%7B%22nodeType%22%3A3%2C%22id%22%3A5%2C%22textContent%22%3A%22%5Cn%20%20%22%7D%2C%7B%22nodeType%22%3A1%2C%22id%22%3A6%2C%22tagName%22%3A%22STYLE%22%2C%22attributes%22%3A%7B%7D%2C%22childNodes%22%3A%5B%7B%22nodeType%22%3A3%2C%22id%22%3A7%2C%22textContent%22%3A%22%5Cn%20%20%20%20body%20%7B%5Cn%20%20%20%20%20%20margin%3A%200%3B%5Cn%20%20%20%20%20%20padding%3A%200%3B%5Cn%20%20%20%20%20%20display%3A%20flex%3B%5Cn%20%20%20%20%20%20justify-content%3A%20center%3B%5Cn%20%20%20%20%20%20align-items%3A%20center%3B%5Cn%20%20%20%20%20%20min-height%3A%20100vh%3B%5Cn%20%20%20%20%20%20background-color%3A%20%231a1a1a%3B%5Cn%20%20%20%20%20%20font-family%3A%20Arial%2C%20sans-serif%3B%5Cn%20%20%20%20%7D%22%7D%5D%7D%2C%7B%22nodeType%22%3A3%2C%22id%22%3A8%2C%22textContent%22%3A%22%5Cn%22%7D%5D%7D%2C%7B%22nodeType%22%3A3%2C%22id%22%3A9%2C%22textContent%22%3A%22%5Cn%22%7D%2C%7B%22nodeType%22%3A1%2C%22id%22%3A10%2C%22tagName%22%3A%22BODY%22%2C%22attributes%22%3A%7B%7D%2C%22childNodes%22%3A%5B%5D%7D%5D%7D%5D%7D";

        const html = `
<!DOCTYPE html>
<html>
    <head>
		<script type="text/javascript" src="/screenshot-scripts/javascripts/jquery.min.js"></script>
        <script type="text/javascript">
            if ('undefined' === typeof window.$) {
                window.$ = jQuery; //WordPress
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

        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(html);

    } catch (error) {
        console.error('Screenshot proxy failed:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// Routes
app.get('/favicon.ico', (req, res) => {
    res.status(204).end(); // No content for favicon
});

// Test POST endpoint for debugging
app.post('/test-post', (req, res) => {
    console.log('=== TEST POST ENDPOINT ===');
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    console.log('Body type:', typeof req.body);
    res.json({ 
        message: 'POST test successful', 
        receivedBody: req.body,
        bodyType: typeof req.body,
        contentType: req.get('content-type')
    });
});

app.get('/asset', handleAsset);
app.post('/asset', handleAsset);
app.put('/asset', handleAsset);
app.patch('/asset', handleAsset);
app.delete('/asset', handleAsset);

app.get('/screenshot-proxy', handleScreenshotProxy);

// Main proxy route - catch all other requests
app.use('/', handleRequest);

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    if (!res.headersSent) {
        res.status(500).send('Internal server error');
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`Proxy server running on port ${PORT}`);
    console.log(`=================================`);
    console.log(`Usage examples:`);
    console.log(`Main proxy: http://localhost:${PORT}/?hmtarget=example.com&hmtype=1`);
    console.log(`Asset proxy: http://localhost:${PORT}/asset?hmtarget=example.com&hmtype=2&hmurl=https%3A//example.com/style.css`);
    console.log(`Screenshot: http://localhost:${PORT}/screenshot-proxy?initialMutationUrl=...`);
    console.log(`=================================`);
    
    // Test URL rewriting logic
    console.log('\n=== Testing URL Rewriting Logic ===');
    const testHtml = 'src="//thejellybee.com/cdn/shop/t/94/assets/vendor.min.js?v=77136857757479301481665067824"';
    console.log('Input HTML:', testHtml);
    
    const rewritten = rewriteUrls(testHtml, 'thejellybee.com', 'localhost:3000', 'http');
    console.log('Output HTML:', rewritten);
    
    const expectedOutput = 'src="//localhost:3000/cdn/shop/t/94/assets/vendor.min.js?v=77136857757479301481665067824&hmtarget=thejellybee.com&hmtype=1"';
    console.log('Expected HTML:', expectedOutput);
    
    const isCorrect = rewritten === expectedOutput;
    console.log('✅ Test Result:', isCorrect ? 'PASS' : 'FAIL');
    
    if (!isCorrect) {
        console.log('❌ Mismatch detected!');
        console.log('Expected length:', expectedOutput.length);
        console.log('Actual length:', rewritten.length);
    }
    
    // Test absolute URL rewriting
    console.log('\n=== Testing Absolute URL Rewriting ===');
    const testAbsoluteHtml = 'href="https://cdn.jsdelivr.net/npm/bootstrap@4.5.3/dist/css/bootstrap-grid.min.css"';
    console.log('Input HTML:', testAbsoluteHtml);
    
    const rewrittenAbsolute = rewriteUrls(testAbsoluteHtml, 'thejellybee.com', 'localhost:3000', 'http');
    console.log('Output HTML:', rewrittenAbsolute);
    
    const expectedAbsolute = 'href="http://localhost:3000/npm/bootstrap@4.5.3/dist/css/bootstrap-grid.min.css?hmtarget=cdn.jsdelivr.net&hmtype=1"';
    console.log('Expected HTML:', expectedAbsolute);
    
    const isAbsoluteCorrect = rewrittenAbsolute === expectedAbsolute;
    console.log('✅ Absolute URL Test Result:', isAbsoluteCorrect ? 'PASS' : 'FAIL');
    
    // Test srcset rewriting
    console.log('\n=== Testing Srcset Rewriting ===');
    const testSrcsetHtml = 'srcset="https://i.shgcdn.com/image1.jpg 180w,https://i.shgcdn.com/image2.jpg 360w"';
    console.log('Input HTML:', testSrcsetHtml);
    
    const rewrittenSrcset = rewriteUrls(testSrcsetHtml, 'factorydirectjewelry.com', 'localhost:3000', 'http');
    console.log('Output HTML:', rewrittenSrcset);
    
    const expectedSrcset = 'srcset="http://localhost:3000/image1.jpg?hmtarget=i.shgcdn.com&hmtype=1 180w,http://localhost:3000/image2.jpg?hmtarget=i.shgcdn.com&hmtype=1 360w"';
    console.log('Expected HTML:', expectedSrcset);
    
    const isSrcsetCorrect = rewrittenSrcset === expectedSrcset;
    console.log('✅ Srcset Test Result:', isSrcsetCorrect ? 'PASS' : 'FAIL');
    
    // Test dt attribute rewriting (custom multi-URL attribute)
    console.log('\n=== Testing DT Attribute Rewriting ===');
    const testDtHtml = 'dt="https://i.shgcdn.com/image1.jpg 180w,https://i.shgcdn.com/image2.jpg 360w"';
    console.log('Input HTML:', testDtHtml);
    
    const rewrittenDt = rewriteUrls(testDtHtml, 'factorydirectjewelry.com', 'localhost:3000', 'http');
    console.log('Output HTML:', rewrittenDt);
    
    const expectedDt = 'dt="http://localhost:3000/image1.jpg?hmtarget=i.shgcdn.com&hmtype=1 180w,http://localhost:3000/image2.jpg?hmtarget=i.shgcdn.com&hmtype=1 360w"';
    console.log('Expected HTML:', expectedDt);
    
    const isDtCorrect = rewrittenDt === expectedDt;
    console.log('✅ DT Attribute Test Result:', isDtCorrect ? 'PASS' : 'FAIL');
    
    // Test d-src attribute rewriting (single URL data attribute)
    console.log('\n=== Testing D-SRC Attribute Rewriting ===');
    const testDSrcHtml = 'd-src="https://i.shgcdn.com/single-image.jpg"';
    console.log('Input HTML:', testDSrcHtml);
    
    const rewrittenDSrc = rewriteUrls(testDSrcHtml, 'factorydirectjewelry.com', 'localhost:3000', 'http');
    console.log('Output HTML:', rewrittenDSrc);
    
    const expectedDSrc = 'd-src="http://localhost:3000/single-image.jpg?hmtarget=i.shgcdn.com&hmtype=1"';
    console.log('Expected HTML:', expectedDSrc);
    
    const isDSrcCorrect = rewrittenDSrc === expectedDSrc;
    console.log('✅ D-SRC Attribute Test Result:', isDSrcCorrect ? 'PASS' : 'FAIL');
    
    // Test JavaScript interceptor injection
    console.log('\n=== Testing JavaScript Interceptor Injection ===');
    const testHtmlWithHead = '<html><head><title>Test</title></head><body>Content</body></html>';
    console.log('Input HTML with head:', testHtmlWithHead);
    
    const rewrittenWithInterceptor = rewriteUrls(testHtmlWithHead, 'thejellybee.com', 'localhost:3000', 'http');
    const hasInterceptor = rewrittenWithInterceptor.includes('Proxy interceptor loaded for target:');
    console.log('Has interceptor script:', hasInterceptor ? 'YES' : 'NO');
    console.log('Interceptor includes fetch override:', rewrittenWithInterceptor.includes('window.fetch = function') ? 'YES' : 'NO');
    console.log('Interceptor includes XHR override:', rewrittenWithInterceptor.includes('window.XMLHttpRequest = function') ? 'YES' : 'NO');
    console.log('✅ JavaScript Interceptor Test Result:', hasInterceptor ? 'PASS' : 'FAIL');
    
    console.log('=== End Tests ===\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    process.exit(0);
});

module.exports = app;