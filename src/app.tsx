import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./css/app.css";

const SET_NAME = "ignoreinrecs";
const SUPPORT_URL =
  "https://support.spotify.com/us/article/exclude-playlists-or-tracks-from-your-taste-profile/";
const VIEW_KEY = "taste-profile:view";
const FILTERS = new Set(["all", "excluded", "included", "outside"] as const);

type FilterId = "all" | "excluded" | "included" | "outside";
type Status = "loading" | "ready" | "error";

type PlaylistRow = {
  uri: string;
  name: string;
  owner: string;
  folder: string;
  tracks: number | null;
  image: string;
  inLibrary: boolean;
  unavailable: boolean;
};

type DisplayRow = PlaylistRow & {
  excluded: boolean;
  excludedAt: number;
};

type UndoState = {
  uris: string[];
  previous: Map<string, number | null>;
  action: "exclude" | "include";
};

type ProgressState = {
  value: number;
  label: string;
};

function coverSrc(images: Array<{ url?: string } | null | undefined> | undefined): string {
  const raw = images?.find((image) => image?.url)?.url || "";
  if (!raw) return "";
  if (!raw.startsWith("spotify:")) return raw;

  const [, kind, ...rest] = raw.split(":");
  if (kind === "image") return `https://i.scdn.co/image/${rest[0]}`;
  if (kind === "mosaic") return `https://mosaic.scdn.co/300/${rest.join("")}`;
  return "";
}

function formatDate(seconds: number): string {
  const value = Number(seconds);
  if (!value) return "";
  return new Date(value * 1000).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function trackLabel(count: number | null): string {
  if (!Number.isFinite(count as number)) return "";
  return count === 1 ? "1 track" : `${count} tracks`;
}

function playlistCount(count: number): string {
  return count === 1 ? "1 playlist" : `${count} playlists`;
}

function excludedMap(items: unknown): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of (items as Array<string | { uri?: string; addTime?: number }> | undefined) || []) {
    const uri = typeof item === "string" ? item : item?.uri;
    if (!uri?.startsWith("spotify:playlist:")) continue;
    const added = Number(typeof item === "string" ? 0 : item?.addTime || 0);
    map.set(uri, Number.isFinite(added) ? added : 0);
  }
  return map;
}

type LibraryNode = {
  items?: Array<{
    type?: string;
    name?: string;
    uri?: string;
    isOwnedBySelf?: boolean;
    owner?: { displayName?: string };
    totalLength?: number;
    images?: Array<{ url?: string }>;
  }>;
};

function flattenLibrary(node: LibraryNode | undefined, folder: string[] = []): PlaylistRow[] {
  const rows: PlaylistRow[] = [];
  for (const item of node?.items || []) {
    if (item?.type === "folder") {
      const nextFolder = item.name ? [...folder, item.name] : folder;
      rows.push(...flattenLibrary(item as LibraryNode, nextFolder));
      continue;
    }
    if (item?.type !== "playlist" || !item.uri) continue;
    rows.push({
      uri: item.uri,
      name: item.name || "Untitled playlist",
      owner: item.isOwnedBySelf ? "You" : item.owner?.displayName || "",
      folder: folder.join(" / "),
      tracks: Number.isFinite(item.totalLength) ? (item.totalLength as number) : null,
      image: coverSrc(item.images),
      inLibrary: true,
      unavailable: false,
    });
  }
  return rows;
}

function uniqueRows(rows: PlaylistRow[]): PlaylistRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.uri)) return false;
    seen.add(row.uri);
    return true;
  });
}

function compareRows(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
  onDone?: () => void
): Promise<R[]> {
  const results = new Array<R>(items.length);
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

async function loadOutsidePlaylist(uri: string): Promise<PlaylistRow> {
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

function matchesQuery(row: PlaylistRow, query: string): boolean {
  if (!query) return true;
  const haystack = `${row.name} ${row.owner} ${row.folder}`.toLocaleLowerCase("en");
  return haystack.includes(query);
}

function readView(): { filter: FilterId; query: string } {
  try {
    const storage = Spicetify.LocalStorage;
    const raw = storage?.get?.(VIEW_KEY) || localStorage.getItem(VIEW_KEY);
    const view = JSON.parse(raw || "{}") as { filter?: string; query?: string };
    return {
      filter: FILTERS.has(view.filter as FilterId) ? (view.filter as FilterId) : "all",
      query: typeof view.query === "string" ? view.query : "",
    };
  } catch {
    return { filter: "all", query: "" };
  }
}

function writeView(view: { filter: FilterId; query: string }) {
  const payload = JSON.stringify(view);
  if (Spicetify.LocalStorage?.set) Spicetify.LocalStorage.set(VIEW_KEY, payload);
  else localStorage.setItem(VIEW_KEY, payload);
}

function openPlaylist(uri: string) {
  const id = uri.split(":")[2];
  if (!id) return;
  Spicetify.Platform.History.push(`/playlist/${id}`);
}

export default function App() {
  const [library, setLibrary] = useState<PlaylistRow[]>([]);
  const [outside, setOutside] = useState<PlaylistRow[]>([]);
  const [excluded, setExcluded] = useState<Map<string, number>>(() => new Map());
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<ProgressState>({ value: 0, label: "Loading playlists" });
  const savedView = useMemo(() => readView(), []);
  const [filter, setFilter] = useState<FilterId>(savedView.filter);
  const [query, setQuery] = useState(savedView.query);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pendingUris, setPendingUris] = useState<Set<string>>(() => new Set());
  const [undo, setUndo] = useState<UndoState | null>(null);
  const libraryRef = useRef<PlaylistRow[]>([]);
  const outsideRef = useRef<PlaylistRow[]>([]);
  const excludedRef = useRef(excluded);
  const applying = useRef(false);

  useEffect(() => {
    excludedRef.current = excluded;
  }, [excluded]);

  useEffect(() => {
    writeView({ filter, query });
  }, [filter, query]);

  const reportProgress = useCallback((value: number, label: string) => {
    setProgress({ value: Math.min(1, Math.max(0, value)), label });
  }, []);

  const rememberOutside = useCallback(async (uris: string[]) => {
    const known = new Set([...libraryRef.current, ...outsideRef.current].map((row) => row.uri));
    const missing = uris.filter((uri) => !known.has(uri));
    if (!missing.length) return;
    const loaded = await mapPool(missing, 4, loadOutsidePlaylist);
    setOutside((current) => uniqueRows([...current, ...loaded]));
  }, []);

  const load = useCallback(async () => {
    const api = Spicetify.Platform?.CollectionPlatformAPI as
      | {
          get: (name: string) => Promise<unknown>;
          add: (name: string, uris: string[]) => Promise<unknown>;
          remove: (name: string, uris: string[]) => Promise<unknown>;
          subscribe?: (name: string, cb: (items: unknown) => void) => (() => void) | void;
        }
      | undefined;
    const rootlist = Spicetify.Platform?.RootlistAPI as
      | { getContents: () => Promise<LibraryNode> }
      | undefined;
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

  const loadWithRetry = useCallback(async () => {
    const started = Date.now();
    let lastError: unknown;
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

  useEffect(() => {
    let cancel = () => {};
    let alive = true;

    (async () => {
      try {
        await loadWithRetry();
        if (!alive) return;
        setStatus("ready");
        const api = Spicetify.Platform.CollectionPlatformAPI as {
          subscribe?: (name: string, cb: (items: unknown) => void) => (() => void) | void;
        };
        const subscribe = api?.subscribe;
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
        const message = loadError instanceof Error ? loadError.message : "";
        setError(message.includes("still starting") ? message : "Playlists could not be loaded.");
        setStatus("error");
      }
    })();

    return () => {
      alive = false;
      cancel();
    };
  }, [loadWithRetry, rememberOutside]);

  async function applyExclusion(uris: string[], shouldExclude: boolean) {
    const unique = [...new Set(uris)];
    if (!unique.length || applying.current) return;
    const api = Spicetify.Platform.CollectionPlatformAPI as {
      add: (name: string, uris: string[]) => Promise<unknown>;
      remove: (name: string, uris: string[]) => Promise<unknown>;
    };
    const previous = new Map<string, number | null>();
    for (const uri of unique) {
      previous.set(uri, excludedRef.current.has(uri) ? (excludedRef.current.get(uri) as number) : null);
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
      Spicetify.showNotification(
        unique.length === 1 ? "Couldn't update this playlist. Try again." : "Couldn't update these playlists. Try again."
      );
    } finally {
      applying.current = false;
      setPendingUris(new Set());
    }
  }

  async function undoLast() {
    if (!undo || applying.current) return;
    const api = Spicetify.Platform.CollectionPlatformAPI as {
      add: (name: string, uris: string[]) => Promise<unknown>;
      remove: (name: string, uris: string[]) => Promise<unknown>;
    };
    const snapshot = undo;
    const toExclude: string[] = [];
    const toInclude: string[] = [];
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

  function chooseFilter(next: FilterId) {
    setFilter(next);
    setSelected(new Set());
  }

  function reloadPlaylists() {
    if (status === "loading") return;
    setStatus("loading");
    setError("");
    setProgress({ value: 0, label: "Loading playlists" });
    loadWithRetry()
      .then(() => setStatus("ready"))
      .catch(() => {
        setError("Playlists could not be loaded.");
        setStatus("error");
      });
  }

  function toggleOneSelected(uri: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }

  const needle = query.trim().toLocaleLowerCase("en");
  const rows = useMemo((): DisplayRow[] => {
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
  const pool =
    filter === "outside"
      ? outsideRows
      : filter === "excluded"
        ? libraryRows.filter((row) => row.excluded)
        : filter === "included"
          ? libraryRows.filter((row) => !row.excluded)
          : libraryRows;
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

  return (
    <section className="taste">
      <header className="taste__header">
        <p className="taste__kicker">Library</p>
        <div className="taste__heading">
          <h1>Taste Profile</h1>
          <button
            type="button"
            className={status === "loading" ? "taste__reload is-loading" : "taste__reload"}
            aria-label="Reload playlists"
            title="Reload playlists"
            disabled={status === "loading"}
            onClick={reloadPlaylists}
          >
            <ReloadIcon />
            <span>Reload playlists</span>
          </button>
        </div>
        <p className="taste__intro">
          Taste profile is Spotify&apos;s interpretation of your taste based on what you listen to and how you listen
          to it. Spotify uses it to personalize recommendations, like Discover Weekly and your Home page, and
          experiences with taste summaries, like Wrapped and Blend.{" "}
          <a
            className="taste__more"
            href={SUPPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              event.preventDefault();
              window.open(SUPPORT_URL, "_blank", "noopener");
            }}
          >
            More information
          </a>
        </p>
        <p className="taste__intro">
          In Spotify, that setting lives on each playlist menu, so there is no list of which playlists are excluded.
          This app shows them together, so you can see the setting and change it for any playlist from one place.
        </p>
        <div className="taste__stats">
          {status === "ready" ? <span>{excludedCount} excluded</span> : null}
          {status === "ready" ? <span>{includedCount} included</span> : null}
          {status === "ready" ? <span>{outsideCount} not in your library</span> : null}
        </div>
      </header>

      <div className="taste__toolbar">
        <input
          className="taste__search"
          type="search"
          value={query}
          placeholder="Search by name, folder, or owner"
          aria-label="Search playlists"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(new Set());
          }}
        />
        <div className="taste__filters" role="group" aria-label="Filter playlists">
          <FilterButton id="all" label="All" filter={filter} setFilter={chooseFilter} />
          <FilterButton id="excluded" label="Excluded" filter={filter} setFilter={chooseFilter} />
          <FilterButton id="included" label="Included" filter={filter} setFilter={chooseFilter} />
          <FilterButton id="outside" label="Not in library" filter={filter} setFilter={chooseFilter} />
        </div>
      </div>

      {status === "ready" && visible.length ? (
        <BulkBar
          visible={visible}
          selectedCount={selectedVisible.length}
          allSelected={allSelected}
          partiallySelected={partiallySelected}
          busy={busy}
          includeSelected={selectedExcluded}
          excludeSelected={selectedIncluded}
          includeView={excludedRows.map((row) => row.uri)}
          excludeView={includedRows.map((row) => row.uri)}
          onSelectAll={() => {
            setSelected(allSelected ? new Set() : new Set(visible.map((row) => row.uri)));
          }}
          onApply={applyExclusion}
        />
      ) : null}

      {status === "loading" ? <Progress value={progress.value} label={progress.label} /> : null}

      {status === "error" ? (
        <div className="taste__status taste__status--error">
          <p role="alert">{error}</p>
          <button type="button" className="taste__action" onClick={reloadPlaylists}>
            Reload playlists
          </button>
        </div>
      ) : null}

      {status === "ready" && !visible.length ? <p className="taste__status">{emptyMessage}</p> : null}

      {status === "ready" && visible.length ? (
        filter === "outside" ? (
          <Group
            title="Not in your library"
            rows={visible}
            pendingUris={pendingUris}
            selected={selected}
            onToggleSelected={toggleOneSelected}
            onToggle={(uri, isExcluded) => applyExclusion([uri], !isExcluded)}
          />
        ) : (
          <>
            {filter !== "included" ? (
              <Group
                title="Excluded"
                rows={excludedRows}
                pendingUris={pendingUris}
                selected={selected}
                onToggleSelected={toggleOneSelected}
                onToggle={(uri, isExcluded) => applyExclusion([uri], !isExcluded)}
              />
            ) : null}
            {filter !== "excluded" ? (
              <Group
                title="Included"
                rows={includedRows}
                pendingUris={pendingUris}
                selected={selected}
                onToggleSelected={toggleOneSelected}
                onToggle={(uri, isExcluded) => applyExclusion([uri], !isExcluded)}
              />
            ) : null}
          </>
        )
      ) : null}

      {undo ? (
        <div className="taste__undo" role="status">
          <span>
            {undo.action === "exclude" ? "Excluded" : "Included"} {playlistCount(undo.uris.length)}.
          </span>
          <button type="button" className="taste__action" disabled={busy} onClick={() => undoLast()}>
            Undo
          </button>
          <button type="button" className="taste__refresh" onClick={() => setUndo(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </section>
  );
}

function BulkBar({
  visible,
  selectedCount,
  allSelected,
  partiallySelected,
  busy,
  includeSelected,
  excludeSelected,
  includeView,
  excludeView,
  onSelectAll,
  onApply,
}: {
  visible: DisplayRow[];
  selectedCount: number;
  allSelected: boolean;
  partiallySelected: boolean;
  busy: boolean;
  includeSelected: string[];
  excludeSelected: string[];
  includeView: string[];
  excludeView: string[];
  onSelectAll: () => void;
  onApply: (uris: string[], shouldExclude: boolean) => void;
}) {
  return (
    <div className="taste__bulk">
      <SelectAll
        checked={allSelected}
        indeterminate={partiallySelected}
        disabled={busy || !visible.length}
        label={selectedCount ? `${selectedCount} selected` : "Select all"}
        onChange={onSelectAll}
      />
      {includeSelected.length ? (
        <button
          type="button"
          className="taste__action"
          disabled={busy}
          onClick={() => onApply(includeSelected, false)}
        >
          {`Include selected (${includeSelected.length})`}
        </button>
      ) : null}
      {excludeSelected.length ? (
        <button
          type="button"
          className="taste__refresh"
          disabled={busy}
          onClick={() => onApply(excludeSelected, true)}
        >
          {`Exclude selected (${excludeSelected.length})`}
        </button>
      ) : null}
      {includeView.length ? (
        <button type="button" className="taste__refresh" disabled={busy} onClick={() => onApply(includeView, false)}>
          {`Include all (${includeView.length})`}
        </button>
      ) : null}
      {excludeView.length ? (
        <button type="button" className="taste__refresh" disabled={busy} onClick={() => onApply(excludeView, true)}>
          {`Exclude all (${excludeView.length})`}
        </button>
      ) : null}
    </div>
  );
}

function SelectAll({
  checked,
  indeterminate,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label className="taste__select">
      <input ref={input} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

function ReloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function Progress({ value, label }: { value: number; label: string }) {
  const percent = Math.round(value * 100);
  return (
    <div className="taste__progress">
      <div className="taste__progress-label">
        <span>{label}</span>
        <span>{`${percent}%`}</span>
      </div>
      <div
        className="taste__progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label}
      >
        <div className="taste__progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function FilterButton({
  id,
  label,
  filter,
  setFilter,
}: {
  id: FilterId;
  label: string;
  filter: FilterId;
  setFilter: (id: FilterId) => void;
}) {
  const selected = filter === id;
  return (
    <button
      type="button"
      className={selected ? "taste__filter taste__filter--active" : "taste__filter"}
      aria-pressed={selected}
      onClick={() => setFilter(id)}
    >
      {label}
    </button>
  );
}

function Group({
  title,
  rows,
  pendingUris,
  selected,
  onToggleSelected,
  onToggle,
}: {
  title: string;
  rows: DisplayRow[];
  pendingUris: Set<string>;
  selected: Set<string>;
  onToggleSelected: (uri: string) => void;
  onToggle: (uri: string, isExcluded: boolean) => void;
}) {
  if (!rows.length) return null;
  return (
    <section className="taste__group" aria-label={title}>
      <h2>{`${title} · ${rows.length}`}</h2>
      <ul className="taste__list">
        {rows.map((row) => (
          <Row
            key={row.uri}
            row={row}
            pending={pendingUris.has(row.uri)}
            checked={selected.has(row.uri)}
            onToggleSelected={onToggleSelected}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </section>
  );
}

function Row({
  row,
  pending,
  checked,
  onToggleSelected,
  onToggle,
}: {
  row: DisplayRow;
  pending: boolean;
  checked: boolean;
  onToggleSelected: (uri: string) => void;
  onToggle: (uri: string, isExcluded: boolean) => void;
}) {
  const details = [
    row.owner,
    row.folder,
    trackLabel(row.tracks),
    row.inLibrary ? "" : "Not in your library",
    row.excluded && row.excludedAt ? `Excluded ${formatDate(row.excludedAt)}` : "",
  ].filter(Boolean);
  const action = row.excluded ? "Include" : "Exclude";

  return (
    <li className={checked ? "taste__row taste__row--selected" : "taste__row"}>
      <label className="taste__check">
        <input
          type="checkbox"
          checked={checked}
          disabled={pending}
          aria-label={`Select ${row.name}`}
          onChange={() => onToggleSelected(row.uri)}
        />
      </label>
      {row.image ? (
        <img className="taste__cover" src={row.image} alt="" />
      ) : (
        <div className="taste__cover taste__cover--empty" aria-hidden="true" />
      )}
      <div className="taste__main">
        <button type="button" className="taste__name" title={row.name} onClick={() => openPlaylist(row.uri)}>
          {row.name}
        </button>
        <p className="taste__meta" title={details.join(" · ")}>
          {details.join(" · ")}
        </p>
      </div>
      <span className={row.excluded ? "taste__badge taste__badge--out" : "taste__badge taste__badge--in"}>
        {row.excluded ? "Excluded" : "Included"}
      </span>
      <button
        type="button"
        className="taste__action"
        disabled={pending}
        aria-label={
          row.excluded
            ? `Include ${row.name} in your taste profile`
            : `Exclude ${row.name} from your taste profile`
        }
        onClick={() => onToggle(row.uri, row.excluded)}
      >
        {pending ? "Working…" : action}
      </button>
    </li>
  );
}
