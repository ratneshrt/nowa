#!/usr/bin/env -S node --experimental-strip-types --no-warnings

const BASE_URL = process.env.NOWA_API_URL ?? "https://api.ratne.sh";
const TOKEN = process.env.NOWA_SECRET;

if (!TOKEN) {
  console.error("Error: NOWA_SECRET is not set. Export it in your shell:");
  console.error('  export NOWA_SECRET="your-token-here"');
  process.exit(1);
}

async function api(method: string, path: string, body?: object) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      console.error(`Error ${res.status}:`, JSON.stringify(json, null, 2));
    } catch {
      console.error(`Error ${res.status}:`, text);
    }
    process.exit(1);
  }
  return res.json();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yy} ${HH}:${MM}`;
}

function displayPost(post: { content: string; uid: string; createdAt: string; origin?: string }) {
  console.log(post.content);
  console.log(`-- ${formatDate(post.createdAt)} | ${post.uid}${post.origin ? ` | ${post.origin}` : ""}`);
}

async function cmdPost(args: string[]) {
  const content = args.join(" ").trim();
  if (!content) {
    console.error("Error: post content cannot be empty.");
    process.exit(1);
  }
  const data = await api("POST", "/posts", { content });
  console.log(`${data.uid} | posted`);
}

async function cmdLast(args: string[]) {
  const n = args[0] ? parseInt(args[0], 10) : 1;
  if (isNaN(n) || n < 1) {
    console.error("Error: argument must be a positive number.");
    process.exit(1);
  }
  const data = await api("GET", `/posts/last?n=${n}`);
  const posts: any[] = data.posts ?? [];
  if (posts.length === 0) { console.log("No posts yet."); return; }
  posts.forEach((post, i) => {
    if (i > 0) console.log();
    displayPost(post);
  });
}

async function cmdList(args: string[]) {
  const n = args[0] ? parseInt(args[0], 10) : 10;
  if (isNaN(n) || n < 1) {
    console.error("Error: argument must be a positive number.");
    process.exit(1);
  }
  const data = await api("GET", `/posts?limit=${n}`);
  const posts: any[] = data.posts ?? [];
  if (posts.length === 0) { console.log("No posts yet."); return; }
  posts.forEach((post, i) => {
    if (i > 0) console.log();
    displayPost(post);
  });
}

async function cmdTrash(args: string[]) {
  const n = args[0] ? parseInt(args[0], 10) : 5;
  if (isNaN(n) || n < 1) {
    console.error("Error: argument must be a positive number.");
    process.exit(1);
  }
  const data = await api("GET", `/posts/trash?limit=${n}`);
  const posts: any[] = data.posts ?? [];
  if (posts.length === 0) { console.log("No deleted posts."); return; }
  posts.forEach((post, i) => {
    if (i > 0) console.log();
    displayPost(post);
  });
}

async function cmdStats() {
  const data = await api("GET", "/posts/stats");
  console.log(`total   : ${data.total}`);
  console.log(`visible : ${data.visible}`);
  console.log(`deleted : ${data.deleted}`);
}

async function cmdGet(args: string[]) {
  const uid = args[0];
  if (!uid) {
    console.error("Error: uid required. Usage: nowa get <uid>");
    process.exit(1);
  }
  const data = await api("GET", `/posts/${uid}`);
  displayPost(data);
}

async function cmdEdits(args: string[]) {
  const uid = args[0];
  if (!uid) {
    console.error("Error: uid required. Usage: nowa edits <uid>");
    process.exit(1);
  }
  const data = await api("GET", `/posts/${uid}/edits`);
  const edits: any[] = data.edits ?? [];
  if (edits.length === 0) { console.log("No edits found."); return; }
  edits.forEach((edit, i) => {
    const label = i === 0 ? "[current]" : `[edit ${edits.length - i}]`;
    console.log(`${label} #${edit.editNumber} | ${formatDate(edit.editedAt)}`);
    console.log(edit.contentSnapshot);
    if (i < edits.length - 1) console.log("---");
  });
}

async function cmdEdit(args: string[]) {
  const uid = args[0];
  const content = args.slice(1).join(" ").trim();
  if (!uid || !content) {
    console.error("Error: uid and new content required. Usage: nowa edit <uid> <new content>");
    process.exit(1);
  }
  const data = await api("PATCH", `/posts/${uid}`, { content });
  console.log(`${data.uid} | updated`);
}

async function cmdDelete(args: string[]) {
  const uid = args[0];
  if (!uid) {
    console.error("Error: uid required. Usage: nowa delete <uid>");
    process.exit(1);
  }
  await api("DELETE", `/posts/${uid}`);
  console.log(`${uid} | deleted`);
}

async function cmdRestore(args: string[]) {
  const uid = args[0];
  if (!uid) {
    console.error("Error: uid required. Usage: nowa restore <uid>");
    process.exit(1);
  }
  await api("POST", `/posts/${uid}/restore`);
  console.log(`${uid} | restored`);
}

function showHelp() {
  console.log(`nowa — post and manage now-entries from the terminal

Usage:
  nowa <text...>             create a new post
  nowa last [n]              show last N posts (default 1, max 10)
  nowa ls [n]                list last N posts (default 10)
  nowa trash [n]             show last N deleted posts (default 5)
  nowa stats                 show total / visible / deleted counts
  nowa get <uid>             get a post by uid
  nowa edits <uid>           show full edit history for a post
  nowa edit <uid> <text...>  update a post's content
  nowa delete <uid>          soft-delete a post
  nowa restore <uid>         restore a deleted post
  nowa -h, --help            show this help

Environment variables:
  NOWA_SECRET    Bearer token (required)
  NOWA_API_URL   API base URL (default: https://api.ratne.sh)

Examples:
  nowa back at chaayos again
  nowa last 3
  nowa edit abc123 updated content here
  nowa delete abc123`);
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "-h" || cmd === "--help") {
  showHelp();
} else if (cmd === "last") {
  cmdLast(rest);
} else if (cmd === "ls") {
  cmdList(rest);
} else if (cmd === "trash") {
  cmdTrash(rest);
} else if (cmd === "stats") {
  cmdStats();
} else if (cmd === "get") {
  cmdGet(rest);
} else if (cmd === "edits") {
  cmdEdits(rest);
} else if (cmd === "edit") {
  cmdEdit(rest);
} else if (cmd === "delete") {
  cmdDelete(rest);
} else if (cmd === "restore") {
  cmdRestore(rest);
} else {
  cmdPost([cmd, ...rest]);
}
