// Builds the profile README cards from the GitHub API. No npm packages, Node 22+.
// Env: GH_TOKEN (required), GH_USER (default: token owner), OUT (default: dist),
// TZ_NAME (default: Asia/Kolkata), OWNERS (extra accounts/orgs whose repos count as yours,
// comma separated), OSS_INCLUDE_ORGS=1 to count PRs to your own orgs as outside work.
import { mkdir, writeFile } from 'node:fs/promises';
import ICONS from './octicons.json' with { type: 'json' };
import STACK from './stack.json' with { type: 'json' };

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) throw new Error('GH_TOKEN is empty');
const OUT = process.env.OUT || 'dist';
const TZ = process.env.TZ_NAME || 'Asia/Kolkata';
const OWNERS = (process.env.OWNERS || '').split(',').map((s) => s.trim()).filter(Boolean);

// GitHub Primer colors, so the cards sit in the dashboard like native boxes.
const THEMES = {
  light: { fg: '#1f2328', muted: '#59636e', border: '#d1d9e0', track: '#eff2f5', cal: ['#eff2f5', '#aceebb', '#4ac26b', '#2da44e', '#116329'] },
  dark: { fg: '#f0f6fc', muted: '#9198a1', border: '#3d444d', track: '#212830', cal: ['#212830', '#033a16', '#196c2e', '#2ea043', '#56d364'] },
};
const W = 415, H = 200, PAD = 20;
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;

async function gh(path, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.github.com${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `bearer ${TOKEN}`, 'user-agent': 'profile-cards', accept: 'application/vnd.github+json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (res.ok) {
      const json = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors));
      return json;
    }
    if (attempt === 3 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
      throw new Error(`${path} ${res.status}: ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, attempt * 5000));
  }
}
const gql = async (query, variables) => (await gh('/graphql', { query, variables })).data;

// ---------- data ----------

async function load() {
  const login = process.env.GH_USER || (await gql('{viewer{login}}')).viewer.login;
  const base = (await gql(
    `query($login:String!){user(login:$login){
      login followers{totalCount} organizations(first:50){nodes{login}}
      pullRequests(states:MERGED){totalCount}
      repositoriesContributedTo(first:1,includeUserRepositories:false,contributionTypes:[COMMIT,PULL_REQUEST,ISSUE,REPOSITORY]){totalCount}
      contributionsCollection{contributionYears totalCommitContributions restrictedContributionsCount
        totalPullRequestContributions totalIssueContributions totalPullRequestReviewContributions}
    }}`, { login })).user;

  // Your repos plus the orgs in OWNERS. `mine` is the personal subset used for stats and languages.
  const repos = [];
  for (const owner of new Set([login, ...OWNERS])) {
    for (let after = null; ;) {
      const page = (await gql(
        `query($owner:String!,$after:String){repositoryOwner(login:$owner){repositories(first:100,after:$after,ownerAffiliations:OWNER,isFork:false,privacy:PUBLIC){
          pageInfo{hasNextPage endCursor}
          nodes{name nameWithOwner pushedAt stargazerCount isArchived owner{login} licenseInfo{spdxId}
            latestRelease{tagName publishedAt} primaryLanguage{name color}
            languages(first:10,orderBy:{field:SIZE,direction:DESC}){edges{size node{name color}}}}}}}`,
        { owner, after })).repositoryOwner.repositories;
      repos.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
  }
  const self = `${login}/${login}`.toLowerCase();
  const visible = repos.filter((r) => r.nameWithOwner.toLowerCase() !== self);
  const mine = repos.filter((r) => r.owner.login.toLowerCase() === login.toLowerCase());

  // The calendar API returns one year per query, so walk every year for the longest streak.
  const days = [];
  for (const year of [...base.contributionsCollection.contributionYears].sort()) {
    const cal = (await gql(
      `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){
        contributionCalendar{weeks{contributionDays{date contributionCount contributionLevel}}}}}}`,
      { login, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
    )).user.contributionsCollection.contributionCalendar;
    for (const w of cal.weeks) days.push(...w.contributionDays);
  }

  const prs = [];
  for (let after = null; prs.length < 1000;) {
    const page = (await gql(
      `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:100,after:$after){
        pageInfo{hasNextPage endCursor}
        nodes{...on PullRequest{repository{nameWithOwner stargazerCount owner{login}}}}}}`,
      { q: `author:${login} type:pr is:merged -user:${login}`, after })).search;
    prs.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }

  const events = await gh(`/users/${login}/events/public?per_page=100`);
  return { login, base, repos: visible, mine, days, prs, events };
}

// ---------- svg helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n) => n.toLocaleString('en-US');
// ponytail: width estimate from average glyph width, not real font metrics. Good enough for single-line labels.
const fit = (s, px, size = 14) => {
  const max = Math.floor(px / (size * 0.56));
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
};
const fmtDate = (d, year = false) => new Date(d).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', ...(year && { year: 'numeric' }) });
const icon = (name, x, y, color) =>
  ICONS[name].split('|').map((d) => `<path transform="translate(${x} ${y})" fill="${color}" d="${d}"/>`).join('');

function card(id, title, desc, body, t, aside = '', h = H, w = W) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${id}-t ${id}-d">
<title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>
<style>text{font-family:${FONT};font-size:14px;fill:${t.fg}}.m{fill:${t.muted};font-size:12px}.b{font-weight:600}.n{font-variant-numeric:tabular-nums}</style>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="6" fill="none" stroke="${t.border}"/>
<text x="${PAD}" y="${PAD + 12}" class="b">${esc(title)}</text>
${aside && `<text x="${w - PAD}" y="${PAD + 12}" text-anchor="end" class="m">${esc(aside)}</text>`}
${body}
</svg>\n`;
}

// One label/value row with an octicon, the way GitHub lists facts in its sidebar.
const ROW0 = PAD + 46, ROWH = 27;
function row(i, ico, label, value, t, note = '') {
  const y = ROW0 + i * ROWH;
  return icon(ico, PAD, y - 12, t.muted) +
    `<text x="${PAD + 26}" y="${y}">${esc(label)}${note ? `<tspan class="m" dx="6">${esc(note)}</tspan>` : ''}</text>` +
    `<text x="${W - PAD}" y="${y}" text-anchor="end" class="b n">${esc(value)}</text>`;
}

// ---------- cards ----------

function stats({ base, mine }, t) {
  const c = base.contributionsCollection;
  const stars = mine.reduce((s, r) => s + r.stargazerCount, 0);
  const commits = c.totalCommitContributions + c.restrictedContributionsCount;
  const rows = [
    ['star', 'Stars earned', num(stars)],
    ['git-commit', 'Commits', num(commits), 'last 12 months'],
    ['git-pull-request', 'Pull requests', num(c.totalPullRequestContributions), 'last 12 months'],
    ['people', 'Followers', num(base.followers.totalCount)],
    ['repo', 'Contributed to', `${num(base.repositoriesContributedTo.totalCount)} repos`],
  ];
  return card('stats', 'GitHub stats', rows.map((r) => `${r[1]}: ${r[2]}`).join(', '),
    rows.map((r, i) => row(i, r[0], r[1], r[2], t, r[3])).join(''), t);
}

function streakData(days) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const past = days.filter((d) => d.date <= today);
  let longest = { len: 0 }, run = { len: 0 };
  for (const d of past) {
    if (d.contributionCount > 0) {
      run = run.len ? { ...run, len: run.len + 1, end: d.date } : { len: 1, start: d.date, end: d.date };
      if (run.len > longest.len) longest = run;
    } else run = { len: 0 };
  }
  // Today without contributions yet does not break the streak.
  const last = past.at(-1);
  const current = run.len ? run : (last?.date === today && last.contributionCount === 0 ? currentBefore(past.slice(0, -1)) : { len: 0 });
  const total = past.reduce((s, d) => s + d.contributionCount, 0);
  return { current, longest, total, first: past.find((d) => d.contributionCount > 0)?.date, past };
}
function currentBefore(days) {
  let len = 0, start, end;
  for (let i = days.length - 1; i >= 0 && days[i].contributionCount > 0; i--) { len++; start = days[i].date; end ??= days[i].date; }
  return { len, start, end };
}

function streak({ days }, t) {
  const s = streakData(days);
  const thisYear = new Date().getFullYear();
  const range = (r) => (r.len ? `${fmtDate(r.start)} to ${fmtDate(r.end, r.end.slice(0, 4) != thisYear)}` : 'none yet');
  const dayWord = (n) => `${num(n)} ${n === 1 ? 'day' : 'days'}`;
  // Last 12 weeks of the real calendar.
  const weeks = 12, cell = 10, gap = 3;
  const tail = s.past.slice(-(weeks * 7 - (6 - new Date(s.past.at(-1).date).getUTCDay())));
  const firstDow = new Date(tail[0].date).getUTCDay();
  const lv = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
  const gx = W - PAD - (weeks * (cell + gap) - gap), gy = PAD + 34;
  const grid = tail.map((d, i) => {
    const k = i + firstDow, x = gx + Math.floor(k / 7) * (cell + gap), y = gy + (k % 7) * (cell + gap);
    return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${t.cal[lv[d.contributionLevel] ?? 0]}"><title>${esc(`${d.contributionCount} on ${d.date}`)}</title></rect>`;
  }).join('');
  const facts = [
    ['Current streak', dayWord(s.current.len), range(s.current)],
    ['Longest streak', dayWord(s.longest.len), range(s.longest)],
    ['Contributions', num(s.total), s.first ? `since ${fmtDate(s.first, true)}` : ''],
  ];
  const body = facts.map(([label, value, note], i) => {
    const y = PAD + 46 + i * 46;
    return `<text x="${PAD}" y="${y}" class="m">${esc(label)}</text><text x="${PAD}" y="${y + 19}" class="b n">${esc(value)}<tspan class="m" font-weight="400" dx="8">${esc(note)}</tspan></text>`;
  }).join('') + grid;
  return card('streak', 'Contribution streak', facts.map((f) => `${f[0]}: ${f[1]} (${f[2]})`).join(', '), body, t);
}

// Full width: two cards plus the space between them in the README.
const WIDE = W * 2 + 4;

function langs({ mine, login }, t) {
  const sizes = new Map();
  for (const r of mine) {
    if (r.name.toLowerCase() === login.toLowerCase()) continue;
    for (const e of r.languages.edges) {
      const cur = sizes.get(e.node.name) || { size: 0, color: e.node.color };
      cur.size += e.size;
      sizes.set(e.node.name, cur);
    }
  }
  const all = [...sizes].sort((a, b) => b[1].size - a[1].size);
  const total = all.reduce((s, [, v]) => s + v.size, 0) || 1;
  const top = all.slice(0, 8), rest = all.slice(8).reduce((s, [, v]) => s + v.size, 0);
  if (rest) top.push(['Other', { size: rest, color: t.muted }]);
  const bw = WIDE - PAD * 2, by = PAD + 30;
  let x = PAD;
  const segs = top.map(([name, v]) => {
    const w = (v.size / total) * bw;
    const seg = `<rect x="${x.toFixed(2)}" y="${by}" width="${Math.max(w - 2, 1).toFixed(2)}" height="8" fill="${v.color || t.muted}"><title>${esc(name)}</title></rect>`;
    x += w;
    return seg;
  }).join('');
  const legend = top.map(([name, v], i) => {
    const col = i % 4, r = Math.floor(i / 4), lx = PAD + col * (bw / 4), ly = by + 38 + r * 26;
    const pct = (v.size / total) * 100;
    return `<circle cx="${lx + 5}" cy="${ly - 5}" r="5" fill="${v.color || t.muted}"/>` +
      `<text x="${lx + 18}" y="${ly}">${esc(fit(name, bw / 4 - 80))}<tspan class="m n" dx="6">${pct < 0.1 ? '<0.1' : pct.toFixed(1)}%</tspan></text>`;
  }).join('');
  const body = `<clipPath id="bar"><rect x="${PAD}" y="${by}" width="${bw}" height="8" rx="4"/></clipPath><g clip-path="url(#bar)"><rect x="${PAD}" y="${by}" width="${bw}" height="8" fill="${t.track}"/>${segs}</g>${legend}`;
  return card('langs', 'Most used languages', top.map(([n, v]) => `${n} ${((v.size / total) * 100).toFixed(1)}%`).join(', '), body, t, '',
    by + 38 + (Math.ceil(top.length / 4) - 1) * 26 + PAD + 8, WIDE);
}

// Repo list rows: name, then a middle column, then a right-aligned value.
function repoRows(list, mid, right, t, ico = 'repo') {
  return list.map((r, i) => {
    const y = ROW0 + i * ROWH;
    return icon(ico, PAD, y - 12, t.muted) +
      `<text x="${PAD + 26}" y="${y}" class="b">${esc(fit(r.name, 155))}</text>` + mid(r, y) +
      `<text x="${W - PAD}" y="${y}" text-anchor="end" class="m n">${esc(right(r))}</text>`;
  }).join('');
}
// `at` is the column's distance from the right edge.
const langCell = (r, y, t, at = 150) => {
  const lang = r.primaryLanguage;
  return lang ? `<circle cx="${W - PAD - at}" cy="${y - 5}" r="5" fill="${lang.color || t.muted}"/><text x="${W - PAD - at + 11}" y="${y}" class="m">${esc(fit(lang.name, 80, 12))}</text>` : '';
};
const starCell = (r, y, t, at = 150) => icon('star', W - PAD - at, y - 12, t.muted) + `<text x="${W - PAD - at + 22}" y="${y}" class="m n">${num(r.stargazerCount)}</text>`;

// Tall cards list up to 10 rows. Projects and OSS sit side by side, so both keep the 10-row height;
// releases never goes below the standard card height so it lines up with its neighbour.
const LONG = 10;
const tallH = (rows) => ROW0 + (Math.max(rows, 1) - 1) * ROWH + PAD + 8;
const more = (n, shown, word) => (n > shown ? `+${n - shown} more` : `${n} ${word}`);

// Open source you maintain: licensed and not archived, most starred first.
function projects({ repos }, t) {
  const list = repos.filter((r) => !r.isArchived && r.licenseInfo && r.licenseInfo.spdxId !== 'NOASSERTION')
    .sort((a, b) => b.stargazerCount - a.stargazerCount || b.pushedAt.localeCompare(a.pushedAt));
  const shown = list.slice(0, LONG);
  const body = repoRows(shown, (r, y) => langCell(r, y, t, 172) + starCell(r, y, t, 80), (r) => fmtDate(r.pushedAt), t);
  return card('projects', 'Open source projects', shown.map((r) => `${r.name} (${r.licenseInfo.spdxId}, ${r.stargazerCount} stars)`).join(', ') || 'None yet',
    body || empty('No licensed public repositories yet.', t), t, more(list.length, shown.length, 'projects'), tallH(LONG));
}

function releases({ repos }, t) {
  const list = repos.filter((r) => r.latestRelease).sort((a, b) => b.latestRelease.publishedAt.localeCompare(a.latestRelease.publishedAt));
  const shown = list.slice(0, LONG);
  const body = repoRows(shown, (r, y) => `<text x="${W - PAD - 150}" y="${y}" class="m">${esc(fit(r.latestRelease.tagName, 90, 12))}</text>`,
    (r) => fmtDate(r.latestRelease.publishedAt, r.latestRelease.publishedAt.slice(0, 4) != new Date().getFullYear()), t, 'tag');
  return card('releases', 'Recent releases', shown.map((r) => `${r.name} ${r.latestRelease.tagName}`).join(', ') || 'No releases yet',
    body || empty('No releases yet.', t), t, more(list.length, shown.length, 'repos'), Math.max(H, tallH(shown.length)));
}

function oss({ prs, base, login }, t) {
  const own = new Set([login, ...OWNERS, ...base.organizations.nodes.map((o) => o.login)].map((s) => s.toLowerCase()));
  const byRepo = new Map();
  for (const p of prs) {
    const r = p.repository;
    if (!r || (!process.env.OSS_INCLUDE_ORGS && own.has(r.owner.login.toLowerCase()))) continue;
    const cur = byRepo.get(r.nameWithOwner) || { stars: r.stargazerCount, count: 0 };
    cur.count++;
    byRepo.set(r.nameWithOwner, cur);
  }
  const all = [...byRepo].sort((a, b) => b[1].stars - a[1].stars);
  const list = all.slice(0, LONG);
  const body = list.map(([name, v], i) => {
    const y = ROW0 + i * ROWH;
    return icon('git-merge', PAD, y - 12, t.muted) +
      `<text x="${PAD + 26}" y="${y}">${esc(fit(name, 210))}</text>` +
      icon('star', W - PAD - 132, y - 12, t.muted) +
      `<text x="${W - PAD - 110}" y="${y}" class="m n">${num(v.stars)}</text>` +
      `<text x="${W - PAD}" y="${y}" text-anchor="end" class="b n">${v.count} ${v.count === 1 ? 'PR' : 'PRs'}</text>`;
  }).join('');
  const desc = list.length ? list.map(([n, v]) => `${n}: ${v.count} merged`).join(', ') : 'No merged pull requests to other projects yet';
  return card('oss', 'Merged PRs to other projects', desc, body || empty('No merged pull requests to other projects yet.', t), t,
    more(all.length, list.length, 'projects'), tallH(LONG));
}

function describe(e, login) {
  const repo = e.repo.name.replace(new RegExp(`^(${[login, ...OWNERS].join('|')})/`, 'i'), ''), p = e.payload;
  switch (e.type) {
    // The events API no longer reports commit counts for pushes.
    case 'PushEvent': return ['repo-push', `Pushed to ${repo}`];
    case 'PullRequestEvent':
      if (p.action === 'closed' && p.pull_request?.merged) return ['git-merge', `Merged a PR in ${repo}`];
      return p.action === 'opened' ? ['git-pull-request', `Opened a PR in ${repo}`] : null;
    case 'PullRequestReviewEvent': return ['code-review', `Reviewed a PR in ${repo}`];
    case 'IssuesEvent': return p.action === 'opened' ? ['issue-opened', `Opened an issue in ${repo}`] : null;
    case 'ReleaseEvent': return ['tag', `Released ${p.release?.tag_name ?? ''} of ${repo}`];
    case 'CreateEvent': return p.ref_type === 'repository' ? ['repo', `Created ${repo}`] : null;
    case 'ForkEvent': return ['repo-forked', `Forked ${repo}`];
    default: return null;
  }
}

function activity({ events, login }, t) {
  const self = `${login}/${login}`.toLowerCase();
  const seen = new Set(), list = [];
  for (const e of events) {
    if (e.repo.name.toLowerCase() === self) continue;
    const d = describe(e, login);
    if (!d) continue;
    const key = d[1] + fmtDate(e.created_at);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push([...d, e.created_at]);
    if (list.length === 5) break;
  }
  const body = list.map(([ico, text, at], i) => {
    const y = ROW0 + i * ROWH;
    return icon(ico, PAD, y - 12, t.muted) +
      `<text x="${PAD + 26}" y="${y}">${esc(fit(text, W - PAD * 2 - 80))}</text>` +
      `<text x="${W - PAD}" y="${y}" text-anchor="end" class="m n">${fmtDate(at)}</text>`;
  }).join('');
  return card('activity', 'Recent activity', list.map((l) => l[1]).join(', ') || 'No recent public activity', body || empty('No recent public activity.', t), t);
}

const empty = (msg, t) => `<text x="${PAD}" y="${ROW0}" class="m">${esc(msg)}</text>`;

// Stack chips: one small linked image per tool, brand icon (simple-icons on a 24px grid, or its own `transform` for other sources) in the text color.
function chip({ label, path, transform = 'translate(10 8) scale(0.6667)' }, t) {
  const w = Math.round(42 + [...label].reduce((s, c) => s + (c >= 'A' && c <= 'Z' ? 9.5 : 7), 0)); // ponytail: glyph-width guess, capitals are wider
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="32" viewBox="0 0 ${w} 32" role="img" aria-label="${esc(label)}">
<rect x="0.5" y="0.5" width="${w - 1}" height="31" rx="6" fill="none" stroke="${t.border}"/>
<path transform="${transform}" fill="${t.fg}" d="${path}"/>
<text x="32" y="21" style="font-family:${FONT};font-size:13px;fill:${t.fg}">${esc(label)}</text>
</svg>\n`;
}

// ---------- main ----------

const data = await load();
await mkdir(OUT, { recursive: true });
const cards = { stats, streak, projects, releases, oss, langs, activity };
for (const s of STACK) cards[`stack-${s.id}`] = (_, t) => chip(s, t);
for (const [name, fn] of Object.entries(cards)) {
  for (const [theme, t] of Object.entries(THEMES)) await writeFile(`${OUT}/${name}-${theme}.svg`, fn(data, t));
}
console.log(`wrote ${Object.keys(cards).length * 2} cards for ${data.login} to ${OUT}/`);
