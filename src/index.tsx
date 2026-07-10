import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

const app = new Hono()

// Serve static files
app.use('/static/*', serveStatic({ root: './public' }))

// Favicon
app.get('/favicon.ico', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#6366f1"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>`
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } })
})

// ==================== HELPER ====================
function getToken(c: any): string | null {
  return getCookie(c, 'gh_token') || null
}

async function githubApi(token: string, path: string, options: RequestInit = {}) {
  const resp = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GitManager/1.0',
      ...(options.headers || {})
    }
  })
  const data = await resp.json() as any
  return { status: resp.status, data }
}

// ==================== AUTH ====================
app.get('/login', (c) => {
  const token = getToken(c)
  if (token) return c.redirect('/dashboard')
  return c.html(loginPage())
})

app.post('/login', async (c) => {
  const form = await c.req.formData()
  const token = form.get('token') as string
  if (!token) return c.html(loginPage('Token tidak boleh kosong'))
  
  const { status, data } = await githubApi(token, '/user')
  if (status !== 200) return c.html(loginPage('Token tidak valid atau tidak memiliki akses'))
  
  setCookie(c, 'gh_token', token, {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 7
  })
  setCookie(c, 'gh_user', JSON.stringify({ login: data.login, avatar_url: data.avatar_url, name: data.name }), {
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 7
  })
  return c.redirect('/dashboard')
})

app.get('/logout', (c) => {
  deleteCookie(c, 'gh_token')
  deleteCookie(c, 'gh_user')
  return c.redirect('/login')
})

// ==================== DASHBOARD ====================
app.get('/', (c) => c.redirect('/dashboard'))

app.get('/dashboard', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const { data: repos } = await githubApi(token, '/user/repos?sort=updated&per_page=50&type=all')
  const { data: userData } = await githubApi(token, '/user')
  
  return c.html(dashboardPage(user, Array.isArray(repos) ? repos : [], userData))
})

// ==================== REPOSITORY ROUTES ====================
// Code / Files
app.get('/repo/:owner/:repo', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const path = c.req.query('path') || ''
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}

  // Fetch repo info first to get real default_branch
  const repoRes = await githubApi(token, `/repos/${owner}/${repo}`)
  const repoData = repoRes.data
  const branch = c.req.query('branch') || repoData?.default_branch || 'main'

  const treePath = path ? `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}` : `/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(branch)}`
  const [contentsRes, branchesRes] = await Promise.all([
    githubApi(token, treePath),
    githubApi(token, `/repos/${owner}/${repo}/branches?per_page=100`)
  ])
  
  return c.html(codePage(user, owner, repo, contentsRes.data, repoData, branchesRes.data, path, branch))
})

// File content
app.get('/repo/:owner/:repo/blob', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const path = c.req.query('path') || ''
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const repoRes = await githubApi(token, `/repos/${owner}/${repo}`)
  const repoData = repoRes.data
  const branch = c.req.query('branch') || repoData?.default_branch || 'main'

  const fileRes = await githubApi(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`)
  
  return c.html(filePage(user, owner, repo, fileRes.data, repoData, path, branch))
})

// Commits
app.get('/repo/:owner/:repo/commits', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const page = parseInt(c.req.query('page') || '1')
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const repoRes = await githubApi(token, `/repos/${owner}/${repo}`)
  const repoData = repoRes.data
  const branch = c.req.query('branch') || repoData?.default_branch || 'main'

  const branchParam = branch ? `&sha=${encodeURIComponent(branch)}` : ''
  const commitsRes = await githubApi(token, `/repos/${owner}/${repo}/commits?per_page=20&page=${page}${branchParam}`)
  
  return c.html(commitsPage(user, owner, repo, commitsRes.data, repoData, page, branch))
})

// Single Commit
app.get('/repo/:owner/:repo/commit/:sha', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo, sha } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [commitRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/commits/${sha}`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(commitDetailPage(user, owner, repo, commitRes.data, repoRes.data))
})

// Branches
app.get('/repo/:owner/:repo/branches', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [branchesRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/branches?per_page=100`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(branchesPage(user, owner, repo, branchesRes.data, repoRes.data))
})

// Tags
app.get('/repo/:owner/:repo/tags', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [tagsRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/tags?per_page=50`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(tagsPage(user, owner, repo, tagsRes.data, repoRes.data))
})

// Compare
app.get('/repo/:owner/:repo/compare', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const base = c.req.query('base') || ''
  const head = c.req.query('head') || ''
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [branchesRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/branches?per_page=100`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  let compareData: any = null
  if (base && head) {
    const compareRes = await githubApi(token, `/repos/${owner}/${repo}/compare/${base}...${head}`)
    compareData = compareRes.data
  }
  
  return c.html(comparePage(user, owner, repo, branchesRes.data, repoRes.data, base, head, compareData))
})

// Search Code
app.get('/repo/:owner/:repo/search', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const q = c.req.query('q') || ''
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  let searchResults: any = null
  if (q) {
    const searchRes = await githubApi(token, `/search/code?q=${encodeURIComponent(q)}+repo:${owner}/${repo}&per_page=20`)
    searchResults = searchRes.data
  }
  
  return c.html(searchPage(user, owner, repo, repoRes.data, q, searchResults))
})

// Issues
app.get('/repo/:owner/:repo/issues', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const state = c.req.query('state') || 'open'
  const page = parseInt(c.req.query('page') || '1')
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [issuesRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/issues?state=${state}&per_page=20&page=${page}&filter=all`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(issuesPage(user, owner, repo, issuesRes.data, repoRes.data, state, page))
})

// Single Issue
app.get('/repo/:owner/:repo/issues/:number', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo, number } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [issueRes, commentsRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/issues/${number}`),
    githubApi(token, `/repos/${owner}/${repo}/issues/${number}/comments`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(issueDetailPage(user, owner, repo, issueRes.data, commentsRes.data, repoRes.data))
})

// Pull Requests
app.get('/repo/:owner/:repo/pulls', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const state = c.req.query('state') || 'open'
  const page = parseInt(c.req.query('page') || '1')
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [prsRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/pulls?state=${state}&per_page=20&page=${page}`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(pullsPage(user, owner, repo, prsRes.data, repoRes.data, state, page))
})

// Single PR
app.get('/repo/:owner/:repo/pulls/:number', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo, number } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [prRes, commentsRes, repoRes, filesRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/pulls/${number}`),
    githubApi(token, `/repos/${owner}/${repo}/issues/${number}/comments`),
    githubApi(token, `/repos/${owner}/${repo}`),
    githubApi(token, `/repos/${owner}/${repo}/pulls/${number}/files`)
  ])
  
  return c.html(prDetailPage(user, owner, repo, prRes.data, commentsRes.data, repoRes.data, filesRes.data))
})

// Actions
app.get('/repo/:owner/:repo/actions', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const page = parseInt(c.req.query('page') || '1')
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [runsRes, workflowsRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/actions/runs?per_page=20&page=${page}`),
    githubApi(token, `/repos/${owner}/${repo}/actions/workflows`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(actionsPage(user, owner, repo, runsRes.data, workflowsRes.data, repoRes.data, page))
})

// Releases
app.get('/repo/:owner/:repo/releases', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [releasesRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/releases?per_page=20`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(releasesPage(user, owner, repo, releasesRes.data, repoRes.data))
})

// Environments
app.get('/repo/:owner/:repo/environments', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [envsRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/environments`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(environmentsPage(user, owner, repo, envsRes.data, repoRes.data))
})

// Secrets
app.get('/repo/:owner/:repo/settings/secrets', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [secretsRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/actions/secrets`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(secretsPage(user, owner, repo, secretsRes.data, repoRes.data))
})

// Variables
app.get('/repo/:owner/:repo/settings/variables', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [varsRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/actions/variables`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(variablesPage(user, owner, repo, varsRes.data, repoRes.data))
})

// Webhooks
app.get('/repo/:owner/:repo/settings/webhooks', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [webhooksRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/hooks`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(webhooksPage(user, owner, repo, webhooksRes.data, repoRes.data))
})

// Collaborators
app.get('/repo/:owner/:repo/settings/collaborators', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [collabsRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/collaborators`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(collaboratorsPage(user, owner, repo, collabsRes.data, repoRes.data))
})

// Deploy Keys
app.get('/repo/:owner/:repo/settings/keys', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}
  
  const [keysRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/keys`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])
  
  return c.html(deployKeysPage(user, owner, repo, keysRes.data, repoRes.data))
})

// ==================== API PROXY ====================
app.get('/api/github/*', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const path = '/' + c.req.path.replace('/api/github/', '')
  const query = new URL(c.req.url).search
  const { status, data } = await githubApi(token, path + query)
  return c.json(data, status as any)
})

// ==================== PAGE TEMPLATES ====================
function glassLayout(title: string, user: any, content: string, activeRepo?: string) {
  const userStr = user?.login ? `
    <div class="flex items-center gap-3">
      <img src="${user.avatar_url || ''}" class="w-8 h-8 rounded-full border-2 border-white/30" />
      <span class="text-white/90 text-sm font-medium">${user.login}</span>
      <a href="/logout" class="glass-btn-sm text-red-300 hover:text-red-200">Logout</a>
    </div>
  ` : ''

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - GitManager</title>
<link rel="icon" type="image/svg+xml" href="/favicon.ico">
<link rel="stylesheet" href="/static/style.css">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
</head>
<body>
<div class="bg-animated">
  <div class="bg-orb bg-orb-1"></div>
  <div class="bg-orb bg-orb-2"></div>
  <div class="bg-orb bg-orb-3"></div>
</div>
<div class="app-container">
  <header class="glass-header">
    <div class="header-inner">
      <a href="/dashboard" class="logo">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
        <span>GitManager</span>
      </a>
      ${userStr}
    </div>
  </header>
  <main class="main-content">
    ${content}
  </main>
  <footer class="glass-footer">
    <p>GitManager &copy; 2025 &mdash; GitHub Repository Management</p>
  </footer>
</div>
<script>
document.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
</script>
</body>
</html>`
}

function repoNav(owner: string, repo: string, active: string, repoData?: any) {
  const defaultBranch = repoData?.default_branch || 'main'
  const items = [
    { key: 'code', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Code', href: `/repo/${owner}/${repo}` },
    { key: 'commits', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg> Commits', href: `/repo/${owner}/${repo}/commits` },
    { key: 'branches', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg> Branches', href: `/repo/${owner}/${repo}/branches` },
    { key: 'tags', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> Tags', href: `/repo/${owner}/${repo}/tags` },
    { key: 'compare', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 8 22 12 18 16"/><polyline points="6 8 2 12 6 16"/><line x1="2" y1="12" x2="22" y2="12"/></svg> Compare', href: `/repo/${owner}/${repo}/compare` },
    { key: 'search', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Search', href: `/repo/${owner}/${repo}/search` },
    { key: 'issues', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Issues', href: `/repo/${owner}/${repo}/issues` },
    { key: 'pulls', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg> Pull Requests', href: `/repo/${owner}/${repo}/pulls` },
    { key: 'actions', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Actions', href: `/repo/${owner}/${repo}/actions` },
    { key: 'releases', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Releases', href: `/repo/${owner}/${repo}/releases` },
    { key: 'environments', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Environments', href: `/repo/${owner}/${repo}/environments` },
    { key: 'secrets', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Secrets', href: `/repo/${owner}/${repo}/settings/secrets` },
    { key: 'variables', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg> Variables', href: `/repo/${owner}/${repo}/settings/variables` },
    { key: 'webhooks', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg> Webhooks', href: `/repo/${owner}/${repo}/settings/webhooks` },
    { key: 'collaborators', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> Collaborators', href: `/repo/${owner}/${repo}/settings/collaborators` },
    { key: 'keys', label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> Deploy Keys', href: `/repo/${owner}/${repo}/settings/keys` },
  ]
  
  return `<nav class="repo-nav glass-card mb-4">
    <div class="repo-nav-title">
      <a href="/dashboard" class="back-link">← Dashboard</a>
      <span class="repo-name-badge">
        <a href="https://github.com/${owner}" target="_blank" class="text-blue-300 hover:underline">${owner}</a>
        <span class="text-white/40">/</span>
        <a href="/repo/${owner}/${repo}" class="text-white hover:underline font-semibold">${repo}</a>
      </span>
      ${repoData?.private ? '<span class="badge-private">Private</span>' : '<span class="badge-public">Public</span>'}
    </div>
    <div class="repo-nav-items">
      ${items.map(item => `<a href="${item.href}" class="nav-item ${active === item.key ? 'active' : ''}">${item.label}</a>`).join('')}
    </div>
  </nav>`
}

// ==================== PAGE FUNCTIONS ====================
function loginPage(error?: string) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login - GitManager</title>
<link rel="icon" type="image/svg+xml" href="/favicon.ico">
<link rel="stylesheet" href="/static/style.css">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
</head>
<body>
<div class="bg-animated">
  <div class="bg-orb bg-orb-1"></div>
  <div class="bg-orb bg-orb-2"></div>
  <div class="bg-orb bg-orb-3"></div>
</div>
<div class="login-container">
  <div class="login-card glass-card">
    <div class="login-logo">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="white"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
    </div>
    <h1 class="login-title">GitManager</h1>
    <p class="login-subtitle">Masukkan GitHub Personal Access Token Anda</p>
    ${error ? `<div class="alert-error">${error}</div>` : ''}
    <form method="POST" action="/login" class="login-form">
      <div class="form-group">
        <label class="form-label">GitHub Token</label>
        <input type="password" name="token" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" class="form-input" required autocomplete="off" />
      </div>
      <button type="submit" class="btn-primary w-full">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        Login dengan Token
      </button>
    </form>
    <div class="login-help">
      <p>Buat token di <a href="https://github.com/settings/tokens" target="_blank" class="link">GitHub Settings → Developer settings → Personal access tokens</a></p>
      <p class="mt-1 text-white/40 text-xs">Scope yang diperlukan: repo, read:org, admin:repo_hook</p>
    </div>
  </div>
</div>
</body>
</html>`
}

function dashboardPage(user: any, repos: any[], userData: any) {
  const totalRepos = repos.length
  const privateRepos = repos.filter(r => r.private).length
  const publicRepos = totalRepos - privateRepos
  const totalStars = repos.reduce((sum, r) => sum + (r.stargazers_count || 0), 0)

  const repoCards = repos.map(repo => `
    <a href="/repo/${repo.owner.login}/${repo.name}" class="repo-card glass-card hover-lift">
      <div class="repo-card-header">
        <div class="repo-card-name">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>${repo.name}</span>
        </div>
        <span class="${repo.private ? 'badge-private' : 'badge-public'}">${repo.private ? 'Private' : 'Public'}</span>
      </div>
      ${repo.description ? `<p class="repo-desc">${repo.description}</p>` : '<p class="repo-desc text-white/30 italic">No description</p>'}
      <div class="repo-meta">
        ${repo.language ? `<span class="repo-lang"><span class="lang-dot"></span>${repo.language}</span>` : ''}
        <span class="repo-stat">⭐ ${repo.stargazers_count}</span>
        <span class="repo-stat">🍴 ${repo.forks_count}</span>
        <span class="repo-stat">🔄 ${timeAgo(repo.updated_at)}</span>
      </div>
    </a>
  `).join('')

  const content = `
    <div class="dashboard-header">
      <div class="user-profile glass-card">
        <img src="${userData?.avatar_url || ''}" class="user-avatar" />
        <div class="user-info">
          <h2 class="user-name">${userData?.name || userData?.login || 'User'}</h2>
          <p class="user-login">@${userData?.login}</p>
          ${userData?.bio ? `<p class="user-bio">${userData.bio}</p>` : ''}
          <div class="user-stats">
            <span>👥 ${userData?.followers} followers</span>
            <span>👤 ${userData?.following} following</span>
            <span>📦 ${userData?.public_repos} public repos</span>
          </div>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-card glass-card">
          <div class="stat-num">${totalRepos}</div>
          <div class="stat-label">Total Repos</div>
        </div>
        <div class="stat-card glass-card">
          <div class="stat-num">${publicRepos}</div>
          <div class="stat-label">Public</div>
        </div>
        <div class="stat-card glass-card">
          <div class="stat-num">${privateRepos}</div>
          <div class="stat-label">Private</div>
        </div>
        <div class="stat-card glass-card">
          <div class="stat-num">${totalStars}</div>
          <div class="stat-label">Total Stars</div>
        </div>
      </div>
    </div>
    
    <div class="section-header">
      <h3 class="section-title">Repositories</h3>
      <input type="text" id="repoSearch" placeholder="🔍 Filter repositories..." class="search-input" oninput="filterRepos(this.value)">
    </div>
    <div class="repo-grid" id="repoGrid">
      ${repoCards}
    </div>
    
    <script>
    function filterRepos(q) {
      const cards = document.querySelectorAll('#repoGrid .repo-card');
      const query = q.toLowerCase();
      cards.forEach(card => {
        const name = card.querySelector('.repo-card-name span').textContent.toLowerCase();
        const desc = card.querySelector('.repo-desc')?.textContent.toLowerCase() || '';
        card.style.display = name.includes(query) || desc.includes(query) ? '' : 'none';
      });
    }
    </script>
  `
  
  return glassLayout('Dashboard', user, content)
}

function codePage(user: any, owner: string, repo: string, contents: any, repoData: any, branches: any[], path: string, branch: string) {
  const isError = !Array.isArray(contents)
  const errorMsg = isError ? (contents?.message || 'Tidak dapat memuat konten repository') : ''
  const files = isError ? [] : contents.sort((a: any, b: any) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (a.type !== 'dir' && b.type === 'dir') return 1
    return a.name.localeCompare(b.name)
  })

  const breadcrumb = path ? path.split('/').map((part, i, arr) => {
    const partPath = arr.slice(0, i + 1).join('/')
    const href = `/repo/${owner}/${repo}?path=${encodeURIComponent(partPath)}&branch=${encodeURIComponent(branch)}`
    return `<a href="${href}" class="breadcrumb-link">${escapeHtml(part)}</a>`
  }).join('<span class="text-white/30"> / </span>') : ''

  const branchOptions = Array.isArray(branches) ? branches.map(b => 
    `<option value="${escapeHtml(b.name)}" ${b.name === branch ? 'selected' : ''}>${escapeHtml(b.name)}</option>`
  ).join('') : `<option value="${escapeHtml(branch)}" selected>${escapeHtml(branch)}</option>`

  const defaultBranch = repoData?.default_branch || branch

  const fileRows = files.map((f: any) => `
    <tr class="file-row">
      <td class="file-icon-cell">
        ${f.type === 'dir' ? 
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="#60a5fa" stroke="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' :
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
        }
      </td>
      <td class="file-name-cell">
        ${f.type === 'dir' ? 
          `<a href="/repo/${owner}/${repo}?path=${encodeURIComponent(f.path)}&branch=${encodeURIComponent(branch)}" class="file-link dir-link">${escapeHtml(f.name)}</a>` :
          `<a href="/repo/${owner}/${repo}/blob?path=${encodeURIComponent(f.path)}&branch=${encodeURIComponent(branch)}" class="file-link">${escapeHtml(f.name)}</a>`
        }
      </td>
      <td class="file-size-cell">${f.type === 'file' ? formatBytes(f.size) : ''}</td>
    </tr>
  `).join('')

  const content = `
    ${repoNav(owner, repo, 'code', repoData)}
    <div class="glass-card">
      <div class="code-toolbar">
        <div class="breadcrumb">
          <a href="/repo/${owner}/${repo}?branch=${encodeURIComponent(branch)}" class="breadcrumb-link">root</a>
          ${breadcrumb ? '<span class="text-white/30"> / </span>' + breadcrumb : ''}
        </div>
        <div class="toolbar-right">
          <select class="glass-select" onchange="window.location='/repo/${owner}/${repo}?branch='+encodeURIComponent(this.value)${path ? `+'&path=${encodeURIComponent(path)}'` : ''}">
            ${branchOptions}
          </select>
        </div>
      </div>
      ${isError
        ? `<div class="alert-error p-4">
            <strong>Gagal memuat konten:</strong> ${escapeHtml(errorMsg)}
            ${contents?.documentation_url ? `<br><a href="${contents.documentation_url}" target="_blank" class="link text-xs">${contents.documentation_url}</a>` : ''}
            <br><small class="text-white/50">Branch: <code>${escapeHtml(branch)}</code> | Default: <code>${escapeHtml(defaultBranch)}</code></small>
           </div>`
        : files.length === 0 ? '<div class="empty-state">Repository kosong atau branch belum memiliki file</div>' : `
        <table class="file-table">
          <tbody>${fileRows}</tbody>
        </table>
      `}
    </div>
    <div class="glass-card mt-3 p-4">
      <div class="flex flex-wrap gap-4 text-sm text-white/60">
        <span>🌿 Default branch: <code class="text-white/80">${escapeHtml(defaultBranch)}</code></span>
        <span>⭐ ${repoData?.stargazers_count || 0}</span>
        <span>🍴 ${repoData?.forks_count || 0}</span>
        <span>👁️ ${repoData?.watchers_count || 0}</span>
        ${repoData?.language ? `<span>💻 ${repoData.language}</span>` : ''}
        ${repoData?.license ? `<span>📄 ${repoData.license?.spdx_id || repoData.license?.name}</span>` : ''}
      </div>
      ${repoData?.description ? `<p class="mt-2 text-white/70 text-sm">${escapeHtml(repoData.description)}</p>` : ''}
    </div>
  `
  return glassLayout(`Code - ${repo}`, user, content)
}

function filePage(user: any, owner: string, repo: string, fileData: any, repoData: any, path: string, branch: string) {
  let fileContent = ''
  let isImage = false
  
  if (fileData?.content) {
    const ext = path.split('.').pop()?.toLowerCase() || ''
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico']
    if (imageExts.includes(ext)) {
      isImage = true
      fileContent = `<img src="data:image/${ext};base64,${fileData.content.replace(/\n/g, '')}" class="max-w-full" />`
    } else {
      try {
        const decoded = atob(fileData.content.replace(/\n/g, ''))
        const langMap: Record<string, string> = { js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c', php: 'php', sh: 'bash', yml: 'yaml', yaml: 'yaml', json: 'json', md: 'markdown', html: 'html', css: 'css', sql: 'sql' }
        const lang = langMap[ext] || ext || 'plaintext'
        fileContent = `<pre><code class="language-${lang}">${escapeHtml(decoded)}</code></pre>`
      } catch {
        fileContent = '<div class="alert-error">Cannot decode file content</div>'
      }
    }
  }

  const pathParts = path.split('/')
  const breadcrumb = pathParts.map((part, i, arr) => {
    if (i === arr.length - 1) return `<span class="text-white font-medium">${part}</span>`
    const href = `/repo/${owner}/${repo}?path=${arr.slice(0, i + 1).join('/')}&branch=${branch}`
    return `<a href="${href}" class="breadcrumb-link">${part}</a>`
  }).join('<span class="text-white/30"> / </span>')

  const content = `
    ${repoNav(owner, repo, 'code', repoData)}
    <div class="glass-card">
      <div class="file-header">
        <div class="breadcrumb">
          <a href="/repo/${owner}/${repo}?branch=${branch}" class="breadcrumb-link">root</a>
          <span class="text-white/30"> / </span>
          ${breadcrumb}
        </div>
        <div class="toolbar-right gap-2">
          <span class="text-white/50 text-sm">${formatBytes(fileData?.size || 0)}</span>
          ${fileData?.html_url ? `<a href="${fileData.html_url}" target="_blank" class="glass-btn-sm">View on GitHub</a>` : ''}
          ${fileData?.download_url ? `<a href="${fileData.download_url}" class="glass-btn-sm" download>Download</a>` : ''}
        </div>
      </div>
      <div class="file-content ${isImage ? 'flex justify-center p-8' : ''}">
        ${fileContent}
      </div>
    </div>
  `
  return glassLayout(`${path.split('/').pop()} - ${repo}`, user, content)
}

function commitsPage(user: any, owner: string, repo: string, commits: any[], repoData: any, page: number, branch: string) {
  const isError = !Array.isArray(commits)
  const items = isError ? [] : commits

  const rows = items.map((c: any) => `
    <div class="commit-card glass-card hover-lift">
      <div class="commit-header">
        <a href="/repo/${owner}/${repo}/commit/${c.sha}" class="commit-message">${escapeHtml(c.commit?.message?.split('\n')[0] || '')}</a>
        <a href="/repo/${owner}/${repo}/commit/${c.sha}" class="commit-sha">${c.sha.substring(0, 7)}</a>
      </div>
      <div class="commit-meta">
        <img src="${c.author?.avatar_url || ''}" class="w-5 h-5 rounded-full" />
        <span class="text-white/70">${c.commit?.author?.name || ''}</span>
        <span class="text-white/40">committed ${timeAgo(c.commit?.author?.date)}</span>
      </div>
    </div>
  `).join('')

  const content = `
    ${repoNav(owner, repo, 'commits', repoData)}
    <div class="section-header">
      <h3 class="section-title">Commits${branch ? ` on ${branch}` : ''}</h3>
      <div class="flex gap-2">
        ${page > 1 ? `<a href="/repo/${owner}/${repo}/commits?page=${page - 1}&branch=${branch}" class="glass-btn-sm">← Prev</a>` : ''}
        ${items.length === 20 ? `<a href="/repo/${owner}/${repo}/commits?page=${page + 1}&branch=${branch}" class="glass-btn-sm">Next →</a>` : ''}
      </div>
    </div>
    <div class="commits-list">
      ${isError ? '<div class="alert-error">Gagal memuat commits</div>' : items.length === 0 ? '<div class="empty-state">Tidak ada commits</div>' : rows}
    </div>
  `
  return glassLayout(`Commits - ${repo}`, user, content)
}

function commitDetailPage(user: any, owner: string, repo: string, commit: any, repoData: any) {
  const files = commit?.files || []
  const stats = commit?.stats || {}

  const fileDiffs = files.map((f: any) => `
    <div class="diff-file glass-card mb-3">
      <div class="diff-file-header">
        <span class="diff-filename">${f.filename}</span>
        <div class="diff-stats">
          <span class="text-green-400">+${f.additions}</span>
          <span class="text-red-400">-${f.deletions}</span>
          <span class="badge-${f.status === 'added' ? 'public' : f.status === 'removed' ? 'private' : 'neutral'}">${f.status}</span>
        </div>
      </div>
      ${f.patch ? `<pre class="diff-content"><code>${formatDiff(f.patch)}</code></pre>` : ''}
    </div>
  `).join('')

  const content = `
    ${repoNav(owner, repo, 'commits', repoData)}
    <div class="glass-card mb-4">
      <div class="p-4">
        <h2 class="text-xl font-semibold text-white mb-2">${escapeHtml(commit?.commit?.message?.split('\n')[0] || '')}</h2>
        ${commit?.commit?.message?.includes('\n') ? `<p class="text-white/60 text-sm mb-3 whitespace-pre-line">${escapeHtml(commit.commit.message.split('\n').slice(1).join('\n').trim())}</p>` : ''}
        <div class="flex items-center gap-4 text-sm text-white/60">
          <img src="${commit?.author?.avatar_url || ''}" class="w-6 h-6 rounded-full" />
          <span>${commit?.commit?.author?.name}</span>
          <span>${timeAgo(commit?.commit?.author?.date)}</span>
          <code class="text-blue-300 bg-white/10 px-2 py-0.5 rounded text-xs">${commit?.sha?.substring(0, 40)}</code>
        </div>
        <div class="flex gap-4 mt-3 text-sm">
          <span class="text-green-400">+${stats.additions} additions</span>
          <span class="text-red-400">-${stats.deletions} deletions</span>
          <span class="text-white/60">${files.length} files changed</span>
        </div>
      </div>
    </div>
    ${fileDiffs}
  `
  return glassLayout(`Commit ${commit?.sha?.substring(0, 7)} - ${repo}`, user, content)
}

function branchesPage(user: any, owner: string, repo: string, branches: any[], repoData: any) {
  const isError = !Array.isArray(branches)
  const items = isError ? [] : branches
  const defaultBranch = repoData?.default_branch || 'main'

  const rows = items.map((b: any) => `
    <div class="branch-card glass-card hover-lift">
      <div class="branch-info">
        <div class="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
          <span class="branch-name">${b.name}</span>
          ${b.name === defaultBranch ? '<span class="badge-public">default</span>' : ''}
          ${b.protected ? '<span class="badge-neutral">protected</span>' : ''}
        </div>
        <code class="text-xs text-white/40">${b.commit?.sha?.substring(0, 7)}</code>
      </div>
      <div class="branch-actions">
        <a href="/repo/${owner}/${repo}?branch=${b.name}" class="glass-btn-sm">Browse</a>
        <a href="/repo/${owner}/${repo}/commits?branch=${b.name}" class="glass-btn-sm">Commits</a>
        <a href="/repo/${owner}/${repo}/compare?base=${defaultBranch}&head=${b.name}" class="glass-btn-sm">Compare</a>
      </div>
    </div>
  `).join('')

  const content = `
    ${repoNav(owner, repo, 'branches', repoData)}
    <div class="section-header">
      <h3 class="section-title">Branches <span class="count-badge">${items.length}</span></h3>
    </div>
    ${isError ? '<div class="alert-error">Gagal memuat branches</div>' : items.length === 0 ? '<div class="empty-state">Tidak ada branches</div>' : `<div class="space-y-2">${rows}</div>`}
  `
  return glassLayout(`Branches - ${repo}`, user, content)
}

function tagsPage(user: any, owner: string, repo: string, tags: any[], repoData: any) {
  const isError = !Array.isArray(tags)
  const items = isError ? [] : tags

  const rows = items.map((t: any) => `
    <div class="tag-card glass-card hover-lift">
      <div class="flex items-center gap-3">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
        <span class="tag-name text-white font-medium">${t.name}</span>
        <code class="text-xs text-white/40">${t.commit?.sha?.substring(0, 7)}</code>
      </div>
      <div class="flex gap-2">
        <a href="/repo/${owner}/${repo}?branch=${t.name}" class="glass-btn-sm">Browse</a>
        <a href="/repo/${owner}/${repo}/commits?branch=${t.name}" class="glass-btn-sm">Commits</a>
      </div>
    </div>
  `).join('')

  const content = `
    ${repoNav(owner, repo, 'tags', repoData)}
    <div class="section-header">
      <h3 class="section-title">Tags <span class="count-badge">${items.length}</span></h3>
    </div>
    ${isError ? '<div class="alert-error">Gagal memuat tags</div>' : items.length === 0 ? '<div class="empty-state">Tidak ada tags</div>' : `<div class="space-y-2">${rows}</div>`}
  `
  return glassLayout(`Tags - ${repo}`, user, content)
}

function comparePage(user: any, owner: string, repo: string, branches: any[], repoData: any, base: string, head: string, compareData: any) {
  const branchOptions = (selected: string) => Array.isArray(branches) ? branches.map(b => 
    `<option value="${b.name}" ${b.name === selected ? 'selected' : ''}>${b.name}</option>`
  ).join('') : ''

  const commits = compareData?.commits || []
  const files = compareData?.files || []

  const content = `
    ${repoNav(owner, repo, 'compare', repoData)}
    <div class="glass-card mb-4">
      <div class="p-4">
        <h3 class="text-lg font-semibold text-white mb-4">Compare Branches</h3>
        <form method="GET" class="flex items-center gap-3 flex-wrap">
          <select name="base" class="glass-select flex-1">${branchOptions(base || repoData?.default_branch)}</select>
          <span class="text-white/60 font-bold">···</span>
          <select name="head" class="glass-select flex-1">${branchOptions(head)}</select>
          <button type="submit" class="btn-primary">Compare</button>
        </form>
      </div>
    </div>
    ${compareData ? `
      <div class="glass-card mb-4 p-4">
        <div class="flex gap-6 text-sm">
          <span class="text-blue-300">↑ ${compareData.ahead_by} ahead</span>
          <span class="text-orange-300">↓ ${compareData.behind_by} behind</span>
          <span class="text-white/60">${commits.length} commits</span>
          <span class="text-white/60">${files.length} files changed</span>
          <span class="text-green-400">+${compareData.files?.reduce((s: number, f: any) => s + f.additions, 0)} additions</span>
          <span class="text-red-400">-${compareData.files?.reduce((s: number, f: any) => s + f.deletions, 0)} deletions</span>
        </div>
      </div>
      <div class="section-title mb-3">Commits (${commits.length})</div>
      ${commits.map((c: any) => `
        <div class="commit-card glass-card mb-2">
          <div class="commit-header">
            <a href="/repo/${owner}/${repo}/commit/${c.sha}" class="commit-message">${escapeHtml(c.commit?.message?.split('\n')[0] || '')}</a>
            <code class="commit-sha">${c.sha.substring(0, 7)}</code>
          </div>
          <div class="commit-meta text-sm">
            <img src="${c.author?.avatar_url || ''}" class="w-4 h-4 rounded-full" />
            <span class="text-white/60">${c.commit?.author?.name}</span>
          </div>
        </div>
      `).join('')}
    ` : base && head ? '<div class="glass-card p-4 text-white/60">Memuat perbandingan...</div>' : ''}
  `
  return glassLayout(`Compare - ${repo}`, user, content)
}

function searchPage(user: any, owner: string, repo: string, repoData: any, q: string, results: any) {
  const items = results?.items || []

  const content = `
    ${repoNav(owner, repo, 'search', repoData)}
    <div class="glass-card mb-4">
      <div class="p-4">
        <form method="GET" class="flex gap-3">
          <input type="text" name="q" value="${escapeHtml(q)}" placeholder="Search in ${repo}..." class="form-input flex-1" />
          <button type="submit" class="btn-primary">Search</button>
        </form>
      </div>
    </div>
    ${q ? `
      <div class="section-header">
        <h3 class="section-title">Results for "${escapeHtml(q)}" <span class="count-badge">${results?.total_count || 0}</span></h3>
      </div>
      ${items.length === 0 ? '<div class="empty-state">Tidak ada hasil ditemukan</div>' : items.map((item: any) => `
        <div class="glass-card mb-2 hover-lift">
          <div class="p-4">
            <a href="/repo/${owner}/${repo}/blob?path=${item.path}" class="text-blue-300 hover:underline font-medium">${item.path}</a>
            <div class="text-white/50 text-sm mt-1">Score: ${item.score?.toFixed(2)}</div>
          </div>
        </div>
      `).join('')}
    ` : ''}
  `
  return glassLayout(`Search - ${repo}`, user, content)
}

function issuesPage(user: any, owner: string, repo: string, issues: any[], repoData: any, state: string, page: number) {
  const isError = !Array.isArray(issues)
  const items = isError ? [] : issues.filter((i: any) => !i.pull_request)

  const content = `
    ${repoNav(owner, repo, 'issues', repoData)}
    <div class="section-header">
      <h3 class="section-title">Issues</h3>
      <div class="flex gap-2">
        <a href="?state=open${page > 1 ? '' : ''}" class="glass-btn-sm ${state === 'open' ? 'active' : ''}">Open</a>
        <a href="?state=closed" class="glass-btn-sm ${state === 'closed' ? 'active' : ''}">Closed</a>
        <a href="?state=all" class="glass-btn-sm ${state === 'all' ? 'active' : ''}">All</a>
      </div>
    </div>
    ${isError ? '<div class="alert-error">Gagal memuat issues</div>' : items.length === 0 ? `<div class="empty-state">Tidak ada ${state} issues</div>` : `
      <div class="space-y-2">
        ${items.map((issue: any) => `
          <a href="/repo/${owner}/${repo}/issues/${issue.number}" class="issue-card glass-card hover-lift block">
            <div class="issue-header">
              <span class="issue-state ${issue.state === 'open' ? 'open' : 'closed'}">${issue.state === 'open' ? '🟢' : '🔴'}</span>
              <span class="issue-title">${escapeHtml(issue.title)}</span>
              <span class="issue-num">#${issue.number}</span>
            </div>
            <div class="issue-meta">
              <img src="${issue.user?.avatar_url}" class="w-4 h-4 rounded-full" />
              <span class="text-white/60 text-sm">${issue.user?.login}</span>
              <span class="text-white/40 text-sm">${timeAgo(issue.created_at)}</span>
              ${issue.labels?.map((l: any) => `<span class="label-badge" style="background:#${l.color}22;border-color:#${l.color}66;color:#${l.color}">${l.name}</span>`).join('')}
              ${issue.comments > 0 ? `<span class="text-white/40 text-sm">💬 ${issue.comments}</span>` : ''}
            </div>
          </a>
        `).join('')}
      </div>
      <div class="flex gap-2 mt-4">
        ${page > 1 ? `<a href="?state=${state}&page=${page - 1}" class="glass-btn-sm">← Prev</a>` : ''}
        ${items.length === 20 ? `<a href="?state=${state}&page=${page + 1}" class="glass-btn-sm">Next →</a>` : ''}
      </div>
    `}
  `
  return glassLayout(`Issues - ${repo}`, user, content)
}

function issueDetailPage(user: any, owner: string, repo: string, issue: any, comments: any[], repoData: any) {
  const content = `
    ${repoNav(owner, repo, 'issues', repoData)}
    <div class="glass-card mb-4">
      <div class="p-6">
        <div class="flex items-start gap-3 mb-4">
          <span class="issue-state ${issue?.state === 'open' ? 'open' : 'closed'} text-xl">${issue?.state === 'open' ? '🟢' : '🔴'}</span>
          <div>
            <h2 class="text-xl font-semibold text-white">${escapeHtml(issue?.title || '')}</h2>
            <div class="flex gap-2 mt-1 text-sm text-white/50 flex-wrap items-center">
              <img src="${issue?.user?.avatar_url}" class="w-5 h-5 rounded-full" />
              <span>${issue?.user?.login}</span>
              <span>opened ${timeAgo(issue?.created_at)}</span>
              <span>#${issue?.number}</span>
              ${issue?.labels?.map((l: any) => `<span class="label-badge" style="background:#${l.color}22;border-color:#${l.color}66;color:#${l.color}">${l.name}</span>`).join('')}
            </div>
          </div>
        </div>
        ${issue?.body ? `<div class="markdown-body glass-inner p-4 rounded-lg">${escapeHtml(issue.body)}</div>` : '<p class="text-white/30 italic">No description</p>'}
      </div>
    </div>
    ${Array.isArray(comments) && comments.length > 0 ? `
      <div class="section-title mb-3">Comments (${comments.length})</div>
      ${comments.map((c: any) => `
        <div class="glass-card mb-3">
          <div class="p-4">
            <div class="flex gap-2 items-center mb-2 text-sm text-white/60">
              <img src="${c.user?.avatar_url}" class="w-5 h-5 rounded-full" />
              <span>${c.user?.login}</span>
              <span>${timeAgo(c.created_at)}</span>
            </div>
            <div class="text-white/80 text-sm whitespace-pre-line">${escapeHtml(c.body || '')}</div>
          </div>
        </div>
      `).join('')}
    ` : ''}
  `
  return glassLayout(`#${issue?.number} - Issues - ${repo}`, user, content)
}

function pullsPage(user: any, owner: string, repo: string, prs: any[], repoData: any, state: string, page: number) {
  const isError = !Array.isArray(prs)
  const items = isError ? [] : prs

  const content = `
    ${repoNav(owner, repo, 'pulls', repoData)}
    <div class="section-header">
      <h3 class="section-title">Pull Requests</h3>
      <div class="flex gap-2">
        <a href="?state=open" class="glass-btn-sm ${state === 'open' ? 'active' : ''}">Open</a>
        <a href="?state=closed" class="glass-btn-sm ${state === 'closed' ? 'active' : ''}">Closed</a>
      </div>
    </div>
    ${isError ? '<div class="alert-error">Gagal memuat pull requests</div>' : items.length === 0 ? `<div class="empty-state">Tidak ada ${state} pull requests</div>` : `
      <div class="space-y-2">
        ${items.map((pr: any) => `
          <a href="/repo/${owner}/${repo}/pulls/${pr.number}" class="issue-card glass-card hover-lift block">
            <div class="issue-header">
              <span class="text-purple-400">${pr.draft ? '⬜' : pr.state === 'open' ? '🟣' : '🟤'}</span>
              <span class="issue-title">${escapeHtml(pr.title)}</span>
              <span class="issue-num">#${pr.number}</span>
            </div>
            <div class="issue-meta">
              <img src="${pr.user?.avatar_url}" class="w-4 h-4 rounded-full" />
              <span class="text-white/60 text-sm">${pr.user?.login}</span>
              <span class="text-white/40 text-sm">${timeAgo(pr.created_at)}</span>
              <span class="text-white/40 text-xs">${pr.head?.label} → ${pr.base?.label}</span>
            </div>
          </a>
        `).join('')}
      </div>
      <div class="flex gap-2 mt-4">
        ${page > 1 ? `<a href="?state=${state}&page=${page - 1}" class="glass-btn-sm">← Prev</a>` : ''}
        ${items.length === 20 ? `<a href="?state=${state}&page=${page + 1}" class="glass-btn-sm">Next →</a>` : ''}
      </div>
    `}
  `
  return glassLayout(`Pull Requests - ${repo}`, user, content)
}

function prDetailPage(user: any, owner: string, repo: string, pr: any, comments: any[], repoData: any, files: any[]) {
  const filesHtml = Array.isArray(files) ? files.map(f => `
    <div class="diff-file glass-card mb-2">
      <div class="diff-file-header">
        <span class="diff-filename">${f.filename}</span>
        <div class="diff-stats">
          <span class="text-green-400">+${f.additions}</span>
          <span class="text-red-400">-${f.deletions}</span>
        </div>
      </div>
      ${f.patch ? `<pre class="diff-content"><code>${formatDiff(f.patch)}</code></pre>` : ''}
    </div>
  `).join('') : ''

  const content = `
    ${repoNav(owner, repo, 'pulls', repoData)}
    <div class="glass-card mb-4">
      <div class="p-6">
        <div class="flex items-start gap-3 mb-4">
          <span class="text-2xl">${pr?.state === 'open' ? '🟣' : pr?.merged ? '🟤' : '🔴'}</span>
          <div>
            <h2 class="text-xl font-semibold text-white">${escapeHtml(pr?.title || '')}</h2>
            <div class="flex gap-2 mt-1 text-sm text-white/50 flex-wrap items-center">
              <img src="${pr?.user?.avatar_url}" class="w-5 h-5 rounded-full" />
              <span>${pr?.user?.login}</span>
              <span>opened ${timeAgo(pr?.created_at)}</span>
              <span>#${pr?.number}</span>
              <span class="text-white/30">${pr?.head?.label} → ${pr?.base?.label}</span>
            </div>
          </div>
        </div>
        ${pr?.body ? `<div class="glass-inner p-4 rounded-lg text-white/80 text-sm whitespace-pre-line">${escapeHtml(pr.body)}</div>` : ''}
        <div class="flex gap-4 mt-3 text-sm">
          <span class="text-green-400">+${pr?.additions} additions</span>
          <span class="text-red-400">-${pr?.deletions} deletions</span>
          <span class="text-white/60">${pr?.changed_files} files</span>
          <span class="text-white/60">${pr?.commits} commits</span>
        </div>
      </div>
    </div>
    ${filesHtml}
    ${Array.isArray(comments) && comments.length > 0 ? `
      <div class="section-title mb-3">Comments (${comments.length})</div>
      ${comments.map((c: any) => `
        <div class="glass-card mb-2">
          <div class="p-4">
            <div class="flex gap-2 items-center mb-2 text-sm text-white/60">
              <img src="${c.user?.avatar_url}" class="w-5 h-5 rounded-full" />
              <span>${c.user?.login}</span>
              <span>${timeAgo(c.created_at)}</span>
            </div>
            <div class="text-white/80 text-sm">${escapeHtml(c.body || '')}</div>
          </div>
        </div>
      `).join('')}
    ` : ''}
  `
  return glassLayout(`PR #${pr?.number} - ${repo}`, user, content)
}

function actionsPage(user: any, owner: string, repo: string, runs: any, workflows: any, repoData: any, page: number) {
  const runItems = runs?.workflow_runs || []
  const workflowItems = workflows?.workflows || []

  const statusIcon = (s: string, c: string) => {
    if (s === 'completed') {
      if (c === 'success') return '✅'
      if (c === 'failure') return '❌'
      if (c === 'cancelled') return '⛔'
      return '⚪'
    }
    if (s === 'in_progress') return '🔄'
    if (s === 'queued') return '⏳'
    return '⚪'
  }

  const content = `
    ${repoNav(owner, repo, 'actions', repoData)}
    ${workflowItems.length > 0 ? `
      <div class="glass-card mb-4">
        <div class="p-4">
          <h3 class="text-sm font-semibold text-white/60 mb-3 uppercase tracking-wider">Workflows</h3>
          <div class="flex flex-wrap gap-2">
            ${workflowItems.map((w: any) => `
              <span class="glass-btn-sm ${w.state === 'active' ? 'text-green-300' : 'text-white/40'}">${w.name}</span>
            `).join('')}
          </div>
        </div>
      </div>
    ` : ''}
    <div class="section-header">
      <h3 class="section-title">Workflow Runs</h3>
      <div class="flex gap-2">
        ${page > 1 ? `<a href="?page=${page - 1}" class="glass-btn-sm">← Prev</a>` : ''}
        ${runItems.length === 20 ? `<a href="?page=${page + 1}" class="glass-btn-sm">Next →</a>` : ''}
      </div>
    </div>
    ${runItems.length === 0 ? '<div class="empty-state">Tidak ada workflow runs</div>' : `
      <div class="space-y-2">
        ${runItems.map((run: any) => `
          <div class="glass-card hover-lift">
            <div class="p-4">
              <div class="flex items-center gap-3">
                <span class="text-xl">${statusIcon(run.status, run.conclusion)}</span>
                <div class="flex-1">
                  <div class="text-white font-medium">${escapeHtml(run.display_title || run.name)}</div>
                  <div class="flex gap-3 mt-1 text-sm text-white/50">
                    <span>${run.name}</span>
                    <span>${run.head_branch}</span>
                    <span>${timeAgo(run.created_at)}</span>
                    <code class="text-xs">${run.head_sha?.substring(0, 7)}</code>
                  </div>
                </div>
                <div class="text-right">
                  <span class="badge-${run.conclusion === 'success' ? 'public' : run.conclusion === 'failure' ? 'private' : 'neutral'}">${run.status} ${run.conclusion ? '· ' + run.conclusion : ''}</span>
                </div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `
  return glassLayout(`Actions - ${repo}`, user, content)
}

function releasesPage(user: any, owner: string, repo: string, releases: any[], repoData: any) {
  const isError = !Array.isArray(releases)
  const items = isError ? [] : releases

  const content = `
    ${repoNav(owner, repo, 'releases', repoData)}
    <div class="section-header">
      <h3 class="section-title">Releases <span class="count-badge">${items.length}</span></h3>
    </div>
    ${isError ? '<div class="alert-error">Gagal memuat releases</div>' : items.length === 0 ? '<div class="empty-state">Tidak ada releases</div>' : `
      <div class="space-y-4">
        ${items.map((r: any) => `
          <div class="glass-card hover-lift">
            <div class="p-5">
              <div class="flex items-start justify-between mb-3">
                <div>
                  <h3 class="text-lg font-semibold text-white">${escapeHtml(r.name || r.tag_name)}</h3>
                  <div class="flex gap-2 mt-1 items-center text-sm text-white/50">
                    <span class="tag-name text-purple-300">${r.tag_name}</span>
                    <span>${timeAgo(r.published_at)}</span>
                    ${r.prerelease ? '<span class="badge-neutral">Pre-release</span>' : ''}
                    ${r.draft ? '<span class="badge-neutral">Draft</span>' : ''}
                  </div>
                </div>
                <a href="${r.html_url}" target="_blank" class="glass-btn-sm">View on GitHub</a>
              </div>
              ${r.body ? `<div class="text-white/70 text-sm whitespace-pre-line mb-3">${escapeHtml(r.body.substring(0, 300))}${r.body.length > 300 ? '...' : ''}</div>` : ''}
              ${r.assets?.length > 0 ? `
                <div class="border-t border-white/10 pt-3">
                  <div class="text-xs text-white/40 mb-2">Assets (${r.assets.length})</div>
                  <div class="flex flex-wrap gap-2">
                    ${r.assets.map((a: any) => `
                      <a href="${a.browser_download_url}" class="glass-btn-sm text-xs">
                        📦 ${a.name} (${formatBytes(a.size)})
                      </a>
                    `).join('')}
                  </div>
                </div>
              ` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `
  return glassLayout(`Releases - ${repo}`, user, content)
}

function environmentsPage(user: any, owner: string, repo: string, envsData: any, repoData: any) {
  const items = envsData?.environments || []

  const content = `
    ${repoNav(owner, repo, 'environments', repoData)}
    <div class="section-header">
      <h3 class="section-title">Environments <span class="count-badge">${items.length}</span></h3>
    </div>
    ${items.length === 0 ? '<div class="empty-state">Tidak ada environments</div>' : `
      <div class="grid grid-2 gap-4">
        ${items.map((env: any) => `
          <div class="glass-card hover-lift">
            <div class="p-5">
              <div class="flex items-center gap-3 mb-3">
                <span class="text-2xl">🌍</span>
                <div>
                  <h3 class="text-white font-semibold">${env.name}</h3>
                  <div class="text-white/40 text-sm">ID: ${env.id}</div>
                </div>
              </div>
              ${env.protection_rules?.length > 0 ? `
                <div class="text-sm">
                  <div class="text-white/50 mb-1">Protection Rules:</div>
                  ${env.protection_rules.map((r: any) => `
                    <span class="badge-neutral mr-1">${r.type}</span>
                  `).join('')}
                </div>
              ` : ''}
              <div class="mt-3 text-xs text-white/40">Updated: ${timeAgo(env.updated_at)}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `
  return glassLayout(`Environments - ${repo}`, user, content)
}

function secretsPage(user: any, owner: string, repo: string, secretsData: any, repoData: any) {
  const items = secretsData?.secrets || []

  const content = `
    ${repoNav(owner, repo, 'secrets', repoData)}
    <div class="section-header">
      <h3 class="section-title">Actions Secrets <span class="count-badge">${items.length}</span></h3>
      <span class="text-white/40 text-sm">🔒 Secret values are encrypted and cannot be read</span>
    </div>
    ${items.length === 0 ? '<div class="empty-state">Tidak ada secrets</div>' : `
      <div class="space-y-2">
        ${items.map((s: any) => `
          <div class="glass-card hover-lift">
            <div class="p-4 flex items-center justify-between">
              <div class="flex items-center gap-3">
                <span class="text-yellow-400">🔑</span>
                <div>
                  <div class="text-white font-mono font-medium">${s.name}</div>
                  <div class="text-white/40 text-sm">Updated: ${timeAgo(s.updated_at)}</div>
                </div>
              </div>
              <div class="flex gap-2">
                <span class="badge-neutral">Encrypted</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `
  return glassLayout(`Secrets - ${repo}`, user, content)
}

function variablesPage(user: any, owner: string, repo: string, varsData: any, repoData: any) {
  const items = varsData?.variables || []

  const content = `
    ${repoNav(owner, repo, 'variables', repoData)}
    <div class="section-header">
      <h3 class="section-title">Actions Variables <span class="count-badge">${items.length}</span></h3>
    </div>
    ${items.length === 0 ? '<div class="empty-state">Tidak ada variables</div>' : `
      <div class="space-y-2">
        ${items.map((v: any) => `
          <div class="glass-card hover-lift">
            <div class="p-4 flex items-center justify-between">
              <div class="flex items-center gap-3">
                <span class="text-blue-400">#</span>
                <div>
                  <div class="text-white font-mono font-medium">${v.name}</div>
                  <div class="text-white/60 text-sm font-mono mt-0.5">${escapeHtml(v.value || '')}</div>
                  <div class="text-white/40 text-xs mt-1">Updated: ${timeAgo(v.updated_at)}</div>
                </div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `
  return glassLayout(`Variables - ${repo}`, user, content)
}

function webhooksPage(user: any, owner: string, repo: string, webhooks: any[], repoData: any) {
  const isError = !Array.isArray(webhooks)
  const items = isError ? [] : webhooks

  const content = `
    ${repoNav(owner, repo, 'webhooks', repoData)}
    <div class="section-header">
      <h3 class="section-title">Webhooks <span class="count-badge">${items.length}</span></h3>
    </div>
    ${isError ? '<div class="alert-error">Gagal memuat webhooks (Perlu akses admin)</div>' : items.length === 0 ? '<div class="empty-state">Tidak ada webhooks</div>' : `
      <div class="space-y-3">
        ${items.map((w: any) => `
          <div class="glass-card hover-lift">
            <div class="p-4">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <span class="${w.active ? 'text-green-400' : 'text-red-400'}">${w.active ? '●' : '○'}</span>
                  <span class="text-white font-mono">${w.config?.url || 'No URL'}</span>
                </div>
                <span class="badge-${w.active ? 'public' : 'private'}">${w.active ? 'Active' : 'Inactive'}</span>
              </div>
              <div class="flex flex-wrap gap-1 mt-2">
                ${w.events?.map((e: string) => `<span class="badge-neutral text-xs">${e}</span>`).join('') || ''}
              </div>
              <div class="text-white/40 text-xs mt-2">Content-Type: ${w.config?.content_type || 'json'}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `
  return glassLayout(`Webhooks - ${repo}`, user, content)
}

function collaboratorsPage(user: any, owner: string, repo: string, collabs: any[], repoData: any) {
  const isError = !Array.isArray(collabs)
  const items = isError ? [] : collabs

  const content = `
    ${repoNav(owner, repo, 'collaborators', repoData)}
    <div class="section-header">
      <h3 class="section-title">Collaborators <span class="count-badge">${items.length}</span></h3>
    </div>
    ${isError ? '<div class="alert-error">Gagal memuat collaborators (Perlu akses admin)</div>' : items.length === 0 ? '<div class="empty-state">Tidak ada collaborators</div>' : `
      <div class="grid grid-2 gap-3">
        ${items.map((c: any) => `
          <div class="glass-card hover-lift">
            <div class="p-4 flex items-center gap-3">
              <img src="${c.avatar_url}" class="w-12 h-12 rounded-full border-2 border-white/20" />
              <div class="flex-1">
                <div class="text-white font-medium">${c.login}</div>
                <div class="text-white/40 text-sm">${c.type}</div>
                <div class="flex gap-1 mt-1 flex-wrap">
                  ${c.permissions ? Object.entries(c.permissions).filter(([,v]) => v).map(([k]) => `<span class="badge-neutral text-xs">${k}</span>`).join('') : ''}
                </div>
              </div>
              <a href="https://github.com/${c.login}" target="_blank" class="glass-btn-sm">Profile</a>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `
  return glassLayout(`Collaborators - ${repo}`, user, content)
}

function deployKeysPage(user: any, owner: string, repo: string, keys: any[], repoData: any) {
  const isError = !Array.isArray(keys)
  const items = isError ? [] : keys

  const content = `
    ${repoNav(owner, repo, 'keys', repoData)}
    <div class="section-header">
      <h3 class="section-title">Deploy Keys <span class="count-badge">${items.length}</span></h3>
    </div>
    ${isError ? '<div class="alert-error">Gagal memuat deploy keys (Perlu akses admin)</div>' : items.length === 0 ? '<div class="empty-state">Tidak ada deploy keys</div>' : `
      <div class="space-y-3">
        ${items.map((k: any) => `
          <div class="glass-card hover-lift">
            <div class="p-4">
              <div class="flex items-start justify-between mb-2">
                <div>
                  <div class="text-white font-medium">${k.title}</div>
                  <div class="text-white/40 text-sm mt-0.5">Added: ${timeAgo(k.created_at)}</div>
                </div>
                <span class="badge-${k.read_only ? 'neutral' : 'public'}">${k.read_only ? 'Read-only' : 'Read/Write'}</span>
              </div>
              <div class="font-mono text-xs text-white/50 break-all bg-white/5 p-2 rounded">${k.key}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `
  return glassLayout(`Deploy Keys - ${repo}`, user, content)
}

// ==================== UTILITIES ====================
function escapeHtml(str: string): string {
  return str?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') || ''
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return ''
  const now = new Date()
  const date = new Date(dateStr)
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`
  return `${Math.floor(diff / 31536000)}y ago`
}

function formatDiff(patch: string): string {
  return patch.split('\n').map(line => {
    if (line.startsWith('+')) return `<span class="diff-add">${escapeHtml(line)}</span>`
    if (line.startsWith('-')) return `<span class="diff-del">${escapeHtml(line)}</span>`
    if (line.startsWith('@@')) return `<span class="diff-hunk">${escapeHtml(line)}</span>`
    return escapeHtml(line)
  }).join('\n')
}

export default app
