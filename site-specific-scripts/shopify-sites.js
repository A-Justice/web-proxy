(function() {
    'use strict';
    
    console.log('🛒 Initializing Shopify compatibility layer...');
    
    // Initialize window.Shopify if it doesn't exist
    if (!window.Shopify) {
        window.Shopify = {};
    }
    
    // Initialize routes object if it doesn't exist
    if (!window.Shopify.routes) {
        window.Shopify.routes = {};
    }
    
    // Set up essential Shopify routes
    const targetDomain = '${target}';
    const baseUrl = 'https://' + targetDomain;
    
    // Core Shopify routes that are commonly accessed
    window.Shopify.routes = {
        root: '/',
        account_login_url: '/account/login',
        account_logout_url: '/account/logout',
        account_recover_url: '/account/recover',
        account_edit_url: '/account',
        account_addresses_url: '/account/addresses',
        account_orders_url: '/account/orders',
        collections_url: '/collections',
        all_products_collection_url: '/collections/all',
        search_url: '/search',
        cart_url: '/cart',
        cart_add_url: '/cart/add',
        cart_change_url: '/cart/change',
        cart_clear_url: '/cart/clear',
        cart_update_url: '/cart/update',
        predictive_search_url: '/search/suggest'
    };
    
    // Initialize other common Shopify objects
    if (!window.Shopify.shop) {
        window.Shopify.shop = targetDomain;
    }
    
    if (!window.Shopify.locale) {
        window.Shopify.locale = 'en';
    }
    
    if (!window.Shopify.currency) {
        window.Shopify.currency = { active: 'USD' };
    }
    
    if (!window.Shopify.country) {
        window.Shopify.country = 'US';
    }
    
    if (!window.Shopify.theme) {
        window.Shopify.theme = { name: 'proxy-theme', id: 1 };
    }
    
    // Prevent errors from common Shopify method calls
    if (!window.Shopify.formatMoney) {
        window.Shopify.formatMoney = function(cents, format) {
            if (!format) format = '${{amount}}';
            const value = cents / 100;
            return format.replace(/\{\{\s*amount\s*\}\}/, value.toFixed(2));
        };
    }
    
    // Fix for cart object
    if (!window.Shopify.Cart) {
        window.Shopify.Cart = {
            getCart: function(callback) {
                fetch('/cart.js')
                    .then(response => response.json())
                    .then(callback)
                    .catch(console.error);
            }
        };
    }
    
    console.log('✅ Shopify compatibility layer initialized');
    console.log('✅ window.Shopify.routes.root =', window.Shopify.routes.root);
    
})();

(function() {
    'use strict';
    
    console.log('🛡️ Loading error prevention layer...');
    
    // Catch and prevent common undefined property errors
    const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const originalDefineProperty = Object.defineProperty;
    
    // Override property access to provide fallbacks for undefined objects
    function createSafeProxy(target, path) {
        return new Proxy(target, {
            get: function(obj, prop) {
                if (obj[prop] === undefined) {
                    const fullPath = path + '.' + prop;
                    console.warn('🛡️ Accessing undefined property:', fullPath, 'providing fallback');
                    
                    // Special handling for common Shopify properties
                    if (fullPath === 'window.Shopify.routes.root') {
                        return '/';
                    } else if (fullPath.includes('Shopify.routes')) {
                        return '/';
                    } else if (fullPath.includes('Shopify.currency')) {
                        return { active: 'USD' };
                    } else if (fullPath.includes('Shopify.locale')) {
                        return 'en';
                    } else if (fullPath.includes('Shopify.shop')) {
                        return '${target}';
                    }
                    
                    // Return empty object for further chaining
                    return {};
                }
                
                // If it's an object, wrap it in a proxy too
                if (typeof obj[prop] === 'object' && obj[prop] !== null) {
                    return createSafeProxy(obj[prop], path + '.' + prop);
                }
                
                return obj[prop];
            }
        });
    }
    
    
    // Enhanced window.onerror handler
    const originalOnError = window.onerror;
    window.onerror = function(message, source, lineno, colno, error) {
        if (message && message.includes("Cannot read properties of undefined")) {
            console.warn('🛡️ Caught undefined property error:', message);
            console.warn('🛡️ Source:', source, 'Line:', lineno);
            
            // Try to prevent the error from propagating
            return true;
        }
        
        if (originalOnError) {
            return originalOnError.apply(this, arguments);
        }
        return false;
    };
    
    // Enhanced unhandled promise rejection handler
    window.addEventListener('unhandledrejection', function(event) {
        if (event.reason && event.reason.message && 
            event.reason.message.includes("Cannot read properties of undefined")) {
            console.warn('🛡️ Caught unhandled promise rejection with undefined property:', event.reason);
            event.preventDefault();
        }
    });
    
    console.log('✅ Error prevention layer loaded');
})();