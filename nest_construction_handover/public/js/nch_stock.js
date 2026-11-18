// Shared by the Van & Site Stock and Stock Locations pages, so a quantity, a unit
// and a van's compartments read the same on the phone and on the desk.
window.nch_stock = {
	// The order a van's compartments are shown in, and taken from when stock leaves
	// the van: project stock first, then wherever the item is.
	COMPARTMENTS: ['Goods In Transit', 'Van Stock', 'Technician Tools', 'Assets'],

	esc: function(s) {
		var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
		return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return map[c]; });
	},

	// Quantities as people say them: 25, not 25.000.
	qty: function(value) {
		return String(parseFloat(flt(value).toFixed(4)));
	},

	// A unit worth saying after a quantity: " Meter", but nothing for plain Nos.
	unit: function(uom) {
		return !uom || uom === 'Nos' ? '' : ' ' + uom;
	},

	// A quantity with its unit, as one piece of text: 25, 3 Meter.
	amount: function(value, uom) {
		return this.qty(value) + this.unit(uom);
	},

	// Which compartment tab a van opens on: the one picked last, else the first with
	// stock in it, else the first.
	first_tab: function(parts, kept, has_stock) {
		if (parts.indexOf(kept) !== -1) return kept;
		return parts.filter(has_stock)[0] || parts[0];
	},

	lines: function(n) {
		return n === 1 ? __('1 item') : __('{0} items', [n]);
	},

	// What someone picked last on a screen. A locked-down browser is not a reason to
	// stop working, so storage that refuses is ignored.
	kept: function(page, key) {
		try { return localStorage.getItem(page + ':' + key) || ''; } catch (e) { return ''; }
	},

	keep: function(page, key, value) {
		try { localStorage.setItem(page + ':' + key, value || ''); } catch (e) { /* storage blocked */ }
	}
};
