import frappe


@frappe.whitelist(methods=['GET'])
def get_modules():
    return frappe.get_all("Module Def", pluck='name')


@frappe.whitelist(methods=['GET'])
def get_doctypes(modules: str = ''):
    filters = {}
    if modules:
        filters['module'] = ('in', modules.split(','))
    return frappe.get_all("Doctype", filters=filters, fields=['name', 'module', 'istable'])


@frappe.whitelist(methods=['GET'])
def get_schema(doctypes: str = '', modules: str = ''):
    filters = {}
    if doctypes:
        filters['name'] = ('in', doctypes.split(','))
    if modules:
        filters['module'] = ('in', modules.split(','))
    all_doctypes = frappe.get_all(
        "Doctype", filters=filters, fields=[
            "name",
            "issingle",
            "is_virtual",
            "istable",
            "module",
            "app",
            "title_field",
            "description",
            "read_only",
            "parent_node",
            "document_type",
            "is_submittable",
            "custom",
        ]
    )
    all_docfields = frappe.get_all(
        "Docfield",
        filters={'parent': ('in', [d.name for d in all_doctypes])},
        fields=[
            "name",
            "parent",
            "parentfield",
            "fieldname",
            "label",
            "fieldtype",
            "options",
            "hidden",
            "reqd",
            "unique",
            "default",
            "description",
            "read_only",
            "is_virtual",
            "not_nullable",
        ]
    )
    doctype_wise_fields = {
        dt.name: {
            **dt,
            'fields': [df for df in all_docfields if df.parent == dt.name]
        } for dt in all_doctypes
    }
    return doctype_wise_fields
