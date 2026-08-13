/* Material Requisition Board — Frappe Page */
frappe.pages['material-requisition-3d'].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Material Requisition Board',
		single_column: true,
	});

	const mount = document.createElement('div');
	mount.id = 'mr3d-root';
	mount.style.cssText = 'width:100%;height:calc(100vh - var(--navbar-height, 48px) - var(--page-head-height, 48px) - var(--margin-sm, 10px) * 2);min-height:480px;';
	$(wrapper).find('.layout-main-section')[0].appendChild(mount);

	function loadScript(src, cb) {
		const s = document.createElement('script');
		s.src = src;
		s.onload = cb;
		document.head.appendChild(s);
	}

	loadScript('/assets/warehouse_theatre_3d/js/vue.global.prod.js', function () {
		loadScript('/assets/warehouse_theatre_3d/js/mr3d-vue.js?v=' + Date.now(), function () {
			if (window.MR3D) window.MR3D.init('mr3d-root');
		});
	});
};
