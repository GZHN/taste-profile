import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DeadlineError,
  comparePlaylistSort,
  excludedMap,
  failedTrack,
  flattenLibrary,
  parseSavedView,
  resolveDecoratedChunk,
  restoreExcluded,
  snapshotExcluded,
  stampExcluded,
  undoWrites,
  uniquePlaylists,
  withDeadline,
  type DisplayPlaylist,
} from "./model.ts";

test("legacy included filter restores as not excluded", () => {
  const view = parseSavedView(JSON.stringify({ filter: "included", sort: "name", query: "jazz" }));
  assert.equal(view.exclusionFilter, "not_excluded");
  assert.equal(view.playlistSort, "name");
  assert.equal(view.playlistQuery, "jazz");
  assert.equal(view.trackQuery, "jazz");
});

test("a current exclusion filter wins over a leftover legacy filter", () => {
  const view = parseSavedView(JSON.stringify({ filter: "excluded", exclusionFilter: "all" }));
  assert.equal(view.exclusionFilter, "all");
});

test("invalid saved view falls back to defaults", () => {
  const view = parseSavedView("{");
  assert.equal(view.tab, "playlists");
  assert.equal(view.playlistDisplay, "list");
  assert.equal(view.trackFilter, "excluded");
  assert.equal(view.trackDisplay, "list");
});

test("flattenLibrary keeps folder paths and drops duplicate playlist URIs", () => {
  const rows = uniquePlaylists(
    flattenLibrary({
      items: [
        {
          type: "folder",
          name: "Focus",
          items: [{ type: "playlist", uri: "spotify:playlist:a", name: "Deep", isOwnedBySelf: true, totalLength: 3 }],
        },
        { type: "playlist", uri: "spotify:playlist:a", name: "Deep again", totalLength: 3 },
        { type: "episode", uri: "spotify:episode:skip", name: "Nope" },
      ],
    })
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].folder, "Focus");
  assert.equal(rows[0].owner, "You");
  assert.equal(rows[0].libraryIndex, 0);
});

test("excludedMap keeps playlist and track times and skips other URIs", () => {
  const map = excludedMap([
    { uri: "spotify:playlist:a", addTime: 10 },
    "spotify:track:b",
    { uri: "spotify:episode:c", addTime: 4 },
  ]);
  assert.equal(map.get("spotify:playlist:a"), 10);
  assert.equal(map.get("spotify:track:b"), 0);
  assert.equal(map.has("spotify:episode:c"), false);
});

test("decoration does not label an exclusion with a different track", () => {
  const rows = resolveDecoratedChunk(
    ["spotify:track:a", "spotify:track:b"],
    [{ uri: "spotify:track:b", name: "Bee" }]
  );
  assert.equal(rows[0].uri, "spotify:track:a");
  assert.equal(rows[0].detail, "unavailable");
  assert.equal(rows[0].name, "Track unavailable");
  assert.equal(rows[1].name, "Bee");
  assert.equal(rows[1].detail, "ready");
});

test("a same-length row without a URI stays aligned to the request", () => {
  const rows = resolveDecoratedChunk(["spotify:track:a"], [{ name: "Aye" }]);
  assert.equal(rows[0].uri, "spotify:track:a");
  assert.equal(rows[0].name, "Aye");
  assert.equal(rows[0].detail, "ready");
});

test("a request failure is not stored as an unavailable track", () => {
  const row = failedTrack("spotify:track:a");
  assert.equal(row.detail, "failed");
  assert.notEqual(row.name, "Track unavailable");
});

test("a failed write restores the previous exclusion map", () => {
  const current = new Map<string, number>([
    ["spotify:playlist:kept", 5],
    ["spotify:playlist:new", 9],
  ]);
  const previous = snapshotExcluded(new Map([["spotify:playlist:kept", 5]]), ["spotify:playlist:kept", "spotify:playlist:new"]);
  const stamped = stampExcluded(current, ["spotify:playlist:new"], true, 9);
  assert.equal(stamped.get("spotify:playlist:new"), 9);
  const restored = restoreExcluded(stamped, previous);
  assert.equal(restored.has("spotify:playlist:new"), false);
  assert.equal(restored.get("spotify:playlist:kept"), 5);
});

test("undo of a new exclusion only removes URIs that were not excluded before", () => {
  const previous = snapshotExcluded(new Map([["spotify:playlist:old", 4]]), ["spotify:playlist:old", "spotify:playlist:new"]);
  const writes = undoWrites(previous);
  assert.deepEqual(writes.add, ["spotify:playlist:old"]);
  assert.deepEqual(writes.remove, ["spotify:playlist:new"]);
});

test("recent playlist sort puts the newest exclusion first", () => {
  const older = { name: "A", excludedAt: 1, libraryIndex: 0, tracks: 1 } as DisplayPlaylist;
  const newer = { name: "B", excludedAt: 5, libraryIndex: 1, tracks: 1 } as DisplayPlaylist;
  assert.ok(comparePlaylistSort(older, newer, "recent") > 0);
});

test("withDeadline returns a value that settles in time", async () => {
  assert.equal(await withDeadline(Promise.resolve("ok"), 200), "ok");
});

test("withDeadline rejects when the work never settles", async () => {
  const hung = new Promise<string>(() => {});
  await assert.rejects(withDeadline(hung, 30), (error: unknown) => error instanceof DeadlineError);
});
