export const EXCLUSION_FILTERS = new Set(["all", "excluded", "not_excluded"] as const);
export const PLAYLIST_SORTS = new Set(["library", "name", "name-desc", "tracks", "tracks-desc", "recent"] as const);
export const TRACK_SORTS = new Set(["name", "name-desc", "artist", "album", "recent"] as const);
export const PLAYLIST_DISPLAYS = new Set(["list", "compact"] as const);
export const TABS = new Set(["playlists", "tracks"] as const);

export type TabId = "playlists" | "tracks";
export type ExclusionFilter = "all" | "excluded" | "not_excluded";
export type PlaylistSort = "library" | "name" | "name-desc" | "tracks" | "tracks-desc" | "recent";
export type TrackSort = "name" | "name-desc" | "artist" | "album" | "recent";
export type PlaylistDisplay = "list" | "compact";
export type TrackDetail = "ready" | "unavailable" | "failed";

export type PlaylistRow = {
  kind: "playlist";
  uri: string;
  name: string;
  owner: string;
  folder: string;
  tracks: number | null;
  image: string;
  libraryIndex: number;
};

export type TrackRow = {
  kind: "track";
  uri: string;
  name: string;
  artists: string;
  album: string;
  image: string;
  durationMs: number | null;
  detail: TrackDetail;
};

export type DisplayPlaylist = PlaylistRow & {
  excluded: boolean;
  excludedAt: number;
};

export type DisplayTrack = TrackRow & {
  excluded: boolean;
  excludedAt: number;
};

export type SavedView = {
  tab: TabId;
  exclusionFilter: ExclusionFilter;
  playlistSort: PlaylistSort;
  trackSort: TrackSort;
  playlistDisplay: PlaylistDisplay;
  trackFilter: ExclusionFilter;
  trackDisplay: PlaylistDisplay;
  playlistQuery: string;
  trackQuery: string;
};

export type LibraryNode = {
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

export type DecoratedTrack = {
  uri?: string;
  name?: string;
  duration?: { totalMilliseconds?: number } | number;
  artists?: { items?: Array<{ profile?: { name?: string } }> };
  albumOfTrack?: {
    name?: string;
    coverArt?: { sources?: Array<{ url?: string; width?: number }> };
  };
};

export class DeadlineError extends Error {
  constructor() {
    super("Spotify took too long to respond");
    this.name = "DeadlineError";
  }
}

/** Rejects when `work` does not settle within `ms`. A late result is ignored. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) return Promise.reject(new DeadlineError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function coverSrc(images: Array<{ url?: string } | null | undefined> | undefined): string {
  const raw = images?.find((image) => image?.url)?.url || "";
  if (!raw) return "";
  if (!raw.startsWith("spotify:")) return raw;

  const [, kind, ...rest] = raw.split(":");
  if (kind === "image") return `https://i.scdn.co/image/${rest[0]}`;
  if (kind === "mosaic") return `https://mosaic.scdn.co/300/${rest.join("")}`;
  return "";
}

export function formatDate(seconds: number): string {
  const value = Number(seconds);
  if (!value) return "";
  return new Date(value * 1000).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDuration(ms: number | null): string {
  if (!Number.isFinite(ms as number) || (ms as number) <= 0) return "—";
  const total = Math.floor((ms as number) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatRelative(timestamp: number | null, now = Date.now()): string {
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

export function trackCountLabel(count: number | null): string {
  if (!Number.isFinite(count as number)) return "—";
  return Number(count).toLocaleString("en");
}

export function playlistCount(count: number): string {
  return count === 1 ? "1 playlist" : `${count} playlists`;
}

export function trackCount(count: number): string {
  return count === 1 ? "1 track" : `${count} tracks`;
}

export function isPlaylistUri(uri: string): boolean {
  return uri.startsWith("spotify:playlist:");
}

export function isTrackUri(uri: string): boolean {
  return uri.startsWith("spotify:track:");
}

export function itemCountLabel(uris: string[]): string {
  const playlists = uris.filter((uri) => isPlaylistUri(uri)).length;
  const tracks = uris.filter((uri) => isTrackUri(uri)).length;
  if (playlists && tracks) return `${uris.length} items`;
  if (tracks) return trackCount(tracks);
  return playlistCount(playlists || uris.length);
}

export function ownerLabel(owner: string): string {
  if (!owner) return "";
  if (owner === "You") return "Created by you";
  return owner;
}

export function excludedMap(items: unknown): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of (items as Array<string | { uri?: string; addTime?: number }> | undefined) || []) {
    const uri = typeof item === "string" ? item : item?.uri;
    if (!uri || (!isPlaylistUri(uri) && !isTrackUri(uri))) continue;
    const added = Number(typeof item === "string" ? 0 : item?.addTime || 0);
    map.set(uri, Number.isFinite(added) ? added : 0);
  }
  return map;
}

export function flattenLibrary(
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

export function uniquePlaylists(rows: PlaylistRow[]): PlaylistRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.uri)) return false;
    seen.add(row.uri);
    return true;
  });
}

export function uniqueTracks(rows: TrackRow[]): TrackRow[] {
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

export function comparePlaylistSort(a: DisplayPlaylist, b: DisplayPlaylist, sort: PlaylistSort): number {
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

export function compareTrackSort(a: DisplayTrack, b: DisplayTrack, sort: TrackSort): number {
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

export function unavailableTrack(uri: string): TrackRow {
  return {
    kind: "track",
    uri,
    name: "Track unavailable",
    artists: "",
    album: "",
    image: "",
    durationMs: null,
    detail: "unavailable",
  };
}

export function failedTrack(uri: string): TrackRow {
  return {
    kind: "track",
    uri,
    name: "Couldn't load this track",
    artists: "Try Refresh",
    album: "",
    image: "",
    durationMs: null,
    detail: "failed",
  };
}

function trackDurationMs(track: DecoratedTrack | null | undefined): number | null {
  const duration = track?.duration;
  if (typeof duration === "number" && Number.isFinite(duration)) return duration;
  const total = duration && typeof duration === "object" ? duration.totalMilliseconds : null;
  return Number.isFinite(total as number) ? (total as number) : null;
}

export function trackFromDecorated(uri: string, track: DecoratedTrack | null | undefined): TrackRow {
  if (!track?.name) return unavailableTrack(uri);
  const artists = (track.artists?.items || [])
    .map((artist) => artist?.profile?.name)
    .filter((name): name is string => Boolean(name))
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
    detail: "ready",
  };
}

/**
 * Pair exclusion URIs with decoration rows.
 * A row is used only when its URI matches, or when it has no URI and the
 * response is the same length as the request (Spotify sometimes omits `uri`
 * but keeps position). A different URI at that index is not reused.
 */
export function resolveDecoratedChunk(uris: string[], tracks: Array<DecoratedTrack | null>): TrackRow[] {
  const sameLength = tracks.length === uris.length;
  return uris.map((uri, index) => {
    const byUri = tracks.find((track) => track?.uri === uri);
    if (byUri?.uri === uri) return trackFromDecorated(uri, byUri);
    const positional = tracks[index];
    if (sameLength && positional && !positional.uri) return trackFromDecorated(uri, positional);
    return unavailableTrack(uri);
  });
}

export function matchesPlaylistQuery(row: PlaylistRow, query: string): boolean {
  if (!query) return true;
  const haystack = `${row.name} ${row.owner} ${row.folder}`.toLocaleLowerCase("en");
  return haystack.includes(query);
}

export function matchesTrackQuery(row: TrackRow, query: string): boolean {
  if (!query) return true;
  const haystack = `${row.name} ${row.artists} ${row.album}`.toLocaleLowerCase("en");
  return haystack.includes(query);
}

export function defaultSavedView(): SavedView {
  return {
    tab: "playlists",
    exclusionFilter: "all",
    playlistSort: "library",
    trackSort: "name",
    playlistDisplay: "list",
    trackFilter: "excluded",
    trackDisplay: "list",
    playlistQuery: "",
    trackQuery: "",
  };
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

export function parseSavedView(raw: string | null | undefined): SavedView {
  const defaults = defaultSavedView();
  try {
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
      trackFilter: EXCLUSION_FILTERS.has(merged.trackFilter) ? merged.trackFilter : defaults.trackFilter,
      trackDisplay: PLAYLIST_DISPLAYS.has(merged.trackDisplay) ? merged.trackDisplay : defaults.trackDisplay,
      playlistQuery: typeof merged.playlistQuery === "string" ? merged.playlistQuery : "",
      trackQuery: typeof merged.trackQuery === "string" ? merged.trackQuery : "",
    };
  } catch {
    return defaults;
  }
}

export function snapshotExcluded(current: Map<string, number>, uris: string[]): Map<string, number | null> {
  const previous = new Map<string, number | null>();
  for (const uri of uris) {
    previous.set(uri, current.has(uri) ? (current.get(uri) as number) : null);
  }
  return previous;
}

export function stampExcluded(
  current: Map<string, number>,
  uris: string[],
  shouldExclude: boolean,
  nowSec: number
): Map<string, number> {
  const next = new Map(current);
  for (const uri of uris) {
    if (shouldExclude) next.set(uri, current.get(uri) || nowSec);
    else next.delete(uri);
  }
  return next;
}

export function restoreExcluded(
  current: Map<string, number>,
  previous: Map<string, number | null>
): Map<string, number> {
  const next = new Map(current);
  for (const [uri, value] of previous) {
    if (value === null) next.delete(uri);
    else next.set(uri, value);
  }
  return next;
}

export function undoWrites(previous: Map<string, number | null>): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const [uri, value] of previous) {
    if (value === null || value === undefined) remove.push(uri);
    else add.push(uri);
  }
  return { add, remove };
}

export function loadFailureCopy(kind: "load" | "refresh", detail: string): string {
  const reason = detail ? ` (${detail})` : "";
  if (kind === "refresh") {
    return `Taste profile could not be refreshed${reason}. Tap Refresh to try again.`;
  }
  return `Taste profile could not be loaded${reason}. Check that Spotify is ready, then tap Refresh.`;
}

export function errorDetail(loadError: unknown): string {
  if (loadError instanceof DeadlineError) return loadError.message;
  if (loadError instanceof Error && loadError.message) return loadError.message.slice(0, 160);
  if (typeof loadError === "string" && loadError) return loadError.slice(0, 160);
  return "Spotify rejected the request";
}
