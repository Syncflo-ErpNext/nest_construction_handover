"""Van and site stock: the server side of the Van & Site Stock screen.

Three kinds of people use it, told apart by the warehouse on their user
(User.custom_assigned_warehouse) and that warehouse's handover_role:

    Main Store   the storeman: sends to vans, takes returns back in
    Van          a technician: delivers to sites, brings stock back, records
                 what was used on site
    Site Store   a site: records what was used, sends returns back on a van,
                 books in supplier deliveries against the site's purchase orders.
                 A site manager also works every site they manage (Project Site).

A handover is a Stock Handover Docket. The giver lists what is going and the
docket is Open. The receiver counts what arrived and accepts, which posts one
Stock Entry for what was counted; or turns it down; or the giver withdraws it.
Nothing moves in ERPNext until it is accepted, so stock never sits in limbo as
a draft Stock Entry that somebody could submit from the desk.

Stock listed on an open docket is spoken for and cannot be sent or used twice.
Every Stock Entry is built and submitted with the user's own permissions.
"""

import json
import re

import frappe
from frappe import _
from frappe.utils import flt, get_fullname, now_datetime, nowdate

DOCKET = "Stock Handover Docket"
DOCKET_ITEM = "Stock Handover Docket Item"

# A van is a group warehouse with one compartment under it per category
# (Warehouse.van_category): Goods In Transit, Van Stock, Technician Tools, Assets.
# The driver chooses the one compartment a whole handover goes into when accepting.

KINDS = {"Main Store": "store", "Van": "van", "Site Store": "site"}
OFFICE_ROLES = {"Stock Manager", "System Manager"}
PURCHASING_ROLES = {"PO Requester", "Purchase Site Manager", "Purchase Approver", "Purchase Director"}

SEARCH_LIMIT = 20
EPSILON = 1e-9


# ---- who and where ----------------------------------------------------------


def _sites():
	"""Site store -> its row on an open project (nest_project_sites), where installed."""
	if "nest_project_sites" not in frappe.get_installed_apps():
		return {}
	from nest_project_sites.api import get_sites

	return {row["store"]: row for row in get_sites()}


def _places():
	"""Every handover location by warehouse: stores, vans (with compartments) and sites."""
	rows = frappe.get_all(
		"Warehouse",
		filters={"disabled": 0, "handover_role": ["is", "set"]},
		fields=["name", "warehouse_name", "is_group", "parent_warehouse", "handover_role", "van_category", "company"],
		order_by="name asc",
	)
	sites = _sites()
	places = {}
	for row in rows:
		kind = KINDS.get(row.handover_role)
		# A van's compartments are listed under the van; a group is only ever a van.
		if not kind or bool(row.is_group) != (kind == "van"):
			continue
		place = {"name": row.name, "kind": kind, "label": row.warehouse_name or row.name, "company": row.company}
		if kind == "van":
			place["compartments"] = {
				leaf.van_category: leaf.name
				for leaf in rows
				if leaf.parent_warehouse == row.name and leaf.van_category and not leaf.is_group
			}
		elif kind == "site" and row.name in sites:
			site = sites[row.name]
			place.update(
				label=site["label"],
				project=site["project"],
				project_name=site["project_name"],
				site_manager=site["site_manager"],
			)
		places[row.name] = place

	vans = [name for name, place in places.items() if place["kind"] == "van"]
	if vans and _user_has_warehouse():
		for row in frappe.get_all(
			"User",
			filters={"enabled": 1, "custom_assigned_warehouse": ["in", vans]},
			fields=["custom_assigned_warehouse", "full_name"],
		):
			places[row.custom_assigned_warehouse].setdefault("driver", row.full_name)
	return places


def _has_po_site():
	"""Whether purchase orders carry the site they are for (nest_po_management)."""
	return frappe.get_meta("Purchase Order").has_field("po_site")


def _user_has_warehouse():
	return frappe.get_meta("User").has_field("custom_assigned_warehouse")


def _labels(places):
	"""Warehouse -> what people call it, compartments included ("VAN1 · Assets")."""
	labels = {}
	for name, place in places.items():
		labels[name] = place["label"]
		for category, leaf in (place.get("compartments") or {}).items():
			labels[leaf] = "{0} · {1}".format(place["label"], category)
	return labels


def _me():
	"""Who is asking and which places are theirs. Anyone with no place is refused.

	A whitelisted method is callable by any logged-in user, so this is the
	permission check, not the screen's own navigation.
	"""
	me = _whoami()
	if not me:
		frappe.throw(
			_("You have no store, van or site to work from. Ask the office to set Assigned Warehouse on your user."),
			frappe.PermissionError,
		)
	return me


def _whoami():
	"""Who is asking and which places are theirs, or None if they have none."""
	user = frappe.session.user
	roles = set(frappe.get_roles(user))
	places = _places()

	assigned = frappe.db.get_value("User", user, "custom_assigned_warehouse") if _user_has_warehouse() else None
	if assigned and assigned not in places:
		# A van assigned by one of its compartments still means the van.
		parent = frappe.db.get_value("Warehouse", assigned, "parent_warehouse")
		if places.get(parent, {}).get("kind") == "van":
			assigned = parent

	mine = [assigned] if assigned in places else []
	kind = places[assigned]["kind"] if mine else None
	managed = [name for name, place in places.items() if place["kind"] == "site" and place.get("site_manager") == user]
	if kind in (None, "site"):
		mine += [name for name in managed if name not in mine]
		if mine:
			kind = "site"

	office = bool(roles & OFFICE_ROLES)
	if not kind and office:
		# The office works as the main store.
		mine = [name for name, place in places.items() if place["kind"] == "store"]
		kind = "store" if mine else None
	if not kind:
		return None

	return frappe._dict(
		user=user,
		full_name=get_fullname(user),
		kind=kind,
		mine=mine,
		# A driver can also run sites (named Site Manager on the project): his van stays
		# his own place, and these sites are his too, on the Site Stock tile.
		managed=[name for name in managed if name not in mine],
		office=office,
		roles=roles,
		places=places,
	)


def _warehouses_of(place):
	"""The warehouses stock actually sits in: a van's compartments, or the place itself."""
	if place["kind"] == "van":
		return list((place.get("compartments") or {}).values())
	return [place["name"]]


def _receives(me, doc):
	"""Only the place it was sent to accepts it: the office cannot sign for a van."""
	return doc.to_warehouse in me.mine or doc.to_warehouse in me.managed


def _gives(me, doc):
	"""The sender may take it back; so may the office, to clear one that is stuck."""
	return doc.from_warehouse in me.mine or doc.given_by == me.user or me.office


# ---- stock ------------------------------------------------------------------


def _qty(value):
	"""Quantities as people say them: 25, not 25.000."""
	return "{:g}".format(flt(value))


def _amount(qty, uom):
	"""A quantity as people say it, with its unit unless that is plain Nos: 25, 3 Meter."""
	return _qty(qty) + ("" if not uom or uom == "Nos" else " " + uom)


def _rows(rows):
	"""Lines arrive as JSON from the browser; keep those with an item and a quantity."""
	if isinstance(rows, str):
		rows = json.loads(rows)
	rows = [row for row in (rows or []) if row.get("item_code") and flt(row.get("qty")) > 0]
	if not rows:
		frappe.throw(_("Nothing to record. Add at least one item with a quantity."))
	return rows


def _items(codes, enabled_only=True):
	"""Item code -> name, unit and whether it is tracked by serial or batch number.
	Disabled items are left out unless asked for: they cannot be moved, but stock
	of one may still be sitting somewhere and has to show where."""
	if not codes:
		return {}
	filters = {"name": ["in", list(set(codes))], "is_stock_item": 1}
	if enabled_only:
		filters["disabled"] = 0
	return {
		row.name: row
		for row in frappe.get_all(
			"Item",
			filters=filters,
			fields=["name", "item_name", "stock_uom", "has_serial_no", "has_batch_no"],
		)
	}


def _usable(codes):
	"""Refuse anything this screen cannot move: unknown items, and serial or batch tracked ones."""
	items = _items(codes)
	for code in codes:
		item = items.get(code)
		if not item:
			frappe.throw(_("{0} is not a stock item on this site.").format(code))
		if item.has_serial_no or item.has_batch_no:
			frappe.throw(
				_("{0} is tracked by serial or batch number. Move it from the desk, where the numbers can be picked.").format(
					code
				)
			)
	return items


def _on_hand(warehouses):
	"""(item, warehouse) -> quantity on hand."""
	if not warehouses:
		return {}
	return {
		(row.item_code, row.warehouse): flt(row.actual_qty)
		for row in frappe.get_all(
			"Bin",
			filters={"warehouse": ["in", warehouses]},
			fields=["item_code", "warehouse", "actual_qty"],
		)
	}


def _promised(warehouses, exclude=None):
	"""(item, warehouse) -> quantity listed on open dockets leaving it: spoken for."""
	if not warehouses:
		return {}
	rows = frappe.db.sql(
		"""
		select i.item_code, i.s_warehouse, sum(i.qty_sent) as qty
		from `tabStock Handover Docket Item` i
		inner join `tabStock Handover Docket` d on d.name = i.parent
		where d.status = 'Open' and i.s_warehouse in %(warehouses)s and d.name != %(exclude)s
		group by i.item_code, i.s_warehouse
		""",
		{"warehouses": tuple(warehouses), "exclude": exclude or ""},
		as_dict=True,
	)
	return {(row.item_code, row.s_warehouse): flt(row.qty) for row in rows}


def _check_free(lines, labels, items):
	"""Say which item is short, where, and why, before ERPNext's own refusal does."""
	wanted = {}
	for line in lines:
		key = (line["item_code"], line["s_warehouse"])
		wanted[key] = wanted.get(key, 0) + flt(line["qty"])
	warehouses = list({key[1] for key in wanted})
	have = _on_hand(warehouses)
	promised = _promised(warehouses)
	for (code, warehouse), qty in wanted.items():
		free = have.get((code, warehouse), 0) - promised.get((code, warehouse), 0)
		if qty > free + EPSILON:
			uom = items[code].stock_uom if code in items else ""
			message = _("Only {0} of {1} free in {2}, not {3}.").format(
				_amount(max(free, 0), uom), code, labels.get(warehouse, warehouse), _qty(qty)
			)
			if promised.get((code, warehouse)):
				message += " " + _("{0} more is already on its way and not yet accepted.").format(
					_qty(promised[(code, warehouse)])
				)
			frappe.throw(message)


def _bins(warehouses):
	"""Stock on hand in these warehouses: one row per item and warehouse."""
	return frappe.get_all(
		"Bin",
		filters={"warehouse": ["in", warehouses], "actual_qty": [">", 0]},
		fields=["item_code", "warehouse", "actual_qty"],
		order_by="item_code asc",
	)


def _held(warehouses, labels):
	"""What is in these warehouses now, and how much of it is free to move."""
	bins = _bins(warehouses)
	if not bins:
		return []
	items = _items([row.item_code for row in bins])
	promised = _promised(warehouses)
	held = []
	for row in bins:
		item = items.get(row.item_code)
		if not item:
			continue
		qty = flt(row.actual_qty)
		held.append(
			{
				"item_code": row.item_code,
				"item_name": item.item_name,
				"stock_uom": item.stock_uom,
				"tracked": bool(item.has_serial_no or item.has_batch_no),
				"warehouse": row.warehouse,
				"where": labels.get(row.warehouse, row.warehouse),
				"qty": qty,
				"free": max(qty - promised.get((row.item_code, row.warehouse), 0), 0),
			}
		)
	return held


# ---- reading ----------------------------------------------------------------


def _public(place):
	shown = {key: place.get(key) for key in ("name", "kind", "label", "driver", "project", "project_name")}
	if place.get("compartments"):
		shown["compartments"] = place["compartments"]
	return shown


@frappe.whitelist()
def bootstrap():
	"""Everything the screen needs to open."""
	me = _me()
	places = me.places

	def listed(kind):
		return [_public(place) for place in places.values() if place["kind"] == kind]

	projects = []
	if me.kind == "store":
		projects = frappe.get_all(
			"Project", filters={"status": "Open"}, fields=["name", "project_name", "company"], order_by="name desc"
		)

	return {
		"user": me.user,
		"full_name": me.full_name,
		"kind": me.kind,
		"mine": [_public(places[name]) for name in me.mine],
		"managed": [_public(places[name]) for name in me.managed],
		"stores": listed("store"),
		"vans": listed("van"),
		"sites": listed("site"),
		"projects": projects,
		"purchasing": bool(me.roles & PURCHASING_ROLES) and "nest_po_management" in frappe.get_installed_apps(),
		"receive_at": _receiving_sites(me),
		"inbox": _inbox(me),
	}


@frappe.whitelist()
def inbox():
	"""Handovers waiting for me to accept, and the ones I sent that are not accepted yet."""
	return _inbox(_me())


def _inbox(me):
	# The van and the sites a driver runs: the screen shows each on its own tile.
	places = me.mine + me.managed
	fields = ["name", "status", "from_warehouse", "to_warehouse", "project", "given_by", "given_at", "stock_entry"]
	incoming = frappe.get_all(
		DOCKET, filters={"status": "Open", "to_warehouse": ["in", places]}, fields=fields, order_by="given_at asc"
	)
	sent = frappe.get_all(
		DOCKET, filters={"status": "Open", "from_warehouse": ["in", places]}, fields=fields, order_by="given_at desc"
	)
	return {"incoming": _summaries(incoming, me.places), "sent": _summaries(sent, me.places)}


def _summaries(dockets, places):
	if not dockets:
		return []
	labels = _labels(places)
	# The site a handover is for: where a delivery goes, else the site of the project an
	# issue to a van was booked for. A return off a site is not for that site.
	sites = {name: place for name, place in places.items() if place["kind"] == "site"}
	site_of_project = {}
	for place in sites.values():
		if place.get("project"):
			site_of_project.setdefault(place["project"], place["label"])
	lines = {}
	for row in frappe.get_all(
		DOCKET_ITEM,
		filters={"parenttype": DOCKET, "parent": ["in", [d.name for d in dockets]]},
		fields=["parent", "item_code", "item_name", "qty_sent"],
		order_by="idx asc",
	):
		lines.setdefault(row.parent, []).append(row)

	out = []
	for doc in dockets:
		rows = lines.get(doc.name, [])
		preview = ", ".join("{0} × {1}".format(r.item_name or r.item_code, _qty(r.qty_sent)) for r in rows[:3])
		if len(rows) > 3:
			preview += " " + _("and {0} more").format(len(rows) - 3)
		if doc.to_warehouse in sites:
			site = sites[doc.to_warehouse]["label"]
		elif doc.from_warehouse in sites:
			site = None
		else:
			site = site_of_project.get(doc.project)
		out.append(
			{
				"name": doc.name,
				"status": doc.status,
				"from": labels.get(doc.from_warehouse, doc.from_warehouse),
				"to": labels.get(doc.to_warehouse, doc.to_warehouse),
				"from_warehouse": doc.from_warehouse,
				"to_warehouse": doc.to_warehouse,
				"project": doc.project,
				"site": site,
				"by": get_fullname(doc.given_by),
				"at": doc.given_at,
				"lines": len(rows),
				"preview": preview,
				"stock_entry": doc.get("stock_entry"),
			}
		)
	return out


@frappe.whitelist()
def docket(name):
	"""One handover, with its lines, and what I may do with it."""
	me = _me()
	doc = frappe.get_doc(DOCKET, name)
	receives, gives = _receives(me, doc), _gives(me, doc)
	if not (receives or gives):
		frappe.throw(_("{0} is not to or from you.").format(name), frappe.PermissionError)
	labels = _labels(me.places)
	# Into a van the driver puts the whole handover in one part of the van: say which there are.
	target = me.places.get(doc.to_warehouse) or {}
	booked_for = frappe.db.get_value("Material Request", doc.material_request, "set_warehouse") if doc.material_request else None
	return {
		"name": doc.name,
		"status": doc.status,
		"from": labels.get(doc.from_warehouse, doc.from_warehouse),
		"to": labels.get(doc.to_warehouse, doc.to_warehouse),
		"into_van": target.get("kind") == "van",
		"compartments": list(target.get("compartments") or {}),
		"booked_for": labels.get(booked_for, booked_for) if booked_for else None,
		"project": doc.project,
		"project_name": frappe.db.get_value("Project", doc.project, "project_name") if doc.project else None,
		"by": get_fullname(doc.given_by),
		"at": doc.given_at,
		"received_by": get_fullname(doc.received_by) if doc.received_by else None,
		"received_at": doc.received_at,
		"notes": doc.notes,
		"stock_entry": doc.stock_entry,
		"can_accept": doc.status == "Open" and receives,
		"can_withdraw": doc.status == "Open" and gives and not receives,
		"lines": [
			{
				"row": item.name,
				"item_code": item.item_code,
				"item_name": item.item_name,
				"uom": item.uom,
				"sent": flt(item.qty_sent),
				"received": flt(item.qty_received),
				"from": labels.get(item.s_warehouse) if item.s_warehouse else None,
				"to": labels.get(item.t_warehouse) if item.t_warehouse else None,
			}
			for item in doc.items
		],
	}


@frappe.whitelist()
def held(location):
	"""What is at a place now: a van by compartment, a store, or a site."""
	me = _me()
	place = me.places.get(location)
	if not place:
		frappe.throw(_("{0} is not a store, van or site.").format(location))
	return _held(_warehouses_of(place), _labels(me.places))


@frappe.whitelist()
def due(van):
	"""What is on my van for each site and not yet handed over there: site -> lines.

	What the van accepted on handovers for a project, less what has left the van on
	handovers for that project (an open one carries what was sent, an accepted one
	what was counted in, so a short count stays due), and never more than is free in
	that part of the van now. Deliver to a site starts from this list.
	"""
	me = _me()
	place = me.places.get(van)
	if van not in me.mine or not place or place["kind"] != "van":
		frappe.throw(_("Only the driver of {0} sees what is due off it.").format(van), frappe.PermissionError)
	parts = list((place.get("compartments") or {}).values())
	site_of = {}
	for name, site in me.places.items():
		if site["kind"] == "site" and site.get("project"):
			site_of.setdefault(site["project"], name)
	if not parts or not site_of:
		return {}

	values = {"van": van, "parts": tuple(parts)}
	came = frappe.db.sql(
		"""
		select d.project, i.item_code, i.t_warehouse as warehouse, sum(i.qty_received) as qty
		from `tabStock Handover Docket Item` i
		inner join `tabStock Handover Docket` d on d.name = i.parent
		where d.status = 'Posted' and d.to_warehouse = %(van)s and ifnull(d.project, '') != ''
			and i.t_warehouse in %(parts)s
		group by d.project, i.item_code, i.t_warehouse
		order by d.project, i.item_code
		""",
		values,
		as_dict=True,
	)
	if not came:
		return {}
	gone = {
		(row.project, row.item_code, row.warehouse): flt(row.qty)
		for row in frappe.db.sql(
			"""
			select d.project, i.item_code, i.s_warehouse as warehouse,
				sum(case when d.status = 'Posted' then i.qty_received else i.qty_sent end) as qty
			from `tabStock Handover Docket Item` i
			inner join `tabStock Handover Docket` d on d.name = i.parent
			where d.status in ('Open', 'Complete', 'Posted') and d.from_warehouse = %(van)s
				and ifnull(d.project, '') != '' and i.s_warehouse in %(parts)s
			group by d.project, i.item_code, i.s_warehouse
			""",
			values,
			as_dict=True,
		)
	}
	held = {(row["item_code"], row["warehouse"]): row for row in _held(parts, _labels(me.places))}

	out = {}
	for row in came:
		site = site_of.get(row.project)
		here = held.get((row.item_code, row.warehouse))
		if not site or not here or here["tracked"]:
			continue
		qty = min(flt(row.qty) - gone.get((row.project, row.item_code, row.warehouse), 0), here["free"])
		if qty > EPSILON:
			out.setdefault(site, []).append(
				{
					"item_code": row.item_code,
					"item_name": here["item_name"],
					"stock_uom": here["stock_uom"],
					"s_warehouse": row.warehouse,
					"qty": qty,
				}
			)
	return out


# ---- the office's desktop stock views ---------------------------------------

STOCK_VIEWS = {"main": "store", "vans": "van", "sites": "site"}
KIND_LABELS = {"store": "Main store", "van": "Van", "site": "Site"}


def _office():
	me = _me()
	if not (me.office or me.kind == "store"):
		frappe.throw(_("Only the office and the store see every stock location."), frappe.PermissionError)
	return me


def _natural(label):
	"""Sort key that puts VAN2 before VAN10."""
	return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", label or "")]


@frappe.whitelist()
def stock_view(view):
	"""Every place of one kind with what is in it now: the main store, every van
	(by compartment) or every site."""
	me = _office()
	kind = STOCK_VIEWS.get(view)
	if not kind:
		frappe.throw(_("{0} is not a stock view.").format(view))
	places = sorted((p for p in me.places.values() if p["kind"] == kind), key=lambda p: _natural(p["label"]))

	owner = {}  # warehouse -> (place, compartment)
	for place in places:
		if kind == "van":
			for category, leaf in (place.get("compartments") or {}).items():
				owner[leaf] = (place["name"], category)
		else:
			owner[place["name"]] = (place["name"], None)
	bins = _bins(list(owner)) if owner else []
	# Disabled items too: stock of one is still somewhere, and the office has to find it.
	items = _items([row.item_code for row in bins], enabled_only=False)
	rows_of = {}
	for row in bins:
		item = items.get(row.item_code)
		if not item:
			continue
		name, category = owner[row.warehouse]
		rows_of.setdefault(name, []).append(
			{
				"category": category,
				"item_code": row.item_code,
				"item_name": item.item_name,
				"uom": item.stock_uom,
				"qty": flt(row.actual_qty),
			}
		)
	# Only the description shows, so list by it.
	for rows in rows_of.values():
		rows.sort(key=lambda r: (r["item_name"] or r["item_code"]).lower())

	# Site managers' names in one query, not one per site.
	managers = {place["site_manager"] for place in places if place.get("site_manager")}
	manager_names = (
		dict(frappe.get_all("User", filters={"name": ["in", list(managers)]}, fields=["name", "full_name"], as_list=True))
		if managers
		else {}
	)

	def sub(place):
		if kind == "van":
			return place.get("driver")
		if kind == "site":
			return " · ".join(filter(None, [place.get("project_name"), manager_names.get(place.get("site_manager"))]))
		return None

	return [
		{
			"name": place["name"],
			"label": place["label"],
			"sub": sub(place),
			"compartments": list(place.get("compartments") or {}),
			"rows": rows_of.get(place["name"], []),
		}
		for place in places
	]


@frappe.whitelist()
def enquiry(term):
	"""Where an item is: every store, van compartment and site holding it, and how
	much. Matches an item code, a barcode or part of the code or description."""
	me = _office()
	term = (term or "").strip()
	if not term:
		return []
	# Disabled items too: by exact code or barcode always (so the answer is "disabled",
	# not "no match"); by part of a name only where stock of one is still sitting somewhere.
	base = {"is_stock_item": 1}
	fields = ["name", "item_name", "stock_uom", "disabled"]
	items = frappe.get_all("Item", filters=dict(base, name=term), fields=fields)
	if not items:
		coded = frappe.get_all("Item Barcode", filters={"barcode": term}, pluck="parent", limit=SEARCH_LIMIT)
		if coded:
			items = frappe.get_all("Item", filters=dict(base, name=["in", coded]), fields=fields)
	exact = bool(items)
	if not items:
		like = f"%{term}%"
		items = frappe.get_all(
			"Item",
			filters=base,
			or_filters={"name": ["like", like], "item_name": ["like", like]},
			fields=fields,
			order_by="disabled asc, name asc",
			limit=SEARCH_LIMIT,
		)
	if not items:
		return []

	labels = _labels(me.places)
	kind_of = {}
	for place in me.places.values():
		for warehouse in _warehouses_of(place):
			kind_of[warehouse] = place["kind"]
	order = {"store": 0, "van": 1, "site": 2}
	where = {}
	for row in frappe.get_all(
		"Bin",
		filters={"item_code": ["in", [item.name for item in items]], "actual_qty": [">", 0]},
		fields=["item_code", "warehouse", "actual_qty"],
	):
		where.setdefault(row.item_code, []).append(row)

	out = []
	for item in items:
		rows = sorted(
			where.get(item.name, []),
			key=lambda r: (order.get(kind_of.get(r.warehouse), 3), _natural(labels.get(r.warehouse, r.warehouse))),
		)
		if item.disabled and not rows and not exact:
			continue
		out.append(
			{
				"item_code": item.name,
				"item_name": item.item_name,
				"disabled": bool(item.disabled),
				"uom": item.stock_uom,
				"total": sum(flt(r.actual_qty) for r in rows),
				"locations": [
					{
						"where": labels.get(r.warehouse, r.warehouse),
						"kind": _(KIND_LABELS[kind_of[r.warehouse]]) if r.warehouse in kind_of else "",
						"qty": flt(r.actual_qty),
					}
					for r in rows
				],
			}
		)
	return out


@frappe.whitelist()
def resolve_scan(term, location=None):
	"""What a scanned or typed string is. Only items mean anything on this screen.

	With a location, each item says how much of it is there and free to move.
	"""
	me = _me()
	term = (term or "").strip()
	if not term:
		return {"type": "unknown", "label": _("Nothing scanned.")}

	base = {"disabled": 0, "is_stock_item": 1}
	fields = ["name as item_code", "item_name", "stock_uom", "has_serial_no", "has_batch_no"]
	items = frappe.get_all("Item", filters=dict(base, name=term), fields=fields)
	if not items:
		coded = frappe.get_all("Item Barcode", filters={"barcode": term}, pluck="parent", limit=SEARCH_LIMIT)
		if coded:
			items = frappe.get_all("Item", filters=dict(base, name=["in", coded]), fields=fields)

	place = me.places.get(location) if location else None
	held_here = {}
	if place:
		for row in _held(_warehouses_of(place), _labels(me.places)):
			held_here.setdefault(row["item_code"], []).append(row)

	def shaped(item):
		serial, batch = item.pop("has_serial_no", 0), item.pop("has_batch_no", 0)
		item["tracked"] = bool(serial or batch)
		if place:
			item["held"] = held_here.get(item["item_code"], [])
		return item

	if len(items) == 1:
		item = shaped(items[0])
		return {"type": "item", "value": item["item_code"], "label": item["item_code"], "item": item}
	if len(items) > 1:
		# One barcode on several items is a data fault, not a choice to make silently.
		return {
			"type": "unknown",
			"label": _("{0} is on more than one item.").format(term),
			"suggestions": [shaped(item) for item in items],
		}

	like = f"%{term}%"
	suggestions = frappe.get_all(
		"Item",
		filters=base,
		or_filters={"name": ["like", like], "item_name": ["like", like]},
		fields=fields,
		order_by="name asc",
		limit=SEARCH_LIMIT,
	)
	return {
		"type": "unknown",
		"label": _("Nothing matches {0}.").format(term),
		"suggestions": [shaped(item) for item in suggestions],
	}


@frappe.whitelist()
def stock_for(item_code):
	"""Where an item is and how much: on hand per place, and what is on order."""
	me = _me()
	item = frappe.db.get_value("Item", item_code, ["name", "item_name", "stock_uom"], as_dict=True)
	if not item:
		frappe.throw(_("{0} is not an item on this site.").format(item_code))
	labels = _labels(me.places)
	mine = set()
	for name in me.mine:
		mine.update(_warehouses_of(me.places[name]))
	rows, on_order = [], 0
	for row in frappe.get_all(
		"Bin", filters={"item_code": item_code}, fields=["warehouse", "actual_qty", "ordered_qty"], order_by="actual_qty desc"
	):
		on_order += flt(row.ordered_qty)
		if flt(row.actual_qty) > 0:
			rows.append(
				{
					"warehouse": row.warehouse,
					"where": labels.get(row.warehouse, row.warehouse),
					"qty": flt(row.actual_qty),
					"mine": row.warehouse in mine,
				}
			)
	return {
		"item_code": item.name,
		"item_name": item.item_name,
		"stock_uom": item.stock_uom,
		"rows": rows,
		"on_hand": sum(row["qty"] for row in rows),
		"on_order": on_order,
	}


@frappe.whitelist()
def recent():
	"""The last handovers to or from my places, and what was recorded as used on site."""
	me = _me()
	fields = ["name", "status", "from_warehouse", "to_warehouse", "project", "given_by", "given_at", "stock_entry"]
	dockets = frappe.get_all(
		DOCKET,
		filters={"status": ["in", ["Posted", "Cancelled"]]},
		or_filters={"from_warehouse": ["in", me.mine], "to_warehouse": ["in", me.mine]},
		fields=fields,
		order_by="modified desc",
		limit=20,
	)
	labels = _labels(me.places)
	used = frappe.get_all(
		"Stock Entry",
		filters={"docstatus": 1, "stock_entry_type": "Material Issue", "project": ["is", "set"]},
		or_filters={"owner": me.user, "from_warehouse": ["in", me.mine]},
		fields=["name", "from_warehouse", "project", "posting_date", "owner", "total_outgoing_value"],
		order_by="creation desc",
		limit=10,
	)
	return {
		"dockets": _summaries(dockets, me.places),
		"used": [
			{
				"name": row.name,
				"where": labels.get(row.from_warehouse, row.from_warehouse),
				"project": row.project,
				"at": row.posting_date,
				"by": get_fullname(row.owner),
				"value": flt(row.total_outgoing_value),
			}
			for row in used
		],
	}


@frappe.whitelist(allow_guest=True)
def hub():
	"""The tiles on the /home landing page: only what the signed-in person uses."""
	user = frappe.session.user
	if user == "Guest":
		return {"guest": True, "tiles": []}

	roles = set(frappe.get_roles(user))
	office = "System Manager" in roles
	tiles = []

	me = _whoami()
	if me:
		here = me.places[me.mine[0]]["label"] if len(me.mine) == 1 else _("{0} sites").format(len(me.mine))
		waiting = frappe.db.count(DOCKET, {"status": "Open", "to_warehouse": ["in", me.mine]})
		tiles.append(
			{
				"route": "/desk/van-site-stock",
				"icon": "truck",
				"title": _("Van & Site Stock"),
				"sub": here,
				"badge": (_("1 to accept") if waiting == 1 else _("{0} to accept").format(waiting)) if waiting else None,
			}
		)

	if "nest_po_management" in frappe.get_installed_apps():
		if office or "PO Requester" in roles:
			tiles.append(
				{
					"route": "/po-request",
					"icon": "shopping-cart",
					"title": _("Raise a PO"),
					"sub": _("Ask for a purchase and follow it to approval"),
				}
			)
		if office or roles & {"Purchase Director", "Purchase Approver"} or _approves(user):
			tiles.append(
				{"route": "/po-approvals", "icon": "seal-check", "title": _("PO approvals"), "sub": _("Requests waiting for you")}
			)

	if frappe.db.get_value("User", user, "user_type") == "System User":
		tiles.append({"route": "/desk", "icon": "squares-four", "title": _("Office desk"), "sub": _("Everything else")})

	return {"guest": False, "full_name": get_fullname(user), "tiles": tiles}


def _approves(user):
	"""A site manager or project manager approves purchases on their sites and projects.
	Site managers only while PO Management Settings has a Site Manager tier."""
	site_tier = frappe.db.exists(
		"PO Approval Tier", {"parent": "PO Management Settings", "approver_type": "Site Manager"}
	)
	if site_tier and any(site.get("site_manager") == user for site in _sites().values()):
		return True
	return frappe.get_meta("Project").has_field("po_project_manager") and bool(
		frappe.db.exists("Project", {"po_project_manager": user, "status": "Open"})
	)


# ---- writing ----------------------------------------------------------------


@frappe.whitelist()
def send(from_location, to_location, rows, project=None, notes=None, docket_id=None):
	"""List what is being handed over. Nothing moves until the other end accepts.

	Lines leaving a van name the compartment they come out of. Lines going into a
	van name none: the driver chooses the compartment when accepting. `docket_id`
	comes from the phone, so a second tap on Send returns the first docket instead
	of making another.
	"""
	me = _me()
	if docket_id:
		existing = frappe.db.get_value(DOCKET, {"docket_id": docket_id}, "name")
		if existing:
			return {"name": existing}

	places = me.places
	if from_location not in me.mine and from_location not in me.managed:
		frappe.throw(_("You can only send from your own store, van or site."), frappe.PermissionError)
	source, target = places[from_location], places.get(to_location)
	if not target:
		frappe.throw(_("Choose where the goods are going."))
	if to_location == from_location:
		frappe.throw(_("From and to are the same place."))
	if source["company"] != target["company"]:
		frappe.throw(_("{0} and {1} belong to different companies.").format(source["label"], target["label"]))

	if project and target["kind"] == "van":
		job = frappe.db.get_value("Project", project, ["status", "company"], as_dict=True)
		if not job or job.status != "Open":
			frappe.throw(_("{0} is not an open project.").format(project))
		if job.company != source["company"]:
			frappe.throw(_("{0} belongs to {1}.").format(project, job.company))
	else:
		project = None

	rows = _rows(rows)
	items = _usable([row["item_code"] for row in rows])
	source_compartments = set((source.get("compartments") or {}).values())

	lines = []
	for row in rows:
		code = row["item_code"]
		if source["kind"] == "van":
			s_warehouse = row.get("s_warehouse")
			if s_warehouse not in source_compartments:
				frappe.throw(_("Say which part of the van {0} comes out of.").format(code))
		else:
			s_warehouse = from_location

		# Into a van the driver chooses the compartment when accepting.
		t_warehouse = None if target["kind"] == "van" else to_location

		lines.append(
			{
				"item_code": code,
				"uom": items[code].stock_uom,
				"qty_sent": flt(row["qty"]),
				"qty": flt(row["qty"]),
				"s_warehouse": s_warehouse,
				"t_warehouse": t_warehouse,
			}
		)

	_check_free(lines, _labels(places), items)

	doc = frappe.new_doc(DOCKET)
	doc.docket_id = docket_id or frappe.generate_hash(length=16)
	doc.company = source["company"]
	doc.from_warehouse = from_location
	doc.to_warehouse = to_location
	doc.project = project
	doc.given_by = me.user
	doc.given_at = now_datetime()
	doc.notes = (notes or "").strip() or None
	for line in lines:
		line.pop("qty")
		doc.append("items", line)
	doc.insert()

	# A driver delivering to a site he runs is handing it to himself: it goes straight
	# into the site store, with nobody else to count it.
	if source["kind"] == "van" and from_location in me.mine and to_location in me.managed:
		posted = accept(doc.name)
		return {"name": doc.name, "stock_entry": posted["stock_entry"], "posted": 1}
	return {"name": doc.name}


# ---- bookings: stock booked to a site, then issued to a van -------------------
#
# A booking is a Material Request (transfer, main store to the site store, on the
# site's project) captured once. Issuing it to a van makes a handover from its lines
# as booked; the driver counts it and picks the one part of the van it all goes into.


def _lines_to_go(me, names=None):
	"""Every booking line still to go out on a van, from my store to a site store,
	newest booking first: the one place this rule lives. A line still has to go when
	it is booked for more than open handovers carry and accepted ones counted in; a
	handover turned down or withdrawn carries nothing. Worked out in the database, so
	bookings already sent never crowd out the ones still waiting. Only bookings to a
	site store: a transfer request raised on the desk to anywhere else is not stock
	for a job."""
	stores = me.mine if me.kind == "store" else []
	sites = [name for name, place in me.places.items() if place["kind"] == "site"]
	if not stores or not sites:
		return []
	values = {"stores": tuple(stores), "sites": tuple(sites)}
	only = ""
	if names:
		only = "and mr.name in %(names)s"
		values["names"] = tuple(names)
	return frappe.db.sql(
		f"""
		select * from (
			select mr.name as booking, mr.set_from_warehouse, mr.set_warehouse, mr.owner, mr.creation,
				line.name as line, line.idx, line.item_code, line.item_name, line.stock_uom, line.stock_qty,
				line.stock_qty - ifnull((
					select sum(case when d.status = 'Posted' then i.qty_received else i.qty_sent end)
					from `tabStock Handover Docket Item` i
					inner join `tabStock Handover Docket` d on d.name = i.parent
					where i.material_request_item = line.name
						and d.status in ('Open', 'Complete', 'Posted')
				), 0) as to_go
			from `tabMaterial Request` mr
			inner join `tabMaterial Request Item` line
				on line.parent = mr.name and line.parenttype = 'Material Request'
			where mr.docstatus = 1
				and mr.material_request_type = 'Material Transfer'
				and mr.status not in ('Stopped', 'Cancelled')
				and mr.set_from_warehouse in %(stores)s
				and mr.set_warehouse in %(sites)s
				{only}
		) open_line
		where open_line.to_go > 0.000000001
		order by open_line.creation desc, open_line.booking, open_line.idx
		""",
		values,
		as_dict=True,
	)


def _bookings(me, names=None):
	"""Bookings from my store to a site with something still to issue, newest first."""
	out = {}
	for line in _lines_to_go(me, names):
		booking = out.get(line.booking)
		if not booking:
			site = me.places[line.set_warehouse]
			booking = out[line.booking] = {
				"name": line.booking,
				"from": line.set_from_warehouse,
				"site": site["label"],
				"project": site.get("project"),
				"project_name": site.get("project_name"),
				"by": get_fullname(line.owner),
				"at": line.creation,
				"lines": [],
			}
		booking["lines"].append(
			{
				"row": line.line,
				"item_code": line.item_code,
				"item_name": line.item_name,
				"uom": line.stock_uom,
				"booked": flt(line.stock_qty),
				"to_go": flt(line.to_go),
			}
		)
	return list(out.values())


@frappe.whitelist()
def bookings():
	"""Stock booked to sites from my store and not yet issued to a van."""
	return _bookings(_me())


# ---- desk tile badges --------------------------------------------------------
#
# Nest Home Count Methods: asked for whoever is signed in on every home paint and
# two-minute poll, so anyone without a store gets 0, never an error.


@frappe.whitelist()
def issue_count():
	"""Bookings waiting to be issued to a van: the Issue to Van tile's badge."""
	me = _whoami()
	if not me or me.kind != "store":
		return 0
	return len({line.booking for line in _lines_to_go(me)})


@frappe.whitelist()
def delivery_count():
	"""Purchase orders with stock still to arrive at the main store: the Receive
	Delivery tile's badge. An order raised for a site (its PO site is set) is the site
	manager's to book in, even though its lines carry the store's warehouse."""
	me = _whoami()
	if not me or me.kind != "store":
		return 0
	not_for_a_site = "and ifnull(po.po_site, '') = ''" if _has_po_site() else ""
	return frappe.db.sql(
		f"""
		select count(distinct po.name)
		from `tabPurchase Order` po
		inner join `tabPurchase Order Item` line on line.parent = po.name and line.parenttype = 'Purchase Order'
		where po.docstatus = 1
			and po.status not in ('Closed', 'On Hold')
			and po.per_received < 100
			and line.warehouse in %(stores)s
			and line.qty - line.received_qty > 0.000000001
			and ifnull(line.delivered_by_supplier, 0) = 0
			{not_for_a_site}
		""",
		{"stores": tuple(me.mine)},
	)[0][0]


@frappe.whitelist()
def inbox_count():
	"""Handovers waiting for me to count and accept: the badge on the driver's and the
	site manager's tile."""
	me = _whoami()
	if not me or not me.mine:
		return 0
	return frappe.db.count(DOCKET, {"status": "Open", "to_warehouse": ["in", me.mine]})


@frappe.whitelist()
def site_inbox_count():
	"""Handovers waiting at my sites: the Site Stock tile's badge. A site manager's own
	sites; for a driver who also runs sites, those sites and not his van."""
	me = _whoami()
	if not me:
		return 0
	sites = me.mine if me.kind == "site" else me.managed
	if not sites:
		return 0
	return frappe.db.count(DOCKET, {"status": "Open", "to_warehouse": ["in", sites]})


@frappe.whitelist()
def book(store, site, rows):
	"""Book stock in the store to a site: the list is captured once and kept as a
	Material Request. Nothing moves until it is issued to a van and accepted."""
	me = _me()
	if store not in me.mine or me.places[store]["kind"] != "store":
		frappe.throw(_("Only the main store books stock to a site."), frappe.PermissionError)
	place = me.places.get(site)
	if not place or place["kind"] != "site":
		frappe.throw(_("Choose the site the stock is for."))
	if not place.get("project"):
		frappe.throw(_("{0} is not on an open project.").format(place["label"]))
	if place["company"] != me.places[store]["company"]:
		frappe.throw(_("{0} and {1} belong to different companies.").format(me.places[store]["label"], place["label"]))

	rows = _rows(rows)
	items = _usable([row["item_code"] for row in rows])
	booking = frappe.new_doc("Material Request")
	booking.material_request_type = "Material Transfer"
	booking.company = place["company"]
	booking.transaction_date = booking.schedule_date = nowdate()
	booking.set_from_warehouse = store
	booking.set_warehouse = site
	for row in rows:
		uom = items[row["item_code"]].stock_uom
		booking.append(
			"items",
			{
				"item_code": row["item_code"],
				"qty": flt(row["qty"]),
				"uom": uom,
				"stock_uom": uom,
				"conversion_factor": 1,
				"from_warehouse": store,
				"warehouse": site,
				"project": place["project"],
				"schedule_date": nowdate(),
			},
		)
	_post(booking)
	return {"name": booking.name}


@frappe.whitelist()
def issue(booking, van, docket_id=None):
	"""Issue what is still to go on a booking to a van, exactly as booked: nothing is
	captured again. Nothing moves until the driver counts it and accepts."""
	me = _me()
	if docket_id:
		existing = frappe.db.get_value(DOCKET, {"docket_id": docket_id}, "name")
		if existing:
			return {"name": existing}

	found = _bookings(me, [booking])
	if not found:
		frappe.throw(_("{0} has nothing left to issue, or is not from your store.").format(booking))
	found = found[0]
	target = me.places.get(van)
	if not target or target["kind"] != "van":
		frappe.throw(_("Choose the van it is going on."))
	source = me.places[found["from"]]
	if source["company"] != target["company"]:
		frappe.throw(_("{0} and {1} belong to different companies.").format(source["label"], target["label"]))

	items = _usable([row["item_code"] for row in found["lines"]])
	lines = [
		{
			"item_code": row["item_code"],
			"uom": row["uom"],
			"qty_sent": row["to_go"],
			"qty": row["to_go"],
			"s_warehouse": found["from"],
			"material_request_item": row["row"],
		}
		for row in found["lines"]
	]
	_check_free(lines, _labels(me.places), items)

	doc = frappe.new_doc(DOCKET)
	doc.docket_id = docket_id or frappe.generate_hash(length=16)
	doc.company = source["company"]
	doc.from_warehouse = found["from"]
	doc.to_warehouse = van
	doc.project = found["project"]
	doc.material_request = booking
	doc.given_by = me.user
	doc.given_at = now_datetime()
	for line in lines:
		line.pop("qty")
		# No t_warehouse: the driver chooses the part of the van when accepting.
		doc.append("items", line)
	doc.insert()
	return {"name": doc.name}


def _open(name):
	doc = frappe.get_doc(DOCKET, name)
	if doc.status != "Open":
		done = {"Posted": _("already accepted"), "Cancelled": _("withdrawn or turned down")}
		frappe.throw(_("{0} is no longer waiting: it was {1}.").format(name, done.get(doc.status, _(doc.status).lower())))
	return doc


def _post(doc):
	"""Save and submit what the field recorded, then drop ERPNext's passing pop-up
	notices (a price list applied, an item with no cost yet): they are for the office,
	not the field. Real messages, the ones shown in a dialog, are kept."""
	doc.insert()
	doc.submit()

	def is_toast(message):
		if isinstance(message, str):
			try:
				message = json.loads(message)
			except ValueError:
				return False
		return isinstance(message, dict) and bool(message.get("alert"))

	frappe.local.message_log = [m for m in (frappe.local.message_log or []) if not is_toast(m)]


def _add_note(doc, note):
	doc.notes = "\n".join(filter(None, [doc.notes, note]))


@frappe.whitelist()
def accept(name, counted=None, notes=None, put=None):
	"""Count what arrived and accept it: one Stock Entry for what was counted.

	`counted` maps a docket line to the quantity that arrived; a line not listed
	arrived in full. What did not arrive stays where it was. Into a van, `put` is
	the one part of the van the driver puts the whole handover in; tools and
	stock for a site travel on separate handovers.
	"""
	me = _me()
	doc = _open(name)
	if not _receives(me, doc):
		frappe.throw(_("Only whoever it was sent to can accept it."), frappe.PermissionError)

	counts = json.loads(counted) if isinstance(counted, str) else (counted or {})
	for item in doc.items:
		qty = flt(counts[item.name]) if item.name in counts else flt(item.qty_sent)
		if qty < 0:
			frappe.throw(_("{0}: a count cannot be below zero.").format(item.item_code))
		if qty > flt(item.qty_sent) + EPSILON:
			frappe.throw(
				_("{0}: {1} counted but only {2} was sent. Ask for the extra to be sent on its own.").format(
					item.item_code, _qty(qty), _qty(item.qty_sent)
				)
			)
		item.qty_received = qty

	arrived = [item for item in doc.items if flt(item.qty_received) > 0]
	if not arrived:
		frappe.throw(_("Nothing was counted in. If none of it arrived, turn it down instead."))

	target = me.places.get(doc.to_warehouse) or {}
	if target.get("kind") == "van":
		compartments = target.get("compartments") or {}
		if put not in compartments:
			frappe.throw(_("Choose which part of {0} it all goes into.").format(target["label"]))
		for item in arrived:
			item.t_warehouse = compartments[put]

	labels = _labels(me.places)
	have = _on_hand(list({item.s_warehouse or doc.from_warehouse for item in arrived}))
	for item in arrived:
		source = item.s_warehouse or doc.from_warehouse
		if flt(item.qty_received) > have.get((item.item_code, source), 0) + EPSILON:
			frappe.throw(
				_("Only {0} of {1} is left in {2}, so it cannot be accepted as counted.").format(
					_qty(have.get((item.item_code, source), 0)), item.item_code, labels.get(source, source)
				)
			)

	doc.received_by = me.user
	doc.received_at = now_datetime()
	if (notes or "").strip():
		_add_note(doc, _("On receipt: {0}").format(notes.strip()))
	doc.save()

	entry = frappe.new_doc("Stock Entry")
	entry.stock_entry_type = "Material Transfer"
	entry.company = doc.company
	entry.project = doc.project or None
	entry.remarks = _("Handover {0}: {1} to {2}").format(
		doc.name, labels.get(doc.from_warehouse, doc.from_warehouse), labels.get(doc.to_warehouse, doc.to_warehouse)
	)
	for item in arrived:
		entry.append(
			"items",
			{
				"item_code": item.item_code,
				"qty": flt(item.qty_received),
				"s_warehouse": item.s_warehouse or doc.from_warehouse,
				"t_warehouse": item.t_warehouse or doc.to_warehouse,
				"project": doc.project or None,
			},
		)
	_post(entry)

	doc.db_set({"status": "Posted", "stock_entry": entry.name, "post_error": None, "synced_at": now_datetime()})
	return {"name": doc.name, "stock_entry": entry.name}


@frappe.whitelist()
def reject(name, reason):
	"""Turn a handover down. Nothing moves; the giver sees why."""
	me = _me()
	doc = _open(name)
	if not _receives(me, doc):
		frappe.throw(_("Only whoever it was sent to can turn it down."), frappe.PermissionError)
	reason = (reason or "").strip()
	if not reason:
		frappe.throw(_("Say why it is being turned down."))
	doc.status = "Cancelled"
	_add_note(doc, _("Turned down by {0}: {1}").format(me.full_name, reason))
	doc.save()
	return {"name": doc.name}


@frappe.whitelist()
def withdraw(name):
	"""Take back a handover that has not been accepted yet. Nothing moves."""
	me = _me()
	doc = _open(name)
	if not _gives(me, doc):
		frappe.throw(_("Only whoever sent it can withdraw it."), frappe.PermissionError)
	doc.status = "Cancelled"
	_add_note(doc, _("Withdrawn by {0}").format(me.full_name))
	doc.save()
	return {"name": doc.name}


# ---- supplier deliveries on site --------------------------------------------


def _receiving_sites(me):
	"""Sites this person books supplier deliveries in at: their own and the ones they manage.
	Needs the purchase order's site (nest_po_management), which says where it is going."""
	if not _has_po_site():
		return []
	return [
		name
		for name, place in me.places.items()
		if place["kind"] == "site" and (name in me.mine or place.get("site_manager") == me.user)
	]


def _check_receiver(me, site):
	if site in _receiving_sites(me):
		return
	if me.office and me.places.get(site, {}).get("kind") == "site":
		return
	frappe.throw(_("Only the site's manager books in deliveries there."), frappe.PermissionError)


def _check_store(me, store):
	"""The main store's deliveries are the storeman's (or the office's) to book in."""
	if me.kind != "store" or store not in me.mine or me.places[store]["kind"] != "store":
		frappe.throw(_("Only the main store books in deliveries there."), frappe.PermissionError)


def _store_deliveries(store):
	"""Approved purchase orders with lines still to arrive into the main store. An order
	raised for a site (PO site set) is the site's to book in, so it is left out: the same
	rule as the Receive Delivery tile's badge (delivery_count)."""
	not_for_a_site = "and ifnull(po.po_site, '') = ''" if _has_po_site() else ""
	lines = frappe.db.sql(
		f"""
		select po.name as po, po.supplier, po.supplier_name, po.schedule_date,
			line.name, line.item_code, line.item_name, line.uom, line.qty - line.received_qty as pending
		from `tabPurchase Order` po
		inner join `tabPurchase Order Item` line on line.parent = po.name and line.parenttype = 'Purchase Order'
		where po.docstatus = 1
			and po.status not in ('Closed', 'On Hold')
			and po.per_received < 100
			and line.warehouse = %(store)s
			and line.qty - line.received_qty > 0.000000001
			and ifnull(line.delivered_by_supplier, 0) = 0
			{not_for_a_site}
		order by po.schedule_date asc, po.name asc, line.idx asc
		""",
		{"store": store},
		as_dict=True,
	)
	orders = {}
	for line in lines:
		order = orders.setdefault(
			line.po,
			{"name": line.po, "supplier": line.supplier_name or line.supplier, "due": line.schedule_date, "lines": []},
		)
		order["lines"].append(
			{
				"row": line.name,
				"item_code": line.item_code,
				"item_name": line.item_name,
				"uom": line.uom,
				"pending": flt(line.pending),
			}
		)
	return list(orders.values())


@frappe.whitelist()
def deliveries(site):
	"""Approved purchase orders with something still to arrive: at the main store for the
	storeman, or raised for this site for the site."""
	me = _me()
	if me.places.get(site, {}).get("kind") == "store":
		_check_store(me, site)
		return _store_deliveries(site)
	_check_receiver(me, site)
	orders = frappe.get_all(
		"Purchase Order",
		filters={
			"docstatus": 1,
			"po_site": site,
			"per_received": ["<", 100],
			"status": ["not in", ["Closed", "On Hold"]],
		},
		fields=["name", "supplier", "supplier_name", "schedule_date"],
		order_by="schedule_date asc, name asc",
	)
	if not orders:
		return []
	lines = frappe.get_all(
		"Purchase Order Item",
		filters={"parenttype": "Purchase Order", "parent": ["in", [o.name for o in orders]]},
		fields=["name", "parent", "item_code", "item_name", "uom", "qty", "received_qty", "delivered_by_supplier"],
		order_by="parent asc, idx asc",
	)
	result = []
	for order in orders:
		rows = [
			{
				"row": line.name,
				"item_code": line.item_code,
				"item_name": line.item_name,
				"uom": line.uom,
				"pending": flt(line.qty) - flt(line.received_qty),
			}
			for line in lines
			if line.parent == order.name
			and not line.delivered_by_supplier
			and flt(line.qty) - flt(line.received_qty) > EPSILON
		]
		if rows:
			result.append(
				{"name": order.name, "supplier": order.supplier_name or order.supplier, "due": order.schedule_date, "lines": rows}
			)
	return result


@frappe.whitelist()
def receive(purchase_order, rows, delivery_note=None):
	"""Book in what a supplier delivered: one Purchase Receipt for what was counted, into
	the site store for an order raised for a site, else into the main store the order's
	lines are for. Anything short stays open on the order for the next delivery."""
	from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_receipt

	me = _me()
	site = frappe.db.get_value("Purchase Order", purchase_order, "po_site") if _has_po_site() else None
	if site:
		_check_receiver(me, site)

	if isinstance(rows, str):
		rows = json.loads(rows)
	counted = {row.get("po_detail"): flt(row.get("qty")) for row in rows or [] if flt(row.get("qty")) > 0}
	if not counted:
		frappe.throw(_("Count at least one line that arrived."))

	receipt = make_purchase_receipt(purchase_order)
	kept = []
	for item in receipt.items:
		qty = counted.pop(item.purchase_order_item, None)
		if qty is None:
			continue
		if qty > flt(item.qty) + EPSILON:
			frappe.throw(_("Only {0} of {1} is still to come.").format(_amount(item.qty, item.uom), item.item_code))
		if not site:
			# Not for a site: only the store the line is for books it in.
			_check_store(me, item.warehouse)
		factor = flt(item.conversion_factor) or 1
		item.qty = item.received_qty = qty
		item.stock_qty = item.received_stock_qty = qty * factor
		item.warehouse = site or item.warehouse
		item.idx = len(kept) + 1
		kept.append(item)
	if counted:
		frappe.throw(_("Part of this delivery is not on {0} or has already arrived. Open it again.").format(purchase_order))

	receipt.set("items", kept)
	into = site or kept[0].warehouse
	receipt.set_warehouse = into if all(item.warehouse == into for item in kept) else None
	receipt.supplier_delivery_note = (delivery_note or "").strip() or None
	receipt.remarks = (
		_("Received on site at {0} by {1}") if site else _("Received at {0} by {1}")
	).format(me.places[into]["label"], me.full_name)
	_post(receipt)
	return {"name": receipt.name}


@frappe.whitelist()
def use(store, rows, notes=None):
	"""What was used on site: issued from the site store against its project, which costs it."""
	me = _me()
	place = me.places.get(store)
	if not place or place["kind"] != "site":
		frappe.throw(_("Choose the site the goods were used on."))
	# A driver who runs sites records only on those; other drivers on any site.
	any_site = me.kind == "van" and not me.managed
	if store not in me.mine and store not in me.managed and not any_site and not me.office:
		frappe.throw(_("You can only record what was used on your own sites."), frappe.PermissionError)
	project = place.get("project")
	if not project:
		frappe.throw(_("{0} is not on an open project, so there is nothing to cost it to.").format(place["label"]))

	rows = _rows(rows)
	items = _usable([row["item_code"] for row in rows])
	lines = [{"item_code": row["item_code"], "qty": flt(row["qty"]), "s_warehouse": store} for row in rows]
	_check_free(lines, _labels(me.places), items)

	entry = frappe.new_doc("Stock Entry")
	entry.stock_entry_type = "Material Issue"
	entry.company = place["company"]
	entry.project = project
	entry.from_warehouse = store
	entry.remarks = "\n".join(
		filter(None, [_("Used on {0}, recorded by {1}").format(place["label"], me.full_name), (notes or "").strip()])
	)
	for line in lines:
		entry.append("items", dict(line, project=project))
	_post(entry)
	return {"name": entry.name, "project": project}
