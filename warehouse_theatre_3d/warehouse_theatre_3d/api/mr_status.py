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
    request_type = filters.get("request_type") or "Material Requisition"
    mr = frappe.qb.DocType("Material Request")
    mr_item = frappe.qb.DocType("Material Request Item")

    if request_type == "Fuel Request":
        return Coalesce(mr_item.custom_fuel_request, mr.custom_fuel_request)
    if request_type == "Fixed Asset Request":
        return Coalesce(mr_item.custom_far_no, mr.custom_fixed_asset_request)
    return Coalesce(mr_item.custom_mr_number, mr.custom_mr_no)


@frappe.whitelist()
def get_mr_status(filters=None):
    """Journey-board data: one flat entry per Material Request, with the
    five-stage flow MR -> PR -> PO -> GRV -> Purchase Receipt.

    Structure: { mrs: [...], stats: {...} }
    Each MR is shown as a single card on the calendar (never split by item);
    its items are kept only for the click-detail panel.
    """
    filters = _parse_filters(filters)
    validate_filters(filters)

    rows = _fetch_rows(filters)
    return _nest(rows, filters)


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
    request_type = filters.get("request_type") or "Material Requisition"

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

    if request_type == "Fuel Request":
        query = query.where(
            (mr.custom_fuel_request.isnotnull()) | (mr_item.custom_fuel_request.isnotnull())
        )
    elif request_type == "Fixed Asset Request":
        query = query.where(
            (mr.custom_fixed_asset_request.isnotnull()) | (mr_item.custom_far_no.isnotnull())
        )
    else:
        query = query.where((mr.custom_mr_no.isnotnull()) | (mr_item.custom_mr_number.isnotnull()))

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
        else:
            query = query.where((mr.custom_mr_no == mr_no) | (mr_item.custom_mr_number == mr_no))

    return (
        query.groupby(mr.name, mr_item.item_code)
        .orderby(mr.transaction_date, mr_item.schedule_date)
        .run(as_dict=True)
    )


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


def _fetch_mr_dates(mr_nos):
    """The requisition (MR) is itself a Material Request of type Material Requisition,
    linked from the Purchase MR via custom_mr_no. Return {number: transaction_date}."""
    names = [n for n in set(mr_nos) if n]
    if not names:
        return {}
    mr = frappe.qb.DocType("Material Request")
    rows = (
        frappe.qb.from_(mr)
        .select(mr.name, mr.transaction_date)
        .where(mr.name.isin(names))
        .run(as_dict=True)
    )
    return {r["name"]: _dstr(r["transaction_date"]) for r in rows}


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
        mrs.append(m)

    mr_dates = _fetch_mr_dates([m.get("material_requisition") for m in mrs])
    for m in mrs:
        m["mr_date"] = mr_dates.get(m.get("material_requisition")) or m.get("date")

    mrs.sort(key=lambda m: m["date"] or "9999-12-31")
    stats = {
        "mr_count": len(mrs),
        "item_count": sum(m["item_count"] for m in mrs),
        "qty": sum(m["qty"] for m in mrs),
        "received_qty": sum(m["received_qty"] for m in mrs),
        "ordered_qty": sum(m["ordered_qty"] for m in mrs),
        "pending_mrs": sum(1 for m in mrs if not m["has_po"]),
        "ordered_mrs": sum(1 for m in mrs if m["has_po"] and not m["has_grv"]),
        "arrived_mrs": sum(1 for m in mrs if m["has_grv"] and not m["fully_received"]),
        "done_mrs": sum(1 for m in mrs if m["fully_received"]),
    }
    return {"mrs": mrs, "stats": stats}
