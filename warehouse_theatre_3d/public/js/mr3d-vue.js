/* Material Requisition 3D v0.5.0 — Delivery Playground
   A toy-like 3D calendar of Material Requests.
   Each request (Purchase Request, type "Purchase") is a friendly card sitting on
   the day it was asked for, tinted by its current stage:
     MR Material Requisition → PR Purchase Request → PO Purchase Order
     → GRV Purchase Receipt → ✓ Fully Received
   The card carries 5 candy coins (one per stage), a happy face and its MR date.
   Cards bounce in, wobble on hover, jump + pop confetti when tapped. Clicking a
   card shows the status, the days between steps, the step in the 3D view, and
   the created documents.
   Depends on: Vue 3 global build + THREE (loaded before this script) */
(function () {
'use strict';

const { createApp, defineComponent, reactive, computed, onMounted, onUnmounted, nextTick } = Vue;

/* ─────────────────────────────────────────────────────────────
   HELPERS & CONSTANTS
───────────────────────────────────────────────────────────── */
const COLORS = {
	mr: 0x3b82f6, pr: 0x8b5cf6, po: 0xf59e0b, grv: 0x14b8a6, done: 0x22c55e,
	waiting: 0x93c5fd, arrived: 0x2dd4bf, received: 0x4ade80,
};
const STAGES = [
	{ key: 'MR', label: 'Material Requisition', short: 'MR', color: '#3b82f6' },
	{ key: 'PR', label: 'Purchase Request', short: 'PR', color: '#8b5cf6' },
	{ key: 'PO', label: 'Purchase Order', short: 'PO', color: '#f59e0b' },
	{ key: 'GRV', label: 'Purchase Receipt', short: 'GRV', color: '#14b8a6' },
	{ key: 'DONE', label: 'Fully Received', short: '✓', color: '#22c55e' },
];
const fmt = n => (parseFloat(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const blend = (a, b, t) => {
	const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
	const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
	return ((Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t));
};
const API = 'warehouse_theatre_3d.warehouse_theatre_3d.api.';

/* UTC-safe day arithmetic */
const dayNum = s => {
	const [y, mo, d] = String(s).split('-').map(Number);
	return Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
};
const dayDate = n => new Date(n * 86400000);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* technical status, per-step journey (dates, days elapsed, created docs) */
function techStatus(mr) {
	if (mr.fully_received) return 'Fully Received';
	if (mr.has_grv) return 'Partially Received';
	if (mr.has_po) return 'Ordered';
	return 'Pending';
}
function daysBetween(a, b) {
	if (!a || !b) return null;
	return Math.max(0, dayNum(b) - dayNum(a));
}
function journey(mr) {
	const dates = { MR: mr.mr_date || mr.date, PR: mr.date, PO: mr.po_date, GRV: mr.grv_date, DONE: mr.grv_date || mr.date };
	const done = [true, true, !!mr.has_po, !!mr.has_grv, !!mr.fully_received];
	const steps = STAGES.map((s, i) => ({
		key: s.key, label: s.label, short: s.short, color: s.color,
		done: done[i], date: dates[s.key],
	}));
	steps.forEach((s, i) => {
		s.days = i > 0 && steps[i - 1].date ? daysBetween(steps[i - 1].date, s.date) : null;
	});
	return steps;
}
function stepIndex(mr) {
	const stages = [true, true, !!mr.has_po, !!mr.has_grv, !!mr.fully_received];
	const fu = stages.indexOf(false);
	return fu === -1 ? 5 : fu + 1;
}
function docsOf(mr) {
	const po = mr.purchase_orders || [], grv = mr.purchase_receipts || [];
	const fmtList = arr => arr.length ? (arr.length === 1 ? arr[0] : `${arr[0]} +${arr.length - 1} more`) : null;
	return [
		{ kind: 'Material Requisition', name: mr.material_requisition || null, display: mr.material_requisition || null, route: 'Material Request' },
		{ kind: 'Purchase Request', name: mr.material_request || null, display: mr.material_request || null, route: 'Material Request' },
		{ kind: 'Purchase Order', name: po.length ? po[0] : null, display: fmtList(po), route: 'Purchase Order' },
		{ kind: 'Purchase Receipt', name: grv.length ? grv[0] : null, display: fmtList(grv), route: 'Purchase Receipt' },
	];
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
function easeOutBack(t) {
	const c1 = 1.70158, c3 = c1 + 1;
	return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
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

function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
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
	party: false,
	mrs: [],
	stats: {},
	loading: false,
	loaded: false,
	error: '',
	from_date: '',
	to_date: '',
	request_type: 'Material Requisition',
	company: '',
	companies: [],
	projects: [],
	project: '',
	material_requisition: '',
	material_request: '',
	item_code: '',
	item_name: '',
	selected: null,
	tooltip: { x: 0, y: 0, visible: false, entry: null },
	search: '',
});

/* ─────────────────────────────────────────────────────────────
   CSS
───────────────────────────────────────────────────────────── */
const CSS = `
#mr3d-app.dark{--b:#0c0e14;--b2:#13151e;--b3:#1a1e2a;--bd:rgba(255,255,255,.08);--t:#fff;--t2:rgba(255,255,255,.65);--t3:rgba(255,255,255,.35);--card:rgba(255,255,255,.04);--cb:rgba(255,255,255,.08);--acc:#3b82f6;--acc2:#60a5fa}
#mr3d-app.light{--b:#f0f2f5;--b2:#fff;--b3:#f7f9fc;--bd:#e2e8f0;--t:#1a202c;--t2:#4a5568;--t3:#a0aec0;--card:#fff;--cb:#e2e8f0;--acc:#2563eb;--acc2:#3b82f6}
#mr3d-app{width:100%;height:100%;display:flex;flex-direction:column;background:var(--b);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12.5px;color:var(--t);position:relative;overflow:hidden;transition:background .3s}
#mr3d-cw{flex:1;position:relative;min-height:0}
#mr3d-c{display:block;width:100%;height:100%;touch-action:manipulation}
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
.mr3d-btn-party{background:linear-gradient(135deg,#f59e0b,#ef4444);border:none;color:#fff}
.mr3d-btn-party.on{box-shadow:0 0 0 3px rgba(239,68,68,.35);animation:mr3dpulse .7s ease-in-out infinite}
@keyframes mr3dpulse{50%{transform:scale(1.07)}}
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
.mr3d-legend{position:absolute;bottom:12px;left:12px;display:flex;gap:14px;align-items:center;background:var(--b2);border:1px solid var(--bd);border-radius:14px;padding:8px 14px;z-index:15;box-shadow:0 4px 14px rgba(0,0,0,.12);flex-wrap:wrap}
.mr3d-legend span{display:flex;align-items:center;gap:6px;color:var(--t2);white-space:nowrap;font-size:12px;font-weight:600}
.mr3d-legend i{width:12px;height:12px;border-radius:50%;display:inline-block;flex:0 0 auto}
.mr3d-legend svg{flex:0 0 auto}
.mr3d-hint{position:absolute;bottom:14px;right:12px;color:var(--t3);font-size:12px;z-index:15;font-weight:600}
.mr3d-tooltip{position:absolute;background:var(--b2);border:1px solid var(--bd);border-radius:8px;padding:8px 11px;font-size:11.5px;color:var(--t2);pointer-events:none;z-index:30;box-shadow:0 6px 20px rgba(0,0,0,.22);max-width:260px}
.mr3d-tooltip b{color:var(--t);font-weight:600}
.mr3d-tooltip .row{display:flex;align-items:center;gap:6px;margin-top:3px}
.mr3d-tooltip i{width:9px;height:9px;border-radius:2px;display:inline-block}
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
.mr3d-legend .lg{display:flex;flex-direction:column;gap:3px}
.mr3d-legend .lg-t{font-size:9.5px;font-weight:800;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-right:5px}
.mr3d-legend .bar{width:12px;height:5px;border-radius:2px;display:inline-block;flex:0 0 auto;box-shadow:0 0 6px rgba(255,255,255,.35)}
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
`;

/* ─────────────────────────────────────────────────────────────
   THREE.JS ENGINE
───────────────────────────────────────────────────────────── */
class Engine {
	constructor() {
		this.meshMap = {};
		this.entries = [];
		this.cardMeshes = [];
		this.pipeMeshes = [];
		this.hitMeshes = [];
		this.pulse = [];
		this.theta = .65; this.phi = .85; this.radius = 30; this.panX = 0; this.panZ = 0;
		this.tT = .65; this.tP = .85; this.tR = 30; this.tPX = 0; this.tPZ = 0;
		this.drag = false; this.rDrag = false; this.lx = 0; this.ly = 0;
		this.hovKey = null; this._anim = false;
		this.pops = []; this.confetti = []; this.bouncy = new Map();
		this.party = false; this._partyTick = 0; this._lastT = 0;
		this._sceneX = 1; this._sceneZ = 1;
		this.selLabel = null;
		this.audioCtx = null;
		this.zoomKey = null;
		this.moved = false;
		this._clickTimer = null;
		this._justZoomed = 0;
		this._tapT = 0; this._tapX = -9999; this._tapY = -9999;
	}

	init(canvas, cwEl) {
		const THREE = window.THREE;
		this.canvas = canvas; this.cwEl = cwEl;
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.scene = new THREE.Scene();
		const bg = store.isDark ? 0x0c0e14 : 0xf0f2f5;
		this.renderer.setClearColor(bg, 1);
		this.scene.background = new THREE.Color(bg);
		this.scene.fog = new THREE.Fog(bg, 200, 600);
		this.camera = new THREE.PerspectiveCamera(45, 1, .1, 1200);
		this.scene.add(new THREE.AmbientLight(0xffffff, .55));
		const dL = new THREE.DirectionalLight(0xffffff, .7);
		dL.position.set(40, 70, 30); dL.castShadow = true;
		dL.shadow.mapSize.set(2048, 2048);
		dL.shadow.camera.left = -120; dL.shadow.camera.right = 120;
		dL.shadow.camera.top = 120; dL.shadow.camera.bottom = -120;
		dL.shadow.camera.far = 400;
		this.scene.add(dL);
		const fL = new THREE.DirectionalLight(0x4060ff, .18);
		fL.position.set(-20, 10, -20); this.scene.add(fL);
		this.ptL = new THREE.PointLight(0x60a5fa, .5, 120);
		this.ptL.position.set(0, 40, 0); this.scene.add(this.ptL);
		this.fl = new THREE.Mesh(
			new THREE.PlaneGeometry(400, 400),
			new THREE.MeshStandardMaterial({ color: store.isDark ? 0x0a0c12 : 0xcbd5e1, roughness: .95, metalness: .05 })
		);
		this.fl.rotation.x = -Math.PI / 2; this.fl.position.y = -0.05; this.fl.receiveShadow = true;
		this.scene.add(this.fl);
		this.rootGrp = new THREE.Group();
		this.scene.add(this.rootGrp);
		this._size();
		this._animate();
		new ResizeObserver(() => this._size()).observe(cwEl);
		this.bindMouse();
	}

	_size() {
		const w = this.cwEl.clientWidth, h = this.cwEl.clientHeight;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	_animate() {
		if (this._anim) return;
		this._anim = true;
		const loop = () => {
			requestAnimationFrame(loop);
			const t = performance.now() * .001;
			const dt = Math.max(0, t - (this._lastT || t));
			this._lastT = t;
			const k = 1 - Math.pow(.92, dt * 60);
			this.theta += (this.tT - this.theta) * k;
			this.phi += (this.tP - this.phi) * k;
			this.radius += (this.tR - this.radius) * k;
			this.panX += (this.tPX - this.panX) * k;
			this.panZ += (this.tPZ - this.panZ) * k;
			this.camera.position.set(
				this.panX + this.radius * Math.sin(this.phi) * Math.sin(this.theta),
				this.radius * Math.cos(this.phi),
				this.panZ + this.radius * Math.sin(this.phi) * Math.cos(this.theta)
			);
			this.camera.lookAt(this.panX, 0, this.panZ);
			this.ptL.position.x = Math.sin(t * .25) * 18;
			this.ptL.position.z = Math.cos(t * .25) * 18;

			/* cards bounce in */
			if (this.pops.length) {
				this.pops.forEach(p => {
					p.t += dt;
					if (p.t < p.delay) return;
					const tt = clamp((p.t - p.delay) / .55, 0, 1);
					const s = easeOutBack(tt);
					if (tt >= 1) { p.grp.scale.set(1, 1, 1); p.done = true; }
					else p.grp.scale.set(s, s, s);
				});
				this.pops = this.pops.filter(p => !p.done);
			}

			/* coins pulse on the in-progress stage */
			this.pulse.forEach((p, idx) => {
				const s = 1 + Math.sin(t * 4 + idx * 1.7) * .18;
				p.mesh.scale.set(s, s, 1);
			});

			/* done cards breathe a happy glow */
			const hovKey = this.hovKey;
			this.cardMeshes.forEach(m => {
				const e = m.userData.entry;
				if (!e) return;
				if (e.fully_received && m.userData.key !== hovKey) {
					m.material.emissive.setHex(0x22c55e);
					m.material.emissiveIntensity = .22 + Math.sin(t * 2.5) * .12;
				}
			});

			/* hovered card wobbles + lifts */
			const hg = hovKey ? (this.meshMap[hovKey] || {}).grp : null;
			this.cardMeshes.forEach(m => {
				const sel = m.userData.key === hovKey;
				if (sel && hg && !this.pops.some(p => p.grp === hg)) {
					m.scale.set(1.08, 1.08, 1.08);
					m.rotation.z = Math.sin(t * 9) * .07;
				} else if (!sel) {
					m.scale.set(1, 1, 1);
					m.rotation.z = 0;
				}
			});

			/* tapped cards do a happy jump */
			this.bouncy.forEach((b, k) => {
				b.t += dt;
				const u = clamp(b.t / .7, 0, 1);
				b.grp.position.y = Math.abs(Math.sin(b.t * 13)) * .6 * (1 - u);
				if (b.t >= .7) this.bouncy.delete(k);
			});

			/* confetti physics */
			this.confetti.forEach(c => {
				c.vy -= .0045;
				c.mesh.position.x += c.vx;
				c.mesh.position.y += c.vy;
				c.mesh.position.z += c.vz;
				c.mesh.rotation.x += .14;
				c.mesh.rotation.z += .1;
				c.life -= .006;
			});
			this.confetti = this.confetti.filter(c => c.life > 0 && c.mesh.position.y > -.3);

			/* party rain */
			if (this.party) {
				this._partyTick += dt;
				if (this._partyTick > .09) {
					this._partyTick = 0;
					this.dropConfetti();
				}
			}

			this.renderer.render(this.scene, this.camera);
		};
		loop();
	}

	drawLabel(cvs, text, { accent = false, dark = store.isDark, pill = true, color, glyph, bg, border } = {}) {
		const fontPx = 40, pad = 16, dpr = 2;
		const ctx = cvs.getContext('2d');
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, cvs.width, cvs.height);
		ctx.font = `700 ${fontPx}px Inter, -apple-system, Segoe UI, Roboto, sans-serif`;
		const tw = ctx.measureText(text).width;
		const w = Math.ceil(tw) + pad * 2, h = fontPx + pad * 2;
		cvs.width = w * dpr; cvs.height = h * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		if (pill) {
			ctx.fillStyle = bg || (accent ? (dark ? 'rgba(30,38,58,.94)' : 'rgba(255,255,255,.96)') : 'rgba(0,0,0,0)');
			roundRect(ctx, 0, 0, w, h, h / 2); ctx.fill();
			ctx.strokeStyle = border || (accent ? (dark ? 'rgba(96,165,250,.55)' : 'rgba(37,99,235,.4)') : 'rgba(0,0,0,0)');
			ctx.lineWidth = 3; roundRect(ctx, 0, 0, w, h, h / 2); ctx.stroke();
		}
		ctx.fillStyle = color || (accent ? (dark ? '#fff' : '#111827') : (dark ? '#cbd5e1' : '#374151'));
		ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
		ctx.font = `700 ${fontPx}px Inter, -apple-system, Segoe UI, Roboto, sans-serif`;
		if (glyph === 'check') {
			ctx.beginPath(); ctx.arc(w / 2, h / 2, h * .34, 0, Math.PI * 2); ctx.fillStyle = '#22c55e'; ctx.fill();
			ctx.strokeStyle = '#fff'; ctx.lineWidth = fontPx * .13; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
			ctx.beginPath(); ctx.moveTo(w * .4, h * .5); ctx.lineTo(w * .47, h * .58); ctx.lineTo(w * .63, h * .38); ctx.stroke();
		} else {
			ctx.fillText(text, w / 2, pad + fontPx / 2);
		}
	}

	makeLabel(text, opts = {}) {
		const THREE = window.THREE;
		const cvs = document.createElement('canvas');
		this.drawLabel(cvs, text, opts);
		const dpr = 2, sc = (opts.size || 1) / 40;
		const tex = new THREE.CanvasTexture(cvs);
		tex.anisotropy = 4;
		const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
		sp.scale.set((cvs.width / dpr) * sc, (cvs.height / dpr) * sc, 1);
		sp.userData = { canvas: cvs, size: opts.size || 1 };
		return sp;
	}

	setLabel(sprite, text, opts = {}) {
		const dpr = 2, sc = (opts.size || sprite.userData.size || 1) / 40;
		this.drawLabel(sprite.userData.canvas, text, opts);
		if (sprite.material.map) sprite.material.map.needsUpdate = true;
		sprite.scale.set((sprite.userData.canvas.width / dpr) * sc, (sprite.userData.canvas.height / dpr) * sc, 1);
	}

	/* a cute face + nametag painted on the card's front */
	makeFace(entry) {
		const THREE = window.THREE;
		const w = 128, h = 96;
		const cvs = document.createElement('canvas');
		cvs.width = w; cvs.height = h;
		const ctx = cvs.getContext('2d');
		const circle = (cx, cy, r) => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); };
		const done = !!entry.fully_received;
		const mood = done ? 'done' : (entry.has_grv ? 'grv' : (entry.has_po ? 'po' : 'mr'));
		ctx.fillStyle = '#1f2430';
		circle(w / 2 - 22, 38, 7); circle(w / 2 + 22, 38, 7);
		ctx.fillStyle = '#fff';
		circle(w / 2 - 24, 35, 2.4); circle(w / 2 + 20, 35, 2.4);
		ctx.strokeStyle = '#1f2430';
		ctx.lineWidth = 4; ctx.lineCap = 'round';
		ctx.beginPath();
		if (mood === 'done') ctx.arc(w / 2, 56, 17, 0, Math.PI);
		else if (mood === 'grv') ctx.arc(w / 2, 58, 12, 0, Math.PI);
		else if (mood === 'po') ctx.arc(w / 2, 62, 8, 0, Math.PI);
		else ctx.arc(w / 2, 66, 5, 0, Math.PI);
		ctx.stroke();
		ctx.fillStyle = 'rgba(0,0,0,.5)';
		roundRect(ctx, 6, 64, w - 12, 28, 6); ctx.fill();
		ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
		ctx.fillStyle = '#fff';
		ctx.font = 'bold 13px Inter, -apple-system, Segoe UI, Roboto, sans-serif';
		ctx.fillText(shortDate(entry.mr_date || entry.date), w / 2, 73);
		ctx.font = 'bold 9px "SF Mono", Menlo, Consolas, monospace';
		ctx.fillStyle = 'rgba(255,255,255,.75)';
		ctx.fillText(entry.material_requisition || '', w / 2, 87);
		const tex = new THREE.CanvasTexture(cvs);
		return new THREE.Mesh(
			new THREE.PlaneGeometry(.58, .44),
			new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
		);
	}

	/* happy sound blips (WebAudio, only after the child taps something) */
	tone(freq, dur = .12, type = 'triangle', vol = .06) {
		try {
			const Ctx = window.AudioContext || window.webkitAudioContext;
			if (!Ctx) return;
			if (!this.audioCtx) this.audioCtx = new Ctx();
			const o = this.audioCtx.createOscillator();
			const g = this.audioCtx.createGain();
			o.type = type; o.frequency.value = freq;
			g.gain.setValueAtTime(vol, this.audioCtx.currentTime);
			g.gain.exponentialRampToValueAtTime(.0001, this.audioCtx.currentTime + dur);
			o.connect(g); g.connect(this.audioCtx.destination);
			o.start(); o.stop(this.audioCtx.currentTime + dur);
		} catch (e) { /* audio is optional */ }
	}

	/* a burst of candy confetti */
	burst(x, y, z, n = 46) {
		const THREE = window.THREE;
		const palette = [0x3b82f6, 0x8b5cf6, 0xf59e0b, 0x14b8a6, 0x22c55e, 0xf472b6, 0xfacc15];
		for (let i = 0; i < n; i++) {
			const mesh = new THREE.Mesh(
				new THREE.BoxGeometry(.13, .13, .05),
				new THREE.MeshBasicMaterial({ color: palette[(Math.random() * palette.length) | 0] })
			);
			mesh.position.set(x + (Math.random() - .5) * .4, y + (Math.random() - .5) * .4, z + (Math.random() - .5) * .4);
			mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
			this.rootGrp.add(mesh);
			this.confetti.push({
				mesh,
				vx: (Math.random() - .5) * .3,
				vy: Math.random() * .38 + .22,
				vz: (Math.random() - .5) * .3,
				life: 1,
			});
		}
		this.tone(660, .09, 'square', .05);
		this.tone(990, .12, 'square', .05);
	}

	/* party rain from the sky */
	dropConfetti() {
		const THREE = window.THREE;
		const palette = [0x3b82f6, 0x8b5cf6, 0xf59e0b, 0x14b8a6, 0x22c55e, 0xf472b6, 0xfacc15];
		const mesh = new THREE.Mesh(
			new THREE.BoxGeometry(.16, .16, .06),
			new THREE.MeshBasicMaterial({ color: palette[(Math.random() * palette.length) | 0] })
		);
		mesh.position.set((Math.random() - .5) * this._sceneX * 1.4, 8, (Math.random() - .5) * this._sceneZ * 1.4);
		mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
		this.rootGrp.add(mesh);
		this.confetti.push({ mesh, vx: (Math.random() - .5) * .06, vy: -.3, vz: (Math.random() - .5) * .06, life: 1.4 });
	}

	setParty(on) {
		this.party = on;
		if (on) {
			this.tone(523, .12, 'triangle', .06);
			this.tone(659, .12, 'triangle', .06);
			this.tone(784, .16, 'triangle', .06);
		}
	}

	mat(color, emissive, ei, opacity) {
		const THREE = window.THREE;
		const m = new THREE.MeshStandardMaterial({
			color, emissive, emissiveIntensity: ei,
			roughness: .5, metalness: .15,
		});
		if (opacity !== undefined) { m.transparent = true; m.opacity = opacity; }
		return m;
	}

	buildScene(mrs) {
		const THREE = window.THREE;
		while (this.rootGrp.children.length) this.rootGrp.remove(this.rootGrp.children[0]);
		this.meshMap = {}; this.entries = []; this.cardMeshes = []; this.pipeMeshes = []; this.hitMeshes = []; this.pulse = [];
		this.pops = []; this.confetti = []; this.bouncy.clear();
		store.selected = null; store.tooltip.visible = false;
		this.hideSel();
		if (!mrs || !mrs.length) return;
		if (!store.from_date || !store.to_date) return;

		const dark = store.isDark;
		const bg = dark ? 0x0c0e14 : 0xf0f2f5;
		this.scene.background.setHex(bg);
		this.scene.fog.color.setHex(bg);
		this.renderer.setClearColor(bg, 1);
		if (this.fl) this.fl.material.color.setHex(dark ? 0x0a0c12 : 0xcbd5e1);

		this.selLabel = this.makeLabel('', { size: .5, accent: true });
		this.selLabel.visible = false;
		this.rootGrp.add(this.selLabel);

		const fromN = dayNum(store.from_date), toN = dayNum(store.to_date);
		const totalDays = Math.max(1, toN - fromN + 1);
		const DAY_W = 3.4, ROW_H = 1.15;
		const X0 = -totalDays * DAY_W / 2;
		const dayCenter = i => X0 + (i + .5) * DAY_W;
		const xFor = n => X0 + (n - fromN + .5) * DAY_W;

		const todayN = dayNum((() => { const x = new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; })());
		const axisX1 = X0 + totalDays * DAY_W;
		const xc = (n) => clamp(xFor(n), X0 + .3, axisX1 - .3);

		const rows = mrs.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).reverse();
		const nRows = rows.length;
		const zTop = (nRows - 1) / 2 * ROW_H;
		const rowZ = r => zTop - r * ROW_H;
		const zBottom = rowZ(nRows - 1);

		const lineMat = this.mat(dark ? 0x1a1e2a : 0xadb9cc, 0x000000, 0);
		const gndMat = this.mat(dark ? 0x0e1017 : 0xd3dbe6, 0x000000, 0);
		const gnd = new THREE.Mesh(new THREE.BoxGeometry(totalDays * DAY_W + 2, .12, (nRows * ROW_H) + 8), gndMat);
		gnd.position.set(0, -0.06, 0);
		this.rootGrp.add(gnd);

		/* day boundary lines */
		for (let i = 0; i <= totalDays; i++) {
			const lx = X0 + i * DAY_W;
			const l = new THREE.Mesh(new THREE.BoxGeometry(.02, .3, (nRows * ROW_H) + 8), lineMat);
			l.position.set(lx, .1, 0);
			this.rootGrp.add(l);
		}

		/* weekend shading + day labels + month labels */
		const dayLabelEvery = totalDays <= 90 ? 1 : 7;
		const zDayLabel = zTop + 1.0, zMonthLabel = zTop + 2.2;
		let lastMonth = -1;
		for (let i = 0; i < totalDays; i++) {
			const d = dayDate(fromN + i);
			const wd = d.getUTCDay();
			const x = dayCenter(i);
			if (wd === 6 || wd === 0) {
				const cell = new THREE.Mesh(new THREE.BoxGeometry(DAY_W - .04, .06, (nRows * ROW_H) + 6), this.mat(dark ? 0x12141d : 0xb6c3d4, 0x000000, 0));
				cell.position.set(x, .015, 0);
				this.rootGrp.add(cell);
			}
			const mKey = d.getUTCFullYear() * 12 + d.getUTCMonth();
			if (mKey !== lastMonth) {
				lastMonth = mKey;
				const mline = new THREE.Mesh(new THREE.BoxGeometry(.08, .9, (nRows * ROW_H) + 8), this.mat(dark ? 0x3b82f6 : 0x2563eb, dark ? 0x3b82f6 : 0x2563eb, .25));
				mline.position.set(x, .45, 0);
				this.rootGrp.add(mline);
				const mlab = this.makeLabel(`${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, { size: .9, accent: true, color: dark ? '#93c5fd' : '#2563eb' });
				mlab.position.set(x, 1.15, zMonthLabel);
				mlab.renderOrder = 10;
				this.rootGrp.add(mlab);
			}
			if (i % dayLabelEvery === 0) {
				const lbl = this.makeLabel(String(d.getUTCDate()), {
					size: .52, pill: true,
					bg: dark ? 'rgba(15,18,26,.72)' : 'rgba(255,255,255,.85)',
					border: dark ? 'rgba(96,165,250,.25)' : 'rgba(37,99,235,.25)',
					color: dark ? '#e2e8f0' : '#334155',
				});
				lbl.position.set(x, .42, zDayLabel);
				lbl.renderOrder = 10;
				this.rootGrp.add(lbl);
			}
		}

		/* today marker */
		if (todayN >= fromN && todayN <= toN) {
			const tx = xFor(todayN);
			const tm = new THREE.Mesh(new THREE.BoxGeometry(.06, 1.4, (nRows * ROW_H) + 8), this.mat(0xf59e0b, 0xf59e0b, .5));
			tm.position.set(tx, .7, 0);
			this.rootGrp.add(tm);
			const tl = this.makeLabel('Today', { size: .5, accent: true });
			tl.position.set(tx, 1.15, zMonthLabel + 1.6);
			tl.renderOrder = 10;
			this.rootGrp.add(tl);
		}

		/* MR cards — each card is a little character in its own group */
		const emptyBlockMat = this.mat(dark ? 0x475569 : 0xcfd8e6, 0x000000, 0, dark ? .6 : .8);

		rows.forEach((m, r) => {
			const z = rowZ(r);
			const x = xc(dayNum(m.date));
			const complete = !!m.fully_received;
			const cardY = complete ? 1.0 : .62;
			const stages = [true, true, !!m.has_po, !!m.has_grv, complete];
			const firstUndone = stages.indexOf(false);
			const inProg = firstUndone;

			const g = new THREE.Group();
			g.position.set(x, 0, z);
			this.rootGrp.add(g);

			/* card is tinted with its current stage colour so status reads at a glance */
			const stageCol = hexOf(inProg >= 0 ? inProg : 4);
			const edge = new THREE.Mesh(new THREE.BoxGeometry(2.32, .62, .74),
				this.mat(dark ? blend(0x2b3350, stageCol, .32) : blend(0x9fb0c6, stageCol, .18), 0x000000, 0));
			edge.position.set(0, cardY, 0);
			edge.castShadow = true;
			g.add(edge);
			const cardMat = this.mat(dark ? blend(0x1a1e2a, stageCol, .42) : blend(0xffffff, stageCol, .24), 0x000000, 0);
			const card = new THREE.Mesh(new THREE.BoxGeometry(2.2, .5, .62), cardMat);
			card.position.set(0, cardY, 0);
			card.castShadow = true;
			card.userData = { key: m.material_request, entry: m, x, z, grp: g };
			g.add(card);
			this.cardMeshes.push(card);
			this.hitMeshes.push(card);
			this.meshMap[m.material_request] = { entry: m, rx: x, rz: z, grp: g, y: cardY };
			this.entries.push({ key: m.material_request, entry: m, rx: x, rz: z, y: cardY, grp: g });

			/* happy face + nametag on the front */
			const face = this.makeFace(m);
			face.position.set(0, cardY, .39);
			g.add(face);

			/* MR number floating in front of the card, on its left side (clear of the timeline bar) */
			const mrTxt = (m.material_requisition || m.material_request || '').trim();
			if (mrTxt) {
				const mrLbl = this.makeLabel(mrTxt.length > 14 ? mrTxt.slice(0, 13) + '…' : mrTxt, {
					size: .3, pill: true,
					bg: dark ? 'rgba(15,18,26,.85)' : 'rgba(255,255,255,.94)',
					border: dark ? 'rgba(96,165,250,.45)' : 'rgba(37,99,235,.4)',
					color: dark ? '#fff' : '#1f2937',
				});
				mrLbl.position.set(-1.7, cardY + .35, .5);
				mrLbl.renderOrder = 7;
				g.add(mrLbl);
			}

			/* stage candy coins */
			const COIN = .44, SPACE = .5;
			for (let s = 0; s < 5; s++) {
				const done = stages[s];
				const cx = (s - 2) * SPACE;
				const cy = cardY + .45;
				let mesh;
				if (done) {
					mesh = new THREE.Mesh(new THREE.BoxGeometry(COIN, COIN, .08), this.mat(hexOf(s), hexOf(s), .5));
				} else if (s === inProg) {
					mesh = new THREE.Mesh(new THREE.BoxGeometry(COIN, COIN, .08), this.mat(hexOf(s), hexOf(s), .55));
					this.pulse.push({ mesh });
				} else {
					mesh = new THREE.Mesh(new THREE.BoxGeometry(COIN, COIN, .06), emptyBlockMat);
				}
				mesh.position.set(cx, cy, 0);
				mesh.castShadow = true;
				g.add(mesh);
			}

			if (complete) {
				const tick = this.makeLabel('', { size: .38, glyph: 'check' });
				tick.position.set(0, cardY + .62, 0);
				g.add(tick);
			}

			/* mini timeline bar (group-relative) — one coloured span per journey stage.
			   Each reached stage gets its own colour, spanning the days elapsed for that step. */
			const stageD = [
				m.mr_date || m.date,
				m.date,
				m.has_po ? m.po_date : null,
				m.has_grv ? m.grv_date : null,
				m.fully_received ? (m.grv_date || m.date) : null,
			];
			const stageDone = [true, true, !!m.has_po, !!m.has_grv, !!m.fully_received];
			const stageX = stageD.map(d => (d ? xc(dayNum(d)) : null));
			const firstX = stageX[0];
			const todayX = (todayN >= fromN && todayN <= toN) ? xc(todayN) : null;
			let endX = firstX;
			stageX.forEach(v => { if (v != null && v > endX) endX = v; });
			if (todayX != null && todayX > endX) endX = todayX;
			endX = Math.max(endX, firstX + .18);
			const inProgIdx = stageDone.indexOf(false);
			const segs = [];
			let prevX = firstX, prevDate = stageD[0];
			for (let s = 0; s < 5; s++) {
				if (!stageDone[s] || stageX[s] == null) continue;
				const to = Math.max(stageX[s], prevX + .18);
				segs.push({ a: prevX, b: to, color: hexOf(s), days: s > 0 ? daysBetween(prevDate, stageD[s]) : 0 });
				prevX = Math.max(prevX, to); prevDate = stageD[s];
			}
			if (inProgIdx === -1) {
				/* all five steps done: green DONE span running to today */
				if (endX > prevX) segs.push({ a: prevX, b: endX, color: hexOf(4), days: null });
			} else {
				/* the current in-progress step: its colour, dimmer, running to today */
				const sx = stageX[inProgIdx] != null ? stageX[inProgIdx] : prevX;
				if (endX > sx) segs.push({ a: sx, b: endX, color: hexOf(inProgIdx), days: null });
			}
			segs.forEach(sg => {
				const wdt = Math.max(sg.b - sg.a, .18);
				const box = new THREE.Mesh(new THREE.BoxGeometry(wdt, .2, .34), this.mat(sg.color, sg.color, 1.2));
				box.position.set((sg.a + sg.b) / 2 - x, .16, 0);
				box.userData = { key: m.material_request };
				g.add(box);
				this.pipeMeshes.push(box);
				this.hitMeshes.push(box);
				/* day-count pill resting on the bar itself (not floating in front) */
				if (sg.days != null && sg.days > 0 && sg.b - sg.a > 1.1) {
					const dl = this.makeLabel('+' + sg.days + 'd', {
						size: .2, pill: true,
						bg: dark ? 'rgba(15,18,26,.7)' : 'rgba(255,255,255,.85)',
						border: 'rgba(255,255,255,0)',
						color: dark ? '#cbd5e1' : '#475569',
					});
					dl.position.set((sg.a + sg.b) / 2 - x, .27, 0);
					dl.renderOrder = 6;
					g.add(dl);
				}
			});

			/* bounce in from a tiny seed */
			g.scale.set(.01, .01, .01);
			this.pops.push({ grp: g, delay: r * .045, t: 0, done: false });
		});

		this._sceneX = totalDays * DAY_W;
		this._sceneZ = nRows * ROW_H;
		this._fitBox = new THREE.Box3().setFromObject(gnd);
		this._fitBox.expandByVector(new THREE.Vector3(0, 3, 0));
		this.fit();
		this.highlight(null);
	}

	highlight(key) {
		const THREE = window.THREE;
		this.cardMeshes.forEach(m => {
			const sel = m.userData.key === key;
			m.material.emissive.setHex(sel ? 0x60a5fa : 0x000000);
			m.material.emissiveIntensity = sel ? .35 : 0;
		});
	}

	/* floating label above the selected card: which step it is on in the 3D */
	showSel(entry) {
		if (!this.selLabel) return;
		const e = this.entries.find(x => x.entry === entry);
		if (!e) { this.hideSel(); return; }
		const idx = stepIndex(entry);
		this.setLabel(this.selLabel, `Step ${idx} of 5 · ${STAGES[idx - 1].label}`, { size: .5, accent: true });
		this.selLabel.position.set(e.rx, e.y + 1.7, e.rz);
		this.selLabel.visible = true;
	}

	hideSel() {
		if (this.selLabel) this.selLabel.visible = false;
	}

	fit() {
		const THREE = window.THREE;
		const box = this._fitBox || new THREE.Box3().setFromObject(this.rootGrp);
		const c = box.getCenter(new THREE.Vector3());
		const s = box.getSize(new THREE.Vector3());
		const r = Math.max(s.x, s.z) / 2 + s.y * 1.4;
		this.tPX = c.x; this.tPZ = c.z;
		this.tR = Math.max(10, r * 1.15);
		this.tP = .9;
		this.tT = .65;
		this.zoomKey = null;
	}

	/* start view: zoom onto the week containing today (fall back to the nearest edge) */
	focusWeek(todayN, fromN, toN, xc) {
		const focusN = (todayN >= fromN && todayN <= toN) ? todayN : clamp(todayN, fromN, toN);
		this.tPX = xc(focusN);
		this.tPZ = 0;
		this.tR = Math.max(12, 3.4 * 7 * 1.05);
		this.tP = .9;
		this.tT = .65;
		this.zoomKey = null;
	}

	focusBin(entry) {
		const e = this.entries.find(x => x.entry === entry);
		if (!e) return;
		this.tPX = e.rx; this.tPZ = e.rz;
		this.tR = 7; this.tP = .8;
	}

	/* double-tap / double-click tight zoom on a single card */
	focusCard(entry) {
		const e = this.entries.find(x => x.entry === entry);
		if (!e) return;
		this.zoomKey = e.key;
		this.tPX = e.rx; this.tPZ = e.rz;
		this.tR = 2.4; this.tP = .55;
	}

	/* raycast the card under a screen point; zoom in (or back out if it's the focused one) */
	_zoomAt(cx, cy) {
		const THREE = window.THREE;
		const cw = this.cwEl;
		const r = cw.getBoundingClientRect();
		const mouse = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
		const rc = new THREE.Raycaster();
		rc.setFromCamera(mouse, this.camera);
		const hits = rc.intersectObjects(this.hitMeshes);
		if (hits.length) {
			const key = hits[0].object.userData.key;
			const d = this.meshMap[key];
			if (this.zoomKey === key) {
				this.fit();
			} else {
				store.selected = d.entry;
				this.highlight(key);
				this.showSel(d.entry);
				this.focusCard(d.entry);
				this.burst(d.rx, d.y + .5, d.rz, 44);
				this.tone(660, .14, 'triangle', .05);
			}
		}
	}

	bindMouse() {
		const cw = this.cwEl;
		const rc = new THREE.Raycaster();
		const mouse = new THREE.Vector2();
		let ltX = 0, ltY = 0, ltD = 0;

		cw.addEventListener('mousedown', e => {
			this.drag = true; this.rDrag = e.button === 2;
			this.moved = false;
			this.lx = e.clientX; this.ly = e.clientY; e.preventDefault();
		});
		cw.addEventListener('contextmenu', e => e.preventDefault());
		window.addEventListener('mouseup', () => { this.drag = false; });
		window.addEventListener('mousemove', e => {
			if (!this.drag) return;
			this.moved = true;
			const dx = e.clientX - this.lx, dy = e.clientY - this.ly;
			this.lx = e.clientX; this.ly = e.clientY;
			if (this.rDrag) {
				this.tPX -= dx * .014 * Math.cos(this.theta);
				this.tPZ += dx * .014 * Math.sin(this.theta);
			} else {
				this.tT -= dx * .008;
				this.tP = clamp(this.tP + dy * .008, .12, 1.45);
			}
		});
		cw.addEventListener('wheel', e => {
			e.preventDefault();
			this.tR = clamp(this.tR + e.deltaY * .04, 2, 500);
		}, { passive: false });
		cw.addEventListener('touchstart', e => {
			this.moved = false;
			if (e.touches.length === 2) {
				this._tapT = 0;
				ltD = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
			} else {
				ltX = e.touches[0].clientX; ltY = e.touches[0].clientY;
				const now = Date.now();
				if (this._tapT && now - this._tapT < 320 && Math.hypot(ltX - this._tapX, ltY - this._tapY) < 40) {
					this._tapT = 0;
					this._justZoomed = now;
					if (this._clickTimer) { clearTimeout(this._clickTimer); this._clickTimer = null; }
					this._zoomAt(ltX, ltY);
				} else {
					this._tapT = now; this._tapX = ltX; this._tapY = ltY;
				}
			}
		}, { passive: true });
		cw.addEventListener('touchmove', e => {
			e.preventDefault();
			this.moved = true;
			this._tapT = 0;
			if (e.touches.length === 2) {
				const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
				this.tR = clamp(this.tR - (d - ltD) * .08, 2, 500); ltD = d;
			} else {
				const dx = e.touches[0].clientX - ltX, dy = e.touches[0].clientY - ltY;
				this.tT -= dx * .01; this.tP = clamp(this.tP + dy * .01, .12, 1.45);
				ltX = e.touches[0].clientX; ltY = e.touches[0].clientY;
			}
		}, { passive: false });

		cw.addEventListener('mousemove', e => {
			if (this.drag) { store.tooltip.visible = false; return; }
			const r = cw.getBoundingClientRect();
			mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
			rc.setFromCamera(mouse, this.camera);
			const hits = rc.intersectObjects(this.hitMeshes);
			if (hits.length) {
				const key = hits[0].object.userData.key;
				if (this.hovKey !== key) { this.hovKey = key; this.highlight(key); }
				const d = this.meshMap[key];
				store.tooltip = { x: e.clientX - r.left, y: e.clientY - r.top, visible: true, entry: d.entry };
				cw.style.cursor = 'pointer';
			} else {
				if (this.hovKey) { this.hovKey = null; this.highlight(null); }
				store.tooltip.visible = false;
				cw.style.cursor = 'grab';
			}
		});
		cw.addEventListener('click', e => {
			if (this.moved) return;
			if (this._justZoomed && Date.now() - this._justZoomed < 300) return; /* synthesized click after a double-tap */
			if (this._clickTimer) return; /* second click of a double-click */
			const r = cw.getBoundingClientRect();
			mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
			rc.setFromCamera(mouse, this.camera);
			const hits = rc.intersectObjects(this.hitMeshes);
			if (hits.length) {
				const key = hits[0].object.userData.key;
				const d = this.meshMap[key];
				if (!d) return;
				this._clickTimer = setTimeout(() => {
					this._clickTimer = null;
					store.selected = d.entry;
					this.highlight(key);
					this.showSel(d.entry);
					this.focusBin(d.entry);
					this.burst(d.rx, d.y + .5, d.rz, 44);
					this.tone(440, .1, 'triangle', .06);
					this.tone(660, .14, 'triangle', .05);
					if (d.grp) this.bouncy.set(d.entry.material_request, { t: 0, grp: d.grp });
				}, 240);
			} else {
				if (this._clickTimer) { clearTimeout(this._clickTimer); this._clickTimer = null; }
				store.selected = null;
				this.highlight(null);
				this.hideSel();
			}
		});
		cw.addEventListener('dblclick', e => {
			if (this.moved) return;
			if (this._clickTimer) { clearTimeout(this._clickTimer); this._clickTimer = null; }
			this._zoomAt(e.clientX, e.clientY);
			e.preventDefault();
		});
	}
}

const engine = new Engine();

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
		store.tooltip.visible = false;
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
			nextTick(() => { engine.buildScene(store.mrs); });
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
		engine.buildScene(store.mrs);
	},
	fit() { engine.fit(); },
	party() { store.party = !store.party; engine.setParty(store.party); },
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
	select(entry) {
		store.selected = entry;
		engine.highlight(entry.material_request);
		engine.showSel(entry);
		engine.focusBin(entry);
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

function hexOf(i) { return [COLORS.mr, COLORS.pr, COLORS.po, COLORS.grv, COLORS.done][i]; }

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
	setup() {
		onMounted(() => {
			const cw = document.getElementById('mr3d-cw');
			const canvas = document.getElementById('mr3d-c');
			if (cw && canvas) engine.init(canvas, cw);
			actions.init();
			document.addEventListener('keydown', onKey);
		});
		onUnmounted(() => document.removeEventListener('keydown', onKey));
		function onKey(e) {
			if (e.key === 'Escape') {
				store.selected = null;
				store.search = '';
				store.tooltip.visible = false;
				engine.highlight(null);
				engine.hideSel();
				engine.fit();
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
		return { store, engine, stats, rangeText, searchResults, actions, fmt, STAGES, journey, techStatus, stepIndex, docsOf, WEEKDAYS, onReqType, onCompany, onItemCode };
	},
	template: `
	<div id="mr3d-app" :class="store.isDark?'dark':'light'">
		<div class="mr3d-top">
			<div class="mr3d-title">🚚 Delivery Playground</div>
			<div class="mr3d-stats">
				<div class="mr3d-chip" v-if="stats.mr_count">🎁 <b>{{stats.mr_count}}</b> {{stats.mr_count === 1 ? 'request' : 'requests'}}</div>
			</div>
			<div class="mr3d-sp"></div>
			<div class="mr3d-nav">
				<button title="Look at an earlier week" @click="actions.nav(-7)">◀</button>
				<div class="range">{{rangeText}}</div>
				<button title="Look at a later week" @click="actions.nav(7)">▶</button>
			</div>
			<button class="mr3d-btn-big mr3d-btn-party" :class="store.party?'on':''" @click="actions.party()">🎉 Party</button>
			<button class="mr3d-round" :title="store.isDark?'Daytime':'Nighttime'" @click="actions.toggleTheme()">{{store.isDark?'☀️':'🌙'}}</button>
			<button class="mr3d-round" title="See everything" @click="actions.fit()">🔭</button>
			<button class="mr3d-btn-big" :class="store.grownUps?'on':''" @click="actions.toggleGrownUps()">{{store.grownUps?'🙈 Simple':'🔬 Details'}}</button>
		</div>

		<div class="mr3d-filters">
			<label>Type <select v-model="store.request_type" @change="onReqType()" title="Request type">
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

		<div id="mr3d-cw">
			<canvas id="mr3d-c"></canvas>
			<div class="mr3d-legend">
				<div class="lg">
					<span class="lg-t">Cards</span>
					<span><i style="background:#3b82f6"></i>MR</span>
					<span><i style="background:#8b5cf6"></i>PR</span>
					<span><i style="background:#f59e0b"></i>PO</span>
					<span><i style="background:#14b8a6"></i>GRV</span>
					<span><i style="background:#22c55e"></i>✓</span>
				</div>
				<div class="lg">
					<span class="lg-t">Pipe</span>
					<span><span class="bar" style="background:#3b82f6"></span>MR</span>
					<span><span class="bar" style="background:#8b5cf6"></span>PR</span>
					<span><span class="bar" style="background:#f59e0b"></span>PO</span>
					<span><span class="bar" style="background:#14b8a6"></span>GRV</span>
					<span><span class="bar" style="background:#22c55e"></span>✓</span>
				</div>
			</div>
			<div class="mr3d-hint">👆 Tap a card for its paperwork · Double-tap to zoom in / out</div>
			<div class="mr3d-tooltip" v-if="store.tooltip.visible" :style="{left:store.tooltip.x+'px', top:store.tooltip.y+'px'}">
				<b>{{store.tooltip.entry.material_requisition}}</b>
				<div class="row">
					<i :style="{background:STAGES[stepIndex(store.tooltip.entry)-1].color}"></i>
					<b>Step {{stepIndex(store.tooltip.entry)}} of 5</b>
				</div>
				<div class="row">{{techStatus(store.tooltip.entry)}} · {{store.tooltip.entry.material_request}}</div>
				<div class="row">{{store.tooltip.entry.item_count}} {{store.tooltip.entry.item_count === 1 ? 'item' : 'items'}} · {{store.tooltip.entry.project}}</div>
			</div>
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
				<span class="pill" :style="{background:STAGES[stepIndex(store.selected)-1].color}">Step {{stepIndex(store.selected)}} of 5</span>
				<span>{{techStatus(store.selected)}}</span>
			</div>
			<div class="kv"><span>📅 Date</span><b>{{store.selected.date}}</b></div>
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
					<a v-if="doc.name" @click.prevent="actions.openForm(doc.route, doc.name)">{{doc.display}}</a>
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
			<button class="mr3d-open" v-if="store.grownUps" @click="actions.openDoc(store.selected.material_request)">Open the Purchase Request ✏️</button>
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
})();
