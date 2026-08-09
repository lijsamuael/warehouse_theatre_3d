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
    """Nested Material Requisition status data for the 3D theatre.

    Structure: projects -> mrs -> items, mirroring the
    "Material Requisition Status" script report in ethiopian_payroll.
    """
    filters = _parse_filters(filters)
    validate_filters(filters)

    rows = _fetch_rows(filters)
    return {"projects": _nest(rows, filters)}


def validate_filters(filters):
    from_date, to_date = filters.get("from_date"), filters.get("to_date")
    if from_date and to_date and getdate(to_date) < getdate(from_date):
        frappe.throw(_("To Date cannot be before From Date."))


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
            & (mr.per_received < 100)
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
        .orderby(mr.custom_project, mr.transaction_date, mr_item.schedule_date)
        .run(as_dict=True)
    )


def _fetch_links(rows):
    """Map material_request_item -> sorted PO / PR names."""
    mr_item_names = [r["mr_item"] for r in rows]
    po_map, pr_map = {}, {}

    if mr_item_names:
        pos = frappe.get_all(
            "Purchase Order Item",
            filters={"material_request_item": ["in", mr_item_names], "docstatus": ["<", 2]},
            fields=["material_request_item", "parent"],
        )
        for po in pos:
            po_map.setdefault(po.material_request_item, set()).add(po.parent)

        prs = frappe.get_all(
            "Purchase Receipt Item",
            filters={"material_request_item": ["in", mr_item_names], "docstatus": ["<", 2]},
            fields=["material_request_item", "parent"],
        )
        for pr in prs:
            pr_map.setdefault(pr.material_request_item, set()).add(pr.parent)

    return po_map, pr_map


def _nest(rows, filters):
    po_map, pr_map = _fetch_links(rows)

    project_map = {}
    for row in rows:
        mr_no = row.get("material_requisition") or _("—")
        project = row.get("project") or _("No Project")
        key = f"{project}||{mr_no}"

        project_bucket = project_map.setdefault(project, {})
        mr_entry = project_bucket.setdefault(
            key,
            {
                "material_requisition": mr_no,
                "material_request": row["material_request"],
                "date": row.get("date"),
                "company": row.get("company"),
                "items": [],
            },
        )

        mr_entry["items"].append(
            {
                "item_code": row["item_code"],
                "item_name": row.get("item_name"),
                "description": row.get("description"),
                "uom": row.get("uom"),
                "qty": flt(row["qty"]),
                "ordered_qty": flt(row["ordered_qty"]),
                "received_qty": flt(row["received_qty"]),
                "qty_to_receive": flt(row["qty_to_receive"]),
                "qty_to_order": flt(row["qty_to_order"]),
                "required_date": row.get("required_date"),
                "purchase_orders": sorted(po_map.get(row["mr_item"], set())),
                "purchase_receipts": sorted(pr_map.get(row["mr_item"], set())),
            }
        )

    projects = []
    for project in project_map:
        mrs = list(project_map[project].values())
        items = [it for mr in mrs for it in mr["items"]]
        projects.append(
            {
                "name": project,
                "mrs": mrs,
                "stats": {
                    "mr_count": len(mrs),
                    "item_count": len(items),
                    "qty": sum(flt(it["qty"]) for it in items),
                    "received_qty": sum(flt(it["received_qty"]) for it in items),
                    "ordered_qty": sum(flt(it["ordered_qty"]) for it in items),
                    "qty_to_order": sum(flt(it["qty_to_order"]) for it in items),
                },
            }
        )

    projects.sort(key=lambda p: p["name"])
    return projects
