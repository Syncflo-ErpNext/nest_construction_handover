// Stock Locations: the office's desktop view of where stock is. One page, four
// views, each opened by its own home tile:
//   stock-locations/main     the main store
//   stock-locations/vans     every van, by compartment
//   stock-locations/sites    every site, with a filter
//   stock-locations/enquiry  search an item, see every place it is
// Read only: stock moves on the Van & Site Stock screen.

frappe.pages['stock-locations'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({ parent: wrapper, title: __('Stock'), single_column: true });

	// Bump with every stylesheet change so browsers fetch the new one.
	var BUILD_MARKER = 'v0.2.3-2026-11-18-review-fixes';
	if (!document.getElementById('sl-stylesheet')) {
		var link = document.createElement('link');
		link.id = 'sl-stylesheet';
		link.rel = 'stylesheet';
		link.href = '/assets/nest_construction_handover/css/stock_locations.css?v=' + encodeURIComponent(BUILD_MARKER);
		document.head.appendChild(link);
	}

	wrapper.stockLocations = new StockLocations(page);
};

frappe.pages['stock-locations'].on_page_show = function(wrapper) {
	if (wrapper.stockLocations) wrapper.stockLocations.open();
};

var SL_API = 'nest_construction_handover.field.';

var SL_VIEWS = {
	main: __('Main Stock'),
	vans: __('Van Stock'),
	sites: __('Site Stock'),
	enquiry: __('Stock Enquiry')
};

// Shared with the Van & Site Stock page: public/js/nch_stock.bundle.js (app_include_js).
var SL_COMPARTMENTS = nch_stock.COMPARTMENTS;
var sl_esc = nch_stock.esc;

function sl_kept(key) {
	return nch_stock.kept('stock-locations', key);
}

function sl_keep(key, value) {
	nch_stock.keep('stock-locations', key, value);
}

class StockLocations {

	// Nothing loads here: the desk shows the page straight after loading it, and
	// every show (the first one included) goes through open().
	constructor(page) {
		this.page = page;
		this.$root = $('<div class="sl-root"></div>').appendTo(page.main);
		page.set_secondary_action(__('Refresh'), () => this.open(), 'refresh');
	}

	// Open the view the route names, with fresh figures every time.
	open() {
		var route = frappe.get_route() || [];
		var view = SL_VIEWS[route[1]] ? route[1] : 'main';
		// Every show: the desk puts the page's own title back when it is shown.
		this.page.set_title(SL_VIEWS[view]);
		var fresh = view !== this.view;
		this.view = view;

		if (view === 'enquiry') {
			if (fresh) this.paint_enquiry();
			else this.search();
			return;
		}
		if (fresh) {
			this.current = null;
			this.$root.html('<div class="sl-note">' + __('Loading...') + '</div>');
		}
		frappe.call({ method: SL_API + 'stock_view', args: { view: view } }).then((r) => {
			if (this.view !== view) return;
			this.places = r.message || [];
			this.paint(fresh);
		});
	}

	// ---- main store, vans and sites: places down the side, the chosen one beside them

	paint(fresh) {
		var view = this.view;
		var places = this.places;
		if (!places.length) {
			this.$root.html('<div class="sl-note">' + __('Nothing is set up here yet.') + '</div>');
			return;
		}
		var names = places.map(function(p) { return p.name; });
		if (names.indexOf(this.current) === -1) {
			var kept = sl_kept(view);
			this.current = names.indexOf(kept) !== -1 ? kept : names[0];
		}
		var typed = fresh ? '' : (this.$root.find('[data-place-filter]').val() || '');
		var stocked = !fresh && this.$root.find('[data-stocked]').prop('checked');
		var single = places.length === 1;

		this.$root.html([
			'<div class="sl-layout' + (single ? ' sl-single' : '') + '">',
			single ? '' : [
				'<div class="sl-side">',
				view === 'sites' ? [
					'<input class="form-control sl-filter" data-place-filter placeholder="' + __('Find a site or project') + '">',
					'<label class="sl-check"><input type="checkbox" data-stocked> ' + __('Only sites with stock') + '</label>'
				].join('') : '',
				'<div class="sl-places">',
				places.map((p) => [
					'<button class="sl-place' + (p.name === this.current ? ' sl-place-on' : '') + '" data-place="' + sl_esc(p.name) + '"',
					' data-search="' + sl_esc((p.label + ' ' + (p.sub || '')).toLowerCase()) + '" data-count="' + p.rows.length + '">',
					'<span class="sl-place-name">' + sl_esc(p.label) + '</span>',
					p.sub ? '<span class="sl-place-sub">' + sl_esc(p.sub) + '</span>' : '',
					'<span class="sl-count">' + p.rows.length + '</span>',
					'</button>'
				].join('')).join('\n'),
				'</div>',
				'</div>'
			].join('\n'),
			'<div class="sl-detail" data-detail></div>',
			'</div>'
		].join('\n'));

		this.$root.find('[data-place-filter]').val(typed).on('input', () => this.filter_places());
		this.$root.find('[data-stocked]').prop('checked', stocked).on('change', () => this.filter_places());
		this.$root.find('[data-place]').on('click', (e) => {
			this.current = $(e.currentTarget).attr('data-place');
			sl_keep(view, this.current);
			this.$root.find('[data-place]').removeClass('sl-place-on');
			$(e.currentTarget).addClass('sl-place-on');
			this.paint_detail();
		});
		this.filter_places();
		this.paint_detail();
	}

	filter_places() {
		var typed = (this.$root.find('[data-place-filter]').val() || '').trim().toLowerCase();
		var stocked = this.$root.find('[data-stocked]').prop('checked');
		this.$root.find('[data-place]').each(function() {
			var $p = $(this);
			var show = (!typed || $p.attr('data-search').indexOf(typed) !== -1) && (!stocked || +$p.attr('data-count') > 0);
			$p.toggle(show);
		});
	}

	paint_detail() {
		var place = this.places.filter((p) => p.name === this.current)[0];
		var body;
		if (this.view === 'vans') {
			// One tab per compartment. The tab chosen stays chosen from van to van;
			// until one is chosen, a van opens on its first compartment with stock.
			var parts = SL_COMPARTMENTS.filter(function(cat) { return place.compartments.indexOf(cat) !== -1; });
			var in_part = function(cat) { return place.rows.filter(function(r) { return r.category === cat; }); };
			if (this.tab === undefined) this.tab = sl_kept('van-tab') || null;
			var tab = nch_stock.first_tab(parts, this.tab, function(cat) { return in_part(cat).length; });
			body = '<div class="sl-tabs" role="tablist">' + parts.map(function(cat) {
				var on = cat === tab;
				return '<button class="sl-tab' + (on ? ' sl-tab-on' : '') + '" role="tab" aria-selected="' + on + '" data-tab="' + sl_esc(cat) + '">' +
					'<span>' + sl_esc(cat) + '</span><span class="sl-count">' + in_part(cat).length + '</span></button>';
			}).join('') + '</div>' + this.box(in_part(tab));
		} else {
			// A long list gets its own filter: the main store holds every item.
			body = (place.rows.length > 15 ? '<input class="form-control sl-filter" data-item-filter placeholder="' + __('Find an item') + '">' : '') +
				this.box(place.rows);
		}
		var $detail = this.$root.find('[data-detail]');
		$detail.html([
			'<div class="sl-head"><span class="sl-head-name">' + sl_esc(place.label) + '</span>',
			place.sub ? '<span class="sl-head-sub">' + sl_esc(place.sub) + '</span>' : '',
			'<span class="sl-head-count">' + sl_esc(nch_stock.lines(place.rows.length)) + '</span></div>',
			body
		].join(''));
		$detail.find('[data-tab]').on('click', (e) => {
			this.tab = $(e.currentTarget).attr('data-tab');
			sl_keep('van-tab', this.tab);
			this.paint_detail();
		});
		$detail.find('[data-item-filter]').on('input', (e) => {
			var typed = ($(e.currentTarget).val() || '').trim().toLowerCase();
			$detail.find('[data-row]').each(function() {
				$(this).toggle(!typed || $(this).attr('data-row').indexOf(typed) !== -1);
			});
		});
	}

	box(rows) {
		return [
			'<div class="sl-box">',
			rows.length
				? rows.map(function(r) {
					return '<div class="sl-row" data-row="' + sl_esc((r.item_code + ' ' + r.item_name).toLowerCase()) + '" title="' + sl_esc(r.item_code) + '">' +
						'<span>' + sl_esc(r.item_name || r.item_code) + '</span><b>' + sl_esc(nch_stock.amount(r.qty, r.uom)) + '</b></div>';
				}).join('')
				: '<div class="sl-empty">' + __('Empty') + '</div>',
			'</div>'
		].join('');
	}

	// ---- stock enquiry: an item in, every place it is out -------------------

	paint_enquiry() {
		this.$root.html([
			'<div class="sl-enquiry">',
			'<input class="form-control sl-search" data-enquiry autocomplete="off" placeholder="' + __('Item code, barcode or description') + '">',
			'<div data-results><div class="sl-note">' + __('Type an item to see every place it is.') + '</div></div>',
			'</div>'
		].join(''));
		var $input = this.$root.find('[data-enquiry]');
		var timer = null;
		$input.on('input', () => {
			clearTimeout(timer);
			timer = setTimeout(() => this.search(), 350);
		});
		$input.on('keydown', (e) => {
			if (e.key !== 'Enter') return;
			clearTimeout(timer);
			this.search();
		});
		setTimeout(function() { $input.trigger('focus'); }, 100);
	}

	search() {
		var $input = this.$root.find('[data-enquiry]');
		var $results = this.$root.find('[data-results]');
		var term = ($input.val() || '').trim();
		if (term.length < 2) {
			$results.html('<div class="sl-note">' + __('Type an item to see every place it is.') + '</div>');
			return;
		}
		frappe.call({ method: SL_API + 'enquiry', args: { term: term } }).then((r) => {
			if (($input.val() || '').trim() !== term) return;
			var items = r.message || [];
			if (!items.length) {
				$results.html('<div class="sl-note">' + sl_esc(__('No item matches {0}.', [term])) + '</div>');
				return;
			}
			$results.html((items.length >= 20 ? '<div class="sl-note">' + __('Showing the first 20 matches. Type more to narrow it down.') + '</div>' : '') +
				items.map(function(item) {
					return [
						'<div class="sl-box sl-item">',
						'<div class="sl-box-head"><span><b>' + sl_esc(item.item_name) + '</b> <span class="sl-code">' + sl_esc(item.item_code) + (item.disabled ? ' · ' + sl_esc(__('disabled')) : '') + '</span></span>',
						'<span class="sl-total">' + sl_esc(nch_stock.amount(item.total, item.uom)) + '</span></div>',
						item.locations.length
							? item.locations.map(function(l) {
								return '<div class="sl-row"><span>' + sl_esc(l.where) + (l.kind ? ' <span class="sl-kind">' + sl_esc(l.kind) + '</span>' : '') + '</span>' +
									'<b>' + sl_esc(nch_stock.amount(l.qty, item.uom)) + '</b></div>';
							}).join('')
							: '<div class="sl-empty">' + __('Not in stock anywhere') + '</div>',
						'</div>'
					].join('');
				}).join('\n'));
		});
	}
}
