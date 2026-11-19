{% raw %}
// Com-Struct field phones: lets the desk open with no signal. Served at /nch_sw.js
// (www/nch_sw.py keeps it raw and uncached); registered by the Van & Site Stock page.
//
// Desk pages: network first. A desk page that loads is kept as the shell; with no
// signal the kept shell opens instead, and the field screen works from what the phone
// last saw (van_site_stock.js keeps that, and the queue of what was recorded).
// Files under /assets: network first, kept for when there is no signal.
// Nothing else is touched: every server call goes to the server exactly as before.

var SHELL = 'nch-shell-v1';
var ASSETS = 'nch-assets-v1';
var SHELL_KEY = '/desk';

self.addEventListener('install', function() {
	self.skipWaiting();
});

self.addEventListener('activate', function(event) {
	event.waitUntil(caches.keys().then(function(keys) {
		return Promise.all(keys.filter(function(key) {
			return key.indexOf('nch-') === 0 && key !== SHELL && key !== ASSETS;
		}).map(function(key) {
			return caches.delete(key);
		}));
	}).then(function() {
		return self.clients.claim();
	}));
});

function is_desk(url) {
	return url.pathname === '/desk' || url.pathname.indexOf('/desk/') === 0;
}

// Only a real desk page is kept, never a login page the desk sent someone to.
function keep_shell(response) {
	if (!response || !response.ok || response.redirected || !is_desk(new URL(response.url))) return Promise.resolve();
	var copy = response.clone();
	return caches.open(SHELL).then(function(cache) {
		return cache.put(SHELL_KEY, copy);
	});
}

function offline_page() {
	return new Response([
		'<!doctype html><html><head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1"><title>Com-Struct</title></head>',
		'<body style="font-family: sans-serif; padding: 24px; color: #1f2937">',
		'<h2>No signal</h2>',
		'<p>This phone has not opened Com-Struct with signal yet. Open it once with signal; after that it opens without.</p>',
		'</body></html>'
	].join(''), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// The field screen says which files its page loaded: keep exactly those, and the desk page.
function warm(assets) {
	var shell = fetch(SHELL_KEY, { credentials: 'same-origin' }).then(keep_shell).catch(function() {});
	var files = caches.open(ASSETS).then(function(cache) {
		var wanted = {};
		assets.forEach(function(url) {
			wanted[new URL(url, self.location.origin).href] = true;
		});
		return cache.keys().then(function(kept) {
			var drop = kept.filter(function(request) {
				return !wanted[request.url];
			}).map(function(request) {
				return cache.delete(request);
			});
			var add = Object.keys(wanted).map(function(url) {
				return cache.match(url).then(function(hit) {
					if (hit) return null;
					return fetch(url, { credentials: 'same-origin' }).then(function(response) {
						if (response.ok) return cache.put(url, response);
					}).catch(function() {});
				});
			});
			return Promise.all(drop.concat(add));
		});
	});
	return Promise.all([shell, files]);
}

self.addEventListener('message', function(event) {
	var data = event.data || {};
	if (data.type === 'warm') event.waitUntil(warm(data.assets || []));
	// Signed out: the next person must not open the last one's desk.
	if (data.type === 'forget') event.waitUntil(caches.delete(SHELL));
});

self.addEventListener('fetch', function(event) {
	var request = event.request;
	if (request.method !== 'GET') return;
	var url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (request.mode === 'navigate' && is_desk(url)) {
		event.respondWith(fetch(request).then(function(response) {
			keep_shell(response);
			return response;
		}).catch(function() {
			return caches.match(SHELL_KEY, { cacheName: SHELL }).then(function(hit) {
				return hit || offline_page();
			});
		}));
		return;
	}

	if (url.pathname.indexOf('/assets/') === 0) {
		event.respondWith(fetch(request).then(function(response) {
			if (response.ok) {
				var copy = response.clone();
				caches.open(ASSETS).then(function(cache) {
					cache.put(request, copy);
				});
			}
			return response;
		}).catch(function() {
			return caches.match(request, { cacheName: ASSETS }).then(function(hit) {
				return hit || Response.error();
			});
		}));
	}
});
{% endraw %}
