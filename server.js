const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const dns = require('dns').promises;
const https = require('https');
const http = require('http');
const url = require('url');
const zlib = require('zlib');
const { promisify } = require('util');

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
app.use(express.raw({ type: '*/*', limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
    
    // Only include content-type and content-length for requests with body
    if (hasBody && originalHeaders['content-type']) {
        headers['Content-Type'] = originalHeaders['content-type'];
    }
    
    // Don't copy Content-Length - let fetch handle it automatically
    
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

// URL rewriting function
function rewriteUrls(body, target, proxyHost) {
    if (!body) return body;
    
    let content = body.toString();
    
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

    // Add data-original-domain to main.js script tags
    content = content.replace(
        /(<script[^>]*src=["'](?:\/\/|https?:\/\/)[^\/]+)(\/[^"']+main\.js[^"']*["'][^>]*)(>)/gi,
        (match, scriptStart, path, closing) => {
            const domainMatch = scriptStart.match(/\/\/([^\/]+)/);
            if (domainMatch) {
                const domain = domainMatch[1];
                return `<script src="//${proxyHost}${path}&hmtarget=${domain}&hmtype=1" data-original-domain="${domain}"${closing}`;
            }
            return match;
        }
    );
    
    return content;
}

// Function to rewrite Location headers
function rewriteLocationHeader(location, target, proxyHost) {
    if (!location) return null;
    
    // If it's a full URL, rewrite it
    if (location.match(/^https?:\/\//)) {
        const locationUrl = new URL(location);
        return `https://${proxyHost}/?hmtarget=${locationUrl.host}&hmtype=1${locationUrl.pathname}${locationUrl.search}`;
    } else {
        // If it's a relative URL, make it absolute through our proxy
        if (location.startsWith('/')) {
            return `https://${proxyHost}/?hmtarget=${target}&hmtype=1${location}`;
        }
    }
    return location;
}

// Function to rewrite cart JSON URLs
function rewriteCartJsonUrls(body, target, proxyHost) {
    if (!body) return body;
    
    let content = body.toString();
    
    // Rewrite relative URLs
    content = content.replace(/"url"\s*:\s*"(\/[^"]*)"/gi, (match, url) => {
        const separator = url.includes('?') ? '&' : '?';
        return `"url":"${url}${separator}hmtarget=${target}&hmtype=1"`;
    });
    
    // Rewrite CDN URLs
    content = content.replace(/"(https:\/\/cdn\.shopify\.com\/[^"]*)"/gi, (match, cdnUrl) => {
        const encodedUrl = encodeURIComponent(cdnUrl);
        return `"https://${proxyHost}/asset?hmtarget=${target}&hmtype=2&hmurl=${encodedUrl}"`;
    });
    
    // Rewrite other external URLs
    content = content.replace(/"(https:\/\/[^"]*)"/gi, (match, externalUrl) => {
        if (externalUrl.includes(proxyHost)) {
            return match;
        }
        const encodedUrl = encodeURIComponent(externalUrl);
        return `"https://${proxyHost}/asset?hmtarget=${target}&hmtype=2&hmurl=${encodedUrl}"`;
    });
    
    return content;
}

// Main request handler
async function handleRequest(req, res, next) {
    try {
        console.log('Request URL:', req.url);
        console.log('Query params:', req.query);
        
        // Extract target from query parameters
        const target = req.query.hmtarget;
        if (!target) {
            return res.status(400).send('No target specified');
        }

        // Clean up target
        const cleanTarget = target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        console.log('Target:', cleanTarget);

        // Get the original path and query
        const urlParts = url.parse(req.url, true);
        let targetPath = urlParts.pathname === '/' ? '' : urlParts.pathname;
        
        // Remove proxy-specific parameters
        const cleanQuery = { ...urlParts.query };
        delete cleanQuery.hmtarget;
        delete cleanQuery.hmtype;
        delete cleanQuery.hmurl;
        
        const queryString = new URLSearchParams(cleanQuery).toString();
        const targetUrl = `https://${cleanTarget}${targetPath}${queryString ? '?' + queryString : ''}`;
        
        console.log('Target URL:', targetUrl);

        // Prepare headers
        const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body;
        const headers = getCommonHeaders(cleanTarget, req.headers, hasBody);
        
        // Handle cart section requests - remove caching headers
        if (req.url.includes('sections=cart')) {
            delete headers['If-Modified-Since'];
            delete headers['If-None-Match'];
            headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
            headers['Pragma'] = 'no-cache';
        }

        // Make request to target
        const proxyRes = await makeProxyRequest(targetUrl, {
            method: req.method,
            headers: headers,
            body: hasBody ? req.body : undefined
        });

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
        
        console.log('Content-Type:', contentType, 'Is HTML:', isHtml);

        if (isHtml) {
            console.log('Processing HTML content');
            const rewrittenBody = rewriteUrls(proxyRes.body, cleanTarget, req.get('host'));
            res.send(rewrittenBody);
        } else if (contentType.includes('application/json') && (req.path.includes('/cart/') || req.path.includes('cart.js'))) {
            console.log('Processing JSON cart response');
            const rewrittenBody = rewriteCartJsonUrls(proxyRes.body, cleanTarget, req.get('host'));
            res.send(rewrittenBody);
        } else if (contentType.includes('javascript') && req.path.includes('main.js')) {
            console.log('Processing main.js');
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
        const target = req.query.hmtarget;
        const assetUrl = req.query.hmurl;
        
        if (!target) {
            return res.status(400).send('No target specified for asset');
        }

        let targetUrl;
        if (assetUrl) {
            targetUrl = decodeURIComponent(assetUrl);
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
        }

        console.log('Asset URL:', targetUrl);

        const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body;
        const headers = getCommonHeaders(target.replace(/^https?:\/\//, ''), req.headers, hasBody);
        
        const proxyRes = await makeProxyRequest(targetUrl, {
            method: req.method,
            headers: headers,
            body: hasBody ? req.body : undefined
        });

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

            // Only add body for methods that support it
            if (options.body && ['POST', 'PUT', 'PATCH'].includes(options.method.toUpperCase())) {
                requestOptions.body = options.body;
            }

            console.log('Making request to:', currentUrl);
            console.log('Request method:', requestOptions.method);

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
            
            if (retries >= MAX_RETRIES) {
                throw error;
            }
            
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        }
    }

    throw new Error('Maximum retries exceeded');
}

// Screenshot proxy handler
app.get('/screenshot-proxy', async (req, res) => {
    try {
        const { initialMutationUrl, idSite, idSiteHsr, deviceType, baseUrl = '' } = req.query;
        
        if (!initialMutationUrl) {
            return res.status(400).json({
                error: "invalid url, please check if the url contains initialMutation"
            });
        }

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
});

// Routes
app.get('/favicon.ico', (req, res) => {
    res.status(204).end(); // No content for favicon
});
app.get('/asset', handleAsset);
app.post('/asset', handleAsset);
app.get('/screenshot-proxy', (req, res) => handleScreenshotProxy(req, res));

// Main proxy route - catch all
app.use('/', handleRequest);

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).send('Internal server error');
});

// Start server
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
    console.log(`Access via: http://localhost:${PORT}/?hmtarget=example.com&hmtype=1`);
});

module.exports = app;