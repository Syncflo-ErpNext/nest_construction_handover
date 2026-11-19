// Makes the site installable as a phone app (Chrome menu > Install app / Add to Home screen).
// Loaded on desk and website pages. Working with no signal is set up by the Van & Site
// Stock page (service worker /nch_sw.js); on the sign-in page the kept desk is dropped,
// so the next person never opens the last one's desk.
(function () {
	try {
		if (location.pathname === "/login" && navigator.serviceWorker && navigator.serviceWorker.controller) {
			navigator.serviceWorker.controller.postMessage({ type: "forget" });
		}
		if (document.querySelector('link[rel="manifest"]')) return;
		var link = document.createElement("link");
		link.rel = "manifest";
		link.href = "/assets/nest_construction_handover/pwa/manifest.json";
		document.head.appendChild(link);

		var icon = document.createElement("link");
		icon.rel = "apple-touch-icon";
		icon.href = "/assets/nest_construction_handover/pwa/icon-192.png";
		document.head.appendChild(icon);
	} catch (e) {
		/* never break the page */
	}
})();
