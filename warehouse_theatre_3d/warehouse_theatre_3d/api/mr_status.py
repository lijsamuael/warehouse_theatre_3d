# Copyright (c) 2026, Sami and contributors
# For license information, please see license.txt

import json

import frappe
from frappe import _
from frappe.query_builder.functions import Coalesce, Sum
from frappe.utils import cint, flt, getdate


def _parse_filters(filters):
    if isinstance(filters, str):
        filters = frappe.parse_json(filters)
    return filters or {}


def _requisition_field(filters):
    """Which custom field holds the requisition number for the chosen request type."""
    request_type = filters.get("request_type") or "All"
    mr = frappe.qb.DocType("Material Request")
    mr_item = frappe.qb.DocType("Material Request Item")

    if request_type == "Fuel Request":
        return Coalesce(mr_item.custom_fuel_request, mr.custom_fuel_request)
    if request_type == "Fixed Asset Request":
        return Coalesce(mr_item.custom_far_no, mr.custom_fixed_asset_request)
    if request_type == "Material Requisition":
        return Coalesce(mr_item.custom_mr_number, mr.custom_mr_no)
    return Coalesce(
        mr_item.custom_mr_number,
        mr_item.custom_far_no,
        mr_item.custom_fuel_request,
        mr.custom_mr_no,
        mr.custom_fixed_asset_request,
        mr.custom_fuel_request,
    )


@frappe.whitelist()
def get_mr_status(filters=None):
    """Journey-board data: one flat entry per request along the six-column flow

        Fixed Asset Request / Fuel Request / Material Request  (not yet a PR)
        -> Purchase Request -> Purchase Order -> Purchase Receipt

    Structure: { mrs: [...], stats: {...} }
    Each request is shown as a single card on the calendar (never split by item);
    its items are kept only for the click-detail panel.
    """
    filters = _parse_filters(filters)
    validate_filters(filters)

    rows = _fetch_rows(filters)
    mrs = _nest(rows, filters)
    mrs.extend(_standalone_origins(filters))
    mrs.sort(key=lambda m: m["date"] or "9999-12-31")
    return {"mrs": mrs, "stats": _stats(mrs)}


def validate_filters(filters):
    from_date, to_date = filters.get("from_date"), filters.get("to_date")
    if from_date and to_date and getdate(to_date) < getdate(from_date):
        frappe.throw(_("To Date cannot be Before From Date."))


def _default_dates():
    today = getdate()
    return today.replace(year=today.year - 1).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")


def _fetch_rows(filters):
    mr = frappe.qb.DocType("Material Request")
    mr_item = frappe.qb.DocType("Material Request Item")
    request_type = filters.get("request_type") or "All"

    from_date = filters.get("from_date") or _default_dates()[0]
    to_date = filters.get("to_date") or _default_dates()[1]

    query = (
        frappe.qb.from_(mr)
        .join(mr_item)
        .on(mr_item.parent == mr.name)
        .select(
            _requisition_field(filters).as_("material_requisition"),
            mr.name.as_("material_request"),
            Coalesce(mr.custom_project, _("No Project")).as_("project"),
            mr.transaction_date.as_("date"),
            mr_item.schedule_date.as_("required_date"),
            mr_item.item_code.as_("item_code"),
            mr_item.item_name,
            mr_item.description,
            Coalesce(mr_item.uom, "").as_("uom"),
            Sum(Coalesce(mr_item.qty, 0)).as_("qty"),
            Sum(Coalesce(mr_item.ordered_qty, 0)).as_("ordered_qty"),
            Sum(Coalesce(mr_item.received_qty, 0)).as_("received_qty"),
            (Sum(Coalesce(mr_item.qty, 0)) - Sum(Coalesce(mr_item.received_qty, 0))).as_(
                "qty_to_receive"
            ),
            (Sum(Coalesce(mr_item.qty, 0)) - Sum(Coalesce(mr_item.ordered_qty, 0))).as_(
                "qty_to_order"
            ),
            mr.company,
            mr_item.name.as_("mr_item"),
            Coalesce(mr_item.custom_far_no, mr.custom_fixed_asset_request).as_(
                "fixed_asset_request"
            ),
            Coalesce(mr_item.custom_fuel_request, mr.custom_fuel_request).as_("fuel_request"),
        )
        .where(
            (mr.material_request_type == "Purchase")
            & (mr.docstatus == 1)
            & (mr.status != "Stopped")
            & (mr.transaction_date >= from_date)
            & (mr.transaction_date <= to_date)
        )
    )

    if filters.get("company"):
        query = query.where(mr.company == filters.get("company"))
    if filters.get("project"):
        query = query.where(mr.custom_project == filters.get("project"))
    if filters.get("material_request"):
        query = query.where(mr.name == filters.get("material_request"))
    if filters.get("item_code"):
        query = query.where(mr_item.item_code == filters.get("item_code"))

    if request_type == "Fuel Request":
        query = query.where(
            (mr.custom_fuel_request.isnotnull()) | (mr_item.custom_fuel_request.isnotnull())
        )
    elif request_type == "Fixed Asset Request":
        query = query.where(
            (mr.custom_fixed_asset_request.isnotnull()) | (mr_item.custom_far_no.isnotnull())
        )
    elif request_type == "Material Requisition":
        query = query.where((mr.custom_mr_no.isnotnull()) | (mr_item.custom_mr_number.isnotnull()))
    # "All": include every origin (FAR / Fuel / MR) in one board.

    if filters.get("material_requisition"):
        mr_no = filters.get("material_requisition")
        if request_type == "Fuel Request":
            query = query.where(
                (mr.custom_fuel_request == mr_no) | (mr_item.custom_fuel_request == mr_no)
            )
        elif request_type == "Fixed Asset Request":
            query = query.where(
                (mr.custom_fixed_asset_request == mr_no) | (mr_item.custom_far_no == mr_no)
            )
        elif request_type == "Material Requisition":
            query = query.where((mr.custom_mr_no == mr_no) | (mr_item.custom_mr_number == mr_no))
        else:
            query = query.where(
                (mr.custom_mr_no == mr_no)
                | (mr_item.custom_mr_number == mr_no)
                | (mr.custom_fuel_request == mr_no)
                | (mr_item.custom_fuel_request == mr_no)
                | (mr.custom_fixed_asset_request == mr_no)
                | (mr_item.custom_far_no == mr_no)
            )

    # Department / requested-by are site custom fields on Material Request.
    if frappe.db.has_column("Material Request", "custom_department"):
        query = query.select(mr.custom_department.as_("department"))
    if frappe.db.has_column("Material Request", "custom_requested_by"):
        query = query.select(mr.custom_requested_by.as_("requested_by"))

    return (
        query.groupby(mr.name, mr_item.item_code)
        .orderby(mr.transaction_date, mr_item.schedule_date)
        .run(as_dict=True)
    )


def _standalone_origins(filters):
    """Fixed Asset Requests / Fuel Requests / Material Requests that have not yet
    been converted into a Purchase Request. These fill the first three columns of
    the journey board (FAR, Fuel, MR); once a Purchase Request exists the same
    card flows through PR -> PO -> Purchase Receipt."""
    if filters.get("material_request") or filters.get("item_code"):
        return []

    request_type = filters.get("request_type") or "All"
    from_date = filters.get("from_date")
    to_date = filters.get("to_date")
    company = filters.get("company")
    project = filters.get("project")
    mr_no = filters.get("material_requisition")
    entries = []

    def _in_range(d):
        d = _dstr(d)
        if not d:
            return False
        if from_date and d < from_date:
            return False
        if to_date and d > to_date:
            return False
        return True

    ORIGIN_STAGE = {"far": 0, "fuel": 1, "mr": 2}

    def _base(name, origin, stage, date, project, company, department=None, requested_by=None):
        return {
            "material_requisition": name,
            "material_request": name,
            "date": _dstr(date),
            "mr_date": _dstr(date),
            "project": project or "No Project",
            "company": company,
            "department": department or "",
            "requested_by": requested_by or "",
            "origin": origin,
            "has_pr": False,
            "has_po": False,
            "has_grv": False,
            "fully_received": False,
            "stage": stage if stage is not None else ORIGIN_STAGE[origin],
            "item_count": 0,
            "qty": 0,
            "ordered_qty": 0,
            "received_qty": 0,
            "qty_to_order": 0,
            "qty_to_receive": 0,
            "pct_received": 0,
            "po_date": None,
            "grv_date": None,
            "purchase_orders": [],
            "purchase_receipts": [],
            "fixed_asset_requests": [name] if origin == "far" else [],
            "fuel_requests": [name] if origin == "fuel" else [],
            "material_requisitions": [name] if origin == "mr" else [],
            "items": [],
        }

    def _extra_cols(table, candidates):
        """Columns that actually exist on the (possibly custom) origin doctype."""
        return [c for c in candidates if frappe.db.has_column(table, c)]

    if request_type in ("All", "Fixed Asset Request"):
        try:
            far_cols = ["f.name", "f.transaction_date", "f.company", "f.project"]
            far_cols += [f"f.{c}" for c in _extra_cols("Fixed Asset Request", ["department", "requested_by"])]
            far_rows = frappe.db.sql(
                """select %s
                   from `tabFixed Asset Request` f
                   where f.docstatus = 1 and not exists (
                       select 1 from `tabMaterial Request` m
                       left join `tabMaterial Request Item` i on i.parent = m.name
                       where m.material_request_type = 'Purchase' and m.docstatus = 1
                       and (m.custom_fixed_asset_request = f.name or i.custom_far_no = f.name))"""
                % ", ".join(far_cols),
                as_dict=True,
            )
        except Exception:
            # Fixed Asset Request is not registered on every site; skip it.
            far_rows = []
        for r in far_rows:
            if not _in_range(r.get("transaction_date")):
                continue
            if company and r.get("company") != company:
                continue
            if project and r.get("project") != project:
                continue
            if mr_no and mr_no != r["name"]:
                continue
            entries.append(
                _base(
                    r["name"], "far", None, r.get("transaction_date"), r.get("project"), r.get("company"),
                    r.get("department"), r.get("requested_by"),
                )
            )

    if request_type in ("All", "Fuel Request"):
        try:
            fuel_cols = ["f.name", "f.date", "f.project"]
            fuel_cols += [f"f.{c}" for c in _extra_cols("Fuel Request", ["custom_department", "requested_by"])]
            fuel_rows = frappe.db.sql(
                """select %s
                   from `tabFuel Request` f
                   where f.docstatus = 1 and not exists (
                       select 1 from `tabMaterial Request` m
                       left join `tabMaterial Request Item` i on i.parent = m.name
                       where m.material_request_type = 'Purchase' and m.docstatus = 1
                       and (m.custom_fuel_request = f.name or i.custom_fuel_request = f.name))"""
                % ", ".join(fuel_cols),
                as_dict=True,
            )
        except Exception:
            # Fuel Request is not registered on every site; skip it.
            fuel_rows = []
        for r in fuel_rows:
            if not _in_range(r.get("date")):
                continue
            if project and r.get("project") != project:
                continue
            if mr_no and mr_no != r["name"]:
                continue
            entries.append(
                _base(
                    r["name"], "fuel", None, r.get("date"), r.get("project"), None,
                    r.get("custom_department"), r.get("requested_by"),
                )
            )

    if request_type in ("All", "Material Requisition"):
        mr_cols = ["m.name", "m.transaction_date", "m.custom_project", "m.company"]
        mr_cols += [f"m.{c}" for c in _extra_cols("Material Request", ["custom_department", "custom_requested_by"])]
        mr_rows = frappe.db.sql(
            """select %s
               from `tabMaterial Request` m
               where m.material_request_type <> 'Purchase' and m.docstatus = 1
               and m.status <> 'Stopped' and not exists (
                   select 1 from `tabMaterial Request` p
                   left join `tabMaterial Request Item` i on i.parent = p.name
                   where p.material_request_type = 'Purchase' and p.docstatus = 1
                   and (p.custom_mr_no = m.name or i.custom_mr_number = m.name))"""
            % ", ".join(mr_cols),
            as_dict=True,
        )
        for r in mr_rows:
            if not _in_range(r.get("transaction_date")):
                continue
            if company and r.get("company") != company:
                continue
            if project and r.get("project") != project:
                continue
            if mr_no and mr_no != r["name"]:
                continue
            entries.append(
                _base(
                    r["name"], "mr", None, r.get("transaction_date"), r.get("custom_project"), r.get("company"),
                    r.get("custom_department"), r.get("custom_requested_by"),
                )
            )

    return entries


def _stats(mrs):
    """Counts per journey column + overall totals, used by the header chips."""
    return {
        "mr_count": len(mrs),
        "item_count": sum(m["item_count"] for m in mrs),
        "qty": sum(m["qty"] for m in mrs),
        "received_qty": sum(m["received_qty"] for m in mrs),
        "ordered_qty": sum(m["ordered_qty"] for m in mrs),
        "far_count": sum(1 for m in mrs if m.get("origin") == "far"),
        "fuel_count": sum(1 for m in mrs if m.get("origin") == "fuel"),
        "material_count": sum(1 for m in mrs if m.get("origin") == "mr"),
        "req_count": sum(1 for m in mrs if m["stage"] in (0, 1, 2)),
        "pr_count": sum(1 for m in mrs if m["stage"] == 3),
        "po_count": sum(1 for m in mrs if m["stage"] == 4),
        "received_count": sum(1 for m in mrs if m["stage"] == 5),
        "pending_mrs": sum(1 for m in mrs if not m["has_po"]),
        "ordered_mrs": sum(1 for m in mrs if m["has_po"] and not m["has_grv"]),
        "arrived_mrs": sum(1 for m in mrs if m["has_grv"] and not m["fully_received"]),
        "done_mrs": sum(1 for m in mrs if m["fully_received"]),
    }


def _fetch_links(rows):
    """Map material_request_item -> {doc_name: date} for POs and receipts (GRVs)."""
    mr_item_names = [r["mr_item"] for r in rows]
    po_map, pr_map = {}, {}

    if mr_item_names:
        po = frappe.qb.DocType("Purchase Order")
        poi = frappe.qb.DocType("Purchase Order Item")
        po_rows = (
            frappe.qb.from_(poi)
            .join(po)
            .on(po.name == poi.parent)
            .select(poi.material_request_item, po.name, po.transaction_date)
            .where(poi.material_request_item.isin(mr_item_names))
            .where(po.docstatus < 2)
            .run(as_dict=True)
        )
        for r in po_rows:
            po_map.setdefault(r.material_request_item, {})[r.name] = r.transaction_date

        pr = frappe.qb.DocType("Purchase Receipt")
        pri = frappe.qb.DocType("Purchase Receipt Item")
        pr_rows = (
            frappe.qb.from_(pri)
            .join(pr)
            .on(pr.name == pri.parent)
            .select(pri.material_request_item, pr.name, pr.posting_date)
            .where(pri.material_request_item.isin(mr_item_names))
            .where(pr.docstatus < 2)
            .run(as_dict=True)
        )
        for r in pr_rows:
            pr_map.setdefault(r.material_request_item, {})[r.name] = r.posting_date

    return po_map, pr_map


def _dstr(d):
    return d.strftime("%Y-%m-%d") if d else None


def _fetch_origin_dates(entries):
    """Best-effort transaction dates for every origin document referenced by the
    Purchase Material Requests, so the journey can start from the true origin
    (Material Requisition / Fuel Request / Fixed Asset Request) instead of the
    Purchase Request itself. Fixed Asset Request is not a registered DocType on
    some sites, so we read its table directly and swallow any errors."""
    out = {}
    mr_names = {m.get("material_requisition") for m in entries}
    mr_names |= {n for m in entries for n in m.get("material_requisitions", [])}
    fuel_names = {n for m in entries for n in m.get("fuel_requests", [])}
    far_names = {n for m in entries for n in m.get("fixed_asset_requests", [])}

    def _grab(table, col, names):
        names = [n for n in names if n]
        if not names:
            return
        try:
            rows = frappe.db.sql(
                "select name, %s from `%s` where name in %%s" % (col, table),
                [names],
                as_dict=True,
            )
        except Exception:
            return
        for r in rows:
            if r.get(col):
                out[r["name"]] = _dstr(r[col])

    _grab("tabMaterial Request", "transaction_date", mr_names)
    _grab("tabFuel Request", "date", fuel_names)
    _grab("tabFixed Asset Request", "transaction_date", far_names)
    return out


def _nest(rows, filters):
    po_map, pr_map = _fetch_links(rows)

    mr_map = {}
    for row in rows:
        mr_no = row.get("material_requisition") or row["material_request"]
        mr_name = row["material_request"]
        entry = mr_map.setdefault(
            mr_name,
            {
                "material_requisition": mr_no,
                "material_request": mr_name,
                "date": _dstr(row.get("date")),
                "required_date": _dstr(row.get("required_date")),
                "project": row.get("project"),
                "company": row.get("company"),
                "department": row.get("department") or "",
                "requested_by": row.get("requested_by") or "",
                "items": [],
            },
        )
        if not entry["required_date"]:
            entry["required_date"] = _dstr(row.get("required_date"))

        po_dates = sorted({_dstr(d) for d in po_map.get(row["mr_item"], {}).values()})
        grv_dates = sorted({_dstr(d) for d in pr_map.get(row["mr_item"], {}).values()})

        entry["items"].append(
            {
                "item_code": row["item_code"],
                "item_name": row.get("item_name"),
                "description": row.get("description"),
                "uom": row.get("uom"),
                "qty": flt(row["qty"]),
                "ordered_qty": flt(row["ordered_qty"]),
                "received_qty": flt(row["received_qty"]),
                "qty_to_order": flt(row["qty_to_order"]),
                "qty_to_receive": flt(row["qty_to_receive"]),
                "required_date": _dstr(row.get("required_date")),
                "po_date": po_dates[0] if po_dates else None,
                "grv_date": grv_dates[0] if grv_dates else None,
                "purchase_orders": sorted(po_map.get(row["mr_item"], {}).keys()),
                "purchase_receipts": sorted(pr_map.get(row["mr_item"], {}).keys()),
                "material_requisition": row.get("material_requisition"),
                "fixed_asset_request": row.get("fixed_asset_request"),
                "fuel_request": row.get("fuel_request"),
            }
        )

    mrs = []
    for mr_name in mr_map:
        m = mr_map[mr_name]
        items = m["items"]
        qty = sum(flt(it["qty"]) for it in items)
        ord_qty = sum(flt(it["ordered_qty"]) for it in items)
        rec_qty = sum(flt(it["received_qty"]) for it in items)
        all_po = [n for it in items for n in it["purchase_orders"]]
        all_grv = [n for it in items for n in it["purchase_receipts"]]
        po_dates = [d for it in items if it["po_date"] for d in [it["po_date"]]]
        grv_dates = [d for it in items if it["grv_date"] for d in [it["grv_date"]]]

        m["item_count"] = len(items)
        m["qty"] = qty
        m["ordered_qty"] = ord_qty
        m["received_qty"] = rec_qty
        m["qty_to_order"] = max(0.0, flt(qty) - flt(ord_qty))
        m["qty_to_receive"] = max(0.0, flt(qty) - flt(rec_qty))
        m["pct_received"] = round(rec_qty / qty * 100, 1) if qty else 0
        m["has_pr"] = True
        m["has_po"] = bool(all_po)
        m["has_grv"] = bool(all_grv)
        m["fully_received"] = rec_qty >= qty
        m["po_date"] = min(po_dates) if po_dates else None
        m["grv_date"] = min(grv_dates) if grv_dates else None
        m["purchase_orders"] = sorted(set(all_po))
        m["purchase_receipts"] = sorted(set(all_grv))
        m["fixed_asset_requests"] = sorted(
            {it.get("fixed_asset_request") for it in items if it.get("fixed_asset_request")}
        )
        m["fuel_requests"] = sorted(
            {it.get("fuel_request") for it in items if it.get("fuel_request")}
        )
        m["material_requisitions"] = sorted(
            {it.get("material_requisition") for it in items if it.get("material_requisition")}
        )
        # Where this card lives on the board:
        #   FAR / Fuel / MR (three request columns) -> Purchase Request
        #   -> Purchase Order -> Purchase Receipt.
        #   Fuel requests skip the Purchase Order and go PR -> Receipt directly.
        m["origin"] = (
            "far"
            if m["fixed_asset_requests"]
            else ("fuel" if m["fuel_requests"] else "mr")
        )
        if m["origin"] == "fuel":
            m["stage"] = 5 if m["has_grv"] else 3
        elif not m["has_po"]:
            m["stage"] = 3
        elif not m["has_grv"]:
            m["stage"] = 4
        else:
            m["stage"] = 5
        mrs.append(m)

    origin_dates = _fetch_origin_dates(mrs)
    for m in mrs:
        req = m.get("material_requisition")
        candidates = []
        # A real origin number (FAR / Fuel / MR). If the primary requisition
        # collapsed to the Purchase Request's own name there is no real origin
        # there, so we fall through to the FAR / Fuel / source-MR numbers.
        if req and req != m.get("material_request"):
            candidates.append(req)
        candidates += list(m.get("material_requisitions") or [])
        candidates += list(m.get("fixed_asset_requests") or [])
        candidates += list(m.get("fuel_requests") or [])
        dates = [origin_dates[n] for n in candidates if origin_dates.get(n)]
        m["mr_date"] = min(dates) if dates else m.get("date")

    mrs.sort(key=lambda m: m["date"] or "9999-12-31")
    return mrs
