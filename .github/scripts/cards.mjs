// Builds the profile stat cards from the GitHub GraphQL API.
// Counts every contribution on the calendar, including private ones the
// profile is set to show, so the numbers match the contribution graph.
import { mkdirSync, writeFileSync } from "node:fs";

const user = process.env.PROFILE_USER ?? "eshitakundu";
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(JSON.stringify(body.errors ?? body));
  return body.data;
}

const profile = await gql(
  `query($login: String!) {
    user(login: $login) {
      createdAt
      repositoriesContributedTo(includeUserRepositories: true, contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]) { totalCount }
      repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
        nodes {
          stargazerCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
    }
  }`,
  { login: user },
);
const u = profile.user;

// The API caps each contributionsCollection at one year, so walk year by year.
const totals = { all: 0, commits: 0, prs: 0, issues: 0, reviews: 0, private: 0 };
const days = [];
const now = new Date();
for (let from = new Date(u.createdAt); from < now; ) {
  const to = new Date(Math.min(now, new Date(from).setFullYear(from.getFullYear() + 1)));
  const { user: y } = await gql(
    `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions totalPullRequestContributions
          totalIssueContributions totalPullRequestReviewContributions
          restrictedContributionsCount
          contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
        }
      }
    }`,
    { login: user, from: from.toISOString(), to: to.toISOString() },
  );
  const c = y.contributionsCollection;
  totals.all += c.contributionCalendar.totalContributions;
  totals.commits += c.totalCommitContributions;
  totals.prs += c.totalPullRequestContributions;
  totals.issues += c.totalIssueContributions;
  totals.reviews += c.totalPullRequestReviewContributions;
  totals.private += c.restrictedContributionsCount;
  for (const w of c.contributionCalendar.weeks) days.push(...w.contributionDays);
  from = to;
}

// Streaks over unique, sorted days. Today without activity yet doesn't break the current streak.
const byDate = new Map(days.map((d) => [d.date, d.contributionCount]));
const dates = [...byDate.keys()].sort();
let longest = 0;
let run = 0;
for (const d of dates) {
  run = byDate.get(d) > 0 ? run + 1 : 0;
  longest = Math.max(longest, run);
}
let current = 0;
let i = dates.length - 1;
if (i >= 0 && byDate.get(dates[i]) === 0) i--;
for (; i >= 0 && byDate.get(dates[i]) > 0; i--) current++;
const lastYear = dates.slice(-365).reduce((sum, d) => sum + byDate.get(d), 0);

const stars = u.repositories.nodes.reduce((sum, r) => sum + r.stargazerCount, 0);
// Notebook bytes are mostly saved outputs, so they would swamp real code.
const skipLangs = new Set(["Jupyter Notebook"]);
const langs = new Map();
for (const repo of u.repositories.nodes)
  for (const { size, node } of repo.languages.edges) {
    if (skipLangs.has(node.name)) continue;
    const prev = langs.get(node.name) ?? { size: 0, color: node.color ?? "#808080" };
    langs.set(node.name, { ...prev, size: prev.size + size });
  }
const langTotal = [...langs.values()].reduce((s, l) => s + l.size, 0);
const topLangs = [...langs.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 6);

// Windows 95 styling to match the profile header and footer images.
const W = 495;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const fmt = (n) => n.toLocaleString("en-US");
const font = `font-family="'Courier New', Consolas, monospace"`;

function frame(title, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(title)}">
  <rect x="1" y="1" width="${W - 2}" height="${height - 2}" fill="#c0c0c0" stroke="#000" stroke-width="2"/>
  <rect x="6" y="6" width="${W - 12}" height="26" fill="#0057cc"/>
  <text x="14" y="24" ${font} font-size="14" font-weight="bold" fill="#e0e0e0">${esc(title)}</text>
  ${["_", "□", "×"].map((g, k) => `<rect x="${W - 84 + k * 26}" y="9" width="22" height="20" fill="#c0c0c0" stroke="#000"/><text x="${W - 73 + k * 26}" y="24" ${font} font-size="14" font-weight="bold" text-anchor="middle" fill="#000">${g}</text>`).join("")}
  <rect x="12" y="40" width="${W - 24}" height="${height - 52}" fill="#ffffff" stroke="#808080" stroke-width="2"/>
  ${body}
</svg>
`;
}

const rows = [
  ["Total contributions", fmt(totals.all)],
  ["Last 365 days", fmt(lastYear)],
  ["Commits", fmt(totals.commits)],
  ["Pull requests", fmt(totals.prs)],
  ["Issues", fmt(totals.issues)],
  ["Private contributions", fmt(totals.private)],
  ["Public repos contributed to", fmt(u.repositoriesContributedTo.totalCount)],
  ["Stars earned", fmt(stars)],
  ["Current streak", `${current} day${current === 1 ? "" : "s"}`],
  ["Longest streak", `${longest} day${longest === 1 ? "" : "s"}`],
];
const half = Math.ceil(rows.length / 2);
const statsBody = rows
  .map(([label, value], k) => {
    const col = k < half ? 0 : 1;
    const x = 26 + col * 236;
    const y = 66 + (k % half) * 34;
    return `<text x="${x}" y="${y}" ${font} font-size="12" fill="#404040">${esc(label)}</text><text x="${x}" y="${y + 13}" ${font} font-size="13" font-weight="bold" fill="#000">${esc(value)}</text>`;
  })
  .join("\n  ");
const statsHeight = 66 + half * 34 + 6;

const barX = 26;
const barW = W - 52;
let cursor = barX;
const segments = topLangs
  .map(([, l]) => {
    const w = (l.size / langTotal) * barW;
    const seg = `<rect x="${cursor.toFixed(1)}" y="66" width="${w.toFixed(1)}" height="16" fill="${l.color}"/>`;
    cursor += w;
    return seg;
  })
  .join("");
const legend = topLangs
  .map(([name, l], k) => {
    const x = 26 + (k % 2) * 236;
    const y = 120 + Math.floor(k / 2) * 38;
    const pct = ((l.size / langTotal) * 100).toFixed(1);
    return `<rect x="${x}" y="${y - 10}" width="11" height="11" fill="${l.color}" stroke="#000"/><text x="${x + 18}" y="${y}" ${font} font-size="12" fill="#000">${esc(name)} ${pct}%</text>`;
  })
  .join("\n  ");
// Same height as the stats card so the two sit level side by side.
const langHeight = statsHeight;

mkdirSync("cards", { recursive: true });
writeFileSync("cards/stats.svg", frame("C:\\stats.exe", statsHeight, statsBody));
writeFileSync(
  "cards/languages.svg",
  frame(
    "C:\\languages.exe",
    langHeight,
    `<rect x="${barX - 2}" y="64" width="${barW + 4}" height="20" fill="#c0c0c0" stroke="#000"/>${segments}\n  ${legend}`,
  ),
);
console.log({ ...totals, lastYear, current, longest, stars, langs: topLangs.map(([n]) => n) });
