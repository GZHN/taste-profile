// NAME: Taste Profile
// VERSION: 1.3.0
// DESCRIPTION: Review and change which playlists are excluded from your taste profile.

const react = Spicetify.React;
const SET_NAME = "ignoreinrecs";
const SUPPORT_URL = "https://support.spotify.com/us/article/exclude-playlists-or-tracks-from-your-taste-profile/";

function coverSrc(images) {
	const raw = images?.find((image) => image?.url)?.url || "";
	if (!raw) return "";
	if (!raw.startsWith("spotify:")) return raw;

	const [, kind, ...rest] = raw.split(":");
	if (kind === "image") return `https://i.scdn.co/image/${rest[0]}`;
	if (kind === "mosaic") return `https://mosaic.scdn.co/300/${rest.join("")}`;
	return "";
}

function formatDate(seconds) {
	const value = Number(seconds);
	if (!value) return "";
	return new Date(value * 1000).toLocaleDateString("en", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function trackLabel(count) {
	if (!Number.isFinite(count)) return "";
	return count === 1 ? "1 track" : `${count} tracks`;
}

function playlistCount(count) {
	return count === 1 ? "1 playlist" : `${count} playlists`;
}

function excludedMap(items) {
	const map = new Map();
	for (const item of items || []) {
		const uri = typeof item === "string" ? item : item?.uri;
		if (!uri?.startsWith("spotify:playlist:")) continue;
		const added = Number(item?.addTime || 0);
		map.set(uri, Number.isFinite(added) ? added : 0);
	}
	return map;
}

function flattenLibrary(node, folder = []) {
	const rows = [];
	for (const item of node?.items || []) {
		if (item?.type === "folder") {
			const nextFolder = item.name ? [...folder, item.name] : folder;
			rows.push(...flattenLibrary(item, nextFolder));
			continue;
		}
		if (item?.type !== "playlist" || !item.uri) continue;
		rows.push({
			uri: item.uri,
			name: item.name || "Untitled playlist",
			owner: item.isOwnedBySelf ? "You" : item.owner?.displayName || "",
			folder: folder.join(" / "),
			tracks: Number.isFinite(item.totalLength) ? item.totalLength : null,
			image: coverSrc(item.images),
			inLibrary: true,
			unavailable: false,
		});
	}
	return rows;
}

function uniqueRows(rows) {
	const seen = new Set();
	return rows.filter((row) => {
		if (seen.has(row.uri)) return false;
		seen.add(row.uri);
		return true;
	});
}

function compareRows(a, b) {
	return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

async function mapPool(items, limit, task, onDone) {
	const results = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const current = next;
			next += 1;
			results[current] = await task(items[current]);
			onDone?.();
		}
	}
	const workers = Math.min(limit, items.length);
	await Promise.all(Array.from({ length: workers }, worker));
	return results;
}

async function loadOutsidePlaylist(uri) {
	const id = uri.split(":")[2];
	try {
		const meta = await Spicetify.CosmosAsync.get(
			`https://api.spotify.com/v1/playlists/${id}?fields=name,owner(display_name),images,tracks(total)`
		);
		return {
			uri,
			name: meta?.name || "Untitled playlist",
			owner: meta?.owner?.display_name || "",
			folder: "",
			tracks: Number.isFinite(meta?.tracks?.total) ? meta.tracks.total : null,
			image: meta?.images?.[0]?.url || "",
			inLibrary: false,
			unavailable: false,
		};
	} catch {
		return {
			uri,
			name: "Playlist unavailable",
			owner: "",
			folder: "",
			tracks: null,
			image: "",
			inLibrary: false,
			unavailable: true,
		};
	}
}

function matchesQuery(row, query) {
	if (!query) return true;
	const haystack = `${row.name} ${row.owner} ${row.folder}`.toLocaleLowerCase("en");
	return haystack.includes(query);
}

const VIEW_KEY = "taste-profile:view";
const FILTERS = new Set(["all", "excluded", "included", "outside"]);

function readView() {
	try {
		const storage = Spicetify.LocalStorage;
		const raw = storage?.get?.(VIEW_KEY) || localStorage.getItem(VIEW_KEY);
		const view = JSON.parse(raw || "{}");
		return {
			filter: FILTERS.has(view.filter) ? view.filter : "all",
			query: typeof view.query === "string" ? view.query : "",
		};
	} catch {
		return { filter: "all", query: "" };
	}
}

function writeView(view) {
	const payload = JSON.stringify(view);
	if (Spicetify.LocalStorage?.set) Spicetify.LocalStorage.set(VIEW_KEY, payload);
	else localStorage.setItem(VIEW_KEY, payload);
}

function App() {
	const [library, setLibrary] = react.useState([]);
	const [outside, setOutside] = react.useState([]);
	const [excluded, setExcluded] = react.useState(() => new Map());
	const [status, setStatus] = react.useState("loading");
	const [error, setError] = react.useState("");
	const [progress, setProgress] = react.useState({ value: 0, label: "Loading playlists" });
	const savedView = react.useMemo(() => readView(), []);
	const [filter, setFilter] = react.useState(savedView.filter);
	const [query, setQuery] = react.useState(savedView.query);
	const [selected, setSelected] = react.useState(() => new Set());
	const [pendingUris, setPendingUris] = react.useState(() => new Set());
	const [undo, setUndo] = react.useState(null);
	const libraryRef = react.useRef([]);
	const outsideRef = react.useRef([]);
	const excludedRef = react.useRef(excluded);
	const applying = react.useRef(false);

	react.useEffect(() => {
		excludedRef.current = excluded;
	}, [excluded]);

	react.useEffect(() => {
		writeView({ filter, query });
	}, [filter, query]);

	const reportProgress = react.useCallback((value, label) => {
		setProgress({ value: Math.min(1, Math.max(0, value)), label });
	}, []);

	const rememberOutside = react.useCallback(async (uris) => {
		const known = new Set([...libraryRef.current, ...outsideRef.current].map((row) => row.uri));
		const missing = uris.filter((uri) => !known.has(uri));
		if (!missing.length) return;
		const loaded = await mapPool(missing, 4, loadOutsidePlaylist);
		setOutside((current) => uniqueRows([...current, ...loaded]));
	}, []);

	const load = react.useCallback(async () => {
		const api = Spicetify.Platform?.CollectionPlatformAPI;
		const rootlist = Spicetify.Platform?.RootlistAPI;
		reportProgress(0.08, "Connecting to Spotify");
		if (!api?.get || !rootlist?.getContents) {
			throw new Error("Spotify is still starting. Reopen Taste Profile in a moment.");
		}

		reportProgress(0.22, "Loading your library");
		const [ignored, contents] = await Promise.all([api.get(SET_NAME), rootlist.getContents()]);
		const map = excludedMap(ignored);
		const rows = uniqueRows(flattenLibrary(contents));
		const known = new Set(rows.map((row) => row.uri));
		const missing = [...map.keys()].filter((uri) => !known.has(uri));
		reportProgress(missing.length ? 0.4 : 1, missing.length ? "Loading playlists" : "Playlists loaded");
		let done = 0;
		const loadedOutside = uniqueRows(
			missing.length
				? await mapPool(missing, 4, loadOutsidePlaylist, () => {
						done += 1;
						reportProgress(0.4 + 0.6 * (done / missing.length), `Loading playlists · ${done} of ${missing.length}`);
					})
				: []
		);
		libraryRef.current = rows;
		outsideRef.current = loadedOutside;

		setLibrary(rows);
		setOutside(loadedOutside);
		excludedRef.current = map;
		setExcluded(map);
		reportProgress(1, "Playlists loaded");
	}, [reportProgress]);

	const loadWithRetry = react.useCallback(async () => {
		const started = Date.now();
		let lastError;
		while (Date.now() - started < 12000) {
			try {
				await load();
				return;
			} catch (loadError) {
				lastError = loadError;
				await new Promise((resolve) => setTimeout(resolve, 400));
			}
		}
		throw lastError instanceof Error ? lastError : new Error("Playlists could not be loaded.");
	}, [load]);

	react.useEffect(() => {
		let cancel = () => {};
		let alive = true;

		(async () => {
			try {
				await loadWithRetry();
				if (!alive) return;
				setStatus("ready");
				const subscribe = Spicetify.Platform.CollectionPlatformAPI.subscribe;
				if (typeof subscribe !== "function") return;
				const stop = subscribe(SET_NAME, (items) => {
					const map = excludedMap(items);
					excludedRef.current = map;
					setExcluded(map);
					void rememberOutside([...map.keys()]);
				});
				if (typeof stop === "function") cancel = stop;
			} catch (loadError) {
				if (!alive) return;
				const message = loadError?.message || "";
				setError(message.includes("still starting") ? message : "Playlists could not be loaded.");
				setStatus("error");
			}
		})();

		return () => {
			alive = false;
			cancel();
		};
	}, [loadWithRetry, rememberOutside]);

	async function applyExclusion(uris, shouldExclude) {
		const unique = [...new Set(uris)];
		if (!unique.length || applying.current) return;
		const api = Spicetify.Platform.CollectionPlatformAPI;
		const previous = new Map();
		for (const uri of unique) {
			previous.set(uri, excludedRef.current.has(uri) ? excludedRef.current.get(uri) : null);
		}

		applying.current = true;
		setPendingUris(new Set(unique));
		setExcluded((current) => {
			const next = new Map(current);
			const now = Math.floor(Date.now() / 1000);
			for (const uri of unique) {
				if (shouldExclude) next.set(uri, current.get(uri) || now);
				else next.delete(uri);
			}
			excludedRef.current = next;
			return next;
		});

		try {
			if (shouldExclude) await api.add(SET_NAME, unique);
			else await api.remove(SET_NAME, unique);
			setUndo({
				uris: unique,
				previous,
				action: shouldExclude ? "exclude" : "include",
			});
			setSelected(new Set());
		} catch {
			setExcluded((current) => {
				const next = new Map(current);
				for (const [uri, value] of previous) {
					if (value === null) next.delete(uri);
					else next.set(uri, value);
				}
				excludedRef.current = next;
				return next;
			});
			Spicetify.showNotification(unique.length === 1 ? "Couldn't update this playlist. Try again." : "Couldn't update these playlists. Try again.");
		} finally {
			applying.current = false;
			setPendingUris(new Set());
		}
	}

	async function undoLast() {
		if (!undo || applying.current) return;
		const api = Spicetify.Platform.CollectionPlatformAPI;
		const snapshot = undo;
		const toExclude = [];
		const toInclude = [];
		for (const uri of snapshot.uris) {
			const value = snapshot.previous.get(uri);
			if (value === null || value === undefined) toInclude.push(uri);
			else toExclude.push(uri);
		}

		applying.current = true;
		setUndo(null);
		setPendingUris(new Set(snapshot.uris));
		setExcluded((current) => {
			const next = new Map(current);
			for (const uri of snapshot.uris) {
				const value = snapshot.previous.get(uri);
				if (value === null || value === undefined) next.delete(uri);
				else next.set(uri, value);
			}
			excludedRef.current = next;
			return next;
		});

		try {
			if (toExclude.length) await api.add(SET_NAME, toExclude);
			if (toInclude.length) await api.remove(SET_NAME, toInclude);
		} catch {
			Spicetify.showNotification("Couldn't undo that change. Try again.");
		} finally {
			applying.current = false;
			setPendingUris(new Set());
		}
	}

	function chooseFilter(next) {
		setFilter(next);
		setSelected(new Set());
	}

	const needle = query.trim().toLocaleLowerCase("en");
	const rows = react.useMemo(() => {
		return uniqueRows([...library, ...outside])
			.map((row) => ({
				...row,
				excluded: excluded.has(row.uri),
				excludedAt: excluded.get(row.uri) || 0,
			}))
			.filter((row) => row.inLibrary || row.excluded);
	}, [library, outside, excluded]);

	const libraryRows = rows.filter((row) => row.inLibrary);
	const outsideRows = rows.filter((row) => !row.inLibrary);
	const pool = filter === "outside" ? outsideRows : filter === "excluded" ? libraryRows.filter((row) => row.excluded) : filter === "included" ? libraryRows.filter((row) => !row.excluded) : libraryRows;
	const visible = pool.filter((row) => matchesQuery(row, needle)).sort(compareRows);
	const excludedRows = visible.filter((row) => row.excluded);
	const includedRows = visible.filter((row) => !row.excluded);
	const excludedCount = libraryRows.filter((row) => row.excluded).length;
	const includedCount = libraryRows.filter((row) => !row.excluded).length;
	const outsideCount = outsideRows.length;
	const selectedVisible = visible.filter((row) => selected.has(row.uri));
	const selectedExcluded = selectedVisible.filter((row) => row.excluded).map((row) => row.uri);
	const selectedIncluded = selectedVisible.filter((row) => !row.excluded).map((row) => row.uri);
	const allSelected = visible.length > 0 && selectedVisible.length === visible.length;
	const partiallySelected = selectedVisible.length > 0 && !allSelected;
	const busy = pendingUris.size > 0;

	let emptyMessage = "No playlists match this filter.";
	if (filter === "outside" && !needle) emptyMessage = "Every excluded playlist is still in your library.";

	return react.createElement(
		"section",
		{ className: "taste" },
		react.createElement(
			"header",
			{ className: "taste__header" },
			react.createElement("p", { className: "taste__kicker" }, "Library"),
			react.createElement(
				"div",
				{ className: "taste__heading" },
				react.createElement("h1", null, "Taste Profile"),
				react.createElement(
					"button",
					{
						type: "button",
						className: status === "loading" ? "taste__reload is-loading" : "taste__reload",
						"aria-label": "Reload playlists",
						title: "Reload playlists",
						disabled: status === "loading",
						onClick: () => {
							setStatus("loading");
							setError("");
							setProgress({ value: 0, label: "Loading playlists" });
							loadWithRetry()
								.then(() => setStatus("ready"))
								.catch(() => {
									setError("Playlists could not be loaded.");
									setStatus("error");
								});
						},
					},
					react.createElement(ReloadIcon)
				)
			),
			react.createElement(
				"p",
				{ className: "taste__intro" },
				"Taste profile is Spotify's interpretation of your taste based on what you listen to and how you listen to it. Spotify uses it to personalize recommendations, like Discover Weekly and your Home page, and experiences with taste summaries, like Wrapped and Blend. ",
				react.createElement(
					"a",
					{
						className: "taste__more",
						href: SUPPORT_URL,
						target: "_blank",
						rel: "noopener noreferrer",
						onClick: (event) => {
							event.preventDefault();
							window.open(SUPPORT_URL, "_blank", "noopener");
						},
					},
					"More information"
				)
			),
			react.createElement(
				"p",
				{ className: "taste__intro" },
				"In Spotify, that setting lives on each playlist menu, so there is no list of which playlists are excluded. This app shows them together, so you can see the setting and change it for any playlist from one place."
			),
			react.createElement(
				"div",
				{ className: "taste__stats" },
				status === "ready" ? react.createElement("span", null, `${excludedCount} excluded`) : null,
				status === "ready" ? react.createElement("span", null, `${includedCount} included`) : null,
				status === "ready" ? react.createElement("span", null, `${outsideCount} not in your library`) : null
			)
		),
		react.createElement(
			"div",
			{ className: "taste__toolbar" },
			react.createElement("input", {
				className: "taste__search",
				type: "search",
				value: query,
				placeholder: "Search by name, folder, or owner",
				"aria-label": "Search playlists",
				onChange: (event) => {
					setQuery(event.target.value);
					setSelected(new Set());
				},
			}),
			react.createElement(
				"div",
				{ className: "taste__filters", role: "group", "aria-label": "Filter playlists" },
				react.createElement(FilterButton, { id: "all", label: "All", filter, setFilter: chooseFilter }),
				react.createElement(FilterButton, { id: "excluded", label: "Excluded", filter, setFilter: chooseFilter }),
				react.createElement(FilterButton, { id: "included", label: "Included", filter, setFilter: chooseFilter }),
				react.createElement(FilterButton, { id: "outside", label: "Not in library", filter, setFilter: chooseFilter })
			)
		),
		status === "ready" && visible.length
			? react.createElement(BulkBar, {
					visible,
					selectedCount: selectedVisible.length,
					allSelected,
					partiallySelected,
					busy,
					includeSelected: selectedExcluded,
					excludeSelected: selectedIncluded,
					includeView: excludedRows.map((row) => row.uri),
					excludeView: includedRows.map((row) => row.uri),
					onSelectAll: () => {
						setSelected(allSelected ? new Set() : new Set(visible.map((row) => row.uri)));
					},
					onApply: applyExclusion,
				})
			: null,
		status === "loading" ? react.createElement(Progress, { value: progress.value, label: progress.label }) : null,
		status === "error" ? react.createElement("p", { className: "taste__status", role: "alert" }, error) : null,
		status === "ready" && !visible.length ? react.createElement("p", { className: "taste__status" }, emptyMessage) : null,
		status === "ready" && visible.length
			? react.createElement(
					react.Fragment,
					null,
					filter === "outside"
						? react.createElement(Group, {
								title: "Not in your library",
								rows: visible,
								pendingUris,
								selected,
								onToggleSelected: toggleOneSelected,
								onToggle: (uri, isExcluded) => applyExclusion([uri], !isExcluded),
							})
						: react.createElement(
								react.Fragment,
								null,
								filter !== "included" ? react.createElement(Group, { title: "Excluded", rows: excludedRows, pendingUris, selected, onToggleSelected: toggleOneSelected, onToggle: (uri, isExcluded) => applyExclusion([uri], !isExcluded) }) : null,
								filter !== "excluded" ? react.createElement(Group, { title: "Included", rows: includedRows, pendingUris, selected, onToggleSelected: toggleOneSelected, onToggle: (uri, isExcluded) => applyExclusion([uri], !isExcluded) }) : null
							)
				)
			: null,
		undo
			? react.createElement(
					"div",
					{ className: "taste__undo", role: "status" },
					react.createElement("span", null, `${undo.action === "exclude" ? "Excluded" : "Included"} ${playlistCount(undo.uris.length)}.`),
					react.createElement(
						"button",
						{ type: "button", className: "taste__action", disabled: busy, onClick: () => undoLast() },
						"Undo"
					),
					react.createElement(
						"button",
						{ type: "button", className: "taste__refresh", onClick: () => setUndo(null) },
						"Dismiss"
					)
				)
			: null
	);

	function toggleOneSelected(uri) {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(uri)) next.delete(uri);
			else next.add(uri);
			return next;
		});
	}
}

function BulkBar({ visible, selectedCount, allSelected, partiallySelected, busy, includeSelected, excludeSelected, includeView, excludeView, onSelectAll, onApply }) {
	return react.createElement(
		"div",
		{ className: "taste__bulk" },
		react.createElement(SelectAll, {
			checked: allSelected,
			indeterminate: partiallySelected,
			disabled: busy || !visible.length,
			label: selectedCount ? `${selectedCount} selected` : "Select all",
			onChange: onSelectAll,
		}),
		includeSelected.length
			? react.createElement(
					"button",
					{ type: "button", className: "taste__action", disabled: busy, onClick: () => onApply(includeSelected, false) },
					`Include selected (${includeSelected.length})`
				)
			: null,
		excludeSelected.length
			? react.createElement(
					"button",
					{ type: "button", className: "taste__refresh", disabled: busy, onClick: () => onApply(excludeSelected, true) },
					`Exclude selected (${excludeSelected.length})`
				)
			: null,
		includeView.length
			? react.createElement(
					"button",
					{ type: "button", className: "taste__refresh", disabled: busy, onClick: () => onApply(includeView, false) },
					`Include all (${includeView.length})`
				)
			: null,
		excludeView.length
			? react.createElement(
					"button",
					{ type: "button", className: "taste__refresh", disabled: busy, onClick: () => onApply(excludeView, true) },
					`Exclude all (${excludeView.length})`
				)
			: null
	);
}

function SelectAll({ checked, indeterminate, disabled, label, onChange }) {
	const input = react.useRef(null);
	react.useEffect(() => {
		if (input.current) input.current.indeterminate = indeterminate;
	}, [indeterminate]);

	return react.createElement(
		"label",
		{ className: "taste__select" },
		react.createElement("input", {
			ref: input,
			type: "checkbox",
			checked,
			disabled,
			onChange,
		}),
		react.createElement("span", null, label)
	);
}

function ReloadIcon() {
	return react.createElement(
		"svg",
		{
			viewBox: "0 0 24 24",
			width: "18",
			height: "18",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: "2",
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
		},
		react.createElement("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }),
		react.createElement("path", { d: "M21 3v6h-6" })
	);
}

function Progress({ value, label }) {
	const percent = Math.round(value * 100);
	return react.createElement(
		"div",
		{ className: "taste__progress" },
		react.createElement(
			"div",
			{ className: "taste__progress-label" },
			react.createElement("span", null, label),
			react.createElement("span", null, `${percent}%`)
		),
		react.createElement(
			"div",
			{
				className: "taste__progress-track",
				role: "progressbar",
				"aria-valuemin": 0,
				"aria-valuemax": 100,
				"aria-valuenow": percent,
				"aria-label": label,
			},
			react.createElement("div", { className: "taste__progress-fill", style: { width: `${percent}%` } })
		)
	);
}

function FilterButton({ id, label, filter, setFilter }) {
	const selected = filter === id;
	return react.createElement(
		"button",
		{
			type: "button",
			className: selected ? "taste__filter taste__filter--active" : "taste__filter",
			"aria-pressed": selected,
			onClick: () => setFilter(id),
		},
		label
	);
}

function Group({ title, rows, pendingUris, selected, onToggleSelected, onToggle }) {
	if (!rows.length) return null;
	return react.createElement(
		"section",
		{ className: "taste__group", "aria-label": title },
		react.createElement("h2", null, `${title} · ${rows.length}`),
		react.createElement(
			"ul",
			{ className: "taste__list" },
			rows.map((row) =>
				react.createElement(Row, {
					key: row.uri,
					row,
					pending: pendingUris.has(row.uri),
					checked: selected.has(row.uri),
					onToggleSelected,
					onToggle,
				})
			)
		)
	);
}

function Row({ row, pending, checked, onToggleSelected, onToggle }) {
	const details = [
		row.owner,
		row.folder,
		trackLabel(row.tracks),
		row.inLibrary ? "" : "Not in your library",
		row.excluded && row.excludedAt ? `Excluded ${formatDate(row.excludedAt)}` : "",
	].filter(Boolean);
	const action = row.excluded ? "Include" : "Exclude";

	return react.createElement(
		"li",
		{ className: checked ? "taste__row taste__row--selected" : "taste__row" },
		react.createElement(
			"label",
			{ className: "taste__check" },
			react.createElement("input", {
				type: "checkbox",
				checked,
				disabled: pending,
				"aria-label": `Select ${row.name}`,
				onChange: () => onToggleSelected(row.uri),
			})
		),
		row.image
			? react.createElement("img", { className: "taste__cover", src: row.image, alt: "" })
			: react.createElement("div", { className: "taste__cover taste__cover--empty", "aria-hidden": "true" }),
		react.createElement(
			"div",
			{ className: "taste__main" },
			react.createElement(
				"button",
				{
					type: "button",
					className: "taste__name",
					title: row.name,
					onClick: () => openPlaylist(row.uri),
				},
				row.name
			),
			react.createElement("p", { className: "taste__meta", title: details.join(" · ") }, details.join(" · "))
		),
		react.createElement(
			"span",
			{ className: row.excluded ? "taste__badge taste__badge--out" : "taste__badge taste__badge--in" },
			row.excluded ? "Excluded" : "Included"
		),
		react.createElement(
			"button",
			{
				type: "button",
				className: "taste__action",
				disabled: pending,
				"aria-label": row.excluded ? `Include ${row.name} in your taste profile` : `Exclude ${row.name} from your taste profile`,
				onClick: () => onToggle(row.uri, row.excluded),
			},
			pending ? "Working…" : action
		)
	);
}

function openPlaylist(uri) {
	const id = uri.split(":")[2];
	if (!id) return;
	Spicetify.Platform.History.push(`/playlist/${id}`);
}

function render() {
	return react.createElement(App);
}
