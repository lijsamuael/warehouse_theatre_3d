/* Material Requisition 3D v0.2.0 — Vue 3 (CDN) + Three.js
   Visualizes the "Material Requisition Status" report as a 3D flow theatre:
   Lane = Project, station = Material Requisition, pipe = Item.
   Each pipe runs left→right through the fulfilment stages, with segments
   proportional to quantity (red to-order, amber ordered, green received)
   and glowing particles flowing through it.
   Depends on: Vue 3 global build + THREE (loaded before this script) */
(function () {
'use strict';

const { createApp, defineComponent, reactive, computed, onMounted, onUnmounted, nextTick } = Vue;

/* ─────────────────────────────────────────────────────────────
   HELPERS & CONSTANTS
───────────────────────────────────────────────────────────── */
const COLORS = { received: 0x4ade80, ordered: 0xfbbf24, toOrder: 0xf87171 };
const fmt = n => (parseFloat(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const API = 'warehouse_theatre_3d.warehouse_theatre_3d.api.';

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
const store = reactive({
	isDark: false,
	projects: [],
	loading: false,
	loaded: false,
	error: '',
	from_date: '',
	to_date: '',
	request_type: 'Material Requisition',
	company: '',
	companies: [],
	selected: null,
	tooltip: { x: 0, y: 0, visible: false, entry: null },
	search: '',
	maxQty: 1,
});

/* ─────────────────────────────────────────────────────────────
   CSS
───────────────────────────────────────────────────────────── */
const CSS = `
#mr3d-app.dark{--b:#0c0e14;--b2:#13151e;--b3:#1a1e2a;--bd:rgba(255,255,255,.08);--t:#fff;--t2:rgba(255,255,255,.65);--t3:rgba(255,255,255,.35);--card:rgba(255,255,255,.04);--cb:rgba(255,255,255,.08);--acc:#3b82f6;--acc2:#60a5fa}
#mr3d-app.light{--b:#f0f2f5;--b2:#fff;--b3:#f7f9fc;--bd:#e2e8f0;--t:#1a202c;--t2:#4a5568;--t3:#a0aec0;--card:#fff;--cb:#e2e8f0;--acc:#2563eb;--acc2:#3b82f6}
#mr3d-app{width:100%;height:100%;display:flex;flex-direction:column;background:var(--b);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12.5px;color:var(--t);position:relative;overflow:hidden;transition:background .3s}
#mr3d-cw{flex:1;position:relative;min-height:0}
#mr3d-c{display:block;width:100%;height:100%}
.mr3d-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--bd);background:var(--b2);z-index:20}
.mr3d-title{font-weight:700;font-size:13px;color:var(--acc2);margin-right:6px}
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
.mr3d-search input{height:26px;width:190px;border:1px solid var(--bd);background:var(--b3);color:var(--t);border-radius:6px;padding:0 8px;font-size:12px;outline:none}
.mr3d-search input:focus{border-color:var(--acc2)}
.mr3d-drop{position:absolute;top:30px;right:0;width:320px;max-height:340px;overflow:auto;background:var(--b2);border:1px solid var(--bd);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:40}
.mr3d-drop-item{padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--bd);display:flex;flex-direction:column;gap:1px}
.mr3d-drop-item:hover{background:var(--cb)}
.mr3d-drop-item .d1{font-weight:600;color:var(--t)}
.mr3d-drop-item .d2{color:var(--t3);font-size:11px}
.mr3d-legend{position:absolute;bottom:12px;left:12px;display:flex;gap:14px;align-items:center;background:var(--b2);border:1px solid var(--bd);border-radius:8px;padding:7px 12px;z-index:15;box-shadow:0 4px 14px rgba(0,0,0,.12)}
.mr3d-legend span{display:flex;align-items:center;gap:6px;color:var(--t2);white-space:nowrap}
.mr3d-legend i{width:11px;height:11px;border-radius:3px;display:inline-block}
.mr3d-hint{position:absolute;bottom:12px;right:12px;color:var(--t3);font-size:11px;z-index:15}
.mr3d-tooltip{position:absolute;background:var(--b2);border:1px solid var(--bd);border-radius:8px;padding:8px 11px;font-size:11.5px;color:var(--t2);pointer-events:none;z-index:30;box-shadow:0 6px 20px rgba(0,0,0,.22);max-width:240px}
.mr3d-tooltip b{color:var(--t);font-weight:600}
.mr3d-tooltip .row{display:flex;align-items:center;gap:6px;margin-top:3px}
.mr3d-tooltip i{width:9px;height:9px;border-radius:2px;display:inline-block}
.mr3d-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--b);z-index:50}
.mr3d-spinner{width:34px;height:34px;border-radius:50%;border:3px solid var(--bd);border-top-color:var(--acc2);animation:mr3dspin .8s linear infinite}
@keyframes mr3dspin{to{transform:rotate(360deg)}}
.mr3d-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--t3);background:var(--b);z-index:45;font-size:13px}
.mr3d-empty b{color:var(--t2)}
.mr3d-dp{position:absolute;top:56px;right:12px;width:320px;max-height:calc(100% - 120px);overflow:auto;background:var(--b2);border:1px solid var(--bd);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.3);z-index:25;padding:14px 16px;font-size:12px}
.mr3d-dp h3{margin:0 0 4px;font-size:13.5px;color:var(--t)}
.mr3d-dp .sub{color:var(--t3);font-size:11px;margin-bottom:10px}
.mr3d-dp .kv{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid var(--bd);color:var(--t2)}
.mr3d-dp .kv b{color:var(--t);font-weight:600;text-align:right}
.mr3d-bar{display:flex;height:12px;border-radius:4px;overflow:hidden;margin:10px 0;border:1px solid var(--bd)}
.mr3d-bar div{height:100%}
.mr3d-links{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.mr3d-link{display:inline-block;padding:3px 8px;border-radius:6px;border:1px solid var(--acc2);color:var(--acc2);text-decoration:none;font-size:11px}
.mr3d-link:hover{background:var(--acc);border-color:var(--acc);color:#fff}
.mr3d-open{margin-top:10px;width:100%;height:28px;border-radius:6px;border:none;background:var(--acc);color:#fff;font-weight:600;cursor:pointer}
.mr3d-open:hover{background:var(--acc2)}
`;

/* ─────────────────────────────────────────────────────────────
   THREE.JS ENGINE
───────────────────────────────────────────────────────────── */
class Engine {
	constructor() {
		this.meshMap = {};
		this.blockMeshes = [];
		this.offsets = {};
		this.entries = [];
		this.particles = [];
		this.theta = .65; this.phi = .85; this.radius = 30; this.panX = 0; this.panZ = 0;
		this.tT = .65; this.tP = .85; this.tR = 30; this.tPX = 0; this.tPZ = 0;
		this.drag = false; this.rDrag = false; this.lx = 0; this.ly = 0;
		this.hovKey = null; this._anim = false;
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
		this.scene.fog = new THREE.Fog(bg, 60, 160);
		this.camera = new THREE.PerspectiveCamera(45, 1, .1, 300);
		this.scene.add(new THREE.AmbientLight(0xffffff, .45));
		const dL = new THREE.DirectionalLight(0xffffff, .85);
		dL.position.set(18, 30, 14); dL.castShadow = true;
		dL.shadow.mapSize.set(2048, 2048);
		dL.shadow.camera.left = -40; dL.shadow.camera.right = 40;
		dL.shadow.camera.top = 40; dL.shadow.camera.bottom = -40;
		dL.shadow.camera.far = 120;
		this.scene.add(dL);
		const fL = new THREE.DirectionalLight(0x4060ff, .22);
		fL.position.set(-12, 8, -12); this.scene.add(fL);
		this.ptL = new THREE.PointLight(0x60a5fa, .5, 80);
		this.ptL.position.set(0, 20, 0); this.scene.add(this.ptL);
		this.fl = new THREE.Mesh(
			new THREE.PlaneGeometry(160, 160),
			new THREE.MeshStandardMaterial({ color: store.isDark ? 0x0a0c12 : 0xe8ebef, roughness: .95, metalness: .05 })
		);
		this.fl.rotation.x = -Math.PI / 2; this.fl.position.y = -0.03; this.fl.receiveShadow = true;
		this.scene.add(this.fl);
		const gc = store.isDark ? 0x181c28 : 0xd4d9df;
		this.grid = new THREE.GridHelper(160, 80, gc, gc);
		this.scene.add(this.grid);
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
			this.theta += (this.tT - this.theta) * .08;
			this.phi += (this.tP - this.phi) * .08;
			this.radius += (this.tR - this.radius) * .08;
			this.panX += (this.tPX - this.panX) * .08;
			this.panZ += (this.tPZ - this.panZ) * .08;
			this.camera.position.set(
				this.panX + this.radius * Math.sin(this.phi) * Math.sin(this.theta),
				this.radius * Math.cos(this.phi),
				this.panZ + this.radius * Math.sin(this.phi) * Math.cos(this.theta)
			);
			this.camera.lookAt(this.panX, 0, this.panZ);
			this.ptL.position.x = Math.sin(t * .3) * 9;
			this.ptL.position.z = Math.cos(t * .3) * 9;
			this.particles.forEach(pt => {
				const off = (t * pt.speed + pt.phase) % pt.len;
				pt.mesh.position.set(pt.x0 + pt.dir * off, pt.y, pt.z);
			});
			this.renderer.render(this.scene, this.camera);
		};
		loop();
	}

	makeLabel(text, { size = 1, accent = false, dark = store.isDark }) {
		const THREE = window.THREE;
		const dpr = 2, fontPx = 40, pad = 22;
		const cvs = document.createElement('canvas');
		const ctx = cvs.getContext('2d');
		ctx.font = `700 ${fontPx}px Inter, -apple-system, Segoe UI, Roboto, sans-serif`;
		const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
		const h = fontPx + pad * 2;
		cvs.width = w * dpr; cvs.height = h * dpr;
		ctx.scale(dpr, dpr);
		ctx.fillStyle = accent ? (dark ? 'rgba(30,38,58,.94)' : 'rgba(255,255,255,.96)') : 'rgba(0,0,0,0)';
		roundRect(ctx, 0, 0, w, h, h / 2); ctx.fill();
		ctx.strokeStyle = accent ? (dark ? 'rgba(96,165,250,.55)' : 'rgba(37,99,235,.4)') : 'rgba(0,0,0,0)';
		ctx.lineWidth = 3; roundRect(ctx, 0, 0, w, h, h / 2); ctx.stroke();
		ctx.fillStyle = accent ? (dark ? '#fff' : '#111827') : (dark ? '#cbd5e1' : '#374151');
		ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
		ctx.font = `700 ${fontPx}px Inter, -apple-system, Segoe UI, Roboto, sans-serif`;
		ctx.fillText(text, w / 2, pad + fontPx / 2);
		const tex = new THREE.CanvasTexture(cvs);
		tex.anisotropy = 4;
		const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
		const sc = size / fontPx;
		sp.scale.set(w * sc, h * sc, 1);
		return sp;
	}

	buildScene(projects) {
		const THREE = window.THREE;
		while (this.rootGrp.children.length) this.rootGrp.remove(this.rootGrp.children[0]);
		this.meshMap = {}; this.blockMeshes = []; this.offsets = {}; this.entries = []; this.particles = [];
		store.selected = null; store.tooltip.visible = false;
		if (!projects || !projects.length) {
			this.highlight(null);
			return;
		}
		store.maxQty = 1;
		projects.forEach(p => p.mrs.forEach(m => m.items.forEach(it => { if (it.qty > store.maxQty) store.maxQty = it.qty; })));

		const dark = store.isDark;
		const bg = dark ? 0x0c0e14 : 0xf0f2f5;
		this.scene.background.setHex(bg);
		this.scene.fog.color.setHex(bg);
		this.renderer.setClearColor(bg, 1);
		if (this.fl) this.fl.material.color.setHex(dark ? 0x0a0c12 : 0xe8ebef);
		if (this.grid) this.grid.material.color.setHex(dark ? 0x181c28 : 0xd4d9df);

		const PIPE_LEN = 2.2, PIPE_H = .4, PIPE_D = .4, ITEM_Y = .7, BASE_Y = .35;
		const MR_PITCH = PIPE_LEN + .9, MR_PER_ROW = 10, ROW_Z = 3.1;
		const ITEM_COLS = 3, ITEM_Z = PIPE_D + .45;
		const MIN_SEG = .05;

		const lanes = projects.map(p => {
			const maxItems = Math.max(1, ...p.mrs.map(m => m.items.length));
			const rows = Math.max(1, Math.ceil(p.mrs.length / MR_PER_ROW));
			const laneLen = Math.min(p.mrs.length, MR_PER_ROW) * MR_PITCH;
			const laneDepth = rows * ROW_Z;
			const placed = p.mrs.map((m, i) => {
				const row = Math.floor(i / MR_PER_ROW);
				const col = i % MR_PER_ROW;
				const forward = row % 2 === 0;
				const colPos = forward ? col : (MR_PER_ROW - 1 - col);
				return {
					mr: m, row, forward,
					x: -laneLen / 2 + colPos * MR_PITCH + PIPE_LEN / 2,
					z: -laneDepth / 2 + row * ROW_Z + ROW_Z / 2,
				};
			});
			return { p, maxItems, placed, laneLen, laneDepth, rows };
		});

		const n = lanes.length;
		const gridCols = Math.max(1, Math.ceil(Math.sqrt(n)));
		const gridRows = Math.ceil(n / gridCols);
		const cellW = Math.max(...lanes.map(l => l.laneLen)) + 4;
		const cellD = Math.max(...lanes.map(l => l.laneDepth)) + 3.5;

		const channelMat = new THREE.MeshStandardMaterial({ color: dark ? 0x1a1e2a : 0xe2e8f0, roughness: .85, metalness: .15 });
		const railMat = new THREE.MeshStandardMaterial({ color: dark ? 0x242b3d : 0xcbd5e1, roughness: .6, metalness: .35 });
		const arrowMat = new THREE.MeshStandardMaterial({ color: dark ? 0x60a5fa : 0x3b82f6, roughness: .4, metalness: .2 });
		const capMat = new THREE.MeshStandardMaterial({ color: dark ? 0x64748b : 0x94a3b8, roughness: .4, metalness: .6 });

		lanes.forEach((l, li) => {
			const lx = -cellW * gridCols / 2 + cellW * (li % gridCols) + cellW / 2;
			const lz = -cellD * gridRows / 2 + cellD * Math.floor(li / gridCols) + cellD / 2;
			const floorW = l.laneLen + .8, floorD = l.laneDepth + .9;

			const floor = new THREE.Mesh(new THREE.BoxGeometry(floorW, .12, floorD), channelMat);
			floor.position.set(lx, .06, lz); floor.receiveShadow = true;
			this.rootGrp.add(floor);

			const railLen = floorW;
			[-1, 1].forEach(s => {
				const rail = new THREE.Mesh(new THREE.BoxGeometry(railLen, .16, .07), railMat);
				rail.position.set(lx, .12, lz + s * (floorD / 2 + .04)); rail.castShadow = true;
				this.rootGrp.add(rail);
			});

			for (let r = 0; r < l.rows; r++) {
				const forward = r % 2 === 0;
				const z = -l.laneDepth / 2 + r * ROW_Z + ROW_Z / 2;
				const cone = new THREE.Mesh(new THREE.ConeGeometry(.14, .34, 6), arrowMat);
				cone.rotation.z = forward ? -Math.PI / 2 : Math.PI / 2;
				cone.position.set(lx + (forward ? -l.laneLen / 2 - .1 : l.laneLen / 2 + .1), .2, lz + z);
				this.rootGrp.add(cone);
			}

			const lbl = this.makeLabel(l.p.name, { size: .58, accent: true });
			lbl.position.set(lx, .8, lz - l.laneDepth / 2 - 1);
			this.rootGrp.add(lbl);
			const subl = this.makeLabel(`${l.p.stats.mr_count} MR · ${l.p.stats.item_count} items · ${fmt(l.p.stats.qty)} qty`, { size: .3 });
			subl.position.set(lx, .46, lz - l.laneDepth / 2 - 1);
			this.rootGrp.add(subl);

			l.placed.forEach(pl => {
				const rows = Math.ceil(pl.mr.items.length / ITEM_COLS);
				const stackTop = BASE_Y + rows * ITEM_Y;
				pl.mr.items.forEach((it, ii) => {
					const col = ii % ITEM_COLS, row = Math.floor(ii / ITEM_COLS);
					const zOff = (col - (ITEM_COLS - 1) / 2) * ITEM_Z;
					this.buildPipe(lx + pl.x, lz + pl.z + zOff, BASE_Y + row * ITEM_Y, it, l.p.name, pl.mr, capMat, pl.forward ? 1 : -1, PIPE_LEN, PIPE_H, PIPE_D, MIN_SEG);
				});
				const mlabel = this.makeLabel(pl.mr.material_requisition, { size: .3 });
				mlabel.position.set(lx + pl.x, stackTop + .7, lz + pl.z);
				this.rootGrp.add(mlabel);
			});
		});

		this.fit();
		this.highlight(null);
	}

	buildPipe(px, pz, py, item, projectName, mr, capMat, dir, PIPE_LEN, PIPE_H, PIPE_D, MIN_SEG) {
		const THREE = window.THREE;
		const entry = { project: projectName, mr, item };
		const key = mr.material_requisition + '|' + item.item_code;

		const rec = Math.max(0, Math.min(item.received_qty, item.ordered_qty));
		const ordRest = Math.max(0, item.ordered_qty - rec);
		const toOrd = Math.max(0, item.qty - item.ordered_qty);
		const segs = [
			{ q: toOrd, c: COLORS.toOrder },
			{ q: ordRest, c: COLORS.ordered },
			{ q: rec, c: COLORS.received },
		];
		let lens = segs.map(s => Math.max(MIN_SEG, item.qty > 0 ? (s.q / item.qty) * PIPE_LEN : 0));
		const tot = lens.reduce((a, b) => a + b, 0);
		if (tot > PIPE_LEN) lens = lens.map(l => l * PIPE_LEN / tot);

		let x = px - dir * PIPE_LEN / 2;
		lens.forEach((l, i) => {
			if (!(l > 0)) return;
			const m = new THREE.Mesh(
				new THREE.BoxGeometry(l, PIPE_H, PIPE_D),
				new THREE.MeshStandardMaterial({ color: segs[i].c, roughness: .35, metalness: .15, emissive: segs[i].c, emissiveIntensity: .22 })
			);
			m.position.set(x + dir * l / 2, py, pz);
			m.castShadow = true;
			m.userData = { key, color: segs[i].c };
			this.rootGrp.add(m);
			this.blockMeshes.push(m);
			x += dir * l;
		});

		[0, PIPE_LEN].forEach(ox => {
			const cap = new THREE.Mesh(new THREE.CylinderGeometry(PIPE_H / 2 + .02, PIPE_H / 2 + .02, .1, 20), capMat);
			cap.rotation.z = Math.PI / 2;
			cap.position.set(px - PIPE_LEN / 2 + ox, py, pz);
			this.rootGrp.add(cap);
		});

		const proxy = new THREE.Mesh(
			new THREE.BoxGeometry(PIPE_LEN, PIPE_H, PIPE_D),
			new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
		);
		proxy.position.set(px, py, pz);
		proxy.userData = { key, entry };
		this.rootGrp.add(proxy);
		this.meshMap[key] = { proxy, entry, rx: px, rz: pz };
		this.entries.push({ key, entry, rx: px, rz: pz, y: py, shelfH: PIPE_H });

		const domColor = lens[0] > lens[1] && lens[0] > lens[2] ? COLORS.toOrder : lens[1] > lens[2] ? COLORS.ordered : COLORS.received;
		const count = clamp(Math.round(Math.log(1 + item.qty) * 1.5), 1, 3);
		for (let i = 0; i < count; i++) {
			const pm = new THREE.Mesh(
				new THREE.SphereGeometry(.07, 8, 8),
				new THREE.MeshBasicMaterial({ color: domColor, transparent: true, opacity: .95 })
			);
			pm.position.set(px, py, pz);
			this.rootGrp.add(pm);
			this.particles.push({
				mesh: pm, x0: px + dir * (PIPE_LEN / 2 - .1), dir, len: PIPE_LEN - .2,
				phase: (i / count) * (PIPE_LEN - .2),
				speed: .8 + Math.random() * .6, y: py, z: pz,
			});
		}
	}

	highlight(key) {
		this.blockMeshes.forEach(m => {
			const sel = m.userData.key === key;
			m.material.emissive.setHex(sel ? 0xffffff : m.userData.color);
			m.material.emissiveIntensity = sel ? .95 : .22;
		});
	}

	fit() {
		const box = new THREE.Box3().setFromObject(this.rootGrp);
		const c = box.getCenter(new THREE.Vector3());
		const s = box.getSize(new THREE.Vector3());
		const r = Math.max(s.x, s.z) / 2 + s.y * 1.6;
		this.tPX = c.x; this.tPZ = c.z;
		this.tR = Math.max(8, r * 1.35);
		this.tP = .95;
		this.tT = .65;
	}

	focusBin(entry) {
		const e = this.entries.find(x => x.entry === entry);
		if (!e) return;
		this.tPX = e.rx; this.tPZ = e.rz;
		this.tR = 5.2; this.tP = .8;
	}

	bindMouse() {
		const cw = this.cwEl;
		const rc = new THREE.Raycaster();
		const mouse = new THREE.Vector2();
		let ltX = 0, ltY = 0, ltD = 0;

		cw.addEventListener('mousedown', e => {
			this.drag = true; this.rDrag = e.button === 2;
			this.lx = e.clientX; this.ly = e.clientY; e.preventDefault();
		});
		cw.addEventListener('contextmenu', e => e.preventDefault());
		window.addEventListener('mouseup', () => { this.drag = false; });
		window.addEventListener('mousemove', e => {
			if (!this.drag) return;
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
			this.tR = clamp(this.tR + e.deltaY * .04, 5, 120);
		}, { passive: false });
		cw.addEventListener('touchstart', e => {
			if (e.touches.length === 2) {
				ltD = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
			} else { ltX = e.touches[0].clientX; ltY = e.touches[0].clientY; }
		}, { passive: true });
		cw.addEventListener('touchmove', e => {
			e.preventDefault();
			if (e.touches.length === 2) {
				const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
				this.tR = clamp(this.tR - (d - ltD) * .08, 5, 120); ltD = d;
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
			const hits = rc.intersectObjects(Object.values(this.meshMap).map(d => d.proxy));
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
			const r = cw.getBoundingClientRect();
			mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
			rc.setFromCamera(mouse, this.camera);
			const hits = rc.intersectObjects(Object.values(this.meshMap).map(d => d.proxy));
			if (hits.length) {
				const d = this.meshMap[hits[0].object.userData.key];
				store.selected = d.entry;
				this.highlight(hits[0].object.userData.key);
				this.focusBin(d.entry);
			} else {
				store.selected = null;
				this.highlight(null);
			}
		});
	}
}

const engine = new Engine();

/* ─────────────────────────────────────────────────────────────
   ACTIONS
───────────────────────────────────────────────────────────── */
function defaultDates() {
	const t = new Date();
	const to = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
	t.setFullYear(t.getFullYear() - 1);
	const from = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
	return { from, to };
}

const actions = {
	async init() {
		try { store.companies = await call('api.get_companies'); } catch (e) { store.companies = []; }
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
				}),
			});
			store.projects = res.projects || [];
			store.loaded = true;
			nextTick(() => { if (store.projects.length) engine.buildScene(store.projects); });
		} catch (e) {
			store.error = (e && e.message) || String(e);
			store.projects = [];
		} finally {
			store.loading = false;
		}
	},
	toggleTheme() {
		store.isDark = !store.isDark;
		if (store.projects.length) engine.buildScene(store.projects);
	},
	fit() { engine.fit(); },
	select(entry) {
		store.selected = entry;
		engine.highlight(entry.mr.material_requisition + '|' + entry.item.item_code);
		engine.focusBin(entry);
	},
	clearSearch() { store.search = ''; },
	openDoc(name) {
		if (window.frappe) frappe.set_route('Form', 'Material Request', name);
		else window.open('/app/material-request/' + name, '_blank');
	},
};

/* ─────────────────────────────────────────────────────────────
   VUE APP
───────────────────────────────────────────────────────────── */
const allItems = computed(() => {
	const out = [];
	store.projects.forEach(p => p.mrs.forEach(m => m.items.forEach(it => out.push({ project: p, mr: m, item: it }))));
	return out;
});

const searchResults = computed(() => {
	const q = (store.search || '').trim().toLowerCase();
	if (!q) return [];
	return allItems.value
		.filter(e => (e.item.item_code || '').toLowerCase().includes(q) || (e.item.item_name || '').toLowerCase().includes(q))
		.slice(0, 40);
});

const stats = computed(() => {
	let mr = 0, it = 0, qty = 0, rec = 0, ord = 0, toOrd = 0;
	store.projects.forEach(p => {
		mr += p.stats.mr_count; it += p.stats.item_count;
		qty += p.stats.qty; rec += p.stats.received_qty;
		ord += p.stats.ordered_qty; toOrd += p.stats.qty_to_order;
	});
	return { projects: store.projects.length, mr, it, qty, rec, ord, toOrd };
});

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
			}
		}
		function pct(v) { return clamp((parseFloat(v) || 0) / (store.selected?.item.qty || 1), 0, 1) * 100; }
		return { store, stats, searchResults, actions, fmt, pct };
	},
	template: `
	<div id="mr3d-app" :class="store.isDark?'dark':'light'">
		<div class="mr3d-top">
			<div class="mr3d-title">Material Requisition 3D</div>
			<div class="mr3d-stats">
				<div class="mr3d-chip">Projects <b>{{stats.projects}}</b></div>
				<div class="mr3d-chip">MRs <b>{{stats.mr}}</b></div>
				<div class="mr3d-chip">Items <b>{{stats.it}}</b></div>
				<div class="mr3d-chip">Qty <b>{{fmt(stats.qty)}}</b></div>
				<div class="mr3d-chip"><span class="dot" style="background:#4ade80"></span>Received <b>{{fmt(stats.rec)}}</b></div>
				<div class="mr3d-chip"><span class="dot" style="background:#fbbf24"></span>Ordered <b>{{fmt(stats.ord)}}</b></div>
				<div class="mr3d-chip"><span class="dot" style="background:#f87171"></span>To Order <b>{{fmt(stats.toOrd)}}</b></div>
			</div>
			<div class="mr3d-sp"></div>
			<div class="mr3d-f">
				<input type="date" v-model="store.from_date" title="From">
				<input type="date" v-model="store.to_date" title="To">
				<select v-model="store.request_type">
					<option>Material Requisition</option>
					<option>Fuel Request</option>
					<option>Fixed Asset Request</option>
				</select>
				<select v-model="store.company">
					<option value="">All companies</option>
					<option v-for="c in store.companies" :key="c.name" :value="c.name">{{c.name}}</option>
				</select>
				<button class="mr3d-btn mr3d-btn-primary" :disabled="store.loading" @click="actions.load()">{{store.loading?'Loading…':'Load'}}</button>
				<button class="mr3d-btn" @click="actions.toggleTheme()">{{store.isDark?'Light':'Dark'}}</button>
				<button class="mr3d-btn" @click="actions.fit()">Fit</button>
				<div class="mr3d-search">
					<input v-model="store.search" placeholder="Search item / code…" @keydown.esc="actions.clearSearch()">
					<div class="mr3d-drop" v-if="searchResults.length">
						<div class="mr3d-drop-item" v-for="(r,i) in searchResults" :key="i" @click="actions.select(r)">
							<div class="d1">{{r.item.item_code}} — {{r.item.item_name}}</div>
							<div class="d2">{{r.mr.material_requisition}} · {{r.project.name}} · Qty {{fmt(r.item.qty)}}</div>
						</div>
					</div>
				</div>
			</div>
		</div>

		<div id="mr3d-cw">
			<canvas id="mr3d-c"></canvas>
			<div class="mr3d-legend">
				<span><i style="background:#4ade80"></i>Received</span>
				<span><i style="background:#fbbf24"></i>Ordered</span>
				<span><i style="background:#f87171"></i>To order</span>
			</div>
			<div class="mr3d-hint">Drag to orbit · Right-drag to pan · Scroll to zoom · Click an item</div>
			<div class="mr3d-tooltip" v-if="store.tooltip.visible" :style="{left:store.tooltip.x+'px', top:store.tooltip.y+'px'}">
				<b>{{store.tooltip.entry.item.item_code}}</b>
				<div>{{store.tooltip.entry.item.item_name}}</div>
				<div class="row"><i style="background:#4ade80"></i>Received {{fmt(store.tooltip.entry.item.received_qty)}}</div>
				<div class="row"><i style="background:#fbbf24"></i>Ordered {{fmt(store.tooltip.entry.item.ordered_qty)}}</div>
				<div class="row"><i style="background:#f87171"></i>To order {{fmt(store.tooltip.entry.item.qty_to_order)}}</div>
			</div>
			<div class="mr3d-loading" v-if="store.loading">
				<div class="mr3d-spinner"></div>
				<div>Loading material requisitions…</div>
			</div>
			<div class="mr3d-empty" v-else-if="store.error || (store.loaded && !store.projects.length)">
				<b>{{store.error ? 'Something went wrong' : 'No data for these filters'}}</b>
				<div>{{store.error || 'Try a different date range or request type.'}}</div>
			</div>
		</div>

		<div class="mr3d-dp" v-if="store.selected">
			<h3>{{store.selected.item.item_code}} — {{store.selected.item.item_name}}</h3>
			<div class="sub">{{store.selected.item.description}}</div>
			<div class="kv"><span>Project</span><b>{{store.selected.project.name}}</b></div>
			<div class="kv"><span>{{store.request_type}}</span><b>{{store.selected.mr.material_requisition}}</b></div>
			<div class="kv"><span>Material Request</span><b>{{store.selected.mr.material_request}}</b></div>
			<div class="kv"><span>Required By</span><b>{{store.selected.item.required_date}}</b></div>
			<div class="kv"><span>UOM</span><b>{{store.selected.item.uom}}</b></div>
			<div class="mr3d-bar">
				<div :style="{width:pct(store.selected.item.received_qty)+'%',background:'#4ade80'}" :title="'Received '+fmt(store.selected.item.received_qty)"></div>
				<div :style="{width:pct(Math.max(0,store.selected.item.ordered_qty-store.selected.item.received_qty))+'%',background:'#fbbf24'}"></div>
				<div :style="{width:pct(Math.max(0,store.selected.item.qty-store.selected.item.ordered_qty))+'%',background:'#f87171'}"></div>
			</div>
			<div class="kv"><span>Requested</span><b>{{fmt(store.selected.item.qty)}} {{store.selected.item.uom}}</b></div>
			<div class="kv"><span>Received</span><b style="color:#4ade80">{{fmt(store.selected.item.received_qty)}}</b></div>
			<div class="kv"><span>Ordered</span><b style="color:#fbbf24">{{fmt(store.selected.item.ordered_qty)}}</b></div>
			<div class="kv"><span>To order</span><b style="color:#f87171">{{fmt(store.selected.item.qty_to_order)}}</b></div>
			<div class="kv"><span>To receive</span><b>{{fmt(store.selected.item.qty_to_receive)}}</b></div>
			<div class="mr3d-links" v-if="store.selected.item.purchase_orders.length">
				<a class="mr3d-link" v-for="po in store.selected.item.purchase_orders" :key="po" :href="'/app/purchase-order/'+po" target="_blank">{{po}}</a>
			</div>
			<div class="mr3d-links" v-if="store.selected.item.purchase_receipts.length">
				<a class="mr3d-link" v-for="pr in store.selected.item.purchase_receipts" :key="pr" :href="'/app/purchase-receipt/'+pr" target="_blank">{{pr}}</a>
			</div>
			<button class="mr3d-open" @click="actions.openDoc(store.selected.mr.material_request)">Open Material Request</button>
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
