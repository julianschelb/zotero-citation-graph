/* Citation Graph — the plugin object.
 *
 * Registers the menus, the item-pane section and the settings pane, opens the
 * graph in a Zotero tab, builds the graph data from Zotero items plus the
 * resolver's cache, and exposes a small "host" API to the page in the iframe.
 */

/* global Zotero, Services, IOUtils, PathUtils, CitationGraphResolver */

"use strict";

var CitationGraph = {
	pluginID: "citation-graph@julianschelb.github.io",
	TAB_TYPE: "citationgraph",          // no "-" allowed: Zotero splits tab types on it
	PALETTE: ["#2563a8", "#b45309", "#0d9488", "#7c3aed", "#be185d", "#4d7c0f", "#c2410c", "#a16207", "#0e7490", "#9333ea", "#dc2626", "#6b7280"],

	id: null,
	version: null,
	rootURI: null,
	_menuIDs: [],
	_paneID: null,
	_prefPaneID: null,
	_tabs: new Map(),
	_windows: new Set(),

	log(msg) {
		Zotero.debug(`Citation Graph: ${msg}`);
	},

	pref(name, fallback) {
		let value = Zotero.Prefs.get(`citationgraph.${name}`);
		return value === undefined || value === null || value === "" ? fallback : value;
	},

	resolver() {
		return CitationGraphResolver;
	},

	// ------------------------------------------------------------------ lifecycle
	async startup({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this._egoFrames = new Set();
		this._onMessage = event => this.handleMessage(event);
		Zotero.CitationGraph = this;                       // reachable from the settings pane
		// Tabs of our type must not be restored from a previous session: Zotero has no restore
		// hook for them and would stop restoring the remaining tabs.
		Zotero.initializationPromise.then(() => this.scrubSessionState()).catch(e => Zotero.logError(e));
		let errors = [];
		let step = async (name, fn) => {
			try {
				await fn();
			}
			catch (e) {
				errors.push(`${name}: ${e && e.message ? e.message : e}`);
				Zotero.logError(e);
			}
		};
		await step("cache", () => CitationGraphResolver.load());
		await step("menus", () => this.registerMenus());
		await step("section", () => this.registerSection());
		await step("preferences", () => this.registerPrefPane());
		for (let win of Zotero.getMainWindows()) {
			this.onMainWindowLoad(win);
		}
		this.log(`started ${version}, ${CitationGraphResolver.size} cached items${errors.length ? `, errors: ${errors.join("; ")}` : ""}`);
		await this.writeStatus(errors);
		if (this.pref("selfTest", false)) {
			Zotero.uiReadyPromise.then(() => this.selfTest()).catch(e => Zotero.logError(e));
		}
	},

	/**
	 * End-to-end check for developers (pref extensions.zotero.citationgraph.selfTest = true, use a throwaway
	 * profile): creates three items in a test collection, fetches their citations, builds the graphs, opens
	 * the tab, selects an item so the pane section renders, and writes <data dir>/citation-graph/selftest.json.
	 */
	async selfTest() {
		let report = { started: new Date().toISOString(), steps: [] };
		let ok = (name, detail) => report.steps.push({ name, ok: true, detail });
		let fail = (name, e) => report.steps.push({ name, ok: false, error: String((e && e.message) || e) });
		let wait = ms => new Promise(resolve => setTimeout(resolve, ms));
		let write = () => IOUtils.writeJSON(PathUtils.join(CitationGraphResolver.dir, "selftest.json"), report);
		try {
			await wait(3000);
			let libraryID = Zotero.Libraries.userLibraryID;
			let coll = new Zotero.Collection();
			coll.libraryID = libraryID;
			coll.name = "Citation Graph self-test";
			await coll.saveTx();
			let specs = [
				{ title: "GECToR – Grammatical Error Correction: Tag, Not Rewrite", DOI: "10.18653/v1/2020.bea-1.16", date: "2020", creator: ["Kostiantyn", "Omelianchuk"] },
				{ title: "Parallel Iterative Edit Models for Local Sequence Transduction", DOI: "10.18653/v1/D19-1435", date: "2019", creator: ["Abhijeet", "Awasthi"] },
				{ title: "Encode, Tag, Realize: High-Precision Text Editing", DOI: "10.18653/v1/D19-1510", date: "2019", creator: ["Eric", "Malmi"] }
			];
			let items = [];
			for (let spec of specs) {
				let item = new Zotero.Item("conferencePaper");
				item.libraryID = libraryID;
				item.setField("title", spec.title);
				item.setField("DOI", spec.DOI);
				item.setField("date", spec.date);
				item.setCreators([{ firstName: spec.creator[0], lastName: spec.creator[1], creatorType: "author" }]);
				item.setCollections([coll.id]);
				await item.saveTx();
				items.push(item);
			}
			ok("items", items.map(it => it.id));
			let summary = await CitationGraphResolver.resolveItems(items, { progress: () => {} });
			ok("resolve", summary);
			let graph = await this.buildGraph({ type: "collection", id: coll.id });
			ok("graph", { nodes: graph.nodes.length, edges: graph.edges.map(e => `${graph.nodes.find(n => n.id === e.source).first_author}->${graph.nodes.find(n => n.id === e.target).first_author}:${e.via.join("+")}`) });
			let ego = await this.buildEgoGraph(items[0]);
			ok("ego", { nodes: ego.nodes.length, edges: ego.edges.length, refs_total: ego.refs_total });
			await this.openGraph({ type: "collection", id: coll.id });
			await wait(5000);
			let tab = [...this._tabs.values()].pop();
			let cw = tab && tab.iframe.contentWindow;
			let probe = (w) => {
				if (!w) return { loaded: false };
				let unwrapped = w.wrappedJSObject || w;
				return {
					loaded: true,
					uri: w.document.documentURI,
					readyState: w.document.readyState,
					principal: (w.document.nodePrincipal && (w.document.nodePrincipal.isSystemPrincipal ? "system" : w.document.nodePrincipal.origin)) || null,
					bodyChars: w.document.body ? w.document.body.innerHTML.length : -1,
					boot: w.document.getElementById("boot") ? w.document.getElementById("boot").hidden : "no-boot",
					d3: typeof unwrapped.d3,
					page: typeof unwrapped.CitationGraphPage,
					rpcCalls: this._rpcCalls,
					messagesSeen: this._messagesSeen
				};
			};
			ok("tab", Object.assign(probe(cw), { nodesRendered: cw ? cw.document.querySelectorAll("g.node").length : -1, linksRendered: cw ? cw.document.querySelectorAll("path.link").length : -1 }));
			let win = Zotero.getMainWindow();
			await this.screenshot(win, "selftest-tab.png");
			if (cw) {
				try {
					cw.document.getElementById("lay-time").click();
					await wait(1500);
					await this.screenshot(win, "selftest-timeline.png");
				}
				catch (e) {
					fail("timeline", e);
				}
			}
			await this.selectItem(items[0].id);
			await wait(3000);
			// The item pane renders a section only once it is scrolled into view
			for (let details of win.document.querySelectorAll("item-details")) {
				try {
					if (details.scrollToPane) await details.scrollToPane(this._paneID, "instant");
				}
				catch (e) {
					fail("scrollToPane", e);
				}
			}
			await wait(5000);
			await this.screenshot(win, "selftest-pane.png");
			let frames = [...win.document.querySelectorAll("browser.citation-graph-ego")];
			ok("section", frames.map(f => Object.assign(probe(f.contentWindow), {
				egoNodesRendered: f.contentWindow ? f.contentWindow.document.querySelectorAll("g.n").length : -1,
				appClass: f.contentWindow && f.contentWindow.document.getElementById("app") ? f.contentWindow.document.getElementById("app").className : null,
				hostSet: !!f._cgHost, winSet: !!f._cgWin, height: f.style.height, renders: f._cgRenders || 0,
				sectionHidden: !!(f.closest("item-pane-custom-section") && f.closest("item-pane-custom-section").hidden)
			})));
			await this.setStatus(items[0].id, "adopted");
			ok("status", this.statusOf(Zotero.Items.get(items[0].id)));
		}
		catch (e) {
			fail("selfTest", e);
			Zotero.logError(e);
		}
		report.finished = new Date().toISOString();
		await write();
		this.log(`self-test written: ${JSON.stringify(report)}`);
	},

	/** Renders the main window (chrome and in-process content) to a PNG; used by the self-test. */
	async screenshot(win, name) {
		try {
			let doc = win.document;
			let canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
			let w = win.innerWidth, h = win.innerHeight;
			canvas.width = w;
			canvas.height = h;
			let ctx = canvas.getContext("2d");
			ctx.drawWindow(win, 0, 0, w, h, "rgb(255,255,255)", ctx.DRAWWINDOW_DRAW_VIEW | ctx.DRAWWINDOW_USE_WIDGET_LAYERS);
			let bytes = atob(canvas.toDataURL("image/png").split(",")[1]);
			let arr = new Uint8Array(bytes.length);
			for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
			await IOUtils.write(PathUtils.join(CitationGraphResolver.dir, name), arr);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	/** <data dir>/citation-graph/status.json — what the last start registered; for support and smoke tests. */
	async writeStatus(errors) {
		try {
			let dir = CitationGraphResolver.dir;
			await IOUtils.makeDirectory(dir, { ignoreExisting: true });
			await IOUtils.writeJSON(PathUtils.join(dir, "status.json"), {
				version: this.version,
				zotero: Zotero.version,
				started: new Date().toISOString(),
				menus: this._menuIDs.length,
				section: this._paneID || null,
				preferencePane: this._prefPaneID || null,
				cachedItems: CitationGraphResolver.size,
				errors
			});
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	shutdown() {
		for (let [tabID, tab] of this._tabs) {
			try {
				tab.win.Zotero_Tabs.close(tabID);
			}
			catch (e) {
				// window already gone
			}
		}
		this._tabs.clear();
		for (let menuID of this._menuIDs) Zotero.MenuManager.unregisterMenu(menuID);
		this._menuIDs = [];
		if (this._paneID) Zotero.ItemPaneManager.unregisterSection(this._paneID);
		this._paneID = null;
		if (this._prefPaneID) Zotero.PreferencePanes.unregister(this._prefPaneID);
		this._prefPaneID = null;
		for (let win of this._windows) this.onMainWindowUnload(win);
		delete Zotero.CitationGraph;
	},

	onMainWindowLoad(win) {
		if (this._windows.has(win)) return;
		this._windows.add(win);
		try {
			win.MozXULElement.insertFTLIfNeeded("citation-graph.ftl");
		}
		catch (e) {
			Zotero.logError(e);
		}

		// Belt and braces for the session-restore problem described in startup()
		try {
			let hooks = win.Zotero_Tabs && win.Zotero_Tabs.tabHooks;
			if (hooks && hooks.restoreState) {
				hooks.restoreState[this.TAB_TYPE] = async () => ({ itemID: null });
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	onMainWindowUnload(win) {
		for (let [tabID, tab] of [...this._tabs]) {
			if (tab.win === win) this._tabs.delete(tabID);
		}
		this._windows.delete(win);
	},

	/** RPC endpoint for the pages: {cg:"call", id, method, args} from one of our iframes → the iframe's current host. */
	_onMessage: null,

	frames() {
		let frames = [...this._tabs.values()].map(t => t.iframe);
		for (let f of this._egoFrames) frames.push(f);
		return frames.filter(f => f && f.contentWindow);
	},

	async handleMessage(event) {
		this._messagesSeen = (this._messagesSeen || 0) + 1;
		let m = event.data;
		if (!m || typeof m !== "object" || (m.cg !== "call" && m.cg !== "ready")) return;
		let iframe = this.frames().find(f => f._cgWin === event.currentTarget || f.contentWindow === event.currentTarget);
		if (!iframe) return;
		if (m.cg === "ready") {
			if (iframe._cgHost) this.post(iframe, { cg: "start" });
			return;
		}
		this._rpcCalls = (this._rpcCalls || 0) + 1;
		let host = iframe._cgHost;
		let reply = { cgReply: m.id, ok: false };
		try {
			if (!host || typeof host[m.method] !== "function") throw new Error(`unknown host method ${m.method}`);
			let result = await host[m.method](...(m.args || []));
			reply = { cgReply: m.id, ok: true, result: result === undefined ? null : result };
		}
		catch (e) {
			reply.error = String((e && e.message) || e);
			Zotero.logError(e);
		}
		this.post(iframe, reply);
	},

	post(iframe, message) {
		try {
			iframe.contentWindow.postMessage(message, "*");
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	scrubSessionState() {
		try {
			let state = Zotero.Session && Zotero.Session.state;
			for (let w of (state && state.windows) || []) {
				if (Array.isArray(w.tabs)) {
					w.tabs = w.tabs.filter(t => !(t.type || "").startsWith(this.TAB_TYPE));
				}
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// ------------------------------------------------------------------ registration
	registerMenus() {
		let icon = this.rootURI + "content/icons/menu16.svg";
		let add = (options) => {
			let id = Zotero.MenuManager.registerMenu(options);
			if (id) this._menuIDs.push(id);
			else this.log(`menu ${options.menuID} was rejected`);
		};
		add({
			menuID: "citation-graph-tools",
			pluginID: this.pluginID,
			target: "main/menubar/tools",
			menus: [{
				menuType: "submenu",
				l10nID: "citation-graph-tools-submenu",
				icon,
				menus: [
					{ menuType: "menuitem", l10nID: "citation-graph-menu-open-selection", onCommand: () => this.openGraphForSelection() },
					{ menuType: "menuitem", l10nID: "citation-graph-menu-open-items", onCommand: (ev, ctx) => this.openGraph(this.scopeForItems(ctx.items)) },
					{ menuType: "separator" },
					{ menuType: "menuitem", l10nID: "citation-graph-menu-fetch-selection", onCommand: () => this.fetchForSelection() },
					{ menuType: "menuitem", l10nID: "citation-graph-menu-fetch-items", onCommand: (ev, ctx) => this.fetchItems(ctx.items) },
					{ menuType: "separator" },
					{ menuType: "menuitem", l10nID: "citation-graph-menu-clear-cache", onCommand: () => this.clearCache() },
					{ menuType: "menuitem", l10nID: "citation-graph-menu-preferences", onCommand: () => this.openPreferences() }
				]
			}]
		});
		add({
			menuID: "citation-graph-collection",
			pluginID: this.pluginID,
			target: "main/library/collection",
			menus: [
				{ menuType: "menuitem", l10nID: "citation-graph-collection-open", icon, onCommand: (ev, ctx) => this.openGraph(this.scopeForRows(ctx.collectionTreeRows)) },
				{ menuType: "menuitem", l10nID: "citation-graph-collection-fetch", icon, onCommand: (ev, ctx) => this.fetchScope(this.scopeForRows(ctx.collectionTreeRows)) }
			]
		});
		add({
			menuID: "citation-graph-item",
			pluginID: this.pluginID,
			target: "main/library/item",
			menus: [
				{ menuType: "menuitem", l10nID: "citation-graph-item-open", icon, onCommand: (ev, ctx) => this.openGraph(this.scopeForItems(ctx.items)) },
				{ menuType: "menuitem", l10nID: "citation-graph-item-fetch", icon, onCommand: (ev, ctx) => this.fetchItems(ctx.items) }
			]
		});
	},

	registerSection() {
		this._paneID = Zotero.ItemPaneManager.registerSection({
			paneID: "citation-graph",
			pluginID: this.pluginID,
			header: { l10nID: "citation-graph-section-header", icon: this.rootURI + "content/icons/section16.svg" },
			sidenav: { l10nID: "citation-graph-section-sidenav", icon: this.rootURI + "content/icons/section20.svg" },
			sectionButtons: [
				{
					type: "cg-open",
					icon: this.rootURI + "content/icons/open16.svg",
					l10nID: "citation-graph-section-button-open",
					onClick: ({ item }) => this.openGraphForItem(item)
				},
				{
					type: "cg-fetch",
					icon: this.rootURI + "content/icons/fetch16.svg",
					l10nID: "citation-graph-section-button-fetch",
					onClick: ({ item, body }) => this.fetchItems([item], { force: true }).then(() => this.renderEgo(body, item))
				}
			],
			onItemChange: ({ item, setEnabled }) => {
				setEnabled(!!item && item.isRegularItem());
			},
			onRender: ({ body, doc }) => {
				this.ensureEgoFrame(body, doc);
			},
			onAsyncRender: async ({ body, item }) => {
				if (item && item.isRegularItem()) await this.renderEgo(body, item);
			}
		});
		if (!this._paneID) this.log("item pane section was rejected");
	},

	async registerPrefPane() {
		try {
			this._prefPaneID = await Zotero.PreferencePanes.register({
				pluginID: this.pluginID,
				src: this.rootURI + "content/preferences.xhtml",
				scripts: [this.rootURI + "content/preferences.js"],
				image: this.rootURI + "content/icons/section20.svg",
				label: "Citation Graph"
			});
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	openPreferences() {
		Zotero.Utilities.Internal.openPreferences(this._prefPaneID, {});
	},

	// ------------------------------------------------------------------ scopes
	/** A scope names the set of items a graph is built from. */
	scopeForRows(rows) {
		let row = rows && rows[0];
		if (row && row.isCollection && row.isCollection()) {
			return { type: "collection", id: row.ref.id };
		}
		let libraryID = row && row.ref ? row.ref.libraryID : Zotero.Libraries.userLibraryID;
		return { type: "library", libraryID };
	},

	scopeForItems(items) {
		items = (items || []).filter(it => it.isRegularItem());
		if (!items.length) return null;
		return { type: "items", libraryID: items[0].libraryID, itemIDs: items.map(it => it.id) };
	},

	scopeForSelection() {
		let zp = Zotero.getActiveZoteroPane();
		let coll = zp.getSelectedCollections ? zp.getSelectedCollections()[0] : zp.getSelectedCollection();
		if (coll) return { type: "collection", id: coll.id };
		return { type: "library", libraryID: zp.getSelectedLibraryID() };
	},

	descendantItemIDs(collection, out = new Set()) {
		for (let id of collection.getChildItems(true, false)) out.add(id);
		for (let child of collection.getChildCollections()) this.descendantItemIDs(child, out);
		return out;
	},

	regular(items) {
		return items.filter(it => it && it.isRegularItem() && !it.deleted);
	},

	/** Items of a scope plus a group (colour) for each: subcollections of a collection,
	 *  top-level collections of a library. */
	async collectScope(scope) {
		let items = [], groupOf = new Map(), groups = [], name = "", libraryID;
		let assign = (colls, fallback) => {
			for (let c of colls) {
				let ids = this.descendantItemIDs(c);
				for (let id of ids) if (!groupOf.has(id)) groupOf.set(id, c.name);
				groups.push(c.name);
			}
			for (let it of items) if (!groupOf.has(it.id)) groupOf.set(it.id, fallback);
			if (items.some(it => groupOf.get(it.id) === fallback)) groups.push(fallback);
		};
		if (scope.type === "collection") {
			let coll = Zotero.Collections.get(scope.id);
			if (!coll) throw new Error(`collection ${scope.id} not found`);
			libraryID = coll.libraryID;
			name = coll.name;
			items = this.regular(Zotero.Items.get([...this.descendantItemIDs(coll)]));
			assign(coll.getChildCollections().sort((a, b) => a.name.localeCompare(b.name)), coll.name);
		}
		else if (scope.type === "library") {
			libraryID = scope.libraryID;
			name = Zotero.Libraries.get(libraryID).name;
			items = this.regular(await Zotero.Items.getAll(libraryID, true, false));
			assign(Zotero.Collections.getByLibrary(libraryID).sort((a, b) => a.name.localeCompare(b.name)), "No collection");
		}
		else if (scope.type === "items") {
			libraryID = scope.libraryID;
			items = this.regular(Zotero.Items.get(scope.itemIDs));
			name = `${items.length} selected items`;
			assign(Zotero.Collections.getByLibrary(libraryID).sort((a, b) => a.name.localeCompare(b.name)), "No collection");
		}
		else {
			throw new Error(`unknown scope ${JSON.stringify(scope)}`);
		}
		await Zotero.Items.loadDataTypes(items);          // creators, tags, notes, relations may be lazy for group libraries
		let groupList = groups.map((g, i) => ({ name: g, color: this.PALETTE[i % this.PALETTE.length] }));
		return { items, groupOf, groups: groupList, name, libraryID };
	},

	// ------------------------------------------------------------------ graph data
	statusValues() {
		return String(this.pref("statusValues", "adopted, tested, open, background")).split(",").map(s => s.trim()).filter(Boolean);
	},

	statusOf(item) {
		let prefix = String(this.pref("statusTagPrefix", "status:"));
		for (let tag of item.getTags()) {
			if (tag.tag.startsWith(prefix)) return tag.tag.slice(prefix.length).trim();
		}
		return null;
	},

	async setStatus(itemID, status) {
		let item = Zotero.Items.get(itemID);
		if (!item || !item.isEditable()) return false;
		let prefix = String(this.pref("statusTagPrefix", "status:"));
		for (let tag of item.getTags()) {
			if (tag.tag.startsWith(prefix)) item.removeTag(tag.tag);
		}
		if (status) item.addTag(prefix + status);
		await item.saveTx();
		return true;
	},

	noteText(html) {
		return String(html || "")
			.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
			.replace(/<\/(p|div|h\d|li|tr|br)>/gi, "\n")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
			.replace(/\n\s*\n+/g, "\n").trim();
	},

	nodeOf(item, group) {
		let meta = CitationGraphResolver.meta(item);
		let e = CitationGraphResolver.entry(item) || {};
		let oa = e.openalex || {}, s2 = e.s2 || {};
		let primary = null;
		try {
			primary = Zotero.CreatorTypes.getPrimaryIDForType(item.itemTypeID);
		}
		catch (err) {
			primary = null;
		}
		let creators = item.getCreators();
		let authors = creators.filter(c => primary === null || c.creatorTypeID === primary);
		if (!authors.length) authors = creators;
		let names = authors.map(c => c.fieldMode === 1 ? c.lastName : [c.lastName, c.firstName].filter(Boolean).join(", "));
		let notes = [];
		for (let id of item.getNotes()) {
			let note = Zotero.Items.get(id);
			if (note) notes.push(this.noteText(note.getNote()));
		}
		let venue = "";
		for (let field of ["publicationTitle", "proceedingsTitle", "conferenceName", "bookTitle", "publisher"]) {
			try {
				venue = item.getField(field);
			}
			catch (err) {
				venue = "";
			}
			if (venue) break;
		}
		return {
			id: String(item.id),
			key: item.key,
			libraryID: item.libraryID,
			title: meta.title,
			authors: names,
			first_author: names.length ? names[0].split(",")[0].trim() : "",
			year: meta.year || oa.year || s2.year || null,
			venue: venue || oa.venue || "",
			doi: meta.doi || oa.doi || "",
			url: item.getField("url") || "",
			abstract: item.getField("abstractNote") || oa.abstract || "",
			notes,
			group,
			status: this.statusOf(item),
			editable: item.isEditable(),
			resolved: CitationGraphResolver.isResolved(item),
			citations: { openalex: oa.cited_by_count ?? null, semanticscholar: s2.citationCount ?? null },
			refs_found: { openalex: (oa.referenced_works || []).length, semanticscholar: (s2.references || []).length }
		};
	},

	async buildGraph(scope) {
		let { items, groupOf, groups, name, libraryID } = await this.collectScope(scope);
		let nodes = items.map(it => this.nodeOf(it, groupOf.get(it.id)));
		let edges = CitationGraphResolver.buildEdges(items).map(e => ({ source: String(e.source), target: String(e.target), via: e.via }));
		return {
			mode: "full",
			generated: new Date().toISOString(),
			name,
			scope,
			libraryID,
			groups,
			statuses: this.statusValues(),
			nodes,
			edges,
			unresolved: nodes.filter(n => !n.resolved).length,
			cacheSize: CitationGraphResolver.size
		};
	},

	async buildEgoGraph(item) {
		let libraryID = item.libraryID;
		let { items, edges } = CitationGraphResolver.libraryEdges(libraryID);
		let focus = String(item.id);
		let pool = items.some(it => it.id === item.id) ? items : [...items, item];
		await Zotero.Items.loadDataTypes(pool);
		let touching = edges.filter(e => String(e.source) === focus || String(e.target) === focus);
		if (!items.some(it => it.id === item.id)) {
			// Unresolved focus item: its edges can still come from other items' reference lists
			touching = CitationGraphResolver.buildEdges(pool).filter(e => String(e.source) === focus || String(e.target) === focus);
		}
		let neighbourIDs = new Set([focus]);
		for (let e of touching) {
			neighbourIDs.add(String(e.source));
			neighbourIDs.add(String(e.target));
		}
		let byID = new Map(pool.map(it => [String(it.id), it]));
		// Colour by top-level collection of the library
		let groupOf = new Map(), groups = [];
		let colls = Zotero.Collections.getByLibrary(libraryID).sort((a, b) => a.name.localeCompare(b.name));
		for (let c of colls) {
			let ids = this.descendantItemIDs(c);
			for (let id of neighbourIDs) {
				if (ids.has(parseInt(id)) && !groupOf.has(id)) {
					groupOf.set(id, c.name);
					if (!groups.includes(c.name)) groups.push(c.name);
				}
			}
		}
		for (let id of neighbourIDs) if (!groupOf.has(id)) groupOf.set(id, "No collection");
		if ([...groupOf.values()].includes("No collection")) groups.push("No collection");
		let nodes = [...neighbourIDs].map(id => this.nodeOf(byID.get(id), groupOf.get(id)));
		let e = CitationGraphResolver.entry(item) || {};
		return {
			mode: "ego",
			generated: new Date().toISOString(),
			focus,
			libraryID,
			groups: groups.map((g, i) => ({ name: g, color: this.PALETTE[i % this.PALETTE.length] })),
			statuses: this.statusValues(),
			nodes,
			edges: touching.map(x => ({ source: String(x.source), target: String(x.target), via: x.via })),
			resolved: CitationGraphResolver.isResolved(item),
			refs_total: Math.max(((e.openalex || {}).referenced_works || []).length, ((e.s2 || {}).references || []).length),
			citations_total: Math.max((e.openalex || {}).cited_by_count || 0, (e.s2 || {}).citationCount || 0),
			cacheSize: CitationGraphResolver.size
		};
	},

	// ------------------------------------------------------------------ fetching
	async fetchScope(scope, options = {}) {
		if (!scope) return;
		let { items, name } = await this.collectScope(scope);
		return this.fetchItems(items, Object.assign({ name }, options));
	},

	async fetchForSelection() {
		return this.fetchScope(this.scopeForSelection());
	},

	/** Resolve items with a progress window; returns the resolver's summary. */
	async fetchItems(items, { force = false, name = null } = {}) {
		items = this.regular(items || []);
		if (!items.length) return { attempted: 0, resolved: 0 };
		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("Citation Graph");
		let line = new pw.ItemProgress("journalArticle", `Looking up ${items.length} item(s)${name ? ` in “${name}”` : ""}…`);
		pw.show();
		let summary;
		try {
			summary = await CitationGraphResolver.resolveItems(items, {
				force,
				progress: (fraction, text) => {
					line.setProgress(Math.round(fraction * 100));
					line.setText(text);
				}
			});
			line.setProgress(100);
			line.setText(summary.attempted
				? `${summary.resolved} of ${summary.attempted} item(s) found in OpenAlex / Semantic Scholar`
				: "All items were already fetched");
		}
		catch (e) {
			Zotero.logError(e);
			line.setText(`Failed: ${e.message || e}`);
		}
		pw.startCloseTimer(5000);
		await this.refreshOpenTabs();
		return summary;
	},

	async clearCache() {
		let win = Zotero.getMainWindow();
		let ok = Services.prompt.confirm(win, "Citation Graph", `Delete the cached citation data for ${CitationGraphResolver.size} item(s)? Nothing in your library is changed.`);
		if (!ok) return;
		await CitationGraphResolver.clear();
		await this.refreshOpenTabs();
	},

	// ------------------------------------------------------------------ the graph tab
	async openGraphForSelection() {
		return this.openGraph(this.scopeForSelection());
	},

	async openGraphForItem(item) {
		let collIDs = item.getCollections();
		if (collIDs.length) return this.openGraph({ type: "collection", id: collIDs[0] });
		return this.openGraph({ type: "library", libraryID: item.libraryID });
	},

	async openGraph(scope) {
		if (!scope) return;
		let win = Zotero.getMainWindow();
		let doc = win.document;
		let { name } = await this.collectScope(scope);
		let tab = win.Zotero_Tabs.add({
			type: this.TAB_TYPE,
			title: `Citation graph — ${name}`,
			data: {},
			select: true,
			onClose: () => this._tabs.delete(tab.id)
		});
		let iframe = this.createFrame(doc, "full");
		iframe.setAttribute("flex", "1");
		tab.container.appendChild(iframe);
		let host = this.makeHost({ scope, iframe });
		this.whenLoaded(iframe).then(() => this.attachHost(iframe, host));
		this._tabs.set(tab.id, { win, iframe, scope, host });
	},

	/** A content <browser> showing one of our pages, like Zotero's reader and feed-abstract views. */
	createFrame(doc, mode) {
		let browser = doc.createXULElement("browser");     // same attributes as Zotero's reader: in-process content
		browser.setAttribute("type", "content");
		browser.setAttribute("transparent", "true");
		browser.setAttribute("src", `resource://citationgraph/graph.html#${mode}`);
		return browser;
	},

	/** Resolves once the frame shows our page (the load event of the content document). */
	whenLoaded(frame) {
		return new Promise((resolve) => {
			let done = false;
			let finish = () => {
				if (done) return;
				done = true;
				resolve();
			};
			let onLoad = (event) => {
				if (event.target !== frame.contentDocument) return;
				frame.removeEventListener("load", onLoad, true);
				finish();
			};
			frame.addEventListener("load", onLoad, true);
			let tries = 0;
			let poll = () => {
				if (done) return;
				let doc = frame.contentDocument;
				if (doc && doc.readyState === "complete" && /citationgraph/.test(doc.documentURI || "")) return finish();
				if (++tries < 100) setTimeout(poll, 100);
			};
			setTimeout(poll, 100);
		});
	},

	attachHost(frame, host) {
		frame._cgHost = host;
		let cw = frame.contentWindow;
		if (cw && frame._cgWin !== cw) {
			cw.addEventListener("message", this._onMessage);
			frame._cgWin = cw;
		}
		this.post(frame, { cg: "start" });
	},

	async refreshOpenTabs() {
		for (let tab of this._tabs.values()) this.post(tab.iframe, { cg: "refresh" });
	},

	/** The API the page in the iframe talks to. Everything crosses the realm boundary as JSON strings. */
	makeHost({ scope, iframe }) {
		let self = this;
		return {
			mode: "full",
			version: this.version,
			async getGraph() {
				return JSON.stringify(await self.buildGraph(scope));
			},
			async fetch(force) {
				let { items } = await self.collectScope(scope);
				await self.fetchItems(items, { force: !!force });
				return JSON.stringify(await self.buildGraph(scope));
			},
			async fetchItem(itemID) {
				await self.fetchItems([Zotero.Items.get(parseInt(itemID))], { force: true });
				return JSON.stringify(await self.buildGraph(scope));
			},
			selectItem(itemID) {
				return self.selectItem(parseInt(itemID));
			},
			async setStatus(itemID, status) {
				await self.setStatus(parseInt(itemID), status);
				return JSON.stringify(await self.buildGraph(scope));
			},
			openURL(url) {
				Zotero.launchURL(url);
			},
			setHeight() {},
			log(msg) {
				self.log(`page: ${msg}`);
			}
		};
	},

	async selectItem(itemID) {
		let win = Zotero.getMainWindow();
		win.Zotero_Tabs.select("zotero-pane");
		await win.ZoteroPane.selectItem(itemID);
	},

	// ------------------------------------------------------------------ the item-pane section
	ensureEgoFrame(body, doc) {
		let iframe = body.querySelector("browser.citation-graph-ego");
		if (iframe) return iframe;
		iframe = this.createFrame(doc, "ego");
		iframe.className = "citation-graph-ego";
		iframe.style.cssText = `display:block; width:100%; height:${parseInt(this.pref("egoHeight", 260))}px; border:0; background:transparent;`;
		body.appendChild(iframe);
		iframe._cgReady = this.whenLoaded(iframe);
		this._egoFrames.add(iframe);
		return iframe;
	},

	async renderEgo(body, item) {
		let iframe = this.ensureEgoFrame(body, body.ownerDocument);
		iframe._cgRenders = (iframe._cgRenders || 0) + 1;
		this.log(`renderEgo #${iframe._cgRenders} for item ${item.id}`);
		await iframe._cgReady;
		this.log(`renderEgo: frame loaded (${iframe.contentDocument && iframe.contentDocument.documentURI})`);
		let self = this;
		let host = {
			mode: "ego",
			version: this.version,
			focusID: String(item.id),
			async getGraph() {
				return JSON.stringify(await self.buildEgoGraph(item));
			},
			async fetch(force) {
				await self.fetchItems([item], { force: !!force });
				return JSON.stringify(await self.buildEgoGraph(item));
			},
			async fetchItem(itemID) {
				await self.fetchItems([Zotero.Items.get(parseInt(itemID))], { force: true });
				return JSON.stringify(await self.buildEgoGraph(item));
			},
			selectItem(itemID) {
				return self.selectItem(parseInt(itemID));
			},
			async setStatus(itemID, status) {
				await self.setStatus(parseInt(itemID), status);
				return JSON.stringify(await self.buildEgoGraph(item));
			},
			openFull() {
				return self.openGraphForItem(item);
			},
			openURL(url) {
				Zotero.launchURL(url);
			},
			setHeight(px) {
				iframe.style.height = `${Math.max(120, Math.min(900, parseInt(px) || 260))}px`;
			},
			log(msg) {
				self.log(`ego: ${msg}`);
			}
		};
		this.attachHost(iframe, host);
	}
};
