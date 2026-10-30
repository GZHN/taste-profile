import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./css/app.css";
import { APP_VERSION } from "./version";
import { WindowedList } from "./windowed-list";
import {
  DeadlineError,
  type DecoratedTrack,
  type DisplayPlaylist,
  type DisplayTrack,
  type ExclusionFilter,
  type LibraryNode,
  type PlaylistDisplay,
  type PlaylistRow,
  type PlaylistSort,
  type SavedView,
  type TabId,
  type TrackRow,
  type TrackSort,
  comparePlaylistSort,
  compareTrackSort,
  errorDetail,
  excludedMap,
  failedTrack,
  flattenLibrary,
  formatDate,
  formatDuration,
  formatRelative,
  isPlaylistUri,
  isTrackUri,
  itemCountLabel,
  loadFailureCopy,
  matchesPlaylistQuery,
  matchesTrackQuery,
  ownerLabel,
  parseSavedView,
  playlistCount,
  resolveDecoratedChunk,
  restoreExcluded,
  snapshotExcluded,
  stampExcluded,
  trackCount,
  trackCountLabel,
  uniquePlaylists,
  uniqueTracks,
  undoWrites,
  withDeadline,
} from "./model";

const SET_NAME = "ignoreinrecs";
const SUPPORT_URL =
  "https://support.spotify.com/us/article/exclude-playlists-or-tracks-from-your-taste-profile/";
const VIEW_KEY = "taste-profile:view";
const MASS_CONFIRM_MIN = 11;
/**
 * Wall-clock budget for one load. Each Spotify call is raced against the time
 * remaining, so a hung request ends the attempt instead of waiting forever.
 */
const LOAD_BUDGET_MS = 20000;

const TAB_ORDER: TabId[] = ["playlists", "tracks"];
type Status = "loading" | "ready" | "error";

type UndoState = {
  uris: string[];
  previous: Map<string, number | null>;
  action: "exclude" | "remove";
};

type ProgressState = {
  value: number;
  label: string;
};

type CollectionAPI = {
  get: (name: string) => Promise<unknown>;
  add: (name: string, uris: string[]) => Promise<unknown>;
  remove: (name: string, uris: string[]) => Promise<unknown>;
  subscribe?: (name: string, cb: (items: unknown) => void) => (() => void) | void;
};

type LoadOutcome = {
  apis: TasteApis | null;
  error: string;
};

function readView(): SavedView {
  try {
    const storage = getSpicetify().LocalStorage;
    const raw = storage?.get?.(VIEW_KEY) || localStorage.getItem(VIEW_KEY);
    return parseSavedView(raw);
  } catch {
    return parseSavedView(null);
  }
}

function writeView(view: SavedView) {
  try {
    const payload = JSON.stringify(view);
    const storage = getSpicetify().LocalStorage;
    if (storage?.set) storage.set(VIEW_KEY, payload);
    else localStorage.setItem(VIEW_KEY, payload);
  } catch {
    // A saved view is a convenience. Storage failure should not break the page.
  }
}

function openPlaylist(uri: string) {
  const id = uri.split(":")[2];
  if (!id) return;
  const spice = getSpicetify();
  const push = spice.Platform?.History?.push;
  if (typeof push !== "function") {
    spice.showNotification?.("Couldn't open this playlist. Try again.", true);
    return;
  }
  push(`/playlist/${id}`);
}

function openTrack(uri: string) {
  const id = uri.split(":")[2];
  if (!id) return;
  const spice = getSpicetify();
  const push = spice.Platform?.History?.push;
  if (typeof push !== "function") {
    spice.showNotification?.("Couldn't open this track. Try again.", true);
    return;
  }
  push(`/track/${id}`);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type TasteApis = {
  collection: CollectionAPI;
  rootlist: { getContents: () => Promise<LibraryNode> };
};

function getSpicetify(): typeof Spicetify {
  // Custom apps can mount in a nested frame; prefer the top Spicetify host.
  try {
    if (typeof window !== "undefined" && window.top && window.top !== window) {
      const topSpice = (window.top as Window & { Spicetify?: typeof Spicetify }).Spicetify;
      if (topSpice?.Platform) return topSpice;
    }
  } catch {
    // Cross-origin frame access can throw; fall back to local Spicetify.
  }
  return Spicetify;
}

function getTasteApis(): TasteApis | null {
  const spice = getSpicetify();
  const platform = spice?.Platform;
  const collection = platform?.CollectionPlatformAPI as CollectionAPI | undefined;
  const rootlist = platform?.RootlistAPI as TasteApis["rootlist"] | undefined;
  if (!platform || typeof collection?.get !== "function" || typeof rootlist?.getContents !== "function") {
    return null;
  }
  return { collection, rootlist };
}

async function loadExcludedTracks(uris: string[]): Promise<TrackRow[]> {
  const unique = [...new Set(uris)];
  if (!unique.length) return [];

  const spice = getSpicetify();
  const defs = spice.GraphQL?.Definitions as { decorateContextTracks?: unknown } | undefined;
  const request = spice.GraphQL?.Request;
  if (!defs?.decorateContextTracks || typeof request !== "function") {
    return unique.map(failedTrack);
  }

  const byUri = new Map<string, TrackRow>();
  const chunkSize = 50;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    try {
      const response = (await request(defs.decorateContextTracks, { uris: chunk })) as {
        data?: { tracks?: Array<DecoratedTrack | null> };
      };
      for (const row of resolveDecoratedChunk(chunk, response?.data?.tracks || [])) {
        byUri.set(row.uri, row);
      }
    } catch {
      for (const uri of chunk) byUri.set(uri, failedTrack(uri));
    }
  }

  return unique.map((uri) => byUri.get(uri) || failedTrack(uri));
}

export default function App() {
  const [library, setLibrary] = useState<PlaylistRow[]>([]);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [excluded, setExcluded] = useState<Map<string, number>>(() => new Map());
  const [status, setStatus] = useState<Status>("loading");
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<ProgressState>({ value: 0, label: "Starting…" });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const savedView = useMemo(() => readView(), []);
  const [tab, setTab] = useState<TabId>(savedView.tab);
  const [exclusionFilter, setExclusionFilter] = useState<ExclusionFilter>(savedView.exclusionFilter);
  const [playlistSort, setPlaylistSort] = useState<PlaylistSort>(savedView.playlistSort);
  const [trackSort, setTrackSort] = useState<TrackSort>(savedView.trackSort);
  const [playlistDisplay, setPlaylistDisplay] = useState<PlaylistDisplay>(savedView.playlistDisplay);
  const [playlistQuery, setPlaylistQuery] = useState(savedView.playlistQuery);
  const [trackQuery, setTrackQuery] = useState(savedView.trackQuery);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pendingUris, setPendingUris] = useState<Set<string>>(() => new Set());
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [openMenuUri, setOpenMenuUri] = useState<string | null>(null);
  const libraryRef = useRef<PlaylistRow[]>([]);
  const tracksRef = useRef<TrackRow[]>([]);
  const excludedRef = useRef(excluded);
  const applying = useRef(false);

  useEffect(() => {
    excludedRef.current = excluded;
  }, [excluded]);

  useEffect(() => {
    writeView({
      tab,
      exclusionFilter,
      playlistSort,
      trackSort,
      playlistDisplay,
      trackFilter: exclusionFilter,
      trackDisplay: playlistDisplay,
      playlistQuery,
      trackQuery,
    });
  }, [tab, exclusionFilter, playlistSort, trackSort, playlistDisplay, playlistQuery, trackQuery]);

  useEffect(() => {
    if (!openMenuUri) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.(".taste__menu")) setOpenMenuUri(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const trigger = document.querySelector<HTMLElement>('.taste__menu [aria-expanded="true"]');
      setOpenMenuUri(null);
      trigger?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenuUri]);

  const reportProgress = useCallback((value: number, label: string) => {
    setProgress({ value: Math.min(1, Math.max(0, value)), label });
  }, []);

  const rememberTracks = useCallback(async (uris: string[]) => {
    const known = new Set(tracksRef.current.map((row) => row.uri));
    const missing = uris.filter((uri) => isTrackUri(uri) && !known.has(uri));
    if (!missing.length) return;
    const loaded = await loadExcludedTracks(missing);
    setTracks((current) => {
      const next = uniqueTracks([...current, ...loaded]);
      tracksRef.current = next;
      return next;
    });
  }, []);

  const applyLoadedData = useCallback(
    (ignored: unknown, contents: LibraryNode, loadedTracks: TrackRow[]) => {
      const map = excludedMap(ignored);
      const rows = uniquePlaylists(flattenLibrary(contents));
      libraryRef.current = rows;
      tracksRef.current = uniqueTracks(loadedTracks);
      setLibrary(rows);
      setTracks(tracksRef.current);
      excludedRef.current = map;
      setExcluded(map);
      setLastUpdatedAt(Date.now());
      reportProgress(1, "Taste profile loaded");
      return map;
    },
    [reportProgress]
  );

  /**
   * Keep trying until Spotify answers or LOAD_BUDGET_MS elapses. Methods can
   * exist before they work, so we probe with real get()/getContents() calls.
   * Each call is bounded by the time still left, including a request that
   * never settles.
   *
   * `signal.cancelled` only skips applying results — it must not surface as a
   * hard UI error (Spicetify remounts the page during navigation; Refresh works
   * because it never uses a cancellation flag).
   */
  const loadWithRetry = useCallback(
    async (signal?: { cancelled: boolean }): Promise<LoadOutcome> => {
      let attempt = 0;
      let lastError = "";
      const started = Date.now();
      const budgetLeft = () => LOAD_BUDGET_MS - (Date.now() - started);
      const timedOut = (): LoadOutcome => ({
        apis: null,
        error: lastError || "Spotify took too long to respond",
      });

      while (!signal?.cancelled) {
        if (budgetLeft() <= 0) return timedOut();

        attempt += 1;
        const apis = getTasteApis();
        if (!apis) {
          if (!signal?.cancelled) reportProgress(0.05, "Waiting for Spotify");
          const wait = Math.min(300, budgetLeft());
          if (wait <= 0) return timedOut();
          await delay(wait);
          continue;
        }

        try {
          if (!signal?.cancelled) {
            reportProgress(0.12, attempt === 1 ? "Connecting to Spotify" : "Retrying connection");
            reportProgress(0.22, "Loading your library");
          }

          // Fetch separately so one cold API doesn't fail the whole attempt.
          const ignored = await withDeadline(apis.collection.get(SET_NAME), budgetLeft());
          if (signal?.cancelled) return { apis: null, error: "" };
          const contents = await withDeadline(apis.rootlist.getContents(), budgetLeft());
          if (signal?.cancelled) return { apis: null, error: "" };

          const map = excludedMap(ignored);
          const trackUris = [...map.keys()].filter(isTrackUri);
          if (!signal?.cancelled) {
            reportProgress(
              trackUris.length ? 0.4 : 1,
              trackUris.length ? "Loading exclusions" : "Taste profile loaded"
            );
          }
          const loadedTracks = trackUris.length ? await withDeadline(loadExcludedTracks(trackUris), budgetLeft()) : [];
          if (signal?.cancelled) return { apis: null, error: "" };

          applyLoadedData(ignored, contents, loadedTracks);
          return { apis, error: "" };
        } catch (loadError) {
          if (signal?.cancelled) return { apis: null, error: "" };
          lastError = errorDetail(loadError);
          reportProgress(0.08, `Waiting for Spotify (${lastError.slice(0, 80)})`);
          if (loadError instanceof DeadlineError || budgetLeft() <= 0) return { apis: null, error: lastError };
          const wait = Math.min(budgetLeft(), Math.min(2000, 400 + attempt * 150));
          if (wait <= 0) return { apis: null, error: lastError };
          await delay(wait);
        }
      }
      return { apis: null, error: "" };
    },
    [applyLoadedData, reportProgress]
  );

  const loadWithRetryRef = useRef(loadWithRetry);
  const rememberTracksRef = useRef(rememberTracks);
  useEffect(() => {
    loadWithRetryRef.current = loadWithRetry;
  }, [loadWithRetry]);
  useEffect(() => {
    rememberTracksRef.current = rememberTracks;
  }, [rememberTracks]);

  // Mount-once bootstrap. Defer past Spotify's route transition — hitting
  // Collection/Rootlist during the first paint is what forces a manual Refresh.
  useEffect(() => {
    let unsubscribe = () => {};
    const signal = { cancelled: false };

    const boot = window.setTimeout(() => {
      void (async () => {
        const result = await loadWithRetryRef.current(signal);
        if (signal.cancelled) return;
        if (!result.apis) {
          setRefreshError("");
          setError(loadFailureCopy("load", result.error));
          setStatus("error");
          return;
        }
        setError("");
        setRefreshError("");
        setStatus("ready");
        const subscribe = result.apis.collection.subscribe;
        if (typeof subscribe !== "function") return;
        const stop = subscribe(SET_NAME, (items) => {
          if (applying.current) return;
          const map = excludedMap(items);
          excludedRef.current = map;
          setExcluded(map);
          void rememberTracksRef.current([...map.keys()]);
        });
        if (typeof stop === "function") unsubscribe = stop;
      })();
    }, 600);

    return () => {
      signal.cancelled = true;
      window.clearTimeout(boot);
      unsubscribe();
    };
  }, []);

  async function applyExclusion(uris: string[], shouldExclude: boolean) {
    const unique = [...new Set(uris)];
    if (!unique.length) return;
    const spice = getSpicetify();
    if (applying.current) {
      spice.showNotification?.("Wait until the current update finishes.");
      return;
    }
    const api = spice.Platform?.CollectionPlatformAPI as CollectionAPI | undefined;
    if (!api || typeof api.add !== "function" || typeof api.remove !== "function") {
      spice.showNotification?.(
        unique.length === 1 ? "Couldn't update this item. Try again." : "Couldn't update these items. Try again.",
        true
      );
      return;
    }
    const previous = snapshotExcluded(excludedRef.current, unique);
    const stamp = Math.floor(Date.now() / 1000);

    applying.current = true;
    setPendingUris(new Set(unique));
    setExcluded((current) => {
      const next = stampExcluded(current, unique, shouldExclude, stamp);
      excludedRef.current = next;
      return next;
    });

    try {
      if (shouldExclude) await api.add(SET_NAME, unique);
      else await api.remove(SET_NAME, unique);
      setUndo({
        uris: unique,
        previous,
        action: shouldExclude ? "exclude" : "remove",
      });
      setSelected(new Set());
      setOpenMenuUri(null);
      spice.showNotification(
        shouldExclude
          ? `Excluded ${itemCountLabel(unique)} from your taste profile.`
          : `Removed exclusion for ${itemCountLabel(unique)}.`
      );
    } catch {
      setExcluded((current) => {
        const next = restoreExcluded(current, previous);
        excludedRef.current = next;
        return next;
      });
      spice.showNotification(
        unique.length === 1 ? "Couldn't update this item. Try again." : "Couldn't update these items. Try again.",
        true
      );
    } finally {
      applying.current = false;
      setPendingUris(new Set());
    }
  }

  async function undoLast() {
    if (!undo || applying.current) return;
    const spice = getSpicetify();
    const api = spice.Platform?.CollectionPlatformAPI as CollectionAPI | undefined;
    if (!api || typeof api.add !== "function" || typeof api.remove !== "function") {
      spice.showNotification?.("Couldn't undo that change. Try again.", true);
      return;
    }
    const snapshot = undo;
    const { add: toExclude, remove: toRemove } = undoWrites(snapshot.previous);
    const beforeUndo = snapshotExcluded(excludedRef.current, snapshot.uris);

    applying.current = true;
    setUndo(null);
    setPendingUris(new Set(snapshot.uris));
    setExcluded((current) => {
      const next = restoreExcluded(current, snapshot.previous);
      excludedRef.current = next;
      return next;
    });

    try {
      if (toExclude.length) await api.add(SET_NAME, toExclude);
      if (toRemove.length) await api.remove(SET_NAME, toRemove);
      spice.showNotification("Change undone.");
    } catch {
      setExcluded((current) => {
        const next = restoreExcluded(current, beforeUndo);
        excludedRef.current = next;
        return next;
      });
      setUndo(snapshot);
      spice.showNotification("Couldn't undo that change. Try again.", true);
    } finally {
      applying.current = false;
      setPendingUris(new Set());
    }
  }

  function chooseTab(next: TabId) {
    setTab(next);
    setSelected(new Set());
    setOpenMenuUri(null);
  }

  function onTabListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = TAB_ORDER.indexOf(tab);
    if (index < 0) return;

    let nextIndex = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % TAB_ORDER.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = TAB_ORDER.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const next = TAB_ORDER[nextIndex];
    chooseTab(next);
    const tabId = next === "playlists" ? "taste-tab-playlists" : "taste-tab-tracks";
    window.requestAnimationFrame(() => document.getElementById(tabId)?.focus());
  }

  function chooseExclusionFilter(next: ExclusionFilter) {
    setExclusionFilter(next);
    setSelected(new Set());
  }

  function reloadAll() {
    if (status === "loading" || reloading) return;
    const keepList = status === "ready";
    setError("");
    setRefreshError("");
    setProgress({ value: 0, label: "Loading taste profile" });
    if (keepList) setReloading(true);
    else setStatus("loading");
    loadWithRetry()
      .then((result) => {
        if (!result.apis) {
          const message = loadFailureCopy(keepList ? "refresh" : "load", result.error);
          if (keepList) setRefreshError(message);
          else setError(message);
          if (!keepList) setStatus("error");
          setReloading(false);
          return;
        }
        setRefreshError("");
        setError("");
        setStatus("ready");
        setReloading(false);
      })
      .catch((loadError) => {
        const message = loadFailureCopy(keepList ? "refresh" : "load", errorDetail(loadError));
        if (keepList) setRefreshError(message);
        else {
          setError(message);
          setStatus("error");
        }
        setReloading(false);
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

  const playlistNeedle = playlistQuery.trim().toLocaleLowerCase("en");
  const trackNeedle = trackQuery.trim().toLocaleLowerCase("en");

  const playlistRows = useMemo((): DisplayPlaylist[] => {
    return uniquePlaylists(library).map((row) => ({
      ...row,
      excluded: excluded.has(row.uri),
      excludedAt: excluded.get(row.uri) || 0,
    }));
  }, [library, excluded]);

  const trackRows = useMemo((): DisplayTrack[] => {
    return uniqueTracks(tracks).map((row) => ({
      ...row,
      excluded: excluded.has(row.uri),
      excludedAt: excluded.get(row.uri) || 0,
    }));
  }, [tracks, excluded]);

  const excludedPlaylistCount = playlistRows.filter((row) => row.excluded).length;
  const notExcludedCount = playlistRows.filter((row) => !row.excluded).length;
  const excludedTrackCount = trackRows.filter((row) => row.excluded).length;

  const visiblePlaylists = playlistRows
    .filter((row) => {
      if (exclusionFilter === "excluded" && !row.excluded) return false;
      if (exclusionFilter === "not_excluded" && row.excluded) return false;
      return matchesPlaylistQuery(row, playlistNeedle);
    })
    .sort((a, b) => comparePlaylistSort(a, b, playlistSort));

  const visibleTracks = trackRows
    .filter((row) => {
      if (exclusionFilter === "excluded" && !row.excluded) return false;
      if (exclusionFilter === "not_excluded" && row.excluded) return false;
      return matchesTrackQuery(row, trackNeedle);
    })
    .sort((a, b) => compareTrackSort(a, b, trackSort));

  const visibleUris = (tab === "playlists" ? visiblePlaylists : visibleTracks).map((row) => row.uri);
  const selectedVisible = visibleUris.filter((uri) => selected.has(uri));
  const selectedExcluded = selectedVisible.filter((uri) => excluded.has(uri));
  const selectedNotExcluded = selectedVisible.filter((uri) => {
    if (excluded.has(uri)) return false;
    return tab === "tracks" ? isTrackUri(uri) : isPlaylistUri(uri);
  });
  const allSelected = visibleUris.length > 0 && selectedVisible.length === visibleUris.length;
  const partiallySelected = selectedVisible.length > 0 && !allSelected;
  const busy = pendingUris.size > 0;
  const loading = status === "loading" || reloading;

  let playlistEmptyTitle = "No playlists match";
  let playlistEmptyBody = "Try another search or filter.";
  if (!playlistNeedle && playlistRows.length === 0) {
    playlistEmptyTitle = "No playlists available";
    playlistEmptyBody = "Your Spotify library could not provide playlists yet.";
  } else if (!playlistNeedle && exclusionFilter === "excluded") {
    playlistEmptyTitle = "No excluded playlists";
    playlistEmptyBody = "None of your playlists are currently excluded from your taste profile.";
  } else if (!playlistNeedle && exclusionFilter === "not_excluded") {
    playlistEmptyTitle = "No matching playlists";
    playlistEmptyBody = "Every playlist in this view is already excluded.";
  }

  let trackEmptyTitle = "No matching tracks";
  let trackEmptyBody = "Try another search or filter.";
  if (!trackNeedle && exclusionFilter === "not_excluded") {
    trackEmptyTitle = "No tracks in this filter";
    trackEmptyBody =
      "Spotify only returns tracks you've excluded. After you remove an exclusion, that track stays under Not excluded until you refresh.";
  } else if (!trackNeedle && !trackRows.some((row) => (exclusionFilter === "all" ? true : row.excluded))) {
    trackEmptyTitle = "No excluded tracks";
    trackEmptyBody = "You don't currently have any individually excluded tracks from your taste profile.";
  }

  return (
    <section className="taste">
      <header className="taste__header">
        <div className="taste__title-block">
          <div className="taste__title-row">
            <h1>Taste Profile</h1>
            <span className="taste__version" aria-label={`Version ${APP_VERSION}`}>
              v{APP_VERSION}
            </span>
          </div>
          <p className="taste__subtitle">
            Take control of which playlists and tracks are excluded from your Spotify taste profile.
          </p>
        </div>
        <div className="taste__header-actions">
          <div className="taste__header-buttons">
            <button
              type="button"
              className="taste__icon-btn"
              aria-label="About Taste Profile"
              aria-expanded={helpOpen}
              aria-controls="taste-help"
              title="About Taste Profile"
              onClick={() => setHelpOpen((open) => !open)}
            >
              <InfoIcon />
            </button>
            <button
              type="button"
              className={loading ? "taste__refresh is-loading" : "taste__refresh"}
              aria-label="Refresh"
              title="Refresh"
              disabled={loading}
              onClick={reloadAll}
            >
              <ReloadIcon />
              <span>Refresh</span>
            </button>
          </div>
          {lastUpdatedAt ? <LastUpdated at={lastUpdatedAt} /> : null}
        </div>
      </header>

      {helpOpen ? (
        <div className="taste__help" id="taste-help">
          <p>
            Taste Profile gives you a centralized way to manage which playlists and tracks are excluded from your
            Spotify taste profile. Spotify uses your listening activity to personalize recommendations and experiences
            such as Discover Weekly, Wrapped, and Blend.{" "}
            <a
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
          <p>
            Manage exclusions individually or in bulk. Switch the list between Playlists and Tracks; the filter,
            search, and Compact or List view stay on the page. Excluding a playlist only
            affects listens from that playlist; excluding a track affects that song everywhere. Removing a playlist
            exclusion does not remove separately excluded tracks.
          </p>
        </div>
      ) : null}

      <div
        className="taste__tabs"
        role="tablist"
        aria-label="Taste Profile views"
        onKeyDown={onTabListKeyDown}
      >
        <button
          type="button"
          role="tab"
          className="taste__tab"
          id="taste-tab-playlists"
          aria-selected={tab === "playlists"}
          aria-controls="taste-panel-playlists"
          tabIndex={tab === "playlists" ? 0 : -1}
          onClick={() => chooseTab("playlists")}
        >
          <span>Playlists</span>
          <span className="taste__tab-count">{status === "ready" ? playlistRows.length : "–"}</span>
        </button>
        <button
          type="button"
          role="tab"
          className="taste__tab"
          id="taste-tab-tracks"
          aria-selected={tab === "tracks"}
          aria-controls="taste-panel-tracks"
          tabIndex={tab === "tracks" ? 0 : -1}
          onClick={() => chooseTab("tracks")}
        >
          <span>Tracks</span>
          <span className="taste__tab-count">{status === "ready" ? excludedTrackCount : "–"}</span>
        </button>
      </div>

      {loading ? <Progress value={progress.value} label={progress.label} /> : null}

      {status === "error" ? (
        <div className="taste__status taste__status--error">
          <p role="alert">{error}</p>
          <button type="button" className="taste__btn taste__btn--primary" onClick={reloadAll}>
            Refresh
          </button>
        </div>
      ) : null}

      {status === "ready" && refreshError ? (
        <div className="taste__status taste__status--error">
          <p role="alert">{refreshError}</p>
        </div>
      ) : null}

      {status === "ready" ? (
        <div
          role="tabpanel"
          id={tab === "playlists" ? "taste-panel-playlists" : "taste-panel-tracks"}
          aria-labelledby={tab === "playlists" ? "taste-tab-playlists" : "taste-tab-tracks"}
        >
          <div className="taste__summary" aria-label="Taste profile summary">
            <SummaryCard tone="warn" icon={<MinusIcon />} value={excludedPlaylistCount} label="Playlists excluded" />
            <SummaryCard tone="ok" icon={<CheckIcon />} value={notExcludedCount} label="Playlists not excluded" />
            <SummaryCard tone="warn" icon={<MinusIcon />} value={excludedTrackCount} label="Tracks excluded" />
          </div>

          <div className="taste__toolbar">
            <div className="taste__filters" role="group" aria-label="Exclusion filter">
              <Chip label="All" pressed={exclusionFilter === "all"} onClick={() => chooseExclusionFilter("all")} />
              <Chip
                label="Excluded"
                pressed={exclusionFilter === "excluded"}
                onClick={() => chooseExclusionFilter("excluded")}
              />
              <Chip
                label="Not excluded"
                pressed={exclusionFilter === "not_excluded"}
                onClick={() => chooseExclusionFilter("not_excluded")}
              />
            </div>
            <SearchField
              value={tab === "playlists" ? playlistQuery : trackQuery}
              placeholder={tab === "playlists" ? "Search playlists..." : "Search tracks, artists, or albums..."}
              label={tab === "playlists" ? "Search playlists" : "Search tracks, artists, or albums"}
              onChange={(value) => {
                if (tab === "playlists") setPlaylistQuery(value);
                else setTrackQuery(value);
                setSelected(new Set());
              }}
            />
            <div className="taste__toolbar-end">
              <label className="taste__select-wrap">
                <span>Sort:</span>
                {tab === "playlists" ? (
                  <select
                    value={playlistSort}
                    aria-label="Sort playlists"
                    onChange={(event) => {
                      setPlaylistSort(event.target.value as PlaylistSort);
                      setSelected(new Set());
                    }}
                  >
                    <option value="library">Custom</option>
                    <option value="name">Name A–Z</option>
                    <option value="name-desc">Name Z–A</option>
                    <option value="tracks">Tracks ↑</option>
                    <option value="tracks-desc">Tracks ↓</option>
                    <option value="recent">Recently excluded</option>
                  </select>
                ) : (
                  <select
                    value={trackSort}
                    aria-label="Sort tracks"
                    onChange={(event) => {
                      setTrackSort(event.target.value as TrackSort);
                      setSelected(new Set());
                    }}
                  >
                    <option value="name">Name A–Z</option>
                    <option value="name-desc">Name Z–A</option>
                    <option value="artist">Artist</option>
                    <option value="album">Album</option>
                    <option value="recent">Recently excluded</option>
                  </select>
                )}
              </label>
              <ViewAsControl value={playlistDisplay} onChange={setPlaylistDisplay} />
            </div>
          </div>

          {selectedVisible.length ? (
            <BulkBar
              label={`${selectedVisible.length} ${
                tab === "playlists"
                  ? selectedVisible.length === 1
                    ? "playlist"
                    : "playlists"
                  : selectedVisible.length === 1
                    ? "track"
                    : "tracks"
              } selected`}
              busy={busy}
              primaryLabel={selectedNotExcluded.length ? "Exclude selected" : undefined}
              onPrimary={
                selectedNotExcluded.length
                  ? () => {
                      const noun =
                        tab === "playlists"
                          ? playlistCount(selectedNotExcluded.length)
                          : trackCount(selectedNotExcluded.length);
                      if (
                        selectedNotExcluded.length >= MASS_CONFIRM_MIN &&
                        !window.confirm(`Exclude ${noun} from your taste profile?`)
                      ) {
                        return;
                      }
                      void applyExclusion(selectedNotExcluded, true);
                    }
                  : undefined
              }
              secondaryLabel={selectedExcluded.length ? "Remove exclusion" : undefined}
              onSecondary={
                selectedExcluded.length
                  ? () => {
                      if (
                        selectedExcluded.length >= MASS_CONFIRM_MIN &&
                        !window.confirm(`Remove exclusion for ${itemCountLabel(selectedExcluded)}?`)
                      ) {
                        return;
                      }
                      void applyExclusion(selectedExcluded, false);
                    }
                  : undefined
              }
              onClear={() => setSelected(new Set())}
            />
          ) : null}

          {tab === "playlists" && visiblePlaylists.length ? (
            <div
              className={
                playlistDisplay === "compact"
                  ? "taste__table taste__table--playlists taste__table--compact"
                  : "taste__table taste__table--playlists"
              }
            >
              <div className="taste__table-head">
                <SelectAll
                  checked={allSelected}
                  indeterminate={partiallySelected}
                  disabled={busy}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(visibleUris))}
                />
                <span aria-hidden="true">Playlist</span>
                <span className="taste__col-tracks" aria-hidden="true">
                  Tracks
                </span>
                <span className="taste__col-taste" aria-hidden="true">
                  Taste profile
                </span>
                <span aria-hidden="true">Action</span>
                <span className="taste__col-more" aria-hidden="true" />
              </div>
              <ul className="taste__list">
                <WindowedList
                  items={visiblePlaylists}
                  rowHeight={playlistDisplay === "compact" ? 38 : 64}
                  getKey={(row) => row.uri}
                  renderItem={(row) => (
                    <PlaylistRowView
                      row={row}
                      display={playlistDisplay}
                      pending={pendingUris.has(row.uri)}
                      locked={busy}
                      checked={selected.has(row.uri)}
                      menuOpen={openMenuUri === row.uri}
                      onToggleSelected={toggleOneSelected}
                      onToggle={(uri, isExcluded) => void applyExclusion([uri], !isExcluded)}
                      onMenuToggle={() => setOpenMenuUri((current) => (current === row.uri ? null : row.uri))}
                      onMenuClose={() => setOpenMenuUri(null)}
                    />
                  )}
                />
              </ul>
            </div>
          ) : tab === "playlists" ? (
            <EmptyState title={playlistEmptyTitle} body={playlistEmptyBody} />
          ) : visibleTracks.length ? (
            <div
              className={
                playlistDisplay === "compact"
                  ? "taste__table taste__table--tracks taste__table--compact"
                  : "taste__table taste__table--tracks"
              }
            >
              <div className="taste__table-head">
                <SelectAll
                  checked={allSelected}
                  indeterminate={partiallySelected}
                  disabled={busy}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(visibleUris))}
                />
                <span aria-hidden="true">Track</span>
                <span className="taste__col-album" aria-hidden="true">
                  Album
                </span>
                <span className="taste__col-duration" aria-hidden="true">
                  Duration
                </span>
                <span className="taste__col-added" aria-hidden="true">
                  Added
                </span>
                <span aria-hidden="true">Action</span>
                <span className="taste__col-more" aria-hidden="true" />
              </div>
              <ul className="taste__list">
                <WindowedList
                  items={visibleTracks}
                  rowHeight={playlistDisplay === "compact" ? 38 : 64}
                  getKey={(row) => row.uri}
                  renderItem={(row) => (
                    <TrackRowView
                      row={row}
                      display={playlistDisplay}
                      pending={pendingUris.has(row.uri)}
                      locked={busy}
                      checked={selected.has(row.uri)}
                      menuOpen={openMenuUri === row.uri}
                      onToggleSelected={toggleOneSelected}
                      onToggle={(uri, isExcluded) => void applyExclusion([uri], !isExcluded)}
                      onMenuToggle={() => setOpenMenuUri((current) => (current === row.uri ? null : row.uri))}
                      onMenuClose={() => setOpenMenuUri(null)}
                    />
                  )}
                />
              </ul>
            </div>
          ) : (
            <EmptyState title={trackEmptyTitle} body={trackEmptyBody} icon={<MutedNoteIcon />} />
          )}
        </div>
      ) : null}

      {undo ? (
        <div className="taste__undo" role="status">
          <span>
            {undo.action === "exclude" ? "Excluded" : "Removed exclusion for"} {itemCountLabel(undo.uris)}.
          </span>
          <button type="button" className="taste__btn taste__btn--primary" disabled={busy} onClick={() => void undoLast()}>
            Undo
          </button>
          <button type="button" className="taste__btn" onClick={() => setUndo(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </section>
  );
}

function LastUpdated({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [at]);
  return (
    <p className="taste__updated" aria-live="polite">
      {formatRelative(at, now)}
    </p>
  );
}

function SummaryCard({
  tone,
  icon,
  value,
  label,
}: {
  tone: "warn" | "ok";
  icon: React.ReactNode;
  value: number;
  label: string;
}) {
  const iconClass = tone === "warn" ? "taste__stat-icon taste__stat-icon--warn" : "taste__stat-icon taste__stat-icon--ok";
  return (
    <div className="taste__stat">
      <span className={iconClass} aria-hidden="true">
        {icon}
      </span>
      <div className="taste__stat-body">
        <p className="taste__stat-value">{value}</p>
        <p className="taste__stat-label">{label}</p>
      </div>
    </div>
  );
}

function Chip({ label, pressed, onClick }: { label: string; pressed: boolean; onClick: () => void }) {
  return (
    <button type="button" className="taste__chip" aria-pressed={pressed} onClick={onClick}>
      {label}
    </button>
  );
}

const VIEW_AS_OPTIONS: Array<{ value: PlaylistDisplay; label: string }> = [
  { value: "compact", label: "Compact" },
  { value: "list", label: "List" },
];

function ViewAsControl({
  value,
  onChange,
}: {
  value: PlaylistDisplay;
  onChange: (next: PlaylistDisplay) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);

  const focusOption = (mode: PlaylistDisplay) => {
    const root = groupRef.current;
    if (!root) return;
    const button = root.querySelector<HTMLButtonElement>(`button[data-view="${mode}"]`);
    button?.focus();
  };

  const select = (mode: PlaylistDisplay) => {
    if (mode === value) return;
    onChange(mode);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = VIEW_AS_OPTIONS.findIndex((option) => option.value === value);
    if (index < 0) return;

    let nextIndex = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % VIEW_AS_OPTIONS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + VIEW_AS_OPTIONS.length) % VIEW_AS_OPTIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = VIEW_AS_OPTIONS.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const next = VIEW_AS_OPTIONS[nextIndex].value;
    select(next);
    focusOption(next);
  };

  return (
    <div
      ref={groupRef}
      className="taste__view-as"
      role="radiogroup"
      aria-label="View as"
      onKeyDown={onKeyDown}
    >
      {VIEW_AS_OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={selected ? "taste__view-as-btn taste__view-as-btn--selected" : "taste__view-as-btn"}
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            title={option.label}
            tabIndex={selected ? 0 : -1}
            data-view={option.value}
            onClick={() => select(option.value)}
          >
            {option.value === "compact" ? <CompactViewIcon /> : <ListViewIcon />}
          </button>
        );
      })}
    </div>
  );
}

function SearchField({
  value,
  placeholder,
  label,
  onChange,
}: {
  value: string;
  placeholder: string;
  label: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="taste__search">
      <SearchIcon />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function BulkBar({
  label,
  busy,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  onClear,
}: {
  label: string;
  busy: boolean;
  primaryLabel?: string;
  secondaryLabel?: string;
  onPrimary?: () => void;
  onSecondary?: () => void;
  onClear: () => void;
}) {
  return (
    <div className="taste__bulk" role="region" aria-label="Bulk actions">
      <span className="taste__bulk-label">{label}</span>
      {primaryLabel && onPrimary ? (
        <button type="button" className="taste__btn taste__btn--primary" disabled={busy} onClick={onPrimary}>
          {primaryLabel}
        </button>
      ) : null}
      {secondaryLabel && onSecondary ? (
        <button type="button" className="taste__btn taste__btn--ghost" disabled={busy} onClick={onSecondary}>
          {secondaryLabel}
        </button>
      ) : null}
      <button type="button" className="taste__btn" disabled={busy} onClick={onClear}>
        Clear
      </button>
    </div>
  );
}

function SelectAll({
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label className="taste__check">
      <input
        ref={input}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={checked ? "Deselect all" : "Select all"}
        onChange={onChange}
      />
    </label>
  );
}

function EmptyState({
  title,
  body,
  icon,
}: {
  title: string;
  body: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="taste__empty" role="status">
      <span className="taste__empty-icon" aria-hidden="true">
        {icon || <MutedNoteIcon />}
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
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

type MenuAction = {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
};

function MoreActionsMenu({
  open,
  triggerLabel,
  onToggle,
  onClose,
  actions,
}: {
  open: boolean;
  triggerLabel: string;
  onToggle: () => void;
  onClose: () => void;
  actions: MenuAction[];
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLButtonElement>(
      '.taste__menu-item:not(:disabled), [role="menuitem"]:not([disabled])'
    );
    first?.focus();
  }, [open]);

  const focusItem = (index: number) => {
    const items = enabledMenuItems(panelRef.current);
    if (!items.length) return;
    const next = ((index % items.length) + items.length) % items.length;
    items[next]?.focus();
  };

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = enabledMenuItems(panelRef.current);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(current < 0 ? 0 : current + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(current < 0 ? items.length - 1 : current - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusItem(items.length - 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    }
  };

  return (
    <div className="taste__menu taste__cell-more">
      <button
        ref={triggerRef}
        type="button"
        className="taste__btn taste__btn--icon"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div ref={panelRef} className="taste__menu-panel" role="menu" onKeyDown={onPanelKeyDown}>
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="taste__menu-item"
              role="menuitem"
              disabled={action.disabled}
              onClick={() => {
                action.onSelect();
                onClose();
                triggerRef.current?.focus();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function enabledMenuItems(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).filter(
    (item) => !item.disabled
  );
}

function PlaylistRowView({
  row,
  display,
  pending,
  locked,
  checked,
  menuOpen,
  onToggleSelected,
  onToggle,
  onMenuToggle,
  onMenuClose,
}: {
  row: DisplayPlaylist;
  display: PlaylistDisplay;
  pending: boolean;
  locked: boolean;
  checked: boolean;
  menuOpen: boolean;
  onToggleSelected: (uri: string) => void;
  onToggle: (uri: string, isExcluded: boolean) => void;
  onMenuToggle: () => void;
  onMenuClose: () => void;
}) {
  const compact = display === "compact";
  const meta = [ownerLabel(row.owner), row.folder].filter(Boolean).join(" · ");
  const action = row.excluded ? "Remove exclusion" : "Exclude";

  return (
    <li className={checked ? "taste__row taste__row--selected" : "taste__row"}>
      <label className="taste__check">
        <input
          type="checkbox"
          checked={checked}
          disabled={locked}
          aria-label={`Select ${row.name}`}
          onChange={() => onToggleSelected(row.uri)}
        />
      </label>
      <div className="taste__media">
        {compact ? null : row.image ? (
          <img className="taste__cover" src={row.image} alt="" />
        ) : (
          <div className="taste__cover taste__cover--empty" aria-hidden="true" />
        )}
        <div className="taste__main">
          <button type="button" className="taste__name" title={row.name} onClick={() => openPlaylist(row.uri)}>
            {row.name}
          </button>
          {!compact && meta ? (
            <p className="taste__meta" title={meta}>
              {meta}
            </p>
          ) : null}
        </div>
      </div>
      <span className="taste__cell taste__cell--num taste__cell-tracks">{trackCountLabel(row.tracks)}</span>
      <span className="taste__cell taste__cell-taste">
        <span className={row.excluded ? "taste__status-pill taste__status-pill--warn" : "taste__status-pill"}>
          <span className="taste__status-dot" aria-hidden="true" />
          <span>{row.excluded ? "Excluded" : "Not excluded"}</span>
        </span>
      </span>
      <div className="taste__row-actions">
        <button
          type="button"
          className={row.excluded ? "taste__btn taste__btn--row taste__btn--row-outline" : "taste__btn taste__btn--row taste__btn--primary"}
          disabled={locked}
          aria-label={
            row.excluded
              ? `Remove exclusion for ${row.name}`
              : `Exclude ${row.name} from your taste profile`
          }
          onClick={() => onToggle(row.uri, row.excluded)}
        >
          {pending ? "Working…" : action}
        </button>
      </div>
      <MoreActionsMenu
        open={menuOpen}
        triggerLabel={`More actions for ${row.name}`}
        onToggle={onMenuToggle}
        onClose={onMenuClose}
        actions={[
          {
            label: "Open playlist",
            onSelect: () => openPlaylist(row.uri),
          },
          {
            label: action,
            disabled: locked,
            onSelect: () => onToggle(row.uri, row.excluded),
          },
        ]}
      />
    </li>
  );
}

function TrackRowView({
  row,
  display,
  pending,
  locked,
  checked,
  menuOpen,
  onToggleSelected,
  onToggle,
  onMenuToggle,
  onMenuClose,
}: {
  row: DisplayTrack;
  display: PlaylistDisplay;
  pending: boolean;
  locked: boolean;
  checked: boolean;
  menuOpen: boolean;
  onToggleSelected: (uri: string) => void;
  onToggle: (uri: string, isExcluded: boolean) => void;
  onMenuToggle: () => void;
  onMenuClose: () => void;
}) {
  const compact = display === "compact";
  const action = row.excluded ? "Remove exclusion" : "Exclude";
  const meta = row.artists || (row.detail === "unavailable" ? "Unavailable" : "");
  return (
    <li className={checked ? "taste__row taste__row--selected" : "taste__row"}>
      <label className="taste__check">
        <input
          type="checkbox"
          checked={checked}
          disabled={locked}
          aria-label={`Select ${row.name}`}
          onChange={() => onToggleSelected(row.uri)}
        />
      </label>
      <div className="taste__media">
        {compact ? null : row.image ? (
          <img className="taste__cover" src={row.image} alt="" />
        ) : (
          <div className="taste__cover taste__cover--empty" aria-hidden="true" />
        )}
        <div className="taste__main">
          <button type="button" className="taste__name" title={row.name} onClick={() => openTrack(row.uri)}>
            {row.name}
          </button>
          {!compact && meta ? (
            <p className="taste__meta" title={meta}>
              {meta}
            </p>
          ) : null}
        </div>
      </div>
      <span className="taste__cell taste__cell-album" title={row.album}>
        {row.album || "—"}
      </span>
      <span className="taste__cell taste__cell--num taste__cell-duration">{formatDuration(row.durationMs)}</span>
      <span className="taste__cell taste__cell-added">{row.excludedAt ? formatDate(row.excludedAt) : "—"}</span>
      <div className="taste__row-actions">
        <button
          type="button"
          className={
            row.excluded
              ? "taste__btn taste__btn--row taste__btn--row-outline"
              : "taste__btn taste__btn--row taste__btn--primary"
          }
          disabled={locked}
          aria-label={row.excluded ? `Remove exclusion for ${row.name}` : `Exclude ${row.name} from your taste profile`}
          onClick={() => onToggle(row.uri, row.excluded)}
        >
          {pending ? "Working…" : action}
        </button>
      </div>
      <MoreActionsMenu
        open={menuOpen}
        triggerLabel={`More actions for ${row.name}`}
        onToggle={onMenuToggle}
        onClose={onMenuClose}
        actions={[
          {
            label: "Open track",
            onSelect: () => openTrack(row.uri),
          },
          {
            label: action,
            disabled: locked,
            onSelect: () => onToggle(row.uri, row.excluded),
          },
        ]}
      />
    </li>
  );
}

function SpicetifyIcon({ name, fallback }: { name: Spicetify.Icon; fallback: React.ReactNode }) {
  const html = Spicetify.SVGIcons?.[name];
  if (!html) return <>{fallback}</>;
  return (
    <svg
      className="taste__view-as-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Compact “View as” glyph — three lines; not exposed on Spicetify.SVGIcons. */
function CompactViewIcon() {
  return (
    <svg className="taste__view-as-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
      <rect x="1" y="3.25" width="14" height="1.5" rx="0.75" />
      <rect x="1" y="7.25" width="14" height="1.5" rx="0.75" />
      <rect x="1" y="11.25" width="14" height="1.5" rx="0.75" />
    </svg>
  );
}

function ListViewIconFallback() {
  return (
    <svg className="taste__view-as-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
      <rect x="1" y="2.5" width="3" height="3" rx="0.5" />
      <rect x="5.5" y="3.25" width="9.5" height="1.5" rx="0.75" />
      <rect x="1" y="6.5" width="3" height="3" rx="0.5" />
      <rect x="5.5" y="7.25" width="9.5" height="1.5" rx="0.75" />
      <rect x="1" y="10.5" width="3" height="3" rx="0.5" />
      <rect x="5.5" y="11.25" width="9.5" height="1.5" rx="0.75" />
    </svg>
  );
}

function ListViewIcon() {
  return <SpicetifyIcon name="list-view" fallback={<ListViewIconFallback />} />;
}

function ReloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="taste__search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function MutedNoteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
      <path d="m4 4 16 16" />
    </svg>
  );
}
