import { describe, expect, test } from "vitest";
import type { CommentThread, CommentView } from "../../src/collab/backend.ts";
import {
  filterCandidates,
  insertMention,
  mentionQuery,
  mentionsInBody,
  segmentBody,
} from "../../src/collab/comments/mentions.ts";
import {
  filterThreads,
  latestActivity,
  pinNumbers,
  relativeTime,
  unreadCount,
  unreadIn,
} from "../../src/collab/comments/model.ts";

const ada = { id: "u1", name: "Ada Lovelace", image: null };
const bo = { id: "u2", name: "Bo", image: null };
const cy = { id: "u3", name: "Cyrille Ébène", image: null };

describe("mentions", () => {
  test("detects the mention being typed", () => {
    expect(mentionQuery("Hey @Ad", 7)).toEqual({ start: 4, query: "Ad" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("(@bo", 4)).toEqual({ start: 1, query: "bo" });
    expect(mentionQuery("Ping @Ada Love", 14)).toEqual({ start: 5, query: "Ada Love" });
    expect(mentionQuery("mail me at a@b.co", 17)).toBeNull(); // e-mail, not a mention
    expect(mentionQuery("@ ada", 5)).toBeNull();
    expect(mentionQuery("@a\nb", 4)).toBeNull();
    expect(mentionQuery("@one two three four", 19)).toBeNull();
  });

  test("inserts the picked name and moves the caret after it", () => {
    const q = mentionQuery("Hi @ad please", 6);
    expect(q).not.toBeNull();
    if (!q) return;
    expect(insertMention("Hi @ad please", q, 6, "Ada Lovelace")).toEqual({
      text: "Hi @Ada Lovelace please",
      caret: 17,
    });
  });

  test("ranks members by prefix, word prefix, substring; accents fold", () => {
    const members = [cy, ada, bo, { id: "u4", name: "Abel", image: null }];
    expect(filterCandidates(members, "a").map((m) => m.name)).toEqual(["Abel", "Ada Lovelace"]);
    expect(filterCandidates(members, "love").map((m) => m.name)).toEqual(["Ada Lovelace"]);
    expect(filterCandidates(members, "ebe").map((m) => m.name)).toEqual(["Cyrille Ébène"]);
    expect(filterCandidates(members, "").length).toBe(4);
    expect(filterCandidates(members, "zz")).toEqual([]);
  });

  test("only mentions still in the text are sent", () => {
    expect(mentionsInBody("@Ada Lovelace and @Bo, look", [ada, bo])).toEqual(["u1", "u2"]);
    expect(mentionsInBody("@Bob is not here", [bo])).toEqual([]);
    expect(mentionsInBody("@Bo's turn", [bo])).toEqual(["u2"]);
    expect(mentionsInBody("thanks @Bo!", [bo, ada])).toEqual(["u2"]);
  });

  test("bodies split into text and mention segments (longest name wins)", () => {
    const ada2 = { id: "u9", name: "Ada", image: null };
    expect(segmentBody("cc @Ada Lovelace, @Ada and me@x.io", [ada2, ada])).toEqual([
      { text: "cc " },
      { text: "@Ada Lovelace", mention: "u1" },
      { text: ", " },
      { text: "@Ada", mention: "u9" },
      { text: " and me@x.io" },
    ]);
  });
});

function comment(over: Partial<CommentView>): CommentView {
  return {
    id: "c",
    threadId: null,
    body: "",
    deleted: false,
    author: ada,
    mentions: [],
    createdAt: 0,
    editedAt: null,
    ...over,
  };
}

function thread(over: Partial<CommentThread> & { id: string }): CommentThread {
  return {
    ...comment({ id: over.id }),
    nodeId: null,
    pageId: "p1",
    x: 0,
    y: 0,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    lastActivityAt: over.createdAt ?? 0,
    replies: [],
    ...over,
  };
}

describe("seen time", () => {
  test("latest activity covers replies and uses server times only", () => {
    const t = thread({ id: "t1", createdAt: 100, lastActivityAt: 100 });
    expect(latestActivity([])).toBe(0);
    expect(latestActivity([t])).toBe(100);
    const withReply = {
      ...t,
      replies: [comment({ id: "r1", threadId: "t1", author: bo, createdAt: 900 })],
    };
    expect(latestActivity([withReply])).toBe(900);
    // Seen up to the latest activity: a comment arriving a moment later is unread.
    const later = {
      ...withReply,
      replies: [
        ...withReply.replies,
        comment({ id: "r2", threadId: "t1", author: bo, createdAt: 901 }),
      ],
    };
    expect(unreadIn(later, "u1", latestActivity([withReply]))).toBe(1);
  });
});

describe("threads", () => {
  const threads = [
    thread({ id: "t1", body: "Bigger logo?", createdAt: 100, lastActivityAt: 500, author: bo }),
    thread({
      id: "t2",
      body: "Fix the CTA color",
      createdAt: 200,
      lastActivityAt: 300,
      pageId: "p2",
      replies: [
        comment({
          id: "r1",
          threadId: "t2",
          author: bo,
          body: "@Ada Lovelace done",
          mentions: ["u1"],
          createdAt: 300,
        }),
      ],
    }),
    thread({
      id: "t3",
      body: "Old note",
      createdAt: 50,
      lastActivityAt: 60,
      resolved: true,
      author: cy,
    }),
  ];

  test("filters by status, page, involvement, mentions and text", () => {
    const ctx = { userId: "u1", pageId: "p1" };
    const ids = (f: Parameters<typeof filterThreads>[1]) =>
      filterThreads(threads, f, ctx).map((t) => t.id);
    expect(ids({ status: "open", scope: "all", query: "" })).toEqual(["t1", "t2"]);
    expect(ids({ status: "resolved", scope: "all", query: "" })).toEqual(["t3"]);
    expect(ids({ status: "all", scope: "all", query: "" })).toEqual(["t1", "t2", "t3"]);
    expect(ids({ status: "open", scope: "page", query: "" })).toEqual(["t1"]);
    expect(ids({ status: "all", scope: "mine", query: "" })).toEqual(["t2"]);
    expect(ids({ status: "all", scope: "mentions", query: "" })).toEqual(["t2"]);
    expect(ids({ status: "all", scope: "all", query: "cta" })).toEqual(["t2"]);
    expect(ids({ status: "all", scope: "all", query: "bo" })).toEqual(["t1", "t2"]); // author names match
  });

  test("pins are numbered in creation order", () => {
    expect([...pinNumbers(threads)]).toEqual([
      ["t3", 1],
      ["t1", 2],
      ["t2", 3],
    ]);
  });

  test("unread counts comments by others since the last visit; first visits count mentions only", () => {
    expect(unreadIn(threads[1] as CommentThread, "u1", 250)).toBe(1); // Bo's reply
    expect(unreadIn(threads[1] as CommentThread, "u1", 0)).toBe(1); // own root does not count
    expect(unreadCount(threads, "u1", 150)).toBe(1); // t1 is older; in t2 only Bo's reply is new (the root is own)
    expect(unreadCount(threads, "u1", null)).toBe(1); // only the thread that mentions u1
    expect(unreadCount(threads, "u2", 0)).toBe(1); // Ada's t2 root (t3 resolved, t1 + reply are Bo's)
  });

  test("relative times", () => {
    const now = Date.UTC(2026, 9, 21, 12);
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4 days ago");
  });
});
