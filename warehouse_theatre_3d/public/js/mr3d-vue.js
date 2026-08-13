/* Material Requisition Board
   A 2D Trello-style board of Material Requests. Each request sits in the
   first column whose next step has not happened yet:
     FAR Fixed Asset Request → Fuel Fuel Request → MR Material Request
     → PR Purchase Request → PO Purchase Order → RCV Purchase Receipt
   Clicking a card shows the status, the days between steps, and the created
   documents. Depends on: Vue 3 global build (loaded before this script) */
(function () {
'use strict';

const { createApp, defineComponent, reactive, computed, onMounted, onUnmounted } = Vue;

/* ─────────────────────────────────────────────────────────────
   HELPERS & CONSTANTS
───────────────────────────────────────────────────────────── */
const STAGES = [
	{ key: 'FAR', label: 'Fixed Asset Request', short: 'FAR', color: '#ec4899' },
	{ key: 'Fuel', label: 'Fuel Request', short: 'Fuel', color: '#f59e0b' },
	{ key: 'MR', label: 'Material Request', short: 'MR', color: '#3b82f6' },
	{ key: 'PR', label: 'Purchase Request', short: 'PR', color: '#8b5cf6' },
	{ key: 'PO', label: 'Purchase Order', short: 'PO', color: '#f97316' },
	{ key: 'RCV', label: 'Purchase Receipt', short: 'RCV', color: '#14b8a6' },
];
const ORIGIN_LABEL = { far: 'Fixed Asset Request', fuel: 'Fuel Request', mr: 'Material Request' };
const ORIGIN_SHORT = { far: 'FAR', fuel: 'Fuel', mr: 'MR' };
const ORIGIN_COLOR = { far: '#ec4899', fuel: '#f59e0b', mr: '#3b82f6' };
const ORIGIN_STAGE = { far: 0, fuel: 1, mr: 2 };
const fmt = n => (parseFloat(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const API = 'warehouse_theatre_3d.warehouse_theatre_3d.api.';

/* UTC-safe day arithmetic */
const dayNum = s => {
	const [y, mo, d] = String(s).split('-').map(Number);
	return Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
};
const dayDate = n => new Date(n * 86400000);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* technical status, per-step journey (dates, days elapsed, created docs) */
function originOf(mr) {
	if (mr.origin) return mr.origin;
	if ((mr.fixed_asset_requests || []).length) return 'far';
	if ((mr.fuel_requests || []).length) return 'fuel';
	return 'mr';
}
function techStatus(mr) {
	if (mr.fully_received) return 'Fully Received';
	if (!mr.has_pr) return 'Awaiting Purchase Request';
	if (mr.has_grv) return 'Partially Received';
	if (originOf(mr) === 'fuel') return 'Awaiting Receipt';
	if (mr.has_po) return 'Ordered';
	return 'Pending';
}
function daysBetween(a, b) {
	if (!a || !b) return null;
	return Math.max(0, dayNum(b) - dayNum(a));
}
function journey(mr) {
	const o = originOf(mr);
	const skipPO = o === 'fuel';
	const steps = [
		{ key: o.toUpperCase(), label: ORIGIN_LABEL[o], short: ORIGIN_SHORT[o], color: ORIGIN_COLOR[o], date: mr.mr_date || mr.date, done: true },
		{ key: 'PR', label: 'Purchase Request', short: 'PR', color: '#8b5cf6', date: mr.date, done: !!mr.has_pr },
		{ key: 'PO', label: skipPO ? 'Purchase Order (skipped for Fuel)' : 'Purchase Order', short: 'PO', color: '#f97316', date: skipPO ? (mr.has_pr ? mr.date : null) : mr.po_date, done: skipPO ? !!mr.has_pr : !!mr.has_po },
		{ key: 'RCV', label: 'Purchase Receipt', short: 'RCV', color: '#14b8a6', date: mr.grv_date, done: !!mr.has_grv },
	];
	steps.forEach((s, i) => {
		s.days = i > 0 && steps[i - 1].date ? daysBetween(steps[i - 1].date, s.date) : null;
	});
	return steps;
}
function stageOf(mr) {
	if (!mr.has_pr) return ORIGIN_STAGE[originOf(mr)];
	if (originOf(mr) === 'fuel') return mr.has_grv ? 5 : 3;
	if (!mr.has_po) return 3;
	if (!mr.has_grv) return 4;
	return 5;
}
function stepIndex(mr) {
	const st = mr.stage != null ? mr.stage : stageOf(mr);
	return st + 1;
}
function docsOf(mr) {
	const o = originOf(mr);
	const originNames = o === 'far'
		? (mr.fixed_asset_requests || [])
		: o === 'fuel'
			? (mr.fuel_requests || [])
			: ((mr.material_requisitions || []).length ? mr.material_requisitions : [mr.material_requisition]);
	const originRoute = o === 'far' ? null : (o === 'fuel' ? 'Fuel Request' : 'Material Request');
	const po = mr.purchase_orders || [], grv = mr.purchase_receipts || [];
	const fmtList = arr => arr.length ? (arr.length === 1 ? arr[0] : `${arr[0]} +${arr.length - 1} more`) : null;
	const docs = [
		{ kind: ORIGIN_LABEL[o], name: originNames[0] || null, display: fmtList(originNames) || null, route: originRoute },
		{ kind: 'Purchase Request', name: mr.has_pr ? mr.material_request : null, display: mr.has_pr ? mr.material_request : null, route: 'Material Request' },
		{ kind: 'Purchase Order', name: po.length ? po[0] : null, display: fmtList(po), route: 'Purchase Order' },
		{ kind: 'Purchase Receipt', name: grv.length ? grv[0] : null, display: fmtList(grv), route: 'Purchase Receipt' },
	];
	return docs;
}
function friendlyRange(from, to) {
	if (!from || !to) return '';
	const f = dayDate(dayNum(from)), t = dayDate(dayNum(to));
	const a = `${MONTHS[f.getUTCMonth()]} ${f.getUTCDate()}`;
	const b = f.getUTCMonth() === t.getUTCMonth() ? `${t.getUTCDate()}` : `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`;
	return `${a} – ${b}`;
}
function shortDate(s) {
	if (!s) return '';
	const d = dayDate(dayNum(s));
	return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}

function call(method, args = {}) {
	const full = API + method;
	if (window.frappe && frappe.call) {
		return new Promise((res, rej) =>
			frappe.call({
				method: full,
				args,
				callback: r => (r.exc ? rej(new Error(r.exc)) : res(r.message)),
				error: rej,
			})
		);
	}
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(args || {})) {
		if (v !== null && v !== undefined && v !== '') p.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
	}
	return fetch('/api/method/' + full + (p.toString() ? '?' + p.toString() : ''), {
		method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
	}).then(r => r.json()).then(r => { if (r.message !== undefined) return r.message; throw new Error(r.exc || 'API error'); });
}

/* ─────────────────────────────────────────────────────────────
   STORE
───────────────────────────────────────────────────────────── */
function readTheme() {
	/* dark is the default; persist the user's choice under mr3d-theme */
	try { return localStorage.getItem('mr3d-theme') !== 'light'; } catch (e) { return true; }
}

const store = reactive({
	isDark: readTheme(),
	grownUps: false,
	mrs: [],
	stats: {},
	loading: false,
	loaded: false,
	error: '',
	from_date: '',
	to_date: '',
	request_type: 'All',
	company: '',
	companies: [],
	projects: [],
	project: '',
	material_requisition: '',
	material_request: '',
	item_code: '',
	item_name: '',
	selected: null,
	search: '',
});

/* ─────────────────────────────────────────────────────────────
   CSS
───────────────────────────────────────────────────────────── */
const CSS = `
#mr3d-app.dark{--b:#0c0e14;--b2:#13151e;--b3:#1a1e2a;--bd:rgba(255,255,255,.08);--t:#fff;--t2:rgba(255,255,255,.65);--t3:rgba(255,255,255,.35);--card:rgba(255,255,255,.04);--cb:rgba(255,255,255,.08);--acc:#3b82f6;--acc2:#60a5fa}
#mr3d-app.light{--b:#f0f2f5;--b2:#fff;--b3:#f7f9fc;--bd:#e2e8f0;--t:#1a202c;--t2:#4a5568;--t3:#a0aec0;--card:#fff;--cb:#e2e8f0;--acc:#2563eb;--acc2:#3b82f6}
#mr3d-app{width:100%;height:100%;display:flex;flex-direction:column;background:var(--b);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12.5px;color:var(--t);position:relative;overflow:hidden;transition:background .3s}
#mr3d-stage{flex:1;position:relative;min-height:0;overflow:hidden}
.mr3d-filters{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--bd);background:var(--b3);z-index:18}
.mr3d-filters label{display:flex;align-items:center;gap:4px;color:var(--t2);font-weight:600;font-size:11px;white-space:nowrap}
.mr3d-filters input,.mr3d-filters select{height:26px;border:1px solid var(--bd);background:var(--b2);color:var(--t);border-radius:6px;padding:0 8px;font-size:12px;outline:none;min-width:0}
.mr3d-filters input:focus,.mr3d-filters select:focus{border-color:var(--acc2)}
.mr3d-filters input[type=date]{width:128px}
.mr3d-filters .mr3d-btn{height:26px}
.mr3d-filters .mr3d-btn-primary{height:26px;padding:0 12px}
.mr3d-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--bd);background:var(--b2);z-index:20}
.mr3d-title{font-weight:800;font-size:16px;color:var(--acc2);letter-spacing:-.2px;margin-right:4px;white-space:nowrap}
.mr3d-nav{display:flex;align-items:center;gap:4px}
.mr3d-nav button{width:32px;height:32px;border-radius:50%;border:1px solid var(--bd);background:var(--card);color:var(--t);font-size:15px;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center}
.mr3d-nav button:hover{border-color:var(--acc2);transform:scale(1.1)}
.mr3d-nav .range{min-width:118px;text-align:center;color:var(--t2);font-weight:700;font-size:12.5px;white-space:nowrap}
.mr3d-round{width:32px;height:32px;border-radius:50%;border:1px solid var(--bd);background:var(--card);color:var(--t);font-size:15px;cursor:pointer;line-height:1}
.mr3d-round:hover{border-color:var(--acc2);transform:scale(1.1)}
.mr3d-btn-big{height:32px;border-radius:16px;padding:0 14px;font-weight:700;font-size:12.5px;cursor:pointer;border:1px solid var(--bd);background:var(--card);color:var(--t)}
.mr3d-btn-big:hover{border-color:var(--acc2);transform:scale(1.04)}
.mr3d-btn-big.on{background:var(--acc);border-color:var(--acc);color:#fff}
.mr3d-stats{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.mr3d-chip{padding:2px 9px;border-radius:999px;border:1px solid var(--bd);background:var(--card);color:var(--t2);white-space:nowrap}
.mr3d-chip b{color:var(--t);font-weight:600;margin-left:3px}
.mr3d-chip .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:baseline}
.mr3d-sp{flex:1}
.mr3d-f{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.mr3d-f input,.mr3d-f select{height:26px;border:1px solid var(--bd);background:var(--b3);color:var(--t);border-radius:6px;padding:0 8px;font-size:12px;outline:none}
.mr3d-f input:focus,.mr3d-f select:focus{border-color:var(--acc2)}
.mr3d-btn{height:26px;border:1px solid var(--bd);background:var(--card);color:var(--t);border-radius:6px;padding:0 10px;font-size:12px;cursor:pointer}
.mr3d-btn:hover{border-color:var(--acc2)}
.mr3d-btn-primary{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
.mr3d-btn-primary:hover{background:var(--acc2);border-color:var(--acc2)}
.mr3d-search{position:relative}
.mr3d-search input{height:26px;width:200px;border:1px solid var(--bd);background:var(--b3);color:var(--t);border-radius:6px;padding:0 8px;font-size:12px;outline:none}
.mr3d-search input:focus{border-color:var(--acc2)}
.mr3d-drop{position:absolute;top:30px;right:0;width:340px;max-height:340px;overflow:auto;background:var(--b2);border:1px solid var(--bd);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:40}
.mr3d-drop-item{padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--bd);display:flex;flex-direction:column;gap:1px}
.mr3d-drop-item:hover{background:var(--cb)}
.mr3d-drop-item .d1{font-weight:600;color:var(--t)}
.mr3d-drop-item .d2{color:var(--t3);font-size:11px}
.mr3d-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--b);z-index:50}
.mr3d-spinner{width:34px;height:34px;border-radius:50%;border:3px solid var(--bd);border-top-color:var(--acc2);animation:mr3dspin .8s linear infinite}
@keyframes mr3dspin{to{transform:rotate(360deg)}}
.mr3d-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--t3);background:var(--b);z-index:45;font-size:13px}
.mr3d-empty b{color:var(--t2)}
.mr3d-dp{position:absolute;top:56px;right:12px;width:360px;max-height:calc(100% - 120px);overflow:auto;background:var(--b2);border:1px solid var(--bd);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.3);z-index:25;padding:14px 16px;font-size:12px}
.mr3d-dp h3{margin:0 0 4px;font-size:13.5px;color:var(--t)}
.mr3d-dp .sub{color:var(--t3);font-size:11px;margin-bottom:8px}
.mr3d-dp .kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px solid var(--bd);color:var(--t2)}
.mr3d-dp .kv b{color:var(--t);font-weight:600;text-align:right}
.mr3d-stages{margin:10px 0 4px;display:flex;flex-direction:column;gap:5px}
.mr3d-stages .st{display:flex;align-items:center;gap:7px}
.mr3d-stages .st i{width:11px;height:11px;border-radius:3px;display:inline-block;flex:0 0 auto}
.mr3d-stages .st .nm{color:var(--t2);flex:1}
.mr3d-stages .st .ok{font-weight:700;font-size:11px;color:var(--t)}
.mr3d-bar{display:flex;height:12px;border-radius:4px;overflow:hidden;margin:10px 0;border:1px solid var(--bd)}
.mr3d-bar div{height:100%}
.mr3d-items{margin-top:6px;display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto}
.mr3d-item{border:1px solid var(--bd);border-radius:8px;padding:7px 9px;background:var(--card)}
.mr3d-item .i1{font-weight:600;color:var(--t);font-size:11.5px}
.mr3d-item .i2{color:var(--t3);font-size:10.5px;margin-bottom:4px}
.mr3d-item .i3{display:flex;gap:6px;flex-wrap:wrap}
.mr3d-item .i3 span{color:var(--t2);font-size:10.5px;border:1px solid var(--bd);border-radius:4px;padding:1px 5px}
.mr3d-links{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.mr3d-link{display:inline-block;padding:3px 8px;border-radius:6px;border:1px solid var(--acc2);color:var(--acc2);text-decoration:none;font-size:11px}
.mr3d-link:hover{background:var(--acc);border-color:var(--acc);color:#fff}
.mr3d-open{margin-top:10px;width:100%;height:28px;border-radius:6px;border:none;background:var(--acc);color:#fff;font-weight:600;cursor:pointer}
.mr3d-open:hover{background:var(--acc2)}
.mr3d-status{font-size:14px;font-weight:800;color:var(--t);margin:2px 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mr3d-status .pill{font-size:10.5px;font-weight:700;color:#fff;border-radius:999px;padding:2px 9px;white-space:nowrap}
.mr3d-journey{margin:8px 0;border:1px solid var(--bd);border-radius:8px;padding:6px 9px;background:var(--card)}
.mr3d-journey .jd{display:flex;align-items:center;gap:7px;padding:3px 0;font-size:11.5px;min-width:0}
.mr3d-journey .jd i{width:9px;height:9px;border-radius:2px;display:inline-block;flex:0 0 auto}
.mr3d-journey .jd .nm{color:var(--t2);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mr3d-journey .jd .dt{color:var(--t);font-weight:600;font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.mr3d-journey .jd .days{font-weight:700;color:var(--t3);font-size:10.5px;white-space:nowrap;font-variant-numeric:tabular-nums}
.mr3d-journey .jd .ok{font-weight:700;font-size:11px;color:var(--t);flex:0 0 auto}
.mr3d-journey .jd.pending{opacity:.6}
.mr3d-docs{margin-top:8px;display:flex;flex-direction:column;gap:3px}
.mr3d-docs .doc{display:flex;align-items:center;gap:7px;font-size:11.5px;min-width:0}
.mr3d-docs .doc .dt{color:var(--t3);font-size:10px;flex:0 0 auto;width:112px}
.mr3d-docs .doc a{color:var(--acc2);text-decoration:none;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mr3d-docs .doc a:hover{text-decoration:underline}
.mr3d-docs .doc.none{color:var(--t3)}
.mr3d-board{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0}
.mr3d-board-hdr{display:flex;align-items:center;gap:10px;padding:8px 14px;color:var(--t2);font-size:12px;font-weight:700;flex-wrap:wrap}
.mr3d-board-hdr .note{color:var(--t3);font-weight:600;font-size:11px}
.mr3d-board-cols{flex:1;display:flex;gap:12px;overflow-x:auto;overflow-y:hidden;padding:2px 14px 14px;min-height:0}
.mr3d-board-col{flex:0 0 255px;min-width:255px;max-width:320px;display:flex;flex-direction:column;background:var(--b3);border:1px solid var(--bd);border-radius:10px;overflow:hidden}
.mr3d-board-col-hdr{display:flex;align-items:center;gap:7px;padding:9px 11px;border-bottom:1px solid var(--bd);background:var(--b2);font-weight:800;font-size:12px;color:var(--t)}
.mr3d-board-col-hdr i{width:10px;height:10px;border-radius:3px;display:inline-block;flex:0 0 auto}
.mr3d-board-col-hdr b{margin-left:auto;background:var(--cb);color:var(--t2);border-radius:999px;padding:1px 8px;font-size:11px;font-variant-numeric:tabular-nums}
.mr3d-board-col-body{flex:1;overflow-y:auto;overflow-x:hidden;padding:8px;display:flex;flex-direction:column;gap:7px;min-height:0}
.mr3d-month{font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--t3);padding:3px 4px 0;margin-top:3px}
.mr3d-card{display:block;width:100%;text-align:left;border:1px solid var(--bd);border-left:4px solid var(--card-accent,var(--acc));border-radius:8px;background:var(--card);color:var(--t);padding:8px 10px;cursor:pointer;font-family:inherit;font-size:12px;transition:transform .12s,box-shadow .12s,border-color .12s}
.mr3d-card:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.15);border-color:var(--acc2)}
.mr3d-card.sel{border-color:var(--acc2);box-shadow:0 0 0 2px rgba(59,130,246,.35)}
.mr3d-card-top{display:flex;justify-content:space-between;align-items:baseline;gap:6px}
.mr3d-card-badge{font-size:8.5px;font-weight:900;color:#fff;padding:1px 5px;border-radius:8px;letter-spacing:.3px;line-height:14px}
.mr3d-card-num{font-weight:800;color:var(--t);font-size:11.5px;word-break:break-word;flex:1}
.mr3d-card-date{color:var(--acc2);font-weight:700;font-size:10px;white-space:nowrap;font-variant-numeric:tabular-nums}
.mr3d-card-pr{display:block;color:var(--t2);font-size:10.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mr3d-card-people{display:flex;gap:5px;margin-top:5px;flex-wrap:wrap}
.mr3d-card-people .mr3d-tag{display:inline-flex;align-items:center;gap:3px;color:var(--t2);font-size:10px;background:var(--cb);border:1px solid var(--bd);border-radius:999px;padding:1px 7px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.mr3d-card-meta{display:flex;gap:8px;margin-top:5px;color:var(--t3);font-size:10.5px;flex-wrap:wrap}
.mr3d-card-meta b{color:var(--t2);font-weight:700}
.mr3d-card-bar{display:block;height:4px;border-radius:2px;background:var(--cb);margin-top:6px;overflow:hidden}
.mr3d-card-bar i{display:block;height:100%;border-radius:2px}
.mr3d-col-empty{padding:18px 8px;text-align:center;color:var(--t3);font-size:11px}
.mr3d-board-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--t3);background:var(--b);z-index:5;font-size:13px}
@media (max-width:640px){.mr3d-board-col{flex-basis:210px;min-width:210px}.mr3d-board-col-hdr{font-size:11px}.mr3d-card{padding:6px 8px;font-size:11px}}
`;

/* ─────────────────────────────────────────────────────────────
   ACTIONS
───────────────────────────────────────────────────────────── */
function defaultDates() {
	const t = new Date();
	const to = iso(t);
	t.setDate(t.getDate() - 30);
	const from = iso(t);
	return { from, to };
}

const actions = {
	async init() {
		try { store.companies = await call('api.get_companies'); } catch (e) { store.companies = []; }
		try { store.projects = await call('api.get_projects'); } catch (e) { store.projects = []; }
		const d = defaultDates();
		store.from_date = store.from_date || d.from;
		store.to_date = store.to_date || d.to;
		await actions.load();
	},
	async load() {
		store.loading = true;
		store.error = '';
		try {
			const res = await call('mr_status.get_mr_status', {
				filters: JSON.stringify({
					from_date: store.from_date,
					to_date: store.to_date,
					request_type: store.request_type,
					company: store.company || null,
					project: store.project || null,
					material_requisition: store.material_requisition || null,
					material_request: store.material_request || null,
					item_code: store.item_code || null,
				}),
			});
			store.mrs = res.mrs || [];
			store.stats = res.stats || {};
			store.loaded = true;
		} catch (e) {
			store.error = (e && e.message) || String(e);
			store.mrs = [];
		} finally {
			store.loading = false;
		}
	},
	toggleTheme() {
		store.isDark = !store.isDark;
		try { localStorage.setItem('mr3d-theme', store.isDark ? 'dark' : 'light'); } catch (e) { /* ignore */ }
	},
	nav(days) {
		const from = new Date(store.from_date + 'T00:00:00');
		const to = new Date(store.to_date + 'T00:00:00');
		from.setDate(from.getDate() + days);
		to.setDate(to.getDate() + days);
		store.from_date = iso(from);
		store.to_date = iso(to);
		actions.load();
	},
	toggleGrownUps() { store.grownUps = !store.grownUps; },
	select(entry) { store.selected = entry; },
	selectInBoard(m) {
		if (!m) return;
		store.selected = (store.selected && store.selected.material_request === m.material_request) ? null : m;
	},
	closePanel() {
		store.selected = null;
	},
	clearSearch() { store.search = ''; },
	openDoc(name) {
		if (window.frappe) frappe.set_route('Form', 'Material Request', name);
		else window.open('/app/material-request/' + name, '_blank');
	},
	openForm(dt, name) {
		if (window.frappe) frappe.set_route('Form', dt, name);
		else window.open(`/app/${dt.toLowerCase().replace(/ /g, '-')}/${name}`, '_blank');
	},
};

/* ─────────────────────────────────────────────────────────────
   2D BOARD — Trello-like kanban of the Material Requests
   (calendar-flavoured: month separators + date-sorted cards)
───────────────────────────────────────────────────────────── */
function monthKey(s) { const d = dayDate(dayNum(s)); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
function monthLabel(s) { const d = dayDate(dayNum(s)); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }

function buildBoardColumns(mrs, q) {
	const list = (mrs || []).filter(m => {
		if (!q) return true;
		const s = q.toLowerCase();
		if ((m.material_requisition || '').toLowerCase().includes(s)) return true;
		if ((m.material_request || '').toLowerCase().includes(s)) return true;
		return (m.items || []).some(it =>
			(it.item_code || '').toLowerCase().includes(s) ||
			(it.item_name || '').toLowerCase().includes(s));
	});
	return STAGES.map((s, i) => {
		const cards = list
			.filter(m => m && (stepIndex(m) - 1) === i)
			.slice()
			.sort((a, b) => ((b.date || b.mr_date) || '').localeCompare((a.date || a.mr_date) || ''));
		const rows = [];
		let lastMk = null;
		cards.forEach(m => {
			const src = m.date || m.mr_date || '';
			const mk = src ? monthKey(src) : -1;
			if (mk !== lastMk) {
				rows.push({ type: 'month', key: 'm' + mk, label: src ? monthLabel(src) : 'No date' });
				lastMk = mk;
			}
			rows.push({ type: 'card', key: m.material_request, m });
		});
		return { key: s.key, label: s.label, short: s.short, color: s.color, rows, count: cards.length };
	});
}

const BoardView = defineComponent({
	name: 'BoardView',
	setup() {
		const boardMRS = computed(() => {
			const q = (store.search || '').trim().toLowerCase();
			const mrs = store.mrs || [];
			if (!q) return mrs;
			return mrs.filter(m =>
				(m.material_requisition || '').toLowerCase().includes(q) ||
				(m.material_request || '').toLowerCase().includes(q) ||
				(m.items || []).some(it =>
					(it.item_code || '').toLowerCase().includes(q) ||
					(it.item_name || '').toLowerCase().includes(q)));
		});
		const columns = computed(() => buildBoardColumns(boardMRS.value, ''));
		const range = computed(() => friendlyRange(store.from_date, store.to_date));
		const pct = m => Math.min(100, Math.max(0, Number(m.pct_received) || 0));
		return { store, columns, boardMRS, range, pct, fmt, shortDate, actions, originOf, ORIGIN_COLOR, ORIGIN_SHORT };
	},
	template: `
	<div class="mr3d-board">
		<div class="mr3d-board-hdr">
			<span>🗓 {{range}}</span>
			<span class="note" v-if="(store.search||'').trim()">showing matches for “{{(store.search||'').trim()}}” ({{boardMRS.length}} of {{store.mrs.length}})</span>
			<span class="note" v-else>Click a card for its paperwork · Esc to close</span>
		</div>
		<div class="mr3d-board-cols">
			<div class="mr3d-board-col" v-for="col in columns" :key="col.key">
				<div class="mr3d-board-col-hdr">
					<i :style="{background:col.color}"></i>
					<span>{{col.label}}</span>
					<b>{{col.count}}</b>
				</div>
				<div class="mr3d-board-col-body">
					<template v-for="r in col.rows" :key="r.key">
						<div class="mr3d-month" v-if="r.type==='month'">{{r.label}}</div>
						<button class="mr3d-card" v-else
							:class="{sel:store.selected && store.selected.material_request===r.m.material_request}"
							:style="{'--card-accent': col.color}"
							@click="actions.selectInBoard(r.m)">
							<span class="mr3d-card-top">
								<span class="mr3d-card-badge" :style="{background:ORIGIN_COLOR[originOf(r.m)]}">{{ORIGIN_SHORT[originOf(r.m)]}}</span>
								<span class="mr3d-card-num">{{r.m.material_requisition || r.m.material_request}}</span>
								<span class="mr3d-card-date">{{shortDate(r.m.mr_date || r.m.date)}}</span>
							</span>
						<span class="mr3d-card-pr">{{r.m.has_pr ? r.m.material_request : 'Awaiting Purchase Request'}}</span>
						<span class="mr3d-card-people">
							<span v-if="r.m.department" class="mr3d-tag">🏢 {{r.m.department}}</span>
							<span v-if="r.m.requested_by" class="mr3d-tag">👤 {{r.m.requested_by}}</span>
						</span>
						<span class="mr3d-card-meta">
								<template v-if="r.m.item_count">
									<span><b>{{r.m.item_count}}</b> item{{r.m.item_count===1?'':'s'}}</span>
									<span><b>{{fmt(r.m.qty)}}</b> qty</span>
								</template>
								<span v-else>no PR yet</span>
								<span>{{r.m.project}}</span>
							</span>
							<span class="mr3d-card-bar"><i :style="{width:pct(r.m)+'%',background:'#22c55e'}"></i></span>
						</button>
					</template>
					<div class="mr3d-col-empty" v-if="!col.rows.length">Nothing waiting here</div>
				</div>
			</div>
		</div>
		<div class="mr3d-board-empty" v-if="store.loaded && store.mrs.length && !boardMRS.length">No requests match your search</div>
	</div>
	`,
});

/* ─────────────────────────────────────────────────────────────
   VUE APP
───────────────────────────────────────────────────────────── */
const allItems = computed(() => {
	const out = [];
	store.mrs.forEach(m => m.items.forEach(it => out.push({ mr: m, item: it })));
	return out;
});

const searchResults = computed(() => {
	const q = (store.search || '').trim().toLowerCase();
	if (!q) return [];
	const res = [];
	store.mrs.forEach(m => {
		const hitDoc = (m.material_requisition || '').toLowerCase().includes(q) || (m.material_request || '').toLowerCase().includes(q);
		if (hitDoc) { res.push({ mr: m, item: null }); return; }
		m.items.forEach(it => {
			if ((it.item_code || '').toLowerCase().includes(q) || (it.item_name || '').toLowerCase().includes(q)) {
				res.push({ mr: m, item: it });
			}
		});
	});
	return res.slice(0, 40);
});

const stats = computed(() => store.stats || {});
const rangeText = computed(() => friendlyRange(store.from_date, store.to_date));

const App = defineComponent({
	components: { BoardView },
	setup() {
		onMounted(() => {
			actions.init();
			document.addEventListener('keydown', onKey);
			document.addEventListener('click', onDocClick);
		});
		onUnmounted(() => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('click', onDocClick);
		});
		function onDocClick(e) {
			if (!store.selected) return;
			const t = e.target;
			if (t && t.closest && !t.closest('.mr3d-dp') && !t.closest('.mr3d-card')
				&& !t.closest('.mr3d-top') && !t.closest('.mr3d-filters')) actions.closePanel();
		}
		function onKey(e) {
			if (e.key === 'Escape') {
				store.selected = null;
				store.search = '';
			}
		}
		function onReqType() {
			store.material_requisition = '';
			store.material_request = '';
			actions.load();
		}
		function onCompany() {
			call('api.get_projects', { company: store.company || '' })
				.then(p => { store.projects = p || []; })
				.catch(() => { store.projects = []; });
			actions.load();
		}
		function onItemCode() {
			if (!store.item_code) { store.item_name = ''; return; }
			if (window.frappe && frappe.db) {
				frappe.db.get_value('Item', store.item_code, 'item_name', r => {
					if (r && r.item_name) store.item_name = r.item_name;
				});
			}
		}
		return { store, stats, rangeText, searchResults, actions, fmt, STAGES, journey, techStatus, stepIndex, docsOf, onReqType, onCompany, onItemCode };
	},
	template: `
	<div id="mr3d-app" :class="store.isDark?'dark':'light'">
		<div class="mr3d-top">
			<div class="mr3d-title">🚚 Material Requisition Board</div>
			<div class="mr3d-stats">
				<div class="mr3d-chip" v-if="stats.mr_count">🎁 <b>{{stats.mr_count}}</b> {{stats.mr_count === 1 ? 'request' : 'requests'}}</div>
			</div>
			<div class="mr3d-sp"></div>
			<div class="mr3d-nav">
				<button title="Look at an earlier week" @click="actions.nav(-7)">◀</button>
				<div class="range">{{rangeText}}</div>
				<button title="Look at a later week" @click="actions.nav(7)">▶</button>
			</div>
			<button class="mr3d-round" :title="store.isDark?'Daytime':'Nighttime'" @click="actions.toggleTheme()">{{store.isDark?'☀️':'🌙'}}</button>
			<button class="mr3d-btn-big" :class="store.grownUps?'on':''" @click="actions.toggleGrownUps()">{{store.grownUps?'🙈 Simple':'🔬 Details'}}</button>
		</div>

		<div class="mr3d-filters">
			<label>Type <select v-model="store.request_type" @change="onReqType()" title="Request type">
				<option value="All">All</option>
				<option>Material Requisition</option>
				<option>Fuel Request</option>
				<option>Fixed Asset Request</option>
			</select></label>
			<label>Company <select v-model="store.company" @change="onCompany()" title="Company">
				<option value="">All</option>
				<option v-for="c in store.companies" :key="c.name" :value="c.name">{{c.name}}</option>
			</select></label>
			<label>From <input type="date" v-model="store.from_date" title="From date"></label>
			<label>To <input type="date" v-model="store.to_date" title="To date"></label>
			<label>Project <select v-model="store.project" title="Project">
				<option value="">All</option>
				<option v-for="p in store.projects" :key="p" :value="p">{{p}}</option>
			</select></label>
			<label>MR <input v-model="store.material_requisition" placeholder="MR no." style="width:110px" title="Material Requisition number"></label>
			<label>PR <input v-model="store.material_request" placeholder="Purchase Request" style="width:130px" title="Purchase Request name"></label>
			<label>Item <input v-model="store.item_code" placeholder="Item code" style="width:110px" @blur="onItemCode()" title="Item code"></label>
			<input v-if="store.item_name" :value="store.item_name" readonly title="Item name" style="width:130px">
			<button class="mr3d-btn mr3d-btn-primary" :disabled="store.loading" @click="actions.load()">{{store.loading?'Loading…':'Apply'}}</button>
			<div class="mr3d-search">
				<input v-model="store.search" placeholder="Search MR / item…" @keydown.esc="actions.clearSearch()">
				<div class="mr3d-drop" v-if="searchResults.length">
					<div class="mr3d-drop-item" v-for="(r,i) in searchResults" :key="i" @click="actions.select(r.mr)">
						<div class="d1">{{r.item ? r.item.item_code + ' — ' + r.item.item_name : r.mr.material_requisition}}</div>
						<div class="d2">{{r.mr.material_request}} · {{r.mr.project}} · {{r.mr.date}}</div>
					</div>
				</div>
			</div>
		</div>

		<div id="mr3d-stage">
			<BoardView/>
			<div class="mr3d-loading" v-if="store.loading">
				<div class="mr3d-spinner"></div>
				<div>Fetching the Material Requests… 🎈</div>
			</div>
			<div class="mr3d-empty" v-else-if="store.error || (store.loaded && !store.mrs.length)">
				<b>{{store.error ? 'Oops!' : 'No Material Requests here 🐣'}}</b>
				<div>{{store.error || 'Tap the ◀ ▶ buttons to look at another week.'}}</div>
			</div>
		</div>

		<div class="mr3d-dp" v-if="store.selected">
			<h3>{{store.selected.material_requisition}}</h3>
			<div class="sub">{{store.selected.material_request}} · {{store.selected.project}}<span v-if="store.selected.company"> · {{store.selected.company}}</span></div>
			<div class="mr3d-status">
				<span class="pill" :style="{background:STAGES[stepIndex(store.selected)-1].color}">Step {{stepIndex(store.selected)}} of 6</span>
				<span>{{techStatus(store.selected)}}</span>
			</div>
			<div class="kv"><span>📅 Date</span><b>{{store.selected.date}}</b></div>
			<div class="kv" v-if="store.selected.mr_date && store.selected.mr_date !== store.selected.date"><span>🌱 Originated</span><b>{{store.selected.mr_date}}</b></div>
			<div class="kv" v-if="store.selected.fixed_asset_requests && store.selected.fixed_asset_requests.length"><span>🏷️ FAR</span><b>{{store.selected.fixed_asset_requests.join(', ')}}</b></div>
			<div class="kv" v-if="store.selected.fuel_requests && store.selected.fuel_requests.length"><span>⛽ Fuel Req</span><b>{{store.selected.fuel_requests.join(', ')}}</b></div>
			<div class="kv" v-if="store.selected.department"><span>🏢 Department</span><b>{{store.selected.department}}</b></div>
			<div class="kv" v-if="store.selected.requested_by"><span>👤 Requested by</span><b>{{store.selected.requested_by}}</b></div>
			<div class="kv"><span>📦 Items</span><b>{{store.selected.item_count}}</b></div>
			<div class="kv"><span>🎒 Qty</span><b>{{fmt(store.selected.qty)}}</b></div>
			<div class="kv"><span>✅ Received</span><b style="color:#22c55e">{{store.selected.pct_received}}%</b></div>
			<div class="mr3d-journey">
				<div class="jd" v-for="(s,i) in journey(store.selected)" :key="i" :class="s.done?'':'pending'">
					<i :style="{background:s.color}"></i>
					<span class="nm">{{s.label}}</span>
					<span class="dt">{{s.date || '—'}}</span>
					<span class="days">{{s.days !== null ? (s.days ? '+' + s.days + 'd' : 'same day') : ''}}</span>
					<span class="ok">{{s.done ? '✓' : '…'}}</span>
				</div>
			</div>
			<div class="mr3d-docs">
				<div class="doc" :class="{none:!doc.name}" v-for="doc in docsOf(store.selected)" :key="doc.kind">
					<span class="dt">{{doc.kind}}</span>
					<a v-if="doc.name && doc.route" @click.prevent="actions.openForm(doc.route, doc.name)">{{doc.display}}</a>
					<span v-else-if="doc.name">{{doc.display}}</span>
					<span v-else>not created yet</span>
				</div>
			</div>
			<div class="mr3d-bar">
				<div :style="{width:Math.min(100,store.selected.pct_received)+'%',background:'#22c55e'}" title="Received"></div>
			</div>
			<div class="mr3d-items" v-if="store.grownUps">
				<div class="mr3d-item" v-for="(it,idx) in store.selected.items" :key="idx">
					<div class="i1">{{it.item_code}}</div>
					<div class="i2">{{it.item_name}}</div>
					<div class="i3">
						<span>Qty {{fmt(it.qty)}} {{it.uom}}</span>
						<span>Got {{fmt(it.received_qty)}}</span>
						<span>Bought {{fmt(it.ordered_qty)}}</span>
						<span v-if="it.required_date">By {{it.required_date}}</span>
					</div>
					<div class="i3">
						<a class="mr3d-link" v-for="po in it.purchase_orders" :key="po" @click.prevent="actions.openForm('Purchase Order', po)">{{po}}</a>
						<a class="mr3d-link" v-for="g in it.purchase_receipts" :key="g" @click.prevent="actions.openForm('Purchase Receipt', g)">{{g}}</a>
					</div>
				</div>
			</div>
			<button class="mr3d-open" v-if="store.grownUps && store.selected.has_pr" @click="actions.openDoc(store.selected.material_request)">Open the Purchase Request ✏️</button>
		</div>
	</div>
	`,
});

window.MR3D = {
	init(mountId) {
		if (!document.getElementById('mr3d-style')) {
			const style = document.createElement('style');
			style.id = 'mr3d-style';
			style.textContent = CSS;
			document.head.appendChild(style);
		}
		setTimeout(() => {
			const app = createApp(App);
			app.mount('#' + mountId);
		}, 80);
	},
};

if (window.__MR3D_TEST__) {
	window.__MR3D_TEST__ = { store, actions, App, BoardView, buildBoardColumns, STAGES, stepIndex, journey, fmt, shortDate };
}
})();