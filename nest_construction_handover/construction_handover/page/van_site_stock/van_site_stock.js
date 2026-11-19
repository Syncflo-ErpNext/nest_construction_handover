// Van & Site Stock: the main store, the vans and the sites on one phone screen.
//
// Who you are comes from your user's Assigned Warehouse: the main store, a van or a site
// (a site manager also works every site they manage). A handover is a Stock Handover
// Docket: the giver lists what is going, the receiver counts what arrived and accepts it,
// and only then does stock move, as one Stock Entry for what was counted. Used on site is
// a Material Issue against the site's project. All of it is built by
// nest_construction_handover/field.py with the user's own permissions.
//
// Desk Page: mounts inside page.body (jQuery in v16, CoWork_Helper gotcha 2026-05-10).
// HTML is built as string arrays joined with "\n" (page-bundle rule).
// Bump BUILD_MARKER with every CSS change (gotcha 2026-08-18).

frappe.pages['van-site-stock'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({ parent: wrapper, title: __('Van & Site Stock'), single_column: true });

	var BUILD_MARKER = 'v0.2.3-2026-11-18-instock-colour';
	console.log('Van & Site Stock loaded:', BUILD_MARKER);

	[
		['ch-stylesheet', '/assets/nest_construction_handover/css/van_site_stock.css'],
		['ch-phosphor', '/assets/nest_construction_handover/vendor/phosphor/style.css']
	].forEach(function(css) {
		if (document.getElementById(css[0])) return;
		var link = document.createElement('link');
		link.id = css[0];
		link.rel = 'stylesheet';
		link.href = css[1] + '?v=' + encodeURIComponent(BUILD_MARKER);
		document.head.appendChild(link);
	});

	wrapper.chStock = new ChStock(page);
};

frappe.pages['van-site-stock'].on_page_show = function(wrapper) {
	if (wrapper.chStock) wrapper.chStock.on_show();
};

// ---------------------------------------------------------------------------

var CH_API = 'nest_construction_handover.field.';

// Shared with the Stock Locations page: public/js/nch_stock.bundle.js (app_include_js).
var CH_COMPARTMENTS = nch_stock.COMPARTMENTS;
// The parts of a van a breakdown can be fitted from (Used from the van): never tools or assets.
var CH_USABLE = ['Goods In Transit', 'Van Stock'];
var ch_esc = nch_stock.esc;
var ch_qty = nch_stock.qty;
var ch_amount = nch_stock.amount;
var ch_lines = nch_stock.lines;

function ch_icon(name) {
	return '<i class="ph ph-' + name + '" aria-hidden="true"></i>';
}

function ch_when(value) {
	if (!value) return '';
	return frappe.datetime.prettyDate ? frappe.datetime.prettyDate(value) : frappe.datetime.str_to_user(value);
}

// The places someone picked last, per screen, so the second handover of a shift is three taps.
function ch_remembered(key) {
	return nch_stock.kept('van-site-stock', key);
}

function ch_remember(key, value) {
	nch_stock.keep('van-site-stock', key, value);
}

// Places in A-Z order of their names, for pickers with many sites.
function ch_by_label(list) {
	return (list || []).slice().sort(function(a, b) { return String(a.label).localeCompare(String(b.label)); });
}

// Sites grouped by project, A-Z: [{name, label, sites}]. A site is picked project first;
// a site on no project stands on its own.
function ch_projects(sites) {
	var by = {};
	(sites || []).forEach(function(p) {
		var key = p.project || p.name;
		(by[key] = by[key] || { name: key, label: p.project_name || p.label, sites: [] }).sites.push(p);
	});
	return ch_by_label(Object.keys(by).map(function(key) { return by[key]; }));
}

function ch_call(method, args, freeze) {
	return frappe.call({
		method: CH_API + method,
		args: args || {},
		freeze: !!freeze,
		freeze_message: freeze ? __('Recording...') : undefined
	}).then(function(r) { return r.message; });
}

// The ways stock is handed over, or used straight from a van, and what each needs.
var CH_SENDS = {
	'book': { title: __('Book stock to a project'), to: 'sites', book: true },
	'to-van': { title: __('Send to a van'), to: 'vans', into_van: true, project: true },
	'to-site': { title: __('Deliver to a site'), to: 'sites', out_of_van: true },
	'to-store': { title: __('Back to the store'), to: 'stores', out_of_van: true },
	'site-to-van': { title: __('Back on a van'), to: 'vans', into_van: true },
	// Only to another site on the same project: another project is a different job.
	'site-to-site': { title: __('To another site'), to: 'sites', same_project: true },
	// Van stock belongs to a project: the load keeps it.
	'van-to-van': { title: __('To another van'), to: 'vans', into_van: true, out_of_van: true, project: true },
	// A breakdown: fitted straight from the van to a site of a project, which costs it.
	'van-used': { title: __('Used from the van'), to: 'sites', out_of_van: true, use: true }
};

class ChStock {

	constructor(page) {
		this.page = page;
		this.ctx = null;
		this.basket = [];
		this.screen = null;
		this.$root = $('<div class="ch-root"></div>').appendTo(page.body);
		var $head = page.head ? $(page.head) : $(page.wrapper).find('.page-head');
		if ($head && $head.length) $head.hide();
		this.load().then(() => this.open_route(), () => this.no_entry());
	}

	load() {
		return ch_call('bootstrap').then((ctx) => {
			this.all = ctx;
			this.set_mode(this.site_mode);
		});
	}

	// A driver who also runs sites has two screens: his van (the Van Stock tile) and the
	// sites he runs (the Site Stock tile, van-site-stock/sites). Everyone else has one.
	can_run_sites() {
		return this.all.kind === 'van' && (this.all.managed || []).length > 0;
	}

	set_mode(sites) {
		var all = this.all;
		this.site_mode = !!(sites && this.can_run_sites());
		if (this.site_mode) {
			this.ctx = $.extend({}, all, { kind: 'site', mine: all.managed });
		} else {
			// His van screen stays exactly a van's: supplier deliveries are on his sites' screen.
			var names = all.mine.map(function(p) { return p.name; });
			this.ctx = $.extend({}, all, { receive_at: (all.receive_at || []).filter(function(n) { return names.indexOf(n) !== -1; }) });
		}
	}

	no_entry() {
		this.render([
			'<div class="ch-note">' + __('This screen could not open for you. If you have no store, van or site, ask the office to set Assigned Warehouse on your user.') + '</div>',
			'<button class="ch-secondary" data-retry="1">' + ch_icon('arrow-clockwise') + __('Try again') + '</button>'
		].join('\n'));
		this.$root.find('[data-retry]').on('click', () => this.load().then(() => this.home(), () => this.no_entry()));
	}

	on_show() {
		if (!this.ctx) return;
		// A desk tile names its screen (van-site-stock/book, /issue): open it every time
		// the tile is used, not only the first time this page loads. Except over work
		// half done: coming back to the page must never throw away a list or a count.
		var sub = (frappe.get_route() || [])[1];
		// van-site-stock/sites is the sites' home, not a screen of its own.
		var sites = sub === 'sites';
		if (sites) sub = '';
		if ((sites && this.can_run_sites()) !== this.site_mode && !this.busy()) {
			this.set_mode(sites);
			this.go(sub || 'home', !!sub);
			return;
		}
		if (sub && !this.busy()) this.go(sub, true);
		else if (sub && sub !== this.opened) this.say(__('This list is not finished. Send it or clear it, then use the tile again.'));
		else if (!sub && !this.screen) this.home();
		else if (this.screen === 'home') this.refresh_inbox();
	}

	busy() {
		if (this.screen === 'send' || this.screen === 'use') return this.basket.length > 0;
		return (this.screen === 'review' && this.counting) || this.screen === 'delivery';
	}

	// van-site-stock/book, /issue, /send-van, /deliver, /return-store, /return-van, /used,
	// /site-to-site, /van-to-van, /used-van, /receive, /stock, /find, /recent opens that
	// screen (desk tiles link here).
	open_route() {
		var sub = (frappe.get_route() || [])[1];
		this.set_mode(sub === 'sites');
		if (sub === 'sites') sub = '';
		this.go(sub || 'home', !!sub);
	}

	// from_desk: opened by a desk tile, so its back arrow and Home go back to the desk.
	go(where, from_desk) {
		this.opened = where;
		this.from_desk = !!from_desk;
		if (where === 'book') this.send('book');
		else if (where === 'issue') this.issue_list();
		else if (where === 'send-van') this.send('to-van');
		else if (where === 'deliver') this.send('to-site');
		else if (where === 'return-store') this.send('to-store');
		else if (where === 'return-van') this.send('site-to-van');
		else if (where === 'site-to-site') this.send('site-to-site');
		else if (where === 'van-to-van') this.send('van-to-van');
		else if (where === 'used-van') this.send('van-used');
		else if (where === 'used') this.use();
		else if (where === 'receive') this.receive();
		else if (where === 'collect') this.collect();
		else if (where === 'stock') this.my_stock();
		else if (where === 'find') this.find();
		else if (where === 'recent') this.recent();
		else if (where === 'po-request' || where === 'po-approvals') window.location.href = '/' + where;
		else this.home();
	}

	// ---- building blocks ---------------------------------------------------

	render(html, screen) {
		this.screen = screen || null;
		this.$root.html(html);
		window.scrollTo(0, 0);
	}

	head(title, sub, back) {
		return [
			'<div class="ch-head">',
			back ? '  <button class="ch-back" data-back="1" aria-label="' + __('Back') + '">' + ch_icon('arrow-left') + '</button>' : '',
			'  <div class="ch-head-text">',
			'    <div class="ch-title">' + ch_esc(title) + '</div>',
			sub ? '    <div class="ch-sub">' + ch_esc(sub) + '</div>' : '',
			'  </div>',
			'</div>'
		].join('\n');
	}

	bind_back(handler) {
		this.$root.find('[data-back]').on('click', handler);
	}

	// Back arrows and Home: to the desk when a desk tile opened the screen, else to
	// this page's own home.
	back_home() {
		if (this.from_desk) this.leave();
		else this.home();
	}

	// Back to the desk. Whatever was half done is dropped, so the next tile opens its
	// own screen clean instead of "this list is not finished".
	leave() {
		this.basket = [];
		this.counting = false;
		this.screen = null;
		this.opened = null;
		frappe.set_route((frappe.boot.versions || {}).nest_home ? 'nest-home' : '');
	}

	can_camera() {
		return !!(frappe.ui && frappe.ui.Scanner);
	}

	scan_box(placeholder) {
		return [
			'<div class="ch-scan">',
			'  <span class="ch-scan-mark">' + ch_icon('barcode') + '</span>',
			'  <input class="ch-input" data-scan="1" placeholder="' + ch_esc(placeholder) + '"',
			'         autocomplete="off" spellcheck="false" enterkeyhint="go">',
			this.can_camera() ? '  <button class="ch-camera" data-camera="1" aria-label="' + __('Scan with the camera') + '">' + ch_icon('camera') + '</button>' : '',
			'</div>'
		].join('\n');
	}

	// Hardware scanners type the code and press Enter; so do people. The camera feeds the
	// same handler. on_input, where given, filters a list as people type.
	bind_scan(handler, on_input) {
		var $scan = this.$root.find('[data-scan]');
		$scan.on('keydown', function(e) {
			if (e.key !== 'Enter') return;
			e.preventDefault();
			var term = ($scan.val() || '').trim();
			$scan.val('');
			if (on_input) on_input('');
			if (term) handler(term);
		});
		if (on_input) $scan.on('input', function() { on_input(($scan.val() || '').trim()); });
		this.$root.find('[data-camera]').on('click', () => this.camera(handler));
		// Not on phones: the keyboard would cover the screen before anything is scanned.
		if (!frappe.is_mobile()) $scan.trigger('focus');
	}

	camera(handler) {
		new frappe.ui.Scanner({
			dialog: true,
			multiple: false,
			on_scan: function(data) {
				var text = data && (data.decodedText || (data.result && data.result.text));
				if (text) handler(String(text).trim());
			}
		});
	}

	focus_scan() {
		if (!frappe.is_mobile()) this.$root.find('[data-scan]').val('').trigger('focus');
	}

	say(message, tone) {
		frappe.show_alert({ message: ch_esc(message), indicator: tone || 'orange' }, 5);
	}

	// The label/value lines of a card; empty entries (null) are left out.
	facts(list) {
		return list.filter(Boolean).map(function(f) { return '<div class="ch-fact"><span>' + ch_esc(f[0]) + '</span><b>' + ch_esc(f[1]) + '</b></div>'; }).join('\n');
	}

	tile(go, icon, title, blurb) {
		return [
			'<button class="ch-tile" data-go="' + go + '">',
			'  <span class="ch-tile-mark">' + ch_icon(icon) + '</span>',
			'  <span class="ch-tile-text">',
			'    <span class="ch-tile-title">' + ch_esc(title) + '</span>',
			'    <span class="ch-tile-sub">' + ch_esc(blurb) + '</span>',
			'  </span>',
			'  <span class="ch-tile-go">' + ch_icon('arrow-right') + '</span>',
			'</button>'
		].join('\n');
	}

	row(attrs, main, sub, right) {
		return [
			'<button class="ch-row" ' + attrs + '>',
			'  <span class="ch-row-main">' + main + '</span>',
			sub ? '  <span class="ch-row-sub">' + sub + '</span>' : '',
			right ? '  <span class="ch-row-right">' + right + '</span>' : '',
			'</button>'
		].join('\n');
	}

	tag(text, tone) {
		return '<span class="ch-tag' + (tone ? ' ch-tag-' + tone : '') + '">' + ch_esc(text) + '</span>';
	}

	// A place picker: fixed text when there is only one, a select otherwise.
	place_field(side, label, list, selected, choose_text) {
		var body;
		if (list.length === 1) {
			body = '<div class="ch-fixed">' + ch_icon('map-pin') + ch_esc(list[0].label) + '</div>';
		} else {
			body = [
				'<select class="ch-select" data-side="' + side + '">',
				selected ? '' : '<option value="">' + ch_esc(choose_text) + '</option>',
				list.map(function(p) {
					return '<option value="' + ch_esc(p.name) + '"' + (p.name === selected ? ' selected' : '') + '>' + ch_esc(p.label + (p.driver ? ' · ' + p.driver : '')) + '</option>';
				}).join('\n'),
				'</select>'
			].join('\n');
		}
		return '<label class="ch-label">' + ch_esc(label) + body + '</label>';
	}

	// How many, and from where: one dialog. opts: default, max (number or function of
	// the dialog values), max_text, info, label, action, allow_zero, take
	// ([{value, label}]) with take_default.
	ask(item, opts, done) {
		var me = this;
		opts = opts || {};
		var qty_field = { fieldtype: 'Float', fieldname: 'qty', label: opts.label || __('How many?'), reqd: 1 };
		// default '' = open empty. Set as a default, '' is filled in as 0.000, so leave it unset.
		if (opts.default !== '') qty_field.default = opts.default != null ? opts.default : 1;
		var fields = [{ fieldtype: 'HTML', fieldname: 'info' }, qty_field];
		if (opts.take) fields.push({ fieldtype: 'Select', fieldname: 'take', label: __('Take from'), reqd: 1, options: opts.take, default: opts.take_default });
		var d = new frappe.ui.Dialog({
			title: item.item_code,
			fields: fields,
			primary_action_label: opts.action || __('Add'),
			primary_action: function(values) {
				var qty = flt(values.qty);
				if (qty < 0 || (qty === 0 && !opts.allow_zero)) { me.say(__('Enter a quantity above zero.'), 'red'); return; }
				var max = typeof opts.max === 'function' ? opts.max(values) : opts.max;
				if (max != null && qty > flt(max) + 1e-9) {
					me.say(typeof opts.max_text === 'function' ? opts.max_text(values) : (opts.max_text || __('Only {0} available.', [ch_qty(max)])), 'red');
					return;
				}
				d.hide();
				done(qty, values);
			}
		});
		d.fields_dict.info.$wrapper.html([
			'<div class="ch-ask">',
			'  <div class="ch-ask-name">' + ch_esc(item.item_name || item.item_code) + '</div>',
			opts.info ? '  <div class="ch-ask-info">' + opts.info + '</div>' : '',
			'</div>'
		].join('\n'));
		d.on_hide = function() { me.focus_scan(); };
		d.show();
		setTimeout(function() { d.get_field('qty').$input.trigger('focus').trigger('select'); }, 250);
	}

	done(message, ref, actions) {
		this.render([
			'<div class="ch-done">',
			'  <span class="ch-tick">' + ch_icon('check') + '</span>',
			'  <div class="ch-done-msg">' + ch_esc(message) + '</div>',
			ref ? '  <div class="ch-done-ref">' + ch_esc(ref) + '</div>' : '',
			'</div>',
			'<div class="ch-stack">',
			actions.map(function(a, i) {
				return '<button class="' + (a.primary ? 'ch-submit' : 'ch-secondary') + '" data-action="' + i + '">' + ch_esc(a.label) + '</button>';
			}).join('\n'),
			'</div>'
		].join('\n'), 'done');
		this.$root.find('[data-action]').on('click', function() { actions[+$(this).attr('data-action')].fn(); });
		// What just happened changes what is waiting; home shows it fresh.
		this.refresh_inbox();
	}

	place(name) {
		var ctx = this.ctx;
		return [].concat(ctx.mine, ctx.stores, ctx.vans, ctx.sites).filter(function(p) { return p.name === name; })[0];
	}

	// "VAN1 · Assets" -> "Assets": inside your own van the van's name is noise.
	compartment(warehouse) {
		var found = '';
		[].concat(this.ctx.vans, this.ctx.mine).forEach(function(v) {
			Object.keys(v.compartments || {}).forEach(function(cat) {
				if (v.compartments[cat] === warehouse) found = cat;
			});
		});
		return found;
	}

	// ---- home --------------------------------------------------------------

	home() {
		this.from_desk = false;
		var ctx = this.ctx;
		var kind = ctx.kind;
		var here = ctx.mine.length === 1 ? ctx.mine[0].label : __('Your {0} sites', [ctx.mine.length]);
		var role = { store: __('Main store'), van: __('Van'), site: __('Site') }[kind];
		var mark = { store: 'warehouse', van: 'van', site: 'hard-hat' }[kind];

		var tiles = [];
		if (kind === 'store') {
			tiles.push(this.tile('book', 'clipboard-text', __('Book stock to a project'), __('List what is going to a project')));
			tiles.push(this.tile('send-van', 'truck', __('Send to a van'), __('Van stock: load a van from the store')));
			tiles.push(this.tile('stock', 'package', __('In the store'), __('What is on the shelves')));
		} else if (kind === 'van') {
			tiles.push(this.tile('deliver', 'map-pin', __('Deliver to a site'), __('Hand stock over at a site')));
			tiles.push(this.tile('collect', 'storefront', __('Collect from supplier'), __('Book a site order into your van')));
			tiles.push(this.tile('used', 'wrench', __('Used on site'), __('Record what was fitted; it costs the job')));
			tiles.push(this.tile('used-van', 'toolbox', __('Used from the van'), __('Fitted straight from the van; it costs the job')));
			if ((ctx.vans || []).length > 1) tiles.push(this.tile('van-to-van', 'arrows-left-right', __('To another van'), __('Hand stock to another driver')));
			tiles.push(this.tile('return-store', 'arrow-u-down-left', __('Back to the store'), __('Return what is not needed')));
			tiles.push(this.tile('stock', 'package', __('My van'), __('What is in each part of the van')));
		} else {
			tiles.push(this.tile('used', 'wrench', __('Used on site'), __('Record what was fitted; it costs the job')));
			tiles.push(this.tile('return-van', 'truck', __('Back on a van'), __('Send stock off site')));
			if (this.paired_sites().length) tiles.push(this.tile('site-to-site', 'arrows-left-right', __('To another site'), __('Move stock to another site on the project')));
			tiles.push(this.tile('stock', 'package', __('On site now'), __('What is in the site store')));
		}
		if (kind !== 'store' && (ctx.receive_at || []).length) {
			tiles.push(this.tile('receive', 'receipt', __('Supplier delivery'), __('Book in what a supplier brought to site')));
		}
		tiles.push(this.tile('find', 'magnifying-glass', __('Find stock'), __('How much is there, and where')));

		this.render([
			'<div class="ch-hero">',
			'  <span class="ch-hero-mark">' + ch_icon(mark) + '</span>',
			'  <div class="ch-hero-text">',
			'    <div class="ch-hero-title">' + ch_esc(here) + '</div>',
			'    <div class="ch-hero-sub">' + ch_esc(ctx.full_name) + ' · ' + ch_esc(role) + '</div>',
			'  </div>',
			// One tap back to the desk, from the store, a van or a site.
			'  <button class="ch-hero-home" data-desk="1">' + ch_icon('house') + __('Home') + '</button>',
			'</div>',
			'<div data-incoming></div>',
			'<div data-bookings></div>',
			this.scan_box(__('Scan or type an item to find it')),
			'<div data-results></div>',
			'<div class="ch-menu">' + tiles.join('\n') + '</div>',
			'<div data-sent></div>',
			'<div class="ch-links">',
			'  <button class="ch-link" data-go="recent">' + ch_icon('clock-counter-clockwise') + __('Recent') + '</button>',
			ctx.purchasing ? '  <button class="ch-link" data-go="po-request">' + ch_icon('shopping-cart') + __('Raise a PO') + '</button>' : '',
			ctx.purchasing ? '  <button class="ch-link" data-go="po-approvals">' + ch_icon('seal-check') + __('PO approvals') + '</button>' : '',
			'</div>'
		].join('\n'), 'home');

		this.$root.find('[data-go]').on('click', (e) => this.go($(e.currentTarget).attr('data-go')));
		this.$root.find('[data-desk]').on('click', () => frappe.set_route((frappe.boot.versions || {}).nest_home ? 'nest-home' : ''));
		this.bind_scan((term) => this.home_scan(term));
		this.paint_inbox();
		this.refresh_inbox();
		if (kind === 'store') this.paint_bookings();
	}

	booking_rows(list) {
		return list.map((b) => this.row(
			'data-booking="' + ch_esc(b.name) + '"',
			ch_esc(__('For {0}', [b.project_name || b.project])),
			ch_esc([b.name, ch_lines(b.lines.length), b.by, ch_when(b.at)].join(' · ')),
			this.tag(__('Issue'), 'go')
		)).join('\n');
	}

	bind_bookings($box, list, back) {
		$box.find('[data-booking]').on('click', (e) => {
			var name = $(e.currentTarget).attr('data-booking');
			this.issue_booking(list.filter(function(b) { return b.name === name; })[0], back);
		});
	}

	// Booked to a project, not issued to a van yet: tap one to issue it.
	paint_bookings() {
		ch_call('bookings').then((list) => {
			if (this.screen !== 'home') return;
			var $box = this.$root.find('[data-bookings]');
			$box.html(list.length ? [
				'<div class="ch-waiting">',
				'  <div class="ch-waiting-head">' + ch_icon('clipboard-text') + ch_esc(list.length === 1 ? __('1 booking to issue to a van') : __('{0} bookings to issue to a van', [list.length])) + '</div>',
				'  <div class="ch-list">',
				this.booking_rows(list),
				'  </div>',
				'</div>'
			].join('\n') : '');
			this.bind_bookings($box, list, () => this.home());
		});
	}

	// The Issue to Van screen: every booking waiting to go out, nothing else.
	issue_list() {
		this.render([
			this.head(__('Issue to a van'), __('Stock booked to projects, waiting to go out'), true),
			'<div data-issue-list><div class="ch-note">' + __('Loading...') + '</div></div>'
		].join('\n'), 'issue-list');
		this.bind_back(() => this.back_home());
		ch_call('bookings').then((list) => {
			if (this.screen !== 'issue-list') return;
			var $box = this.$root.find('[data-issue-list]');
			if (!list.length) {
				$box.html([
					'<div class="ch-note">' + __('Nothing is booked and waiting to go out.') + '</div>',
					'<button class="ch-secondary" data-book="1">' + ch_icon('clipboard-text') + __('Book stock to a project') + '</button>'
				].join('\n'));
				$box.find('[data-book]').on('click', () => this.send('book'));
				return;
			}
			$box.html('<div class="ch-list">' + this.booking_rows(list) + '</div>');
			this.bind_bookings($box, list, () => this.issue_list());
		});
	}

	// Issue a booking to a van exactly as booked: pick the van, tap Issue.
	// back: where the back arrow goes, the screen the booking was picked from.
	issue_booking(b, back) {
		var vans = this.ctx.vans;
		var kept = ch_remembered('issue:van');
		this.to = vans.some(function(v) { return v.name === kept; }) ? kept : (vans.length === 1 ? vans[0].name : '');
		this.docket_id = frappe.utils.get_random(20);
		this.render([
			this.head(__('For {0}', [b.project_name || b.project]), b.name, true),
			'<div class="ch-card">',
			this.facts([[__('Project'), b.project_name || b.project], [__('Booked by'), b.by + ' · ' + ch_when(b.at)]]),
			'</div>',
			'<div class="ch-section">' + __('Going') + '</div>',
			'<div class="ch-list">',
			b.lines.map((l) => [
				'<div class="ch-row ch-row-static">',
				'  <span class="ch-row-main">' + ch_esc(l.item_code) + '</span>',
				'  <span class="ch-row-sub">' + ch_esc(l.item_name || '') + '</span>',
				'  <span class="ch-row-right">' + ch_esc(ch_amount(l.to_go, l.uom)) + (l.to_go < l.booked ? '<br><span class="ch-dim">' + ch_esc(__('of {0} booked', [ch_qty(l.booked)])) + '</span>' : '') + '</span>',
				'</div>'
			].join('\n')).join('\n'),
			'</div>',
			this.place_field('to', __('Van'), vans, this.to, __('Choose the van')),
			'<div class="ch-actions"><button class="ch-submit" data-issue="1">' + ch_icon('paper-plane-tilt') + '<span data-issue-label></span></button></div>'
		].join('\n'), 'issue');
		this.bind_back(back);
		var label = () => {
			var van = this.place(this.to);
			this.$root.find('[data-issue]').prop('disabled', !van);
			this.$root.find('[data-issue-label]').text(van ? __('Issue to {0}', [van.label + (van.driver ? ' · ' + van.driver : '')]) : __('Choose the van first'));
		};
		this.$root.find('[data-side]').on('change', (e) => {
			this.to = $(e.currentTarget).val();
			ch_remember('issue:van', this.to);
			label();
		});
		label();
		this.$root.find('[data-issue]').on('click', () => {
			var van = this.place(this.to);
			if (!van) return;
			ch_call('issue', { booking: b.name, van: van.name, docket_id: this.docket_id }, true).then((r) => {
				this.done(__('Issued to {0}', [van.label]), r.name + ' · ' + __('nothing moves until the driver counts it and accepts'), [
					{ label: __('Issue another'), primary: true, fn: () => this.issue_list() },
					{ label: __('Home'), fn: () => this.back_home() }
				]);
			});
		});
	}

	refresh_inbox() {
		ch_call('inbox').then((inbox) => {
			this.ctx.inbox = inbox;
			if (this.screen === 'home') this.paint_inbox();
		});
	}

	paint_inbox() {
		var all = this.ctx.inbox || { incoming: [], sent: [] };
		// Only this screen's places: a driver who runs sites sees his van's handovers on
		// the van screen and his sites' on the sites screen.
		var names = this.ctx.mine.map(function(p) { return p.name; });
		var here = function(warehouse) { return !warehouse || names.indexOf(warehouse) !== -1; };
		var inbox = {
			incoming: (all.incoming || []).filter(function(d) { return here(d.to_warehouse); }),
			sent: (all.sent || []).filter(function(d) { return here(d.from_warehouse); })
		};
		var several = this.ctx.mine.length > 1;
		var $in = this.$root.find('[data-incoming]');
		var $sent = this.$root.find('[data-sent]');

		$in.html(inbox.incoming.length ? [
			'<div class="ch-waiting">',
			'  <div class="ch-waiting-head">' + ch_icon('hand-arrow-down') + ch_esc(inbox.incoming.length === 1 ? __('1 handover to accept') : __('{0} handovers to accept', [inbox.incoming.length])) + '</div>',
			'  <div class="ch-list">',
			// One row per handover: the site it is for and how many items; tap to see them all.
			inbox.incoming.map((d) => this.row(
				'data-docket="' + ch_esc(d.name) + '"',
				d.site
					? ch_esc(__('For {0}', [d.site]))
					: ch_esc(__('From {0}', [d.from])) + (several ? ' <span class="ch-dim">' + ch_esc(__('to {0}', [d.to])) + '</span>' : ''),
				ch_esc(ch_lines(d.lines)) + ' · ' + ch_esc(d.site ? __('from {0}', [d.from]) : d.by) + ' · ' + ch_esc(ch_when(d.at)),
				this.tag(__('Count'), 'go')
			)).join('\n'),
			'  </div>',
			'</div>'
		].join('\n') : '');

		$sent.html(inbox.sent.length ? [
			'<div class="ch-section">' + __('Sent, not accepted yet') + '</div>',
			'<div class="ch-list">',
			inbox.sent.map((d) => this.row(
				'data-docket="' + ch_esc(d.name) + '"',
				ch_esc(__('To {0}', [d.to])),
				ch_esc(d.preview) + ' · ' + ch_esc(ch_when(d.at)),
				this.tag(__('Waiting'))
			)).join('\n'),
			'</div>'
		].join('\n') : '');

		this.$root.find('[data-docket]').on('click', (e) => this.review($(e.currentTarget).attr('data-docket')));
	}

	home_scan(term) {
		ch_call('resolve_scan', { term: term }).then((hit) => {
			if (hit.type === 'item') this.find(hit.value);
			else this.suggest(hit, (item) => this.find(item.item_code));
		});
	}

	// Nothing matched exactly: say so, and offer close matches one tap away.
	suggest(hit, pick) {
		var items = hit.suggestions || [];
		var $results = this.$root.find('[data-results]');
		if (!items.length) {
			$results.html('<div class="ch-note">' + ch_esc(hit.label) + '</div>');
			return;
		}
		$results.html([
			'<div class="ch-note">' + ch_esc(hit.label) + ' ' + __('Did you mean:') + '</div>',
			'<div class="ch-list">',
			items.map((it, i) => this.row('data-sitem="' + i + '"', ch_esc(it.item_code), ch_esc(it.item_name), '')).join('\n'),
			'</div>'
		].join('\n'));
		$results.find('[data-sitem]').on('click', function() {
			$results.empty();
			pick(items[+$(this).attr('data-sitem')]);
		});
	}

	// ---- sending -----------------------------------------------------------

	send(kind) {
		var how = CH_SENDS[kind];
		var ctx = this.ctx;
		this.kind = kind;
		this.basket = [];
		this.due = null;
		this.docket_id = frappe.utils.get_random(20);
		this.project = '';

		var mine_names = this.sources(how).map(function(p) { return p.name; });
		var kept_from = ch_remembered(kind + ':from');
		// A manager with several sites chooses the site each time: From opens empty.
		var several = mine_names.length > 1 && this.ctx.kind === 'site';
		this.from = several ? '' : (mine_names.indexOf(kept_from) !== -1 ? kept_from : (mine_names[0] || ''));

		var targets = this.targets(how);
		// Booking: the storeman always chooses the site, never last time's.
		var kept_to = how.book ? '' : ch_remembered(kind + ':to');
		this.to = targets.some(function(p) { return p.name === kept_to; }) ? kept_to : (targets.length === 1 ? targets[0].name : '');
		// A site is picked project first (site_fields): start on the chosen site's project.
		this.to_project = how.to === 'sites' && !how.same_project ? ((this.place(this.to) || {}).project || this.to) : '';

		this.paint_send(how);
		if ((kind === 'to-site' || kind === 'van-to-van') && (this.place(this.from) || {}).kind === 'van') this.load_due(how);
	}

	// Where a handover can come from: my own places; to another site, only my sites
	// that share their project with another site.
	sources(how) {
		return how.same_project ? this.paired_sites() : this.ctx.mine;
	}

	paired_sites() {
		var sites = this.ctx.sites || [];
		return (this.ctx.mine || []).filter(function(s) {
			return s.project && sites.some(function(o) { return o.project === s.project && o.name !== s.name; });
		});
	}

	// Deliver to a site starts from what the van holds for each project: a project with
	// stock due is chosen and its lines are already on the list, in full. The driver
	// says which of its sites, then takes off what is not for this one. To another van,
	// the projects with stock on the van come first and choosing one fills the list.
	load_due(how) {
		var kind = this.kind;
		ch_call('due', { van: this.from }).then((due) => {
			if (this.kind !== kind || this.screen !== 'send') return;
			this.due = due || {};
			if (how.to === 'sites') {
				if (!this.due[this.to_project]) {
					var first = ch_projects(this.targets(how)).filter((p) => this.due[p.name])[0];
					if (first) {
						this.to_project = first.name;
						this.to = '';
					}
				}
				if (!this.basket.length) this.basket = this.due_lines(this.to_project);
			}
			this.paint_send(how);
		});
	}

	due_lines(project) {
		return ((this.due || {})[project] || []).map(function(l) { return $.extend({}, l); });
	}

	// Book picks the project only: van stock belongs to a project. Deliver then asks
	// which of its sites, only when it has more than one. One project, or one site on
	// the chosen project, fills in by itself.
	site_fields(how, targets) {
		var projects = ch_projects(targets);
		if (projects.length === 1) this.to_project = projects[0].name;
		var project = projects.filter((p) => p.name === this.to_project)[0];
		var sites = project && !how.book ? ch_by_label(project.sites) : [];
		if (sites.length === 1) this.to = sites[0].name;
		return [
			this.place_field('to_project', __('Project'), this.due ? this.due_first(projects) : projects, this.to_project, __('Choose the project')),
			sites.length ? this.place_field('to', sites.length > 1 ? __('Which site?') : __('Site'), sites, this.to, __('Choose the site')) : ''
		].join('\n');
	}

	// Projects with stock due first, each saying how much.
	due_first(targets) {
		var due = this.due;
		var listed = targets.map(function(p) {
			var n = (due[p.name] || []).length;
			return n ? $.extend({}, p, { label: p.label + ' · ' + __('{0} due', [ch_lines(n)]) }) : p;
		});
		return listed.filter(function(p) { return due[p.name]; }).concat(listed.filter(function(p) { return !due[p.name]; }));
	}

	targets(how) {
		var from = this.place(this.from);
		var company = from && from.company;
		return (this.ctx[how.to] || []).filter((p) => p.name !== this.from && (!company || !p.company || p.company === company)
			&& (!(how.book || how.use) || p.project)
			&& (!how.same_project || !!(from && p.project && p.project === from.project)));
	}

	// What a load onto a van can be for: the storeman's open projects; from a van the
	// projects with sites, those with stock on the van first.
	load_projects() {
		if (this.ctx.kind === 'store') return this.ctx.projects || [];
		var projects = ch_projects((this.ctx.sites || []).filter(function(s) { return s.project; }));
		return this.due ? this.due_first(projects) : projects;
	}

	paint_send(how) {
		var source = this.place(this.from);
		var targets = this.targets(how);
		var projects = how.project ? this.load_projects() : [];

		this.render([
			this.head(how.title, source ? __('From {0}', [source.label]) : '', true),
			'<div class="ch-pair">',
			this.place_field('from', __('From'), ch_by_label(this.sources(how)), this.from, __('Choose where from')),
			how.to === 'sites' && !how.same_project
				? this.site_fields(how, targets)
				: this.place_field('to', how.same_project ? __('Which site?') : __('To'), ch_by_label(targets), this.to, how.same_project ? __('Choose the site') : __('Choose where to')),
			projects.length ? [
				'<label class="ch-label">' + __('For a project? (optional)'),
				'  <select class="ch-select" data-project="1">',
				'    <option value="">' + __('No: van stock') + '</option>',
				projects.map((p) => '<option value="' + ch_esc(p.name) + '"' + (p.name === this.project ? ' selected' : '') + '>' + ch_esc(p.label || p.project_name || p.name) + '</option>').join('\n'),
				'  </select>',
				'</label>'
			].join('\n') : '',
			'</div>',
			'<div data-route-note></div>',
			this.scan_box(__('Scan or type an item')),
			'<div data-results></div>',
			// What is going first, in its own colour; what else is here, to add from, below it.
			'<div class="ch-section">' + __('Going') + '</div>',
			'<div class="ch-list" data-basket></div>',
			'<div data-held></div>',
			how.book ? '' : '<label class="ch-label">' + __('Note (optional)') + '<input class="ch-text" data-note="1" autocomplete="off"></label>',
			'<div class="ch-actions"><button class="ch-submit" data-record="1">' + ch_icon('paper-plane-tilt') + '<span data-record-label></span></button></div>'
		].join('\n'), 'send');

		this.bind_back(() => this.back_home());
		this.$root.find('[data-side]').on('change', (e) => {
			var side = $(e.currentTarget).attr('data-side');
			this[side] = $(e.currentTarget).val();
			ch_remember(this.kind + ':' + side, this[side]);
			if (side === 'from') {
				// Different shelves: start the list again.
				this.basket = [];
				if (!this.targets(how).some((p) => p.name === this.to)) this.to = '';
				// To another site: one other site on the project fills in by itself.
				if (how.same_project && !this.to && this.targets(how).length === 1) this.to = this.targets(how)[0].name;
				if (!ch_projects(this.targets(how)).some((p) => p.name === this.to_project)) this.to_project = '';
				var reload = !!this.due;
				this.due = null;
				this.paint_send(how);
				if (reload) this.load_due(how);
				return;
			}
			if (side === 'to_project') {
				// Another project: its sites, and its stock on the van.
				this.to = '';
				if (this.due) this.basket = this.due_lines(this.to_project);
				this.paint_send(how);
				return;
			}
			this.paint_route_note(how);
		});
		this.$root.find('[data-project]').on('change', (e) => {
			this.project = $(e.currentTarget).val();
			// From a van: that project's stock on it fills the list.
			if (this.due) this.basket = this.due_lines(this.project);
			this.paint_route_note(how);
			this.paint_basket();
		});

		var filter = '';
		if (source && (how.out_of_van || source.kind === 'site')) this.paint_held(this.from, how, () => filter);
		this.bind_scan((term) => this.send_scan(term, how), (typed) => {
			filter = typed;
			this.filter_held(typed);
		});
		this.$root.find('[data-record]').on('click', () => this.record_send(how));
		this.paint_route_note(how);
		this.paint_basket(how.book ? __('Book {0}') : (how.use ? __('Record {0} used') : __('Send {0}')));
	}

	paint_route_note(how) {
		var target = this.place(this.to);
		var note = '';
		if (how.book) {
			note = __('Booked stock stays in the store until it is issued to a van.');
		} else if (how.into_van && target) {
			note = __('The driver chooses which part of {0} each item goes in.', [target.label]);
		} else if (how.use) {
			note = __('It costs the project as soon as you record it.');
		}
		this.$root.find('[data-route-note]').html(note ? '<div class="ch-hint">' + ch_icon('info') + ch_esc(note) + '</div>' : '');
	}

	// What is at the source now: tap a line to send it.
	paint_held(location, how, filter) {
		var $box = this.$root.find('[data-held]');
		$box.html('<div class="ch-note">' + __('Loading what is here...') + '</div>');
		ch_call('held', { location: location }).then((rows) => {
			this.held_rows = rows || [];
			// Used from the van: only what a job can use up, never tools or assets.
			if (how && how.use) this.held_rows = this.held_rows.filter((r) => CH_USABLE.indexOf(this.compartment(r.warehouse)) !== -1);
			if (!this.held_rows.length) {
				$box.html('<div class="ch-note">' + __('Nothing here at the moment.') + '</div>');
				return;
			}
			var in_van = how && how.out_of_van;
			$box.html([
				'<div class="ch-section">' + __('Here now (tap to add)') + '</div>',
				'<div class="ch-list">',
				this.held_rows.map((r, i) => {
					// The compartment first: on a phone the end of the line is cut off.
					var sub = (in_van ? ch_esc(this.compartment(r.warehouse)) + ' · ' : '') + ch_esc(r.item_name);
					var right = ch_esc(ch_amount(r.free, r.stock_uom)) + (r.free < r.qty ? '<br><span class="ch-dim">' + __('{0} on its way', [ch_qty(r.qty - r.free)]) + '</span>' : '');
					return this.row('data-held-row="' + i + '" data-filter="' + ch_esc((r.item_code + ' ' + r.item_name).toLowerCase()) + '"', ch_esc(r.item_code), sub, right);
				}).join('\n'),
				'</div>'
			].join('\n'));
			// In stock in blue; what is going or used is green (paint_basket).
			$box.find('[data-held-row]').addClass('ch-row-instock');
			$box.find('[data-held-row]').on('click', (e) => {
				var r = this.held_rows[+$(e.currentTarget).attr('data-held-row')];
				if (how) this.add_line(r, { s_warehouse: r.warehouse }, how);
				else this.add_used(r);
			});
			if (filter && filter()) this.filter_held(filter());
		});
	}

	filter_held(typed) {
		var f = (typed || '').toLowerCase();
		this.$root.find('[data-held-row]').each(function() {
			$(this).toggle(!f || ($(this).attr('data-filter') || '').indexOf(f) !== -1);
		});
	}

	send_scan(term, how) {
		ch_call('resolve_scan', { term: term, location: this.from }).then((hit) => {
			if (hit.type === 'item') this.add_line(hit.item, {}, how);
			else this.suggest(hit, (item) => this.add_line(item, {}, how));
		});
	}

	// Free to send from one warehouse, less what is already on the list.
	free_in(item_code, warehouse, held) {
		var free = 0;
		(held || []).forEach(function(r) { if (r.item_code === item_code && r.warehouse === warehouse) free += flt(r.free); });
		this.basket.forEach(function(b) { if (b.item_code === item_code && b.s_warehouse === warehouse) free -= flt(b.qty); });
		return Math.max(free, 0);
	}

	add_line(item, known, how) {
		this.$root.find('[data-results]').empty();
		if (item.tracked) {
			this.say(__('{0} is tracked by serial or batch number. Move it from the desk.', [item.item_code]), 'red');
			return;
		}
		var held = item.held || (this.held_rows || []).filter(function(r) { return r.item_code === item.item_code; });
		var uom = item.stock_uom || '';

		// Leaving a van: which compartment. Anywhere else: the place itself.
		var sources = how.out_of_van
			? (how.use ? CH_USABLE : CH_COMPARTMENTS).map((cat) => {
				var wh = (this.place(this.from).compartments || {})[cat];
				return wh ? { value: wh, cat: cat, free: this.free_in(item.item_code, wh, held) } : null;
			}).filter(function(s) { return s && s.free > 0; })
			: [{ value: this.from, free: this.free_in(item.item_code, this.from, held) }].filter(function(s) { return s.free > 0; });
		if (known.s_warehouse) sources = sources.filter(function(s) { return s.value === known.s_warehouse; });
		if (!sources.length) {
			this.say(__('None of {0} free to send from here.', [item.item_code]), 'red');
			return;
		}

		// Into a van the driver chooses the compartment when accepting, so the sender
		// only says how many, and from which compartment when leaving a van.
		var free_of = function(values) {
			var pick = values && values.take ? values.take : sources[0].value;
			return (sources.filter(function(s) { return s.value === pick; })[0] || sources[0]).free;
		};
		// Out of a van or a site the whole amount is the usual answer. From the main store
		// nothing earlier says how many, so it starts at one.
		var from_store = (this.place(this.from) || {}).kind === 'store';
		this.ask(item, {
			default: from_store ? (Math.min(1, sources[0].free) || sources[0].free) : sources[0].free,
			max: free_of,
			max_text: function(values) { return __('Only {0} free there.', [ch_amount(free_of(values), uom)]); },
			info: ch_esc(sources.length === 1 ? __('{0} free to send.', [ch_amount(sources[0].free, uom)]) : __('In more than one part of the van.')),
			take: sources.length > 1 ? sources.map(function(s) { return { value: s.value, label: s.cat + ' · ' + ch_amount(s.free, uom) }; }) : null,
			take_default: sources[0].value
		}, (qty, values) => {
			var s_warehouse = values.take || sources[0].value;
			var already = this.basket.filter(function(b) { return b.item_code === item.item_code && b.s_warehouse === s_warehouse; })[0];
			if (already) already.qty += qty;
			else this.basket.push({ item_code: item.item_code, item_name: item.item_name, stock_uom: uom, qty: qty, s_warehouse: s_warehouse });
			this.paint_basket();
		});
	}

	paint_basket(label) {
		if (label) this.record_label = label;
		var $basket = this.$root.find('[data-basket]');
		if (!this.basket.length) {
			$basket.html('<div class="ch-note">' + __('Nothing added yet. Scan an item, or tap one above.') + '</div>');
		} else {
			// On a send screen a line on the list can be tapped to change how many.
			var changeable = this.screen === 'send' || this.screen === 'use';
			$basket.html(this.basket.map((r, i) => {
				var where = [];
				var cat = this.compartment(r.s_warehouse);
				if (cat) where.push(__('from {0}', [cat]));
				return [
					// Going lines in green, so they never look like the stock still to choose from.
					'<div class="ch-row ch-row-static' + (changeable ? ' ch-row-booked" data-line-qty="' + i + '" style="cursor: pointer"' : '"') + '>',
					'  <span class="ch-row-main">' + ch_esc(r.item_code) + '</span>',
					'  <span class="ch-row-sub">' + ch_esc([r.item_name].concat(where).filter(Boolean).join(' · ')) + '</span>',
					'  <span class="ch-row-right">' + ch_esc(ch_amount(r.qty, r.stock_uom)) + '</span>',
					'  <button class="ch-remove" data-remove="' + i + '" aria-label="' + __('Remove') + '">' + ch_icon('x') + '</button>',
					'</div>'
				].join('\n');
			}).join('\n'));
			$basket.find('[data-remove]').on('click', (e) => {
				e.stopPropagation();
				this.basket.splice(+$(e.currentTarget).attr('data-remove'), 1);
				this.paint_basket();
			});
			$basket.find('[data-line-qty]').on('click', (e) => this.change_line(+$(e.currentTarget).attr('data-line-qty')));
		}
		var n = this.basket.length;
		this.$root.find('[data-record]').prop('disabled', !n);
		this.$root.find('[data-record-label]').text(n ? (this.record_label || '{0}').replace('{0}', ch_lines(n)) : __('Add items first'));
	}

	// A line on the list: send fewer (part of a delivery), or more up to what is free there.
	change_line(i) {
		var r = this.basket[i];
		if (!r) return;
		var held = (this.held_rows || []).filter(function(h) { return h.item_code === r.item_code && h.warehouse === r.s_warehouse; });
		var max = held.length ? this.free_in(r.item_code, r.s_warehouse, held) + flt(r.qty) : null;
		this.ask(r, {
			default: r.qty,
			max: max,
			max_text: max != null ? __('Only {0} free there.', [ch_amount(max, r.stock_uom)]) : null,
			info: max != null ? ch_esc(__('{0} free to send.', [ch_amount(max, r.stock_uom)])) : '',
			action: __('Set')
		}, (qty) => {
			r.qty = qty;
			this.paint_basket();
		});
	}

	record_send(how) {
		if (!this.from || !(how.book ? this.to_project : this.to)) { this.say(__('Choose where the goods come from and where they go.'), 'red'); return; }
		var target = this.place(this.to);
		if (how.book) {
			var project = ch_projects(this.targets(how)).filter((p) => p.name === this.to_project)[0];
			ch_call('book', {
				store: this.from,
				project: this.to_project,
				rows: JSON.stringify(this.basket.map(function(r) { return { item_code: r.item_code, qty: r.qty }; }))
			}, true).then((r) => {
				this.done(__('Booked for {0}', [project ? project.label : this.to_project]), r.name + ' · ' + __('it stays in the store until it is issued to a van'), [
					{ label: __('Book more'), primary: true, fn: () => this.send('book') },
					{ label: __('Home'), fn: () => this.back_home() }
				]);
			});
			return;
		}
		if (how.use) {
			var kind_used = this.kind;
			ch_call('use', {
				store: this.from,
				site: this.to,
				notes: this.$root.find('[data-note]').val() || '',
				rows: JSON.stringify(this.basket.map(function(r) {
					return { item_code: r.item_code, qty: r.qty, s_warehouse: r.s_warehouse };
				}))
			}, true).then((r) => {
				this.done(__('Used on {0}', [target.label]), r.name + ' · ' + __('costed to {0}', [target.project_name || r.project]), [
					{ label: __('Record more'), primary: true, fn: () => this.send(kind_used) },
					{ label: __('Home'), fn: () => this.back_home() }
				]);
			});
			return;
		}
		ch_call('send', {
			from_location: this.from,
			to_location: this.to,
			project: this.project || '',
			notes: this.$root.find('[data-note]').val() || '',
			docket_id: this.docket_id,
			rows: JSON.stringify(this.basket.map(function(r) {
				return { item_code: r.item_code, qty: r.qty, s_warehouse: r.s_warehouse };
			}))
		}, true).then((r) => {
			var kind = this.kind;
			// To a site he runs, a driver's delivery is in at once.
			var message = r.posted ? __('Booked into {0}', [target.label]) : __('Sent to {0}', [target.label]);
			var ref = r.posted ? r.stock_entry + ' · ' + r.name : r.name + ' · ' + __('nothing moves until they count it and accept');
			this.done(message, ref, [
				{ label: __('Send more'), primary: true, fn: () => this.send(kind) },
				{ label: __('Home'), fn: () => this.back_home() }
			]);
		});
	}

	// ---- one handover: count and accept, turn down, or withdraw ---------------

	review(name) {
		ch_call('docket', { name: name }).then((d) => {
			this.counted = {};
			// Into a van, the one part of the van the whole handover goes in. It opens on
			// Goods In Transit, the usual answer, so the driver only changes it on purpose.
			this.put = d.into_van && (d.compartments || []).indexOf('Goods In Transit') !== -1 ? 'Goods In Transit' : '';
			// Counting a handover is work in progress (see busy()); looking at one is not.
			this.counting = !!d.can_accept;
			d.lines.forEach((l) => { this.counted[l.row] = l.sent; });
			this.paint_review(d);
		});
	}

	// The parts of the van the driver can put stock in, in the screen's usual order.
	van_parts(d) {
		return CH_COMPARTMENTS.filter(function(c) { return (d.compartments || []).indexOf(c) !== -1; });
	}

	paint_review(d) {
		var facts = [
			[__('From'), d.from],
			[__('To'), d.to],
			d.project ? [__('Project'), d.project_name || d.project] : null,
			[__('Sent by'), d.by + ' · ' + ch_when(d.at)],
			d.received_by ? [__('Accepted by'), d.received_by + ' · ' + ch_when(d.received_at)] : null,
			d.stock_entry ? [__('Stock entry'), d.stock_entry] : null
		];
		var status = d.status === 'Open' ? null : (d.status === 'Posted' ? this.tag(__('Accepted'), 'good') : this.tag(__('Cancelled'), 'warn'));
		var title = d.can_accept ? __('From {0}', [d.from]) : __('To {0}', [d.to]);

		this.render([
			this.head(title, d.name, true),
			'<div class="ch-card">',
			status ? '<div class="ch-card-status">' + status + '</div>' : '',
			this.facts(facts),
			d.notes ? '<div class="ch-notes">' + ch_esc(d.notes).replace(/\n/g, '<br>') + '</div>' : '',
			'</div>',
			d.can_accept && d.into_van ? [
				'<label class="ch-label">' + __('Put it all in'),
				'  <select class="ch-select" data-put-all="1">',
				'    <option value="">' + __('Choose a part of the van') + '</option>',
				this.van_parts(d).map((c) => '<option value="' + ch_esc(c) + '"' + (c === this.put ? ' selected' : '') + '>' + ch_esc(c) + '</option>').join('\n'),
				'  </select>',
				'</label>'
			].join('\n') : '',
			'<div class="ch-section">' + (d.can_accept ? __('Count what arrived (tap a line to change it)') : __('What was sent')) + '</div>',
			'<div class="ch-list" data-lines></div>',
			d.can_accept ? '<label class="ch-label">' + __('Note (optional)') + '<input class="ch-text" data-note="1" autocomplete="off"></label>' : '',
			d.can_accept ? '<button class="ch-secondary ch-quiet" data-reject="1">' + ch_icon('prohibit') + __('Turn it down') + '</button>' : '',
			d.can_withdraw ? '<button class="ch-secondary" data-withdraw="1">' + ch_icon('arrow-bend-up-left') + __('Withdraw it') + '</button>' : '',
			d.can_accept ? '<div class="ch-actions"><button class="ch-submit" data-accept="1">' + ch_icon('check') + '<span data-accept-label></span></button></div>' : ''
		].join('\n'), 'review');

		this.bind_back(() => this.back_home());
		this.paint_lines(d);
		this.$root.find('[data-put-all]').on('change', (e) => {
			this.put = $(e.currentTarget).val() || '';
			this.paint_lines(d);
		});
		this.$root.find('[data-accept]').on('click', () => this.accept(d));
		this.$root.find('[data-reject]').on('click', () => this.reject(d));
		this.$root.find('[data-withdraw]').on('click', () => this.withdraw(d));
	}

	paint_lines(d) {
		var counted = this.counted;
		var choosing = d.can_accept && d.into_van;
		var $lines = this.$root.find('[data-lines]');
		$lines.html(d.lines.map((l) => {
			// Only a van's compartments are worth saying per line; the rest is on the card.
			var where = [];
			if (this.is_compartment(l.from)) where.push(__('from {0}', [this.compartment_of(l.from)]));
			if (!choosing && this.is_compartment(l.to)) where.push(__('into {0}', [this.compartment_of(l.to)]));
			var sub = ch_esc(where.concat([l.item_name]).filter(Boolean).join(' · '));
			var right;
			if (d.can_accept) {
				var n = flt(counted[l.row]);
				right = n === flt(l.sent)
					? this.tag(__('All {0}', [ch_amount(l.sent, l.uom)]), 'good')
					: this.tag(__('{0} of {1}', [ch_qty(n), ch_qty(l.sent)]), 'warn');
			} else if (d.status === 'Posted') {
				right = flt(l.received) === flt(l.sent) ? ch_esc(ch_amount(l.sent, l.uom)) : this.tag(__('{0} of {1}', [ch_qty(l.received), ch_qty(l.sent)]), 'warn');
			} else {
				right = ch_esc(ch_amount(l.sent, l.uom));
			}
			return this.row((d.can_accept ? '' : 'disabled ') + 'data-line="' + ch_esc(l.row) + '"', ch_esc(l.item_code), sub, right);
		}).join('\n'));
		if (d.can_accept) {
			$lines.find('[data-line]').on('click', (e) => {
				var l = d.lines.filter(function(x) { return x.row === $(e.currentTarget).attr('data-line'); })[0];
				this.ask(l, {
					label: __('How many arrived?'),
					default: counted[l.row],
					max: l.sent,
					max_text: __('Only {0} was sent. Ask for the extra to be sent on its own.', [ch_qty(l.sent)]),
					info: ch_esc(__('{0} sent.', [ch_amount(l.sent, l.uom)])),
					allow_zero: true,
					action: __('Set')
				}, (qty) => {
					counted[l.row] = qty;
					this.paint_lines(d);
				});
			});
			var short = d.lines.filter(function(l) { return flt(counted[l.row]) < flt(l.sent); }).length;
			var arrived = d.lines.filter(function(l) { return flt(counted[l.row]) > 0; }).length;
			var unplaced = choosing && !this.put;
			this.$root.find('[data-accept]').prop('disabled', !arrived || unplaced);
			this.$root.find('[data-accept-label]').text(!arrived
				? __('Nothing counted in')
				: (unplaced ? __('Choose the part of the van first')
					: (short ? __('Accept, {0} short', [short === 1 ? __('1 line') : __('{0} lines', [short])]) : __('Accept {0}', [ch_lines(d.lines.length)]))));
		}
	}

	// Line labels come from the server as "VAN1 · Assets" for a van's compartment.
	is_compartment(label) {
		return String(label || '').indexOf(' · ') !== -1;
	}

	compartment_of(label) {
		var parts = String(label || '').split(' · ');
		return parts[parts.length - 1];
	}

	accept(d) {
		ch_call('accept', {
			name: d.name,
			counted: JSON.stringify(this.counted),
			put: this.put,
			notes: this.$root.find('[data-note]').val() || ''
		}, true).then((r) => {
			this.done(__('Accepted into {0}', [d.to]), r.stock_entry + ' · ' + d.name, [
				{ label: __('Home'), primary: true, fn: () => this.back_home() }
			]);
		});
	}

	reject(d) {
		// A note already typed on the handover is the reason: never typed twice.
		var typed = (this.$root.find('[data-note]').val() || '').trim();
		var dialog = new frappe.ui.Dialog({
			title: __('Turn it down'),
			fields: [{ fieldtype: 'Small Text', fieldname: 'reason', label: __('Why? {0} will see this.', [d.by]), reqd: 1, default: typed }],
			primary_action_label: __('Turn it down'),
			primary_action: (values) => {
				dialog.hide();
				ch_call('reject', { name: d.name, reason: values.reason }, true).then(() => {
					this.done(__('Turned down'), d.name + ' · ' + __('nothing moved'), [
						{ label: __('Home'), primary: true, fn: () => this.back_home() }
					]);
				});
			}
		});
		dialog.show();
	}

	withdraw(d) {
		frappe.confirm(__('Withdraw this handover to {0}? Nothing will move.', [d.to]), () => {
			ch_call('withdraw', { name: d.name }, true).then(() => {
				this.done(__('Withdrawn'), d.name + ' · ' + __('nothing moved'), [
					{ label: __('Home'), primary: true, fn: () => this.back_home() }
				]);
			});
		});
	}

	// ---- used on site ------------------------------------------------------

	use() {
		var ctx = this.ctx;
		// A driver who runs sites records what was used on his own sites only.
		var run = this.all.managed || [];
		var sites = ctx.kind === 'site' ? ctx.mine : (run.length ? run : ctx.sites);
		sites = sites.filter(function(s) { return s.project; });
		if (sites.length === 1) { this.use_at(sites[0]); return; }
		this.pick_site(__('Used on site'), sites, (site) => this.use_at(site));
	}

	pick_site(title, sites, next) {
		this.render([
			this.head(title, __('Which site?'), true),
			this.scan_box(__('Type to find the site')),
			'<div class="ch-list" data-sites></div>'
		].join('\n'), 'pick');
		this.bind_back(() => this.back_home());

		var kept = ch_remembered('site');
		// A-Z, so a site is where you expect it; the last one used keeps its tag.
		var ordered = ch_by_label(sites);
		var paint = (filter) => {
			var f = (filter || '').toLowerCase();
			var shown = ordered.filter(function(s) { return !f || [s.label, s.project_name].some(function(v) { return String(v || '').toLowerCase().indexOf(f) !== -1; }); });
			var $list = this.$root.find('[data-sites]');
			if (!shown.length) {
				$list.html('<div class="ch-note">' + (sites.length ? __('No site matches that.') : __('No sites are on an open project.')) + '</div>');
				return;
			}
			$list.html(shown.map((s) => this.row('data-site="' + ch_esc(s.name) + '"', ch_icon('map-pin') + ' ' + ch_esc(this.site_name(s)), '', s.name === kept ? this.tag(__('Last time')) : '')).join('\n'));
			$list.find('[data-site]').on('click', function() {
				var name = $(this).attr('data-site');
				next(sites.filter(function(s) { return s.name === name; })[0]);
			});
		};
		paint('');
		this.bind_scan((term) => {
			var f = term.toLowerCase();
			var hits = sites.filter(function(s) { return String(s.label).toLowerCase().indexOf(f) !== -1; });
			if (hits.length === 1) next(hits[0]);
			else paint(term);
		}, paint);
	}

	// A site's label usually carries its project already ("BAT26 Site 1"); say it once.
	site_name(site) {
		var project = site.project_name || '';
		return project && String(site.label).indexOf(project) === -1 ? site.label + ' · ' + project : site.label;
	}

	use_at(site) {
		ch_remember('site', site.name);
		this.kind = null;
		this.basket = [];
		this.from = site.name;
		this.render([
			this.head(__('Used on site'), this.site_name(site), true),
			this.scan_box(__('Scan or type what was fitted')),
			'<div data-results></div>',
			// What was used first, in green; what is on site, to add from, below it.
			'<div class="ch-section">' + __('Used') + '</div>',
			'<div class="ch-list" data-basket></div>',
			'<div data-held></div>',
			'<label class="ch-label">' + __('Note (optional)') + '<input class="ch-text" data-note="1" autocomplete="off"></label>',
			'<div class="ch-actions"><button class="ch-submit" data-record="1">' + ch_icon('check') + '<span data-record-label></span></button></div>'
		].join('\n'), 'use');

		this.bind_back(() => this.back_home());
		var filter = '';
		this.paint_held(site.name, null, () => filter);
		this.bind_scan((term) => {
			ch_call('resolve_scan', { term: term, location: site.name }).then((hit) => {
				if (hit.type === 'item') this.add_used(hit.item);
				else this.suggest(hit, (item) => this.add_used(item));
			});
		}, (typed) => {
			filter = typed;
			this.filter_held(typed);
		});
		this.$root.find('[data-record]').on('click', () => {
			ch_call('use', {
				store: site.name,
				notes: this.$root.find('[data-note]').val() || '',
				rows: JSON.stringify(this.basket.map(function(r) { return { item_code: r.item_code, qty: r.qty }; }))
			}, true).then((r) => {
				this.done(__('Used on {0}', [site.label]), r.name + ' · ' + __('costed to {0}', [site.project_name || r.project]), [
					{ label: __('More for {0}', [site.label]), primary: true, fn: () => this.use_at(site) },
					{ label: __('Home'), fn: () => this.back_home() }
				]);
			});
		});
		this.paint_basket(__('Record {0} used'));
	}

	add_used(item) {
		this.$root.find('[data-results]').empty();
		if (item.tracked) {
			this.say(__('{0} is tracked by serial or batch number. It is moved, not used up.', [item.item_code]), 'red');
			return;
		}
		var held = item.held || (this.held_rows || []).filter(function(r) { return r.item_code === item.item_code; });
		var free = this.free_in(item.item_code, this.from, held);
		var uom = item.stock_uom || '';
		if (free <= 0) {
			this.say(__('None of {0} at this site.', [item.item_code]), 'red');
			return;
		}
		this.ask(item, {
			// Empty: the site manager says how many were used.
			default: '',
			max: free,
			max_text: __('Only {0} at this site.', [ch_amount(free, uom)]),
			info: ch_esc(__('{0} at this site.', [ch_amount(free, uom)]))
		}, (qty) => {
			var already = this.basket.filter(function(b) { return b.item_code === item.item_code; })[0];
			if (already) already.qty += qty;
			else this.basket.push({ item_code: item.item_code, item_name: item.item_name, stock_uom: uom, qty: qty, s_warehouse: this.from });
			this.paint_basket();
		});
	}

	// ---- supplier deliveries on site ---------------------------------------

	// The storeman books in orders due at the main store; a site, the orders raised for it.
	receive() {
		if (this.ctx.kind === 'store') {
			var stores = this.ctx.mine;
			if (stores.length === 1) this.deliveries_at(stores[0]);
			else this.pick_site(__('Supplier delivery'), stores, (store) => this.deliveries_at(store));
			return;
		}
		var names = this.ctx.receive_at || [];
		var sites = this.ctx.sites.filter(function(s) { return names.indexOf(s.name) !== -1; });
		if (sites.length === 1) { this.deliveries_at(sites[0]); return; }
		this.pick_site(__('Supplier delivery'), sites, (site) => this.deliveries_at(site));
	}

	deliveries_at(site) {
		ch_remember('site', site.name);
		ch_call('deliveries', { site: site.name }).then((orders) => {
			this.render([
				this.head(__('Supplier delivery'), this.site_name(site), true),
				orders.length ? '<div class="ch-section">' + __('Orders still to arrive') + '</div>' : '',
				orders.length ? '<div class="ch-list">' + orders.map((o) => this.row(
					'data-po="' + ch_esc(o.name) + '"',
					ch_esc(o.supplier),
					ch_esc([o.name, ch_lines(o.lines.length), o.due ? __('due {0}', [frappe.datetime.str_to_user(o.due)]) : ''].filter(Boolean).join(' · ')),
					this.tag(__('Count'), 'go')
				)).join('\n') + '</div>' : '<div class="ch-note">' + (site.kind === 'store'
					? __('No approved orders are waiting to arrive at the store.')
					: __('No approved orders are waiting to arrive at this site.')) + '</div>'
			].join('\n'), 'deliveries');
			this.bind_back(() => this.back_home());
			this.$root.find('[data-po]').on('click', (e) => {
				var name = $(e.currentTarget).attr('data-po');
				this.count_delivery(site, orders.filter(function(o) { return o.name === name; })[0]);
			});
		});
	}

	count_delivery(site, o) {
		this.counted = {};
		o.lines.forEach((l) => { this.counted[l.row] = l.pending; });
		this.render([
			this.head(o.supplier, o.name, true),
			'<div class="ch-section">' + __('Count what arrived (tap a line to change it)') + '</div>',
			'<div class="ch-list" data-lines></div>',
			'<label class="ch-label">' + __('Supplier delivery note number (optional)') + '<input class="ch-text" data-dn="1" autocomplete="off"></label>',
			'<div class="ch-actions"><button class="ch-submit" data-book="1">' + ch_icon('check') + '<span data-book-label></span></button></div>'
		].join('\n'), 'delivery');
		this.bind_back(() => this.deliveries_at(site));
		this.paint_delivery(o);
		this.$root.find('[data-book]').on('click', () => {
			var counted = this.counted;
			var rows = o.lines.filter(function(l) { return flt(counted[l.row]) > 0; }).map(function(l) {
				return { po_detail: l.row, qty: counted[l.row] };
			});
			ch_call('receive', {
				purchase_order: o.name,
				rows: JSON.stringify(rows),
				delivery_note: this.$root.find('[data-dn]').val() || ''
			}, true).then((r) => {
				this.done(__('Booked into {0}', [site.label]), r.name + ' · ' + o.name, [
					{ label: __('Another delivery'), primary: true, fn: () => this.deliveries_at(site) },
					{ label: __('Home'), fn: () => this.back_home() }
				]);
			});
		});
	}

	// ---- collecting a site's order from the supplier -----------------------

	// Any driver picks up an order raised for a site and signs for it into his van. The
	// site manager then counts it off the van on a handover, like stock from the store.
	collect() {
		var van = this.ctx.mine[0];
		ch_call('collections').then((orders) => {
			this.render([
				this.head(__('Collect from supplier'), van.label, true),
				orders.length ? '<div class="ch-section">' + __('Site orders still at the supplier') + '</div>' : '',
				orders.length ? '<div class="ch-list">' + orders.map((o) => this.row(
					'data-po="' + ch_esc(o.name) + '"',
					ch_esc(o.supplier),
					ch_esc([__('For {0}', [o.site_label]), o.name, ch_lines(o.lines.length), o.due ? __('due {0}', [frappe.datetime.str_to_user(o.due)]) : ''].filter(Boolean).join(' · ')),
					this.tag(__('Count'), 'go')
				)).join('\n') + '</div>' : '<div class="ch-note">' + __('No approved site orders are waiting to be collected.') + '</div>'
			].join('\n'), 'collections');
			this.bind_back(() => this.back_home());
			this.$root.find('[data-po]').on('click', (e) => {
				var name = $(e.currentTarget).attr('data-po');
				this.count_collection(van, orders.filter(function(o) { return o.name === name; })[0]);
			});
		});
	}

	count_collection(van, o) {
		this.counted = {};
		o.lines.forEach((l) => { this.counted[l.row] = l.pending; });
		this.render([
			this.head(o.supplier, __('For {0}', [o.site_label]) + ' · ' + o.name, true),
			'<div class="ch-section">' + __('Count what you collected (tap a line to change it)') + '</div>',
			'<div class="ch-list" data-lines></div>',
			'<label class="ch-label">' + __('Supplier delivery note number (optional)') + '<input class="ch-text" data-dn="1" autocomplete="off"></label>',
			'<div class="ch-actions"><button class="ch-submit" data-book="1">' + ch_icon('check') + '<span data-book-label></span></button></div>'
		].join('\n'), 'delivery');
		this.bind_back(() => this.collect());
		this.paint_delivery(o, van.label);
		this.$root.find('[data-book]').on('click', () => {
			var counted = this.counted;
			var rows = o.lines.filter(function(l) { return flt(counted[l.row]) > 0; }).map(function(l) {
				return { po_detail: l.row, qty: counted[l.row] };
			});
			ch_call('collect', {
				purchase_order: o.name,
				rows: JSON.stringify(rows),
				delivery_note: this.$root.find('[data-dn]').val() || ''
			}, true).then((r) => {
				this.done(__('On {0} for {1}', [van.label, o.site_label]), r.name + ' · ' + o.name, [
					// Deliver to a site opens on that site, filled with what was collected.
					{ label: __('Deliver now'), primary: true, fn: () => { ch_remember('to-site:to', r.site); this.send('to-site'); } },
					{ label: __('Home'), fn: () => this.back_home() }
				]);
			});
		});
	}

	// into: a driver collecting into his van, not a delivery arriving here.
	paint_delivery(o, into) {
		var counted = this.counted;
		var $lines = this.$root.find('[data-lines]');
		$lines.html(o.lines.map((l) => {
			var n = flt(counted[l.row]);
			var right = n === flt(l.pending)
				? this.tag(__('All {0}', [ch_amount(l.pending, l.uom)]), 'good')
				: this.tag(__('{0} of {1}', [ch_qty(n), ch_qty(l.pending)]), 'warn');
			return this.row('data-line="' + ch_esc(l.row) + '"', ch_esc(l.item_code), ch_esc(l.item_name || ''), right);
		}).join('\n'));
		$lines.find('[data-line]').on('click', (e) => {
			var l = o.lines.filter(function(x) { return x.row === $(e.currentTarget).attr('data-line'); })[0];
			this.ask(l, {
				label: into ? __('How many did you collect?') : __('How many arrived?'),
				default: counted[l.row],
				max: l.pending,
				max_text: __('Only {0} is still to come on this order. The office books in any extra.', [ch_qty(l.pending)]),
				info: ch_esc(__('{0} still to come.', [ch_amount(l.pending, l.uom)])),
				allow_zero: true,
				action: __('Set')
			}, (qty) => {
				counted[l.row] = qty;
				this.paint_delivery(o, into);
			});
		});
		var short = o.lines.filter(function(l) { return flt(counted[l.row]) < flt(l.pending); }).length;
		var arrived = o.lines.filter(function(l) { return flt(counted[l.row]) > 0; }).length;
		var short_lines = short === 1 ? __('1 line') : __('{0} lines', [short]);
		this.$root.find('[data-book]').prop('disabled', !arrived);
		this.$root.find('[data-book-label]').text(!arrived
			? __('Nothing counted in')
			: into
				? (short ? __('Book into {0}, {1} short', [into, short_lines]) : __('Book into {0}', [into]))
				: (short ? __('Book in, {0} short', [short_lines]) : __('Book in {0}', [ch_lines(o.lines.length)])));
	}

	// ---- what is here ------------------------------------------------------

	my_stock(location) {
		var ctx = this.ctx;
		// Several places (a manager's sites): the site is chosen each time, from an A-Z list.
		var several = ctx.mine.length > 1;
		if (!several) location = location || ctx.mine[0].name;
		var here = location ? this.place(location) : null;
		var title = { store: __('In the store'), van: __('My van'), site: __('On site now') }[ctx.kind];

		this.render([
			this.head(title, here ? here.label : '', true),
			several ? '<div class="ch-pair">' + this.place_field('stock', __('Where'), ch_by_label(ctx.mine), location || '', __('Choose a site')) + '</div>' : '',
			this.scan_box(__('Type to find an item')),
			'<div data-stock><div class="ch-note">' + (location ? __('Loading...') : __('Choose a site to see what is there.')) + '</div></div>'
		].join('\n'), 'stock');
		this.bind_back(() => this.back_home());
		this.$root.find('[data-side]').on('change', (e) => {
			var picked = $(e.currentTarget).val();
			if (picked) this.my_stock(picked);
		});
		if (!location) {
			this.bind_scan((term) => this.find_from(term));
			return;
		}

		ch_call('held', { location: location }).then((rows) => {
			rows = rows || [];
			var $box = this.$root.find('[data-stock]');
			if (!rows.length) { $box.html('<div class="ch-note">' + __('Nothing here at the moment.') + '</div>'); return; }
			var line = (r) => {
				var right = ch_esc(ch_amount(r.qty, r.stock_uom)) + (r.free < r.qty ? '<br><span class="ch-dim">' + __('{0} on its way out', [ch_qty(r.qty - r.free)]) + '</span>' : '');
				return this.row('disabled data-filter="' + ch_esc((r.item_code + ' ' + r.item_name).toLowerCase()) + '" data-held-row="1"', ch_esc(r.item_code), ch_esc(r.item_name), right);
			};
			// One tight line per item, name and amount (the code still finds it): vans and
			// sites hold a lot.
			var compact = function(r) {
				var out = r.free < r.qty ? '<small>' + ch_esc(__('{0} on its way out', [ch_qty(r.qty - r.free)])) + '</small>' : '';
				return '<div class="ch-compact-row" data-held-row="1" data-filter="' + ch_esc((r.item_code + ' ' + r.item_name).toLowerCase()) + '">' +
					'<span>' + ch_esc(r.item_name || r.item_code) + '</span><b>' + ch_esc(ch_amount(r.qty, r.stock_uom)) + out + '</b></div>';
			};
			if (here.kind === 'van') {
				// One tab per part of the van.
				var parts = CH_COMPARTMENTS.filter(function(cat) { return (here.compartments || {})[cat]; });
				var in_part = function(cat) { return rows.filter(function(r) { return r.warehouse === here.compartments[cat]; }); };
				var tab = nch_stock.first_tab(parts, ch_remembered('van-tab'), function(cat) { return in_part(cat).length; });
				var paint_tab = () => {
					var mine = in_part(tab);
					$box.html([
						'<div class="ch-tabs" role="tablist">',
						parts.map(function(cat) {
							var on = cat === tab;
							return '<button class="ch-tab' + (on ? ' ch-tab-on' : '') + '" role="tab" aria-selected="' + on + '" data-tab="' + ch_esc(cat) + '">' +
								'<span>' + ch_esc(cat) + '</span><b>' + in_part(cat).length + '</b></button>';
						}).join('\n'),
						'</div>',
						mine.length ? '<div class="ch-compact">' + mine.map(compact).join('\n') + '</div>' : '<div class="ch-note ch-note-small">' + __('Empty') + '</div>'
					].join('\n'));
					$box.find('[data-tab]').on('click', (e) => {
						tab = $(e.currentTarget).attr('data-tab');
						ch_remember('van-tab', tab);
						paint_tab();
						this.filter_held(this.$root.find('[data-scan]').val());
					});
				};
				paint_tab();
			} else if (here.kind === 'site') {
				$box.html('<div class="ch-compact">' + rows.map(compact).join('\n') + '</div>');
			} else {
				$box.html('<div class="ch-list">' + rows.map(line).join('\n') + '</div>');
			}
		});
		this.bind_scan((term) => this.find_from(term), (typed) => this.filter_held(typed));
	}

	// ---- find stock --------------------------------------------------------

	find(item_code) {
		this.render([
			this.head(__('Find stock'), __('Scan or type an item'), true),
			this.scan_box(__('Scan or type an item')),
			'<div data-results></div>',
			'<div data-stock></div>'
		].join('\n'), 'find');
		this.bind_back(() => this.back_home());
		this.bind_scan((term) => this.find_from(term));
		if (item_code) this.show_stock(item_code);
	}

	find_from(term) {
		ch_call('resolve_scan', { term: term }).then((hit) => {
			if (hit.type === 'item') {
				if (this.screen !== 'find') this.find(hit.value);
				else this.show_stock(hit.value);
			} else {
				if (this.screen !== 'find') this.find();
				this.suggest(hit, (item) => this.show_stock(item.item_code));
			}
		});
	}

	show_stock(item_code) {
		this.$root.find('[data-results]').empty();
		ch_call('stock_for', { item_code: item_code }).then((s) => {
			var uom = s.stock_uom || '';
			var rows = s.rows || [];
			this.$root.find('[data-stock]').html([
				'<div class="ch-card">',
				'  <div class="ch-card-title">' + ch_esc(s.item_name || s.item_code) + '</div>',
				'  <div class="ch-dim">' + ch_esc(s.item_code) + '</div>',
				'  <div class="ch-totals">',
				'    <div><b>' + ch_esc(ch_amount(s.on_hand, uom)) + '</b><span>' + __('on hand') + '</span></div>',
				'    <div><b>' + ch_esc(ch_amount(s.on_order, uom)) + '</b><span>' + __('on order') + '</span></div>',
				'  </div>',
				'</div>',
				rows.length ? '<div class="ch-section">' + __('Where it is') + '</div><div class="ch-list">' + rows.map((r) => {
					var main = ch_esc(r.where) + (r.mine ? ' ' + this.tag(__('Yours')) : '');
					return this.row('disabled', main, '', ch_esc(ch_amount(r.qty, uom)));
				}).join('\n') + '</div>' : '<div class="ch-note">' + __('None in stock anywhere.') + '</div>'
			].join('\n'));
		});
	}

	// ---- recent ------------------------------------------------------------

	recent() {
		this.render([
			this.head(__('Recent'), __('Handovers and what was used on site'), true),
			'<div data-recent><div class="ch-note">' + __('Loading...') + '</div></div>'
		].join('\n'), 'recent');
		this.bind_back(() => this.back_home());
		ch_call('recent').then((r) => {
			var dockets = r.dockets || [];
			var used = r.used || [];
			this.$root.find('[data-recent]').html([
				'<div class="ch-section">' + __('Handovers') + '</div>',
				dockets.length ? '<div class="ch-list">' + dockets.map((d) => this.row(
					'data-docket="' + ch_esc(d.name) + '"',
					ch_esc(d.from) + ' ' + ch_icon('arrow-right') + ' ' + ch_esc(d.to),
					ch_esc(d.preview) + ' · ' + ch_esc(ch_when(d.at)),
					d.status === 'Posted' ? this.tag(__('Accepted'), 'good') : this.tag(__('Cancelled'), 'warn')
				)).join('\n') + '</div>' : '<div class="ch-note">' + __('No handovers yet.') + '</div>',
				'<div class="ch-section">' + __('Used on site') + '</div>',
				used.length ? '<div class="ch-list">' + used.map((u) => this.row(
					'disabled',
					ch_esc(u.where),
					ch_esc([u.name, u.by, frappe.datetime.str_to_user(u.at)].filter(Boolean).join(' · ')),
					u.value ? ch_esc(format_currency(u.value)) : ''
				)).join('\n') + '</div>' : '<div class="ch-note">' + __('Nothing recorded yet.') + '</div>'
			].join('\n'));
			this.$root.find('[data-docket]').on('click', (e) => this.review($(e.currentTarget).attr('data-docket')));
		});
	}
}
