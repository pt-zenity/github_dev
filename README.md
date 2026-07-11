# GitManager

A GitHub repository management web UI built with **Hono** + **Cloudflare Pages**.  
Manage repos, branches, commits, Actions, secrets, collaborators, and downloads — all from one interface.

---

## Features

| Category | What you can do |
|---|---|
| **Dashboard** | View all repos (up to 300) with filter tabs: All / Public / Private / Fork / Archived |
| **Code Browser** | Browse files & folders, view file content, download raw files |
| **Commits** | List commits, view diffs per commit |
| **Branches & Tags** | List branches and tags |
| **Compare** | Compare two branches/tags/commits |
| **Search** | Full-text code search inside a repo |
| **Issues & PRs** | List issues and pull requests, view detail |
| **GitHub Actions** | List workflows & runs, view job logs (colorized), trigger dispatch, cancel/rerun |
| **Releases** | List releases with assets |
| **Environments** | View deployment environments |
| **Secrets & Variables** | View / create / delete Actions secrets and variables |
| **Webhooks** | View webhook configurations |
| **Collaborators** | Invite users, manage permissions, cancel pending invitations |
| **User Management** | Add users, permission matrix (pull/triage/push/maintain/admin), remove members |
| **Deploy Keys** | View deploy keys |
| **Download Center** | Download release assets, source archives (ZIP/TAR per branch/tag), workflow artifacts, file finder — all proxied through server (no external redirects) |

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Node.js** | ≥ 18 | https://nodejs.org |
| **npm** | ≥ 9 | bundled with Node.js |
| **Git** | any | https://git-scm.com |
| **Wrangler CLI** | ≥ 4 | installed via `npm install` (no global install needed) |
| **GitHub Account** | — | https://github.com |
| **GitHub Personal Access Token** | — | see [Create Token](#create-github-token) below |

---

## Install from Scratch

### 1. Clone the repository

```bash
git clone https://github.com/pt-zenity/github_dev.git
cd github_dev
```

### 2. Install dependencies

```bash
npm install
```

### 3. Build

```bash
npm run build
```

This compiles `src/index.tsx` via Vite into `dist/_worker.js` (Cloudflare Workers bundle).

### 4. Run locally

```bash
npm run preview
```

The app will be available at **http://localhost:8788**

> To run on a custom port (e.g. 3000):
> ```bash
> npx wrangler pages dev dist --port 3000
> ```

### 5. Open the app

Go to **http://localhost:8788** (or your custom port), then enter your GitHub Personal Access Token on the login page.

---

## Create GitHub Token

1. Go to https://github.com/settings/tokens
2. Click **"Generate new token (classic)"**
3. Give it a name, e.g. `gitmanager`
4. Select the following scopes:

| Scope | Purpose |
|---|---|
| `repo` | Full access to repos (code, issues, PRs, etc.) |
| `workflow` | Trigger and manage GitHub Actions workflows |
| `read:user` | Read user profile |
| `read:org` | Read organization membership |

5. Click **Generate token** and copy the token
6. Paste it into the GitManager login page

> ⚠️ The token is stored in a browser cookie (`gh_token`) — it never leaves your browser/server session.

---

## Project Structure

```
github_dev/
├── src/
│   ├── index.tsx        # Main app — all routes and page templates (~4000 lines)
│   └── renderer.tsx     # JSX renderer helper
│   └── routes/          # (reserved for future route splitting)
├── public/
│   └── static/
│       └── style.css    # All CSS styles
├── dist/                # Build output (auto-generated, not committed)
├── package.json         # Dependencies and scripts
├── wrangler.jsonc       # Cloudflare Pages config
├── vite.config.ts       # Vite build config
└── README.md            # This file
```

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run build` | Build for production → `dist/` |
| `npm run preview` | Serve production build locally via Wrangler |
| `npm run dev` | Start Vite dev server (hot reload, no Cloudflare runtime) |
| `npm run deploy` | Build + deploy to Cloudflare Pages |

---

## Deploy to Cloudflare Pages

### Option A — Wrangler CLI (recommended)

```bash
# 1. Login to Cloudflare
npx wrangler login

# 2. Build
npm run build

# 3. Deploy
npx wrangler pages deploy dist --project-name gitmanager
```

On first deploy Wrangler will create the Pages project automatically.  
Subsequent deploys: just run `npm run deploy`.

### Option B — GitHub + Cloudflare Pages Dashboard

1. Push this repo to your GitHub account
2. Go to https://dash.cloudflare.com → **Pages** → **Create a project**
3. Connect your GitHub repo
4. Set build settings:
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
5. Click **Save and Deploy**

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (edge) |
| Framework | [Hono](https://hono.dev) v4 |
| Build tool | [Vite](https://vitejs.dev) v6 + `@hono/vite-build` |
| Deploy | [Cloudflare Pages](https://pages.cloudflare.com) |
| Crypto | [TweetNaCl](https://tweetnacl.js.org) (token encryption) |
| Styling | Custom CSS (glass morphism dark theme) + Tailwind CDN |
| Icons / UI | FontAwesome CDN |
| API | [GitHub REST API v3](https://docs.github.com/en/rest) |

---

## Environment Notes

- **No database required** — all data is fetched live from the GitHub API
- **No server process** — runs entirely on Cloudflare's edge network
- **Token security** — the GitHub token is stored as an encrypted cookie; it is used server-side to call the GitHub API and never exposed in frontend HTML
- **Download proxy** — all file downloads are streamed through the server so the browser never redirects to `github.com` or Azure blob URLs

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Error: No such module 'node:...'` | Make sure `"nodejs_compat"` is set in `wrangler.jsonc` compatibility_flags |
| Login page loops after token entry | Check token has correct scopes (`repo`, `workflow`, `read:user`) |
| `dist/` not found | Run `npm run build` first |
| Port already in use | Run `npx kill-port 8788` or change port with `--port XXXX` |
| Build error: cannot find `@hono/vite-build` | Run `npm install` again |
| Wrangler not found | Use `npx wrangler` instead of `wrangler` directly |

---

## License

MIT
