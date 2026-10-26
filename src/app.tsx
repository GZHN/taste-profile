import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./css/app.css";
import { APP_VERSION } from "./version";

const SET_NAME = "ignoreinrecs";
const SUPPORT_URL =
  "https://support.spotify.com/us/article/exclude-playlists-or-tracks-from-your-taste-profile/";
const VIEW_KEY = "taste-profile:view";
const MASS_CONFIRM_MIN = 11;
/** Wall-clock budget for loadWithRetry before surfacing a recoverable error. */
const LOAD_BUDGET_MS = 20000;

const EXCLUSION_FILTERS = new Set(["all", "excluded", "not_excluded"] as const);
const PLAYLIST_SORTS = new Set(["library", "name", "name-desc", "tracks", "tracks-desc", "recent"] as const);
const TRACK_SORTS = new Set(["name", "name-desc", "artist", "album", "recent"] as const);
const PLAYLIST_DISPLAYS = new Set(["list", "compact"] as const);
const TABS = new Set(["playlists", "tracks"] as const);

type TabId = "playlists" | "tracks";
const TAB_ORDER: TabId[] = ["playlists", "tracks"];
type ExclusionFilter = "all" | "excluded" | "not_excluded";
type PlaylistSort = "library" | "name" | "name-desc" | "tracks" | "tracks-desc" | "recent";
type TrackSort = "name" | "name-desc" | "artist" | "album" | "recent";
type PlaylistDisplay = "list" | "compact";
type Status = "loading" | "ready" | "error";

type PlaylistRow = {
  kind: "playlist";
  uri: string;
  name: string;
  owner: string;
  folder: string;
  tracks: number | null;
  image: string;
  libraryIndex: number;
};

type TrackRow = {
  kind: "track";
  uri: string;
  name: string;
  artists: string;
  album: string;
  image: string;
  durationMs: number | null;
  unavailable: boolean;
};

type DisplayPlaylist = PlaylistRow & {
  excluded: boolean;
  excludedAt: number;
};

type DisplayTrack = TrackRow & {
  excluded: boolean;
  excludedAt: number;
};

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

type SavedView = {
  tab: TabId;
  exclusionFilter: ExclusionFilter;
  playlistSort: PlaylistSort;
  trackSort: TrackSort;
  playlistDisplay: PlaylistDisplay;
  playlistQuery: string;
  trackQuery: string;
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

function formatDuration(ms: number | null): string {
  if (!Number.isFinite(ms as number) || (ms as number) <= 0) return "—";
  const total = Math.floor((ms as number) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatRelative(timestamp: number | null, now = Date.now()): string {
  if (!timestamp) return "";
  const delta = Math.max(0, now - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "Updated just now";
  if (minutes === 1) return "Last updated 1 minute ago";
  if (minutes < 60) return `Last updated ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "Last updated 1 hour ago";
  if (hours < 24) return `Last updated ${hours} hours ago`;
  return `Last updated ${formatDate(Math.floor(timestamp / 1000))}`;
}

function trackCountLabel(count: number | null): string {
  if (!Number.isFinite(count as number)) return "—";
  return Number(count).toLocaleString("en");
}

function playlistCount(count: number): string {
  return count === 1 ? "1 playlist" : `${count} playlists`;
}

function trackCount(count: number): string {
  return count === 1 ? "1 track" : `${count} tracks`;
}

function itemCountLabel(uris: string[]): string {
  const playlists = uris.filter((uri) => uri.startsWith("spotify:playlist:")).length;
  const tracks = uris.filter((uri) => uri.startsWith("spotify:track:")).length;
  if (playlists && tracks) return `${uris.length} items`;
  if (tracks) return trackCount(tracks);
  return playlistCount(playlists || uris.length);
}

function isPlaylistUri(uri: string): boolean {
  return uri.startsWith("spotify:playlist:");
}

function isTrackUri(uri: string): boolean {
  return uri.startsWith("spotify:track:");
}

function ownerLabel(owner: string): string {
  if (!owner) return "";
  if (owner === "You") return "Created by you";
  return owner;
}

function excludedMap(items: unknown): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of (items as Array<string | { uri?: string; addTime?: number }> | undefined) || []) {
    const uri = typeof item === "string" ? item : item?.uri;
    if (!uri || (!isPlaylistUri(uri) && !isTrackUri(uri))) continue;
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

function flattenLibrary(
  node: LibraryNode | undefined,
  folder: string[] = [],
  counter = { next: 0 }
): PlaylistRow[] {
  const rows: PlaylistRow[] = [];
  for (const item of node?.items || []) {
    if (item?.type === "folder") {
      const nextFolder = item.name ? [...folder, item.name] : folder;
      rows.push(...flattenLibrary(item as LibraryNode, nextFolder, counter));
      continue;
    }
    if (item?.type !== "playlist" || !item.uri) continue;
    rows.push({
      kind: "playlist",
      uri: item.uri,
      name: item.name || "Untitled playlist",
      owner: item.isOwnedBySelf ? "You" : item.owner?.displayName || "",
      folder: folder.join(" / "),
      tracks: Number.isFinite(item.totalLength) ? (item.totalLength as number) : null,
      image: coverSrc(item.images),
      libraryIndex: counter.next++,
    });
  }
  return rows;
}

function uniquePlaylists(rows: PlaylistRow[]): PlaylistRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.uri)) return false;
    seen.add(row.uri);
    return true;
  });
}

function uniqueTracks(rows: TrackRow[]): TrackRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.uri)) return false;
    seen.add(row.uri);
    return true;
  });
}

function compareName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

function comparePlaylistSort(a: DisplayPlaylist, b: DisplayPlaylist, sort: PlaylistSort): number {
  if (sort === "recent") {
    const byDate = (b.excludedAt || 0) - (a.excludedAt || 0);
    if (byDate) return byDate;
    return compareName(a, b);
  }
  if (sort === "library") {
    const byIndex = a.libraryIndex - b.libraryIndex;
    if (byIndex) return byIndex;
    return compareName(a, b);
  }
  if (sort === "tracks" || sort === "tracks-desc") {
    const left = a.tracks ?? -1;
    const right = b.tracks ?? -1;
    const byTracks = sort === "tracks" ? left - right : right - left;
    if (byTracks) return byTracks;
    return compareName(a, b);
  }
  if (sort === "name-desc") return compareName(b, a);
  return compareName(a, b);
}

function compareTrackSort(a: DisplayTrack, b: DisplayTrack, sort: TrackSort): number {
  if (sort === "recent") {
    const byDate = (b.excludedAt || 0) - (a.excludedAt || 0);
    if (byDate) return byDate;
    return compareName(a, b);
  }
  if (sort === "artist") {
    const byArtist = a.artists.localeCompare(b.artists, "en", { sensitivity: "base" });
    if (byArtist) return byArtist;
    return compareName(a, b);
  }
  if (sort === "album") {
    const byAlbum = a.album.localeCompare(b.album, "en", { sensitivity: "base" });
    if (byAlbum) return byAlbum;
    return compareName(a, b);
  }
  if (sort === "name-desc") return compareName(b, a);
  return compareName(a, b);
}

type DecoratedTrack = {
  uri?: string;
  name?: string;
  duration?: { totalMilliseconds?: number } | number;
  artists?: { items?: Array<{ profile?: { name?: string } }> };
  albumOfTrack?: {
    name?: string;
    coverArt?: { sources?: Array<{ url?: string; width?: number }> };
  };
};

function unavailableTrack(uri: string): TrackRow {
  return {
    kind: "track",
    uri,
    name: "Track unavailable",
    artists: "",
    album: "",
    image: "",
    durationMs: null,
    unavailable: true,
  };
}

function trackDurationMs(track: DecoratedTrack | null | undefined): number | null {
  const duration = track?.duration;
  if (typeof duration === "number" && Number.isFinite(duration)) return duration;
  const total = duration && typeof duration === "object" ? duration.totalMilliseconds : null;
  return Number.isFinite(total as number) ? (total as number) : null;
}

function trackFromDecorated(uri: string, track: DecoratedTrack | null | undefined): TrackRow {
  if (!track?.name) return unavailableTrack(uri);
  const artists = (track.artists?.items || [])
    .map((artist) => artist?.profile?.name)
    .filter(Boolean)
    .join(", ");
  const sources = track.albumOfTrack?.coverArt?.sources || [];
  const image =
    sources.find((source) => (source.width || 0) >= 300 && source.url)?.url ||
    [...sources].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url ||
    "";
  return {
    kind: "track",
    uri,
    name: track.name,
    artists,
    album: track.albumOfTrack?.name || "",
    image,
    durationMs: trackDurationMs(track),
    unavailable: false,
  };
}

async function loadExcludedTracks(uris: string[]): Promise<TrackRow[]> {
  const unique = [...new Set(uris)];
  if (!unique.length) return [];

  const defs = Spicetify.GraphQL?.Definitions as { decorateContextTracks?: unknown } | undefined;
  const request = Spicetify.GraphQL?.Request;
  if (!defs?.decorateContextTracks || typeof request !== "function") {
    return unique.map(unavailableTrack);
  }

  const byUri = new Map<string, TrackRow>();
  const chunkSize = 50;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    try {
      const response = (await request(defs.decorateContextTracks, { uris: chunk })) as {
        data?: { tracks?: Array<DecoratedTrack | null> };
      };
      const tracks = response?.data?.tracks || [];
      for (let index = 0; index < chunk.length; index += 1) {
        const uri = chunk[index];
        const match = tracks.find((track) => track?.uri === uri) || tracks[index];
        byUri.set(uri, trackFromDecorated(uri, match));
      }
    } catch {
      for (const uri of chunk) byUri.set(uri, unavailableTrack(uri));
    }
  }

  return unique.map((uri) => byUri.get(uri) || unavailableTrack(uri));
}

function matchesPlaylistQuery(row: PlaylistRow, query: string): boolean {
  if (!query) return true;
  const haystack = `${row.name} ${row.owner} ${row.folder}`.toLocaleLowerCase("en");
  return haystack.includes(query);
}

function matchesTrackQuery(row: TrackRow, query: string): boolean {
  if (!query) return true;
  const haystack = `${row.name} ${row.artists} ${row.album}`.toLocaleLowerCase("en");
  return haystack.includes(query);
}

function migrateLegacyView(raw: Record<string, unknown>): Partial<SavedView> {
  const legacyFilter = typeof raw.filter === "string" ? raw.filter : "";
  const legacySort = typeof raw.sort === "string" ? raw.sort : "";
  const legacyQuery = typeof raw.query === "string" ? raw.query : "";
  const next: Partial<SavedView> = {};

  if (legacyFilter === "excluded") next.exclusionFilter = "excluded";
  else if (legacyFilter === "included") next.exclusionFilter = "not_excluded";
  else if (legacyFilter === "outside" || legacyFilter === "unknown") next.exclusionFilter = "all";

  if (legacySort === "recent") next.playlistSort = "recent";
  else if (legacySort === "library") next.playlistSort = "library";
  else if (legacySort === "name") next.playlistSort = "name";

  if (legacyQuery) {
    next.playlistQuery = legacyQuery;
    next.trackQuery = legacyQuery;
  }
  return next;
}

function readView(): SavedView {
  const defaults: SavedView = {
    tab: "playlists",
    exclusionFilter: "all",
    playlistSort: "library",
    trackSort: "name",
    playlistDisplay: "list",
    playlistQuery: "",
    trackQuery: "",
  };
  try {
    const storage = Spicetify.LocalStorage;
    const raw = storage?.get?.(VIEW_KEY) || localStorage.getItem(VIEW_KEY);
    const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
    const migrated = migrateLegacyView(parsed);
    const merged = { ...defaults, ...migrated, ...parsed } as SavedView;
    return {
      tab: TABS.has(merged.tab) ? merged.tab : defaults.tab,
      exclusionFilter: EXCLUSION_FILTERS.has(merged.exclusionFilter)
        ? merged.exclusionFilter
        : defaults.exclusionFilter,
      playlistSort: PLAYLIST_SORTS.has(merged.playlistSort) ? merged.playlistSort : defaults.playlistSort,
      trackSort: TRACK_SORTS.has(merged.trackSort) ? merged.trackSort : defaults.trackSort,
      playlistDisplay: PLAYLIST_DISPLAYS.has(merged.playlistDisplay)
        ? merged.playlistDisplay
        : defaults.playlistDisplay,
      playlistQuery: typeof merged.playlistQuery === "string" ? merged.playlistQuery : "",
      trackQuery: typeof merged.trackQuery === "string" ? merged.trackQuery : "",
    };
  } catch {
    return defaults;
  }
}

function writeView(view: SavedView) {
  const payload = JSON.stringify(view);
  if (Spicetify.LocalStorage?.set) Spicetify.LocalStorage.set(VIEW_KEY, payload);
  else localStorage.setItem(VIEW_KEY, payload);
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

export default function App() {
  const [library, setLibrary] = useState<PlaylistRow[]>([]);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [excluded, setExcluded] = useState<Map<string, number>>(() => new Map());
  const [status, setStatus] = useState<Status>("loading");
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<ProgressState>({ value: 0, label: "Starting…" });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
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
      playlistQuery,
      trackQuery,
    });
  }, [tab, exclusionFilter, playlistSort, trackSort, playlistDisplay, playlistQuery, trackQuery]);

  useEffect(() => {
    if (!lastUpdatedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [lastUpdatedAt]);

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
      setNow(Date.now());
      reportProgress(1, "Taste profile loaded");
      return map;
    },
    [reportProgress]
  );

  /**
   * Keep trying until Spotify answers or LOAD_BUDGET_MS elapses. Methods can
   * exist before they work, so we probe with real get()/getContents() calls.
   *
   * `signal.cancelled` only skips applying results — it must not surface as a
   * hard UI error (Spicetify remounts the page during navigation; Refresh works
   * because it never uses a cancellation flag). Budget exhaustion returns null
   * so callers can show a recoverable error with Refresh enabled.
   */
  const loadWithRetry = useCallback(
    async (signal?: { cancelled: boolean }): Promise<TasteApis | null> => {
      let attempt = 0;
      const started = Date.now();
      while (!signal?.cancelled) {
        if (Date.now() - started >= LOAD_BUDGET_MS) return null;

        attempt += 1;
        const apis = getTasteApis();
        if (!apis) {
          if (!signal?.cancelled) reportProgress(0.05, "Waiting for Spotify");
          await delay(300);
          continue;
        }

        try {
          if (!signal?.cancelled) {
            reportProgress(0.12, attempt === 1 ? "Connecting to Spotify" : "Retrying connection");
            reportProgress(0.22, "Loading your library");
          }

          // Fetch separately so one cold API doesn't fail the whole attempt.
          const ignored = await apis.collection.get(SET_NAME);
          if (signal?.cancelled) return null;
          const contents = await apis.rootlist.getContents();
          if (signal?.cancelled) return null;

          const map = excludedMap(ignored);
          const trackUris = [...map.keys()].filter(isTrackUri);
          if (!signal?.cancelled) {
            reportProgress(
              trackUris.length ? 0.4 : 1,
              trackUris.length ? "Loading exclusions" : "Taste profile loaded"
            );
          }
          const loadedTracks = trackUris.length ? await loadExcludedTracks(trackUris) : [];
          if (signal?.cancelled) return null;

          applyLoadedData(ignored, contents, loadedTracks);
          return apis;
        } catch (loadError) {
          if (signal?.cancelled) return null;
          const detail =
            loadError instanceof Error
              ? loadError.message
              : typeof loadError === "string"
                ? loadError
                : "Spotify rejected the request";
          reportProgress(0.08, `Waiting for Spotify (${detail.slice(0, 80)})`);
          const remaining = LOAD_BUDGET_MS - (Date.now() - started);
          if (remaining <= 0) return null;
          await delay(Math.min(remaining, Math.min(2000, 400 + attempt * 150)));
        }
      }
      return null;
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
        const apis = await loadWithRetryRef.current(signal);
        if (signal.cancelled) return;
        if (!apis) {
          setError("Taste profile could not be loaded. Check that Spotify is ready, then tap Refresh.");
          setStatus("error");
          return;
        }
        setError("");
        setStatus("ready");
        const subscribe = apis.collection.subscribe;
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
    if (!unique.length || applying.current) return;
    const spice = getSpicetify();
    const api = spice.Platform?.CollectionPlatformAPI as CollectionAPI | undefined;
    if (!api || typeof api.add !== "function" || typeof api.remove !== "function") {
      spice.showNotification?.(
        unique.length === 1 ? "Couldn't update this item. Try again." : "Couldn't update these items. Try again.",
        true
      );
      return;
    }
    const previous = new Map<string, number | null>();
    for (const uri of unique) {
      previous.set(uri, excludedRef.current.has(uri) ? (excludedRef.current.get(uri) as number) : null);
    }

    applying.current = true;
    setPendingUris(new Set(unique));
    setExcluded((current) => {
      const next = new Map(current);
      const stamp = Math.floor(Date.now() / 1000);
      for (const uri of unique) {
        if (shouldExclude) next.set(uri, current.get(uri) || stamp);
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
        const next = new Map(current);
        for (const [uri, value] of previous) {
          if (value === null) next.delete(uri);
          else next.set(uri, value);
        }
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
    const toExclude: string[] = [];
    const toRemove: string[] = [];
    for (const uri of snapshot.uris) {
      const value = snapshot.previous.get(uri);
      if (value === null || value === undefined) toRemove.push(uri);
      else toExclude.push(uri);
    }

    const beforeUndo = new Map<string, number | null>();
    for (const uri of snapshot.uris) {
      beforeUndo.set(uri, excludedRef.current.has(uri) ? (excludedRef.current.get(uri) as number) : null);
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
      if (toRemove.length) await api.remove(SET_NAME, toRemove);
      spice.showNotification("Change undone.");
    } catch {
      setExcluded((current) => {
        const next = new Map(current);
        for (const [uri, value] of beforeUndo) {
          if (value === null) next.delete(uri);
          else next.set(uri, value);
        }
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
    setProgress({ value: 0, label: "Loading taste profile" });
    if (keepList) setReloading(true);
    else setStatus("loading");
    loadWithRetry()
      .then((apis) => {
        if (!apis) {
          setError("Taste profile could not be loaded.");
          setStatus("error");
          setReloading(false);
          return;
        }
        setStatus("ready");
        setReloading(false);
      })
      .catch((loadError) => {
        const detail = loadError instanceof Error ? loadError.message : "";
        setError(detail ? `Taste profile could not be loaded. (${detail})` : "Taste profile could not be loaded.");
        setStatus("error");
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
    return uniqueTracks(tracks)
      .map((row) => ({
        ...row,
        excluded: excluded.has(row.uri),
        excludedAt: excluded.get(row.uri) || 0,
      }))
      .filter((row) => row.excluded);
  }, [tracks, excluded]);

  const excludedPlaylistCount = playlistRows.filter((row) => row.excluded).length;
  const notExcludedCount = playlistRows.filter((row) => !row.excluded).length;
  const excludedTrackCount = trackRows.length;

  const visiblePlaylists = playlistRows
    .filter((row) => {
      if (exclusionFilter === "excluded" && !row.excluded) return false;
      if (exclusionFilter === "not_excluded" && row.excluded) return false;
      return matchesPlaylistQuery(row, playlistNeedle);
    })
    .sort((a, b) => comparePlaylistSort(a, b, playlistSort));

  const visibleTracks = trackRows
    .filter((row) => matchesTrackQuery(row, trackNeedle))
    .sort((a, b) => compareTrackSort(a, b, trackSort));

  const visibleUris = (tab === "playlists" ? visiblePlaylists : visibleTracks).map((row) => row.uri);
  const selectedVisible = visibleUris.filter((uri) => selected.has(uri));
  const selectedExcluded = selectedVisible.filter((uri) => excluded.has(uri));
  const selectedNotExcluded = selectedVisible.filter((uri) => !excluded.has(uri) && isPlaylistUri(uri));
  const allSelected = visibleUris.length > 0 && selectedVisible.length === visibleUris.length;
  const partiallySelected = selectedVisible.length > 0 && !allSelected;
  const busy = pendingUris.size > 0;
  const loading = status === "loading" || reloading;

  let playlistEmptyTitle = "No playlists match";
  let playlistEmptyBody = "Try another search or filter.";
  if (!playlistNeedle && exclusionFilter === "excluded") {
    playlistEmptyTitle = "No excluded playlists";
    playlistEmptyBody = "None of your playlists are currently excluded from your taste profile.";
  } else if (!playlistNeedle && exclusionFilter === "not_excluded") {
    playlistEmptyTitle = "No matching playlists";
    playlistEmptyBody = "Every playlist in this view is already excluded.";
  } else if (!playlistNeedle && !playlistRows.length) {
    playlistEmptyTitle = "No playlists available";
    playlistEmptyBody = "Your Spotify library could not provide playlists yet.";
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
          {lastUpdatedAt ? (
            <p className="taste__updated" aria-live="polite">
              {formatRelative(lastUpdatedAt, now)}
            </p>
          ) : null}
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
            Manage exclusions individually or in bulk, search and filter results, and switch between standard and
            compact playlist views — without digging through each playlist or track menu. Excluding a playlist only
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
          <span>Excluded Tracks</span>
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

      {status === "ready" && tab === "playlists" ? (
        <div
          role="tabpanel"
          id="taste-panel-playlists"
          aria-labelledby="taste-tab-playlists"
        >
          <div className="taste__section-head">
            <div>
              <h2>Playlists</h2>
              <p className="taste__section-copy">
                View and manage taste-profile exclusions across your playlists from one interface.
              </p>
            </div>
          </div>

          <div className="taste__summary" aria-label="Playlist summary">
            <SummaryCard
              tone="warn"
              icon={<MinusIcon />}
              value={excludedPlaylistCount}
              label="Playlists excluded"
            />
            <SummaryCard
              tone="ok"
              icon={<CheckIcon />}
              value={notExcludedCount}
              label="Not excluded"
            />
          </div>

          <div className="taste__toolbar">
            <div className="taste__filters" role="group" aria-label="Exclusion filter">
              <Chip
                label="All"
                pressed={exclusionFilter === "all"}
                onClick={() => chooseExclusionFilter("all")}
              />
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
              value={playlistQuery}
              placeholder="Search playlists..."
              label="Search playlists"
              onChange={(value) => {
                setPlaylistQuery(value);
                setSelected(new Set());
              }}
            />
            <div className="taste__toolbar-end">
              <label className="taste__select-wrap">
                <span>Sort:</span>
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
              </label>
              <ViewAsControl value={playlistDisplay} onChange={setPlaylistDisplay} />
            </div>
          </div>

          {selectedVisible.length ? (
            <BulkBar
              label={`${selectedVisible.length} ${selectedVisible.length === 1 ? "playlist" : "playlists"} selected`}
              busy={busy}
              primaryLabel={selectedNotExcluded.length ? "Exclude selected" : undefined}
              onPrimary={
                selectedNotExcluded.length
                  ? () => {
                      if (
                        selectedNotExcluded.length >= MASS_CONFIRM_MIN &&
                        !window.confirm(`Exclude ${playlistCount(selectedNotExcluded.length)} from your taste profile?`)
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
                        !window.confirm(
                          `Remove exclusion for ${itemCountLabel(selectedExcluded)} from your taste profile?`
                        )
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

          {visiblePlaylists.length ? (
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
                {visiblePlaylists.map((row) => (
                  <PlaylistRowView
                    key={row.uri}
                    row={row}
                    display={playlistDisplay}
                    pending={pendingUris.has(row.uri)}
                    checked={selected.has(row.uri)}
                    menuOpen={openMenuUri === row.uri}
                    onToggleSelected={toggleOneSelected}
                    onToggle={(uri, isExcluded) => void applyExclusion([uri], !isExcluded)}
                    onMenuToggle={() => setOpenMenuUri((current) => (current === row.uri ? null : row.uri))}
                    onMenuClose={() => setOpenMenuUri(null)}
                  />
                ))}
              </ul>
            </div>
          ) : (
            <EmptyState title={playlistEmptyTitle} body={playlistEmptyBody} />
          )}
        </div>
      ) : null}

      {status === "ready" && tab === "tracks" ? (
        <div role="tabpanel" id="taste-panel-tracks" aria-labelledby="taste-tab-tracks">
          <div className="taste__section-head">
            <div>
              <h2>Excluded Tracks</h2>
              <p className="taste__section-copy">
                Browse and remove exclusions from individual tracks that are left out of your taste profile.
              </p>
            </div>
            <div className="taste__toolbar taste__toolbar--compact">
              <SearchField
                value={trackQuery}
                placeholder="Search tracks, artists, or albums..."
                label="Search tracks, artists, or albums"
                onChange={(value) => {
                  setTrackQuery(value);
                  setSelected(new Set());
                }}
              />
              <label className="taste__select-wrap">
                <span>Sort:</span>
                <select
                  value={trackSort}
                  aria-label="Sort tracks"
                  onChange={(event) => {
                    setTrackSort(event.target.value as TrackSort);
                    setSelected(new Set());
                  }}
                >
                  <option value="name">Track name</option>
                  <option value="name-desc">Track name Z–A</option>
                  <option value="artist">Artist</option>
                  <option value="album">Album</option>
                  <option value="recent">Recently excluded</option>
                </select>
              </label>
            </div>
          </div>

          {selectedVisible.length ? (
            <BulkBar
              label={`${selectedVisible.length} ${selectedVisible.length === 1 ? "track" : "tracks"} selected`}
              busy={busy}
              primaryLabel="Remove selected exclusions"
              onPrimary={() => {
                if (
                  selectedExcluded.length >= MASS_CONFIRM_MIN &&
                  !window.confirm(`Remove exclusion for ${trackCount(selectedExcluded.length)}?`)
                ) {
                  return;
                }
                void applyExclusion(selectedExcluded, false);
              }}
              onClear={() => setSelected(new Set())}
            />
          ) : null}

          {visibleTracks.length ? (
            <div className="taste__table taste__table--tracks">
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
                {visibleTracks.map((row) => (
                  <TrackRowView
                    key={row.uri}
                    row={row}
                    pending={pendingUris.has(row.uri)}
                    checked={selected.has(row.uri)}
                    menuOpen={openMenuUri === row.uri}
                    onToggleSelected={toggleOneSelected}
                    onRemove={() => void applyExclusion([row.uri], false)}
                    onMenuToggle={() => setOpenMenuUri((current) => (current === row.uri ? null : row.uri))}
                    onMenuClose={() => setOpenMenuUri(null)}
                  />
                ))}
              </ul>
            </div>
          ) : (
            <EmptyState
              title={trackNeedle ? "No matching tracks" : "No excluded tracks"}
              body={
                trackNeedle
                  ? "Try another search."
                  : "You don't currently have any individually excluded tracks from your taste profile."
              }
              icon={<MutedNoteIcon />}
            />
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

function SummaryCard({
  tone,
  icon,
  value,
  label,
}: {
  tone: "warn" | "ok" | "neutral";
  icon: React.ReactNode;
  value: number;
  label: string;
}) {
  const iconClass =
    tone === "warn" ? "taste__stat-icon taste__stat-icon--warn" : tone === "ok" ? "taste__stat-icon taste__stat-icon--ok" : "taste__stat-icon";
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
          disabled={pending}
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
          disabled={pending}
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
            disabled: pending,
            onSelect: () => onToggle(row.uri, row.excluded),
          },
        ]}
      />
    </li>
  );
}

function TrackRowView({
  row,
  pending,
  checked,
  menuOpen,
  onToggleSelected,
  onRemove,
  onMenuToggle,
  onMenuClose,
}: {
  row: DisplayTrack;
  pending: boolean;
  checked: boolean;
  menuOpen: boolean;
  onToggleSelected: (uri: string) => void;
  onRemove: () => void;
  onMenuToggle: () => void;
  onMenuClose: () => void;
}) {
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
      <div className="taste__media">
        {row.image ? (
          <img className="taste__cover" src={row.image} alt="" />
        ) : (
          <div className="taste__cover taste__cover--empty" aria-hidden="true" />
        )}
        <div className="taste__main">
          <button type="button" className="taste__name" title={row.name} onClick={() => openTrack(row.uri)}>
            {row.name}
          </button>
          <p className="taste__meta" title={row.artists || (row.unavailable ? "Unavailable" : "")}>
            {row.artists || (row.unavailable ? "Unavailable" : "")}
          </p>
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
          className="taste__btn taste__btn--row taste__btn--primary"
          disabled={pending}
          aria-label={`Remove exclusion for ${row.name}`}
          onClick={onRemove}
        >
          {pending ? "Working…" : "Remove exclusion"}
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
            label: "Remove exclusion",
            disabled: pending,
            onSelect: onRemove,
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
