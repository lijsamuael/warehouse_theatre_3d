/* Material Requisition 3D — Frappe Page */
frappe.pages['material-requisition-3d'].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Material Requisition 3D',
		single_column: true,
	});

	$('<style id="mr3d-layout">').text(`
		.layout-main-section-wrapper,.layout-main-section,.page-content {
			padding:0!important;margin:0!important;max-width:none!important;
		}
		.layout-side-section{display:none!important;}
		.layout-main-section{padding:0!important;box-shadow:none!important;}
		.page-body .container{max-width:none!important;padding:0!important;}
	`).appendTo('head');

	const mount = document.createElement('div');
	mount.id = 'mr3d-root';
	mount.style.cssText = 'width:100%;height:calc(100vh - 57px);';
	$(wrapper).find('.layout-main-section')[0].appendChild(mount);

	function loadScript(src, cb) {
		const s = document.createElement('script');
		s.src = src;
		s.onload = cb;
		document.head.appendChild(s);
	}

	loadScript('/assets/warehouse_theatre_3d/js/three.min.js', function () {
		loadScript('/assets/warehouse_theatre_3d/js/vue.global.prod.js', function () {
			loadScript('/assets/warehouse_theatre_3d/js/mr3d-vue.js?v=' + Date.now(), function () {
				if (window.MR3D) window.MR3D.init('mr3d-root');
			});
		});
	});
};
