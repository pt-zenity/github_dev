import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import nacl from 'tweetnacl'
import { decodeBase64, encodeBase64 } from 'tweetnacl-util'

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

  // Fetch ALL repos by paginating (GitHub caps per_page at 100)
  const [userResult, ...pageResults] = await Promise.all([
    githubApi(token, '/user'),
    githubApi(token, '/user/repos?sort=updated&per_page=100&page=1&type=all'),
    githubApi(token, '/user/repos?sort=updated&per_page=100&page=2&type=all'),
    githubApi(token, '/user/repos?sort=updated&per_page=100&page=3&type=all'),
  ])

  const userData = userResult.data
  const allRepos: any[] = []
  for (const r of pageResults) {
    if (Array.isArray(r.data)) allRepos.push(...r.data)
  }

  return c.html(dashboardPage(user, allRepos, userData))
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

// Actions - main page (with workflow filter)
app.get('/repo/:owner/:repo/actions', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo } = c.req.param()
  const page = parseInt(c.req.query('page') || '1')
  const wfId = c.req.query('workflow') || ''
  const statusFilter = c.req.query('status') || ''
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}

  let runsUrl = `/repos/${owner}/${repo}/actions/runs?per_page=20&page=${page}`
  if (wfId) runsUrl += `&workflow_id=${encodeURIComponent(wfId)}`
  if (statusFilter) runsUrl += `&status=${encodeURIComponent(statusFilter)}`

  const [runsRes, workflowsRes, repoRes] = await Promise.all([
    githubApi(token, runsUrl),
    githubApi(token, `/repos/${owner}/${repo}/actions/workflows?per_page=50`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])

  return c.html(actionsPage(user, owner, repo, runsRes.data, workflowsRes.data, repoRes.data, page, wfId, statusFilter))
})

// Run detail page (jobs + steps)
app.get('/repo/:owner/:repo/actions/runs/:runId', async (c) => {
  const token = getToken(c)
  if (!token) return c.redirect('/login')
  const { owner, repo, runId } = c.req.param()
  const userCookie = getCookie(c, 'gh_user')
  const user = userCookie ? JSON.parse(userCookie) : {}

  const [runRes, jobsRes, repoRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/actions/runs/${runId}`),
    githubApi(token, `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=30`),
    githubApi(token, `/repos/${owner}/${repo}`)
  ])

  return c.html(runDetailPage(user, owner, repo, runRes.data, jobsRes.data, repoRes.data))
})

// API: Get run status (for polling)
app.get('/repo/:owner/:repo/actions/runs/:runId/status', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, runId } = c.req.param()
  const [runRes, jobsRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/actions/runs/${runId}`),
    githubApi(token, `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=30`)
  ])
  return c.json({ run: runRes.data, jobs: jobsRes.data })
})

// API: Get job log
// Strategy: let GitHub redirect us, then immediately pipe the blob response
// back as a stream — single RTT, no "blob expired" race condition.
app.get('/repo/:owner/:repo/actions/jobs/:jobId/logs', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, jobId } = c.req.param()

  try {
    // Follow the redirect in one fetch — Cloudflare Workers will follow the
    // 302 → Azure blob URL atomically, so the pre-signed URL never expires
    // between the two hops.
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GitManager/1.0'
      },
      redirect: 'follow'   // let fetch handle the 302 → Azure blob in one shot
    })

    if (resp.ok) {
      // Stream the blob body straight back to the browser
      return new Response(resp.body, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    }

    // 403 — token missing scope
    if (resp.status === 403) {
      return c.text('403 Forbidden — token tidak punya izin baca logs. Butuh scope: repo atau actions:read', 403)
    }
    // 404 — job log not available yet or already deleted
    if (resp.status === 404) {
      return c.text('404 — log belum tersedia (job mungkin masih berjalan atau log sudah dihapus)', 404)
    }
    // 410 — GitHub deleted the log
    if (resp.status === 410) {
      return c.text('410 Gone — log sudah expired / dihapus GitHub', 410)
    }

    const body = await resp.text().catch(() => '')
    return c.text(`GitHub API returned ${resp.status}: ${body.substring(0, 300)}`, 400)

  } catch (err: any) {
    return c.text(`Server error: ${err?.message || err}`, 500)
  }
})

// Run-level logs (full zip → text, all jobs combined)
app.get('/repo/:owner/:repo/actions/runs/:runId/logs', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, runId } = c.req.param()

  try {
    const resp1 = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GitManager/1.0'
      },
      redirect: 'manual'
    })

    if (resp1.status === 302 || resp1.status === 301) {
      const logUrl = resp1.headers.get('location')
      if (!logUrl) return c.text('No redirect location', 400)
      // The run log is a zip file — return the URL so client can show it
      return c.json({ redirect_url: logUrl })
    }

    return c.text(`GitHub returned ${resp1.status}`, 400)
  } catch (err: any) {
    return c.text(`Server error: ${err?.message || err}`, 500)
  }
})

// API: Trigger workflow dispatch
app.post('/repo/:owner/:repo/actions/workflows/:workflowId/dispatch', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, workflowId } = c.req.param()
  const body = await c.req.json() as any
  const ref = body.ref || 'main'
  const inputs = body.inputs || {}

  const res = await githubApi(token, `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, inputs })
  })
  if (res.status === 204) return c.json({ success: true })

  // Translate GitHub's 422 into a clearer message
  const ghMsg: string = res.data?.message || ''
  if (res.status === 422 && ghMsg.toLowerCase().includes('workflow_dispatch')) {
    return c.json({
      error: 'Workflow ini tidak mendukung manual trigger.',
      hint: 'Tambahkan "workflow_dispatch:" ke bagian "on:" di file YAML workflow ini.',
      detail: res.data
    }, 422)
  }
  return c.json({ error: 'Dispatch failed', detail: res.data, status: res.status }, 400)
})

// API: Check if a workflow supports workflow_dispatch (parse its YAML triggers)
app.get('/repo/:owner/:repo/actions/workflows/:workflowId/triggers', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, workflowId } = c.req.param()

  // Get the workflow metadata to find its file path
  const wfRes = await githubApi(token, `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}`)
  if (!wfRes.data?.path) return c.json({ dispatchable: false, triggers: [] })

  // Fetch the raw YAML file
  const filePath = wfRes.data.path  // e.g. ".github/workflows/ci.yml"
  const ref = c.req.query('ref') || 'HEAD'
  const contentRes = await githubApi(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${ref}`)

  if (!contentRes.data?.content) return c.json({ dispatchable: false, triggers: [] })

  // Decode base64 content and extract triggers from the "on:" block
  const yamlText = atob(contentRes.data.content.replace(/\n/g, ''))

  // Quick regex-based trigger detection (no full YAML parser needed)
  // Matches: "on: [push, workflow_dispatch]"  or  "on:\n  workflow_dispatch:"
  const triggers: string[] = []
  // Array form: on: [push, pull_request, workflow_dispatch]
  const arrayMatch = yamlText.match(/^on:\s*\[([^\]]+)\]/m)
  if (arrayMatch) {
    arrayMatch[1].split(',').map(t => t.trim()).forEach(t => triggers.push(t))
  }
  // Block form: "on:\n  workflow_dispatch:\n  push:"
  const blockMatches = yamlText.matchAll(/^  ([a-z_]+)\s*:/gm)
  for (const m of blockMatches) triggers.push(m[1])
  // Inline single-value form: "on: push"
  const singleMatch = yamlText.match(/^on:\s+([a-z_]+)\s*$/m)
  if (singleMatch) triggers.push(singleMatch[1])

  const dispatchable = triggers.includes('workflow_dispatch')
  return c.json({ dispatchable, triggers: [...new Set(triggers)], path: filePath })
})

// API: Cancel a run
app.post('/repo/:owner/:repo/actions/runs/:runId/cancel', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, runId } = c.req.param()
  const res = await githubApi(token, `/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, { method: 'POST' })
  if (res.status === 202) return c.json({ success: true })
  return c.json({ error: 'Cancel failed', detail: res.data }, 400)
})

// API: Re-run a workflow
app.post('/repo/:owner/:repo/actions/runs/:runId/rerun', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, runId } = c.req.param()
  const res = await githubApi(token, `/repos/${owner}/${repo}/actions/runs/${runId}/rerun`, { method: 'POST' })
  if (res.status === 201) return c.json({ success: true })
  return c.json({ error: 'Re-run failed', detail: res.data }, 400)
})

// API: Re-run failed jobs only
app.post('/repo/:owner/:repo/actions/runs/:runId/rerun-failed', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, runId } = c.req.param()
  const res = await githubApi(token, `/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST' })
  if (res.status === 201) return c.json({ success: true })
  return c.json({ error: 'Re-run failed jobs error', detail: res.data }, 400)
})

// API: Delete a run
app.delete('/repo/:owner/:repo/actions/runs/:runId', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, runId } = c.req.param()
  const res = await githubApi(token, `/repos/${owner}/${repo}/actions/runs/${runId}`, { method: 'DELETE' })
  if (res.status === 204) return c.json({ success: true })
  return c.json({ error: 'Delete failed', detail: res.data }, 400)
})

// API: Get latest runs (for live polling on main page)
app.get('/repo/:owner/:repo/actions/poll', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo } = c.req.param()
  const wfId = c.req.query('workflow') || ''
  let url = `/repos/${owner}/${repo}/actions/runs?per_page=20&page=1`
  if (wfId) url += `&workflow_id=${encodeURIComponent(wfId)}`
  const res = await githubApi(token, url)
  return c.json(res.data)
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

// Create / Update secret (PUT)
app.post('/repo/:owner/:repo/settings/secrets/upsert', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo } = c.req.param()

  let name = '', value = ''
  const ct = c.req.header('content-type') || ''
  if (ct.includes('application/json')) {
    const body = await c.req.json() as any
    name = body.name; value = body.value
  } else {
    const form = await c.req.formData()
    name = form.get('name') as string
    value = form.get('value') as string
  }

  if (!name || !value) return c.json({ error: 'name and value required' }, 400)

  // 1. Get repo public key for encryption
  const pubKeyRes = await githubApi(token, `/repos/${owner}/${repo}/actions/secrets/public-key`)
  if (pubKeyRes.status !== 200) return c.json({ error: 'Cannot get public key', detail: pubKeyRes.data }, 400)
  const { key: pubKeyB64, key_id } = pubKeyRes.data as any

  // 2. Encrypt using libsodium sealed box (async, uses Web Crypto for nonce)
  const recipientKey = decodeBase64(pubKeyB64)
  const secretBytes = new TextEncoder().encode(value)
  const encryptedBytes = await sealedBoxAsync(secretBytes, recipientKey)
  const encryptedB64 = encodeBase64(encryptedBytes)

  // 3. PUT to GitHub
  const putRes = await githubApi(token, `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value: encryptedB64, key_id })
  })

  if (putRes.status === 201 || putRes.status === 204) {
    return c.json({ success: true, status: putRes.status })
  }
  return c.json({ error: 'GitHub API error', detail: putRes.data, status: putRes.status }, 400)
})

// Delete secret
app.delete('/repo/:owner/:repo/settings/secrets/:name', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, name } = c.req.param()

  const delRes = await githubApi(token, `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`, {
    method: 'DELETE'
  })

  if (delRes.status === 204) return c.json({ success: true })
  return c.json({ error: 'Delete failed', detail: delRes.data }, 400)
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

  const [collabsRes, repoRes, invitesRes] = await Promise.all([
    githubApi(token, `/repos/${owner}/${repo}/collaborators?per_page=100&affiliation=all`),
    githubApi(token, `/repos/${owner}/${repo}`),
    githubApi(token, `/repos/${owner}/${repo}/invitations?per_page=50`)
  ])

  return c.html(collaboratorsPage(user, owner, repo, collabsRes.data, repoRes.data, invitesRes.data))
})

// API: Invite / add collaborator (PUT — idempotent)
app.put('/repo/:owner/:repo/settings/collaborators/:username', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, username } = c.req.param()
  const body = await c.req.json().catch(() => ({})) as any
  const permission = body.permission || 'push' // pull | triage | push | maintain | admin

  const { status, data } = await githubApi(token, `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permission })
  })

  if (status === 201) return c.json({ success: true, status: 'invited', data })
  if (status === 204) return c.json({ success: true, status: 'already_collab' })
  return c.json({ error: data?.message || 'Failed', detail: data }, status as any)
})

// API: Remove collaborator
app.delete('/repo/:owner/:repo/settings/collaborators/:username', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, username } = c.req.param()

  const { status, data } = await githubApi(token, `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}`, {
    method: 'DELETE'
  })

  if (status === 204) return c.json({ success: true })
  return c.json({ error: data?.message || 'Failed' }, status as any)
})

// API: Cancel pending invitation
app.delete('/repo/:owner/:repo/settings/invitations/:invitationId', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, invitationId } = c.req.param()

  const { status, data } = await githubApi(token, `/repos/${owner}/${repo}/invitations/${invitationId}`, {
    method: 'DELETE'
  })

  if (status === 204) return c.json({ success: true })
  return c.json({ error: data?.message || 'Failed' }, status as any)
})

// API: Update invitation permission
app.patch('/repo/:owner/:repo/settings/invitations/:invitationId', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { owner, repo, invitationId } = c.req.param()
  const body = await c.req.json().catch(() => ({})) as any

  const { status, data } = await githubApi(token, `/repos/${owner}/${repo}/invitations/${invitationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permissions: body.permission || 'push' })
  })

  if (status === 200) return c.json({ success: true, data })
  return c.json({ error: data?.message || 'Failed' }, status as any)
})

// API: Search GitHub user (for autocomplete)
app.get('/api/users/search', async (c) => {
  const token = getToken(c)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const q = c.req.query('q') || ''
  if (!q || q.length < 2) return c.json({ items: [] })

  const { status, data } = await githubApi(token, `/search/users?q=${encodeURIComponent(q)}&per_page=8`)
  if (status === 200) return c.json({ items: data.items || [] })
  return c.json({ items: [] })
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
  const totalRepos  = repos.length
  const publicRepos = repos.filter(r => !r.private && !r.fork && !r.archived).length
  const privateRepos= repos.filter(r =>  r.private).length
  const forkRepos   = repos.filter(r =>  r.fork).length
  const archivedRepos=repos.filter(r =>  r.archived).length
  const totalStars  = repos.reduce((s, r) => s + (r.stargazers_count || 0), 0)

  // Language colour map (subset — enough for the most common languages)
  const langColors: Record<string, string> = {
    JavaScript:'#f1e05a', TypeScript:'#3178c6', Python:'#3572A5', Go:'#00ADD8',
    Rust:'#dea584', Java:'#b07219', 'C++':'#f34b7d', C:'#555555', 'C#':'#178600',
    Ruby:'#701516', PHP:'#4F5D95', Swift:'#ffac45', Kotlin:'#A97BFF',
    Shell:'#89e051', HTML:'#e34c26', CSS:'#563d7c', Dart:'#00B4AB',
    Scala:'#c22d40', Vue:'#41b883', YAML:'#cb171e', Dockerfile:'#384d54'
  }

  const repoCards = repos.map(repo => {
    // Determine visibility category for data attribute
    const vis = repo.private ? 'private' : (repo.fork ? 'fork' : (repo.archived ? 'archived' : 'public'))

    // Badge HTML
    const badgeHtml = repo.archived
      ? '<span class="badge-archived">📦 Archived</span>'
      : repo.fork
        ? '<span class="badge-fork">🍴 Fork</span>'
        : repo.private
          ? '<span class="badge-private">🔒 Private</span>'
          : '<span class="badge-public">🌐 Public</span>'

    const langColor = repo.language ? (langColors[repo.language] || '#8b8b8b') : ''
    const langHtml  = repo.language
      ? `<span class="repo-lang"><span class="lang-dot" style="background:${langColor}"></span>${escapeHtml(repo.language)}</span>`
      : ''

    // Extra badges row (topics, template)
    const topicBadges = (repo.topics || []).slice(0, 3).map((t: string) =>
      `<span class="badge-topic">${escapeHtml(t)}</span>`
    ).join('')

    return `
    <a href="/repo/${repo.owner.login}/${repo.name}" class="repo-card glass-card hover-lift"
       data-vis="${vis}"
       data-name="${escapeHtml(repo.name.toLowerCase())}"
       data-desc="${escapeHtml((repo.description || '').toLowerCase())}">
      <div class="repo-card-header">
        <div class="repo-card-name">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;opacity:.7"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>${escapeHtml(repo.name)}</span>
        </div>
        <div class="repo-badges">${badgeHtml}</div>
      </div>
      <p class="repo-desc">${repo.description ? escapeHtml(repo.description) : '<span style="opacity:.3;font-style:italic">No description</span>'}</p>
      ${topicBadges ? `<div class="repo-topics">${topicBadges}</div>` : ''}
      <div class="repo-meta">
        ${langHtml}
        <span class="repo-stat">⭐ ${repo.stargazers_count}</span>
        <span class="repo-stat">🍴 ${repo.forks_count}</span>
        <span class="repo-stat" title="${repo.updated_at}">🔄 ${timeAgo(repo.updated_at)}</span>
      </div>
    </a>`
  }).join('')

  const content = `
    <div class="dashboard-header">
      <div class="user-profile glass-card">
        <img src="${userData?.avatar_url || ''}" class="user-avatar" />
        <div class="user-info">
          <h2 class="user-name">${escapeHtml(userData?.name || userData?.login || 'User')}</h2>
          <p class="user-login">@${escapeHtml(userData?.login || '')}</p>
          ${userData?.bio ? `<p class="user-bio">${escapeHtml(userData.bio)}</p>` : ''}
          <div class="user-stats">
            <span>👥 ${userData?.followers ?? 0} followers</span>
            <span>👤 ${userData?.following ?? 0} following</span>
            <span>📦 ${userData?.public_repos ?? 0} public repos</span>
          </div>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-card glass-card"><div class="stat-num">${totalRepos}</div><div class="stat-label">Total Repos</div></div>
        <div class="stat-card glass-card"><div class="stat-num">${publicRepos}</div><div class="stat-label">Public</div></div>
        <div class="stat-card glass-card"><div class="stat-num">${privateRepos}</div><div class="stat-label">Private</div></div>
        <div class="stat-card glass-card"><div class="stat-num">${forkRepos}</div><div class="stat-label">Forks</div></div>
        <div class="stat-card glass-card"><div class="stat-num">${archivedRepos}</div><div class="stat-label">Archived</div></div>
        <div class="stat-card glass-card"><div class="stat-num">${totalStars}</div><div class="stat-label">Stars</div></div>
      </div>
    </div>

    <div class="section-header" style="flex-wrap:wrap;gap:10px;">
      <h3 class="section-title">Repositories <span id="repoCount" class="repo-count-badge">${totalRepos}</span></h3>
      <div class="repo-filter-row">
        <div class="repo-filter-tabs">
          <button class="filter-tab active" data-filter="all"     onclick="setFilter('all')">All <span class="tab-count">${totalRepos}</span></button>
          <button class="filter-tab"        data-filter="public"  onclick="setFilter('public')">🌐 Public <span class="tab-count">${publicRepos}</span></button>
          <button class="filter-tab"        data-filter="private" onclick="setFilter('private')">🔒 Private <span class="tab-count">${privateRepos}</span></button>
          <button class="filter-tab"        data-filter="fork"    onclick="setFilter('fork')">🍴 Fork <span class="tab-count">${forkRepos}</span></button>
          ${archivedRepos > 0 ? `<button class="filter-tab" data-filter="archived" onclick="setFilter('archived')">📦 Archived <span class="tab-count">${archivedRepos}</span></button>` : ''}
        </div>
        <input type="text" id="repoSearch" placeholder="🔍 Search..." class="search-input" oninput="applyFilters()">
      </div>
    </div>

    <div id="noReposMsg" class="hidden" style="text-align:center;padding:48px 0;color:rgba(255,255,255,0.3);">No repositories match this filter.</div>
    <div class="repo-grid" id="repoGrid">
      ${repoCards}
    </div>

    <script>
    let currentFilter = 'all';

    function setFilter(f) {
      currentFilter = f;
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === f));
      applyFilters();
    }

    function applyFilters() {
      const q = (document.getElementById('repoSearch').value || '').toLowerCase().trim();
      const cards = document.querySelectorAll('#repoGrid .repo-card');
      let visible = 0;
      cards.forEach(card => {
        const vis  = card.dataset.vis;
        const name = card.dataset.name;
        const desc = card.dataset.desc;
        const matchFilter = currentFilter === 'all' || vis === currentFilter;
        const matchSearch = !q || name.includes(q) || desc.includes(q);
        const show = matchFilter && matchSearch;
        card.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      document.getElementById('repoCount').textContent = visible;
      document.getElementById('noReposMsg').classList.toggle('hidden', visible > 0);
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

function actionsPage(user: any, owner: string, repo: string, runs: any, workflows: any, repoData: any, page: number, wfFilter: string, statusFilter: string) {
  const runItems = runs?.workflow_runs || []
  const workflowItems = workflows?.workflows || []
  const totalRuns = runs?.total_count || 0

  const statusBadge = (status: string, conclusion: string) => {
    if (status === 'completed') {
      if (conclusion === 'success') return '<span class="run-badge run-success">✓ success</span>'
      if (conclusion === 'failure') return '<span class="run-badge run-failure">✗ failure</span>'
      if (conclusion === 'cancelled') return '<span class="run-badge run-cancelled">⊘ cancelled</span>'
      if (conclusion === 'skipped') return '<span class="run-badge run-skipped">⊝ skipped</span>'
      if (conclusion === 'timed_out') return '<span class="run-badge run-failure">⏱ timed out</span>'
      return `<span class="run-badge run-neutral">${conclusion || 'completed'}</span>`
    }
    if (status === 'in_progress') return '<span class="run-badge run-running"><span class="pulse-dot"></span>in progress</span>'
    if (status === 'queued') return '<span class="run-badge run-queued">⏳ queued</span>'
    if (status === 'waiting') return '<span class="run-badge run-queued">⏸ waiting</span>'
    return `<span class="run-badge run-neutral">${status}</span>`
  }

  const statusIcon = (status: string, conclusion: string) => {
    if (status === 'in_progress') return '<div class="run-icon-spin">◌</div>'
    if (status === 'queued' || status === 'waiting') return '<div class="run-icon" style="color:#f59e0b">◎</div>'
    if (status === 'completed') {
      if (conclusion === 'success') return '<div class="run-icon" style="color:#22c55e">●</div>'
      if (conclusion === 'failure') return '<div class="run-icon" style="color:#ef4444">●</div>'
      if (conclusion === 'cancelled') return '<div class="run-icon" style="color:#6b7280">●</div>'
      return '<div class="run-icon" style="color:#6b7280">●</div>'
    }
    return '<div class="run-icon" style="color:#6b7280">○</div>'
  }

  const durationMs = (run: any) => {
    if (!run.run_started_at) return ''
    const start = new Date(run.run_started_at).getTime()
    const end = run.updated_at ? new Date(run.updated_at).getTime() : Date.now()
    const s = Math.floor((end - start) / 1000)
    if (s < 60) return `${s}s`
    return `${Math.floor(s/60)}m ${s%60}s`
  }

  const statusFilters = ['', 'success', 'failure', 'cancelled', 'in_progress', 'queued']

  const content = `
    ${repoNav(owner, repo, 'actions', repoData)}
    <div id="actions-toast" class="toast hidden"></div>

    <!-- Workflows Panel -->
    <div class="glass-card mb-4" id="workflowsPanel">
      <div class="wf-panel-header" onclick="togglePanel('workflowsPanel')">
        <div class="flex items-center gap-2">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          <span class="font-semibold text-white">Workflows</span>
          <span class="count-badge">${workflowItems.length}</span>
        </div>
        <svg class="wf-chevron" id="workflowsPanel-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="wf-panel-body" id="workflowsPanel-body">
        ${workflowItems.length === 0 ? '<div class="p-4 text-white/40 text-sm">No workflows found</div>' : `
          <div class="wf-list">
            ${workflowItems.map((w: any) => `
              <div class="wf-item ${wfFilter === String(w.id) ? 'active' : ''}">
                <div class="wf-item-left">
                  <div class="wf-state-dot ${w.state === 'active' ? 'active' : 'inactive'}"></div>
                  <div>
                    <div class="wf-name">${escapeHtml(w.name)}</div>
                    <div class="wf-path">${escapeHtml(w.path)}</div>
                  </div>
                </div>
              <div class="wf-item-actions">
                  <a href="/repo/${owner}/${repo}/actions?workflow=${w.id}" class="glass-btn-sm ${wfFilter === String(w.id) ? 'active' : ''}">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    Filter
                  </a>
                  <button class="glass-btn-sm wf-run-btn text-green-300"
                    id="runbtn-${w.id}"
                    onclick="openDispatch('${w.id}','${escapeHtml(w.name)}',this)"
                    title="Periksa apakah workflow mendukung manual trigger...">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    Run
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    </div>

    <!-- Runs Header -->
    <div class="section-header mb-3">
      <div class="flex items-center gap-3 flex-wrap">
        <h3 class="section-title">
          Workflow Runs
          ${wfFilter ? `<span class="text-white/40 text-sm font-normal"> — ${escapeHtml(workflowItems.find((w: any) => String(w.id) === wfFilter)?.name || wfFilter)}</span>` : ''}
        </h3>
        <span class="text-white/30 text-sm">${totalRuns.toLocaleString()} total</span>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <!-- Status filter pills -->
        <div class="flex gap-1 flex-wrap">
          ${statusFilters.map(s => `
            <a href="/repo/${owner}/${repo}/actions?${wfFilter ? 'workflow=' + wfFilter + '&' : ''}${s ? 'status=' + s : ''}"
               class="filter-pill ${statusFilter === s ? 'active' : ''}">
              ${s || 'All'}
            </a>
          `).join('')}
        </div>
        ${wfFilter ? `<a href="/repo/${owner}/${repo}/actions" class="glass-btn-sm text-red-300">✕ Clear filter</a>` : ''}
        <button class="glass-btn-sm" id="liveToggle" onclick="toggleLive()" title="Toggle auto-refresh">
          <span class="pulse-dot" id="liveDot" style="display:none"></span>
          <span id="liveLabel">⟳ Live</span>
        </button>
      </div>
    </div>

    <!-- Runs List -->
    <div id="runsList">
      ${runItems.length === 0 ? '<div class="empty-state">Tidak ada workflow runs</div>' : `
        <div class="runs-container">
          ${runItems.map((run: any) => renderRunCard(run, owner, repo, statusBadge, statusIcon, durationMs)).join('')}
        </div>
      `}
    </div>

    <!-- Pagination -->
    <div class="flex gap-2 mt-4 justify-between items-center">
      <div class="text-white/40 text-sm">Page ${page}</div>
      <div class="flex gap-2">
        ${page > 1 ? `<a href="?${wfFilter ? 'workflow=' + wfFilter + '&' : ''}${statusFilter ? 'status=' + statusFilter + '&' : ''}page=${page - 1}" class="glass-btn-sm">← Prev</a>` : ''}
        ${runItems.length === 20 ? `<a href="?${wfFilter ? 'workflow=' + wfFilter + '&' : ''}${statusFilter ? 'status=' + statusFilter + '&' : ''}page=${page + 1}" class="glass-btn-sm">Next →</a>` : ''}
      </div>
    </div>

    <!-- Dispatch Modal -->
    <div id="dispatchBackdrop" class="modal-backdrop hidden" onclick="closeDispatch()"></div>
    <div id="dispatchModal" class="secret-modal hidden" style="max-width:500px">
      <div class="modal-header">
        <h3 class="modal-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;vertical-align:-2px"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Run Workflow: <span id="dispatchName" class="text-green-300"></span>
        </h3>
        <button class="modal-close" onclick="closeDispatch()">✕</button>
      </div>
      <div class="modal-body">
        <!-- Trigger check loading state -->
        <div id="dispatchChecking" class="dispatch-checking">
          <span class="spin">⟳</span> Memeriksa triggers workflow…
        </div>
        <!-- No dispatch trigger warning -->
        <div id="dispatchNoTrigger" class="hidden">
          <div class="dispatch-no-trigger">
            <div class="dispatch-no-trigger-icon">⚠</div>
            <div>
              <div class="dispatch-no-trigger-title">Workflow tidak mendukung manual trigger</div>
              <div class="dispatch-no-trigger-body">
                Workflow ini tidak memiliki trigger <code>workflow_dispatch</code>.<br>
                Untuk mengaktifkan manual trigger, tambahkan ke file YAML:
                <pre class="dispatch-yaml-hint">on:
  workflow_dispatch:</pre>
              </div>
              <div id="dispatchTriggerList" class="dispatch-trigger-list"></div>
            </div>
          </div>
        </div>
        <!-- Dispatchable form -->
        <div id="dispatchForm" class="hidden">
          <div id="dispatchTriggerBadges" class="dispatch-trigger-badges"></div>
          <div class="form-group">
            <label class="form-label">Branch / Tag</label>
            <input type="text" id="dispatchRef" class="form-input font-mono" value="${repoData?.default_branch || 'main'}" placeholder="main" />
            <div class="text-white/30 text-xs mt-1">Branch atau tag yang akan dijalankan workflow-nya</div>
          </div>
          <div class="form-group" id="dispatchInputsGroup" style="display:none">
            <label class="form-label">Inputs (JSON)</label>
            <textarea id="dispatchInputs" class="form-input font-mono" rows="3" placeholder='{"key": "value"}'></textarea>
            <div class="text-white/30 text-xs mt-1">Opsional: workflow_dispatch inputs dalam format JSON</div>
          </div>
          <div id="dispatchError" class="alert-error hidden"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="glass-btn-sm" onclick="closeDispatch()">Tutup</button>
        <button class="btn-primary hidden" id="dispatchBtn" onclick="triggerDispatch()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Jalankan
        </button>
      </div>
    </div>

    <script>
    const OWNER='${owner}', REPO='${repo}';
    let currentDispatchId='', liveInterval=null;

    function showToast(msg, type='success') {
      const t=document.getElementById('actions-toast');
      t.textContent=msg; t.className='toast '+(type==='success'?'toast-success':'toast-error');
      t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'),4000);
    }

    // ── Workflows panel toggle ──
    function togglePanel(id) {
      const body=document.getElementById(id+'-body');
      const chevron=document.getElementById(id+'-chevron');
      const open=body.style.display!=='none';
      body.style.display=open?'none':'block';
      chevron.style.transform=open?'rotate(-90deg)':'rotate(0deg)';
    }

    // ── Dispatch ──
    function openDispatch(id, name, btn) {
      currentDispatchId = id;
      document.getElementById('dispatchName').textContent = name;
      // Reset modal state
      document.getElementById('dispatchChecking').classList.remove('hidden');
      document.getElementById('dispatchNoTrigger').classList.add('hidden');
      document.getElementById('dispatchForm').classList.add('hidden');
      document.getElementById('dispatchBtn').classList.add('hidden');
      document.getElementById('dispatchError').classList.add('hidden');
      document.getElementById('dispatchBackdrop').classList.remove('hidden');
      document.getElementById('dispatchModal').classList.remove('hidden');

      // Fetch triggers from backend
      fetch(\`/repo/\${OWNER}/\${REPO}/actions/workflows/\${encodeURIComponent(id)}/triggers\`)
        .then(r => r.json())
        .then(data => {
          document.getElementById('dispatchChecking').classList.add('hidden');
          if (data.dispatchable) {
            // Show trigger badges
            const badges = (data.triggers || []).map(t =>
              \`<span class="trigger-badge \${t === 'workflow_dispatch' ? 'trigger-dispatch' : 'trigger-other'}">\${t}</span>\`
            ).join('');
            document.getElementById('dispatchTriggerBadges').innerHTML =
              \`<div class="dispatch-triggers-row"><span class="text-white/40 text-xs">Triggers:</span> \${badges}</div>\`;
            document.getElementById('dispatchForm').classList.remove('hidden');
            document.getElementById('dispatchBtn').classList.remove('hidden');
            setTimeout(() => document.getElementById('dispatchRef').focus(), 50);
            // Update Run button to show it's confirmed dispatchable
            if (btn) { btn.classList.add('confirmed'); btn.title = 'Workflow mendukung workflow_dispatch'; }
          } else {
            // Not dispatchable — show friendly explanation
            const triggers = data.triggers || [];
            const listHtml = triggers.length
              ? \`<div class="mt-2 text-white/40 text-xs">Trigger saat ini: \${triggers.map(t => \`<code>\${t}</code>\`).join(', ')}</div>\`
              : '<div class="mt-2 text-white/40 text-xs">Tidak ada trigger yang terdeteksi.</div>';
            document.getElementById('dispatchTriggerList').innerHTML = listHtml;
            document.getElementById('dispatchNoTrigger').classList.remove('hidden');
            // Grey out the Run button permanently
            if (btn) { btn.disabled = true; btn.classList.remove('text-green-300'); btn.classList.add('wf-no-dispatch'); btn.title = 'Tidak ada trigger workflow_dispatch'; }
          }
        })
        .catch(err => {
          document.getElementById('dispatchChecking').classList.add('hidden');
          // On network error, still allow attempting dispatch
          document.getElementById('dispatchForm').classList.remove('hidden');
          document.getElementById('dispatchBtn').classList.remove('hidden');
          document.getElementById('dispatchError').textContent = 'Gagal cek triggers: ' + err.message + '. Coba tetap jalankan.';
          document.getElementById('dispatchError').classList.remove('hidden');
          setTimeout(() => document.getElementById('dispatchRef').focus(), 50);
        });
    }
    function closeDispatch() {
      document.getElementById('dispatchBackdrop').classList.add('hidden');
      document.getElementById('dispatchModal').classList.add('hidden');
    }
    async function triggerDispatch() {
      const ref = document.getElementById('dispatchRef').value.trim();
      const inputsRaw = document.getElementById('dispatchInputs').value.trim();
      const errEl = document.getElementById('dispatchError');
      errEl.classList.add('hidden');
      if (!ref) { errEl.textContent = 'Branch/tag tidak boleh kosong'; errEl.classList.remove('hidden'); return; }
      let inputs = {};
      if (inputsRaw) { try { inputs = JSON.parse(inputsRaw); } catch(e) { errEl.textContent = 'Inputs bukan JSON valid'; errEl.classList.remove('hidden'); return; } }
      const btn = document.getElementById('dispatchBtn');
      btn.disabled = true; btn.innerHTML = '<span class="spin">⟳</span> Menjalankan...';
      try {
        const res = await fetch(\`/repo/\${OWNER}/\${REPO}/actions/workflows/\${encodeURIComponent(currentDispatchId)}/dispatch\`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref, inputs })
        });
        const data = await res.json();
        if (data.success) {
          closeDispatch();
          showToast('✓ Workflow berhasil di-trigger! Halaman akan diperbarui...');
          setTimeout(() => location.reload(), 3000);
        } else if (res.status === 422) {
          // workflow_dispatch not present — show the inline hint
          errEl.innerHTML = \`<strong>\${data.error}</strong><br><span class="text-white/60 text-xs">\${data.hint || ''}</span>\`;
          errEl.classList.remove('hidden');
        } else {
          const msg = data.detail?.message || data.error || 'Unknown error';
          errEl.textContent = 'Error: ' + msg; errEl.classList.remove('hidden');
        }
      } catch(e) { errEl.textContent = 'Network error: ' + e.message; errEl.classList.remove('hidden'); }
      finally { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Jalankan'; }
    }

    // ── Run actions ──
    async function cancelRun(id) {
      if(!confirm('Cancel run #'+id+'?')) return;
      const res=await fetch(\`/repo/\${OWNER}/\${REPO}/actions/runs/\${id}/cancel\`,{method:'POST'});
      const d=await res.json();
      if(d.success){showToast('Run #'+id+' dibatalkan.');setTimeout(()=>location.reload(),1500);}
      else showToast('Gagal cancel: '+(d.error||'unknown'),'error');
    }
    async function rerunWorkflow(id) {
      const res=await fetch(\`/repo/\${OWNER}/\${REPO}/actions/runs/\${id}/rerun\`,{method:'POST'});
      const d=await res.json();
      if(d.success){showToast('Re-run dimulai!');setTimeout(()=>location.reload(),2000);}
      else showToast('Gagal re-run: '+(d.detail?.message||d.error||'unknown'),'error');
    }
    async function rerunFailed(id) {
      const res=await fetch(\`/repo/\${OWNER}/\${REPO}/actions/runs/\${id}/rerun-failed\`,{method:'POST'});
      const d=await res.json();
      if(d.success){showToast('Re-run failed jobs dimulai!');setTimeout(()=>location.reload(),2000);}
      else showToast('Gagal: '+(d.detail?.message||d.error||'unknown'),'error');
    }
    async function deleteRun(id) {
      if(!confirm('Hapus run #'+id+' secara permanen?')) return;
      const res=await fetch(\`/repo/\${OWNER}/\${REPO}/actions/runs/\${id}\`,{method:'DELETE'});
      const d=await res.json();
      if(d.success){showToast('Run #'+id+' dihapus.');const el=document.getElementById('run-'+id);if(el){el.style.opacity=0;el.style.transform='translateX(20px)';el.style.transition='all 0.3s';setTimeout(()=>el.remove(),300);}}
      else showToast('Gagal hapus: '+(d.error||'unknown'),'error');
    }

    // ── Live polling ──
    function toggleLive() {
      if(liveInterval){stopLive();}else{startLive();}
    }
    function startLive() {
      liveInterval=setInterval(pollRuns,5000);
      document.getElementById('liveDot').style.display='inline-block';
      document.getElementById('liveLabel').textContent=' Live ON';
      document.getElementById('liveToggle').classList.add('active');
    }
    function stopLive() {
      clearInterval(liveInterval);liveInterval=null;
      document.getElementById('liveDot').style.display='none';
      document.getElementById('liveLabel').textContent='⟳ Live';
      document.getElementById('liveToggle').classList.remove('active');
    }
    async function pollRuns() {
      const wfId=new URLSearchParams(location.search).get('workflow')||'';
      const url='/repo/'+OWNER+'/'+REPO+'/actions/poll'+(wfId?'?workflow='+encodeURIComponent(wfId):'');
      try {
        const res=await fetch(url); const data=await res.json();
        const runs=data.workflow_runs||[];
        // Update status badges for visible runs
        runs.forEach(run=>{
          const card=document.getElementById('run-'+run.id);
          if(!card) return;
          const badge=card.querySelector('.run-badge-wrap');
          if(badge) badge.innerHTML=getBadgeHtml(run.status,run.conclusion);
          const icon=card.querySelector('.run-status-icon');
          if(icon) icon.innerHTML=getIconHtml(run.status,run.conclusion);
          const dur=card.querySelector('.run-duration');
          if(dur && run.run_started_at) {
            const start=new Date(run.run_started_at).getTime();
            const end=run.updated_at?new Date(run.updated_at).getTime():Date.now();
            const s=Math.floor((end-start)/1000);
            dur.textContent=s<60?s+'s':Math.floor(s/60)+'m '+(s%60)+'s';
          }
        });
      } catch(e){}
    }
    function getBadgeHtml(status,conclusion){
      if(status==='completed'){
        if(conclusion==='success') return '<span class="run-badge run-success">✓ success</span>';
        if(conclusion==='failure') return '<span class="run-badge run-failure">✗ failure</span>';
        if(conclusion==='cancelled') return '<span class="run-badge run-cancelled">⊘ cancelled</span>';
        return '<span class="run-badge run-neutral">'+conclusion+'</span>';
      }
      if(status==='in_progress') return '<span class="run-badge run-running"><span class="pulse-dot"></span>in progress</span>';
      if(status==='queued') return '<span class="run-badge run-queued">⏳ queued</span>';
      return '<span class="run-badge run-neutral">'+status+'</span>';
    }
    function getIconHtml(status,conclusion){
      if(status==='in_progress') return '<div class="run-icon-spin">◌</div>';
      if(status==='queued') return '<div class="run-icon" style="color:#f59e0b">◎</div>';
      if(status==='completed'){
        if(conclusion==='success') return '<div class="run-icon" style="color:#22c55e">●</div>';
        if(conclusion==='failure') return '<div class="run-icon" style="color:#ef4444">●</div>';
      }
      return '<div class="run-icon" style="color:#6b7280">●</div>';
    }

    // Keyboard
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeDispatch();}});

    // Auto-start live if any run is in progress
    const hasRunning=${runItems.some((r: any) => r.status === 'in_progress' || r.status === 'queued') ? 'true' : 'false'};
    if(hasRunning) startLive();
    </script>
  `
  return glassLayout(`Actions - ${repo}`, user, content)
}

function renderRunCard(run: any, owner: string, repo: string, statusBadge: Function, statusIcon: Function, durationMs: Function): string {
  const branch = run.head_branch || ''
  const sha = run.head_sha?.substring(0, 7) || ''
  const dur = durationMs(run)
  const actor = run.actor || run.triggering_actor || {}
  const event = run.event || ''

  return `
    <div class="run-card glass-card" id="run-${run.id}" data-status="${run.status}" data-conclusion="${run.conclusion || ''}">
      <div class="run-card-inner">
        <!-- Status icon -->
        <div class="run-status-icon">${statusIcon(run.status, run.conclusion)}</div>

        <!-- Main info -->
        <div class="run-main">
          <a href="/repo/${owner}/${repo}/actions/runs/${run.id}" class="run-title">${escapeHtml(run.display_title || run.head_commit?.message?.split('\n')[0] || run.name || '')}</a>
          <div class="run-meta">
            <span class="run-workflow">${escapeHtml(run.name || '')}</span>
            <span class="run-sep">·</span>
            <span class="run-branch">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              ${escapeHtml(branch)}
            </span>
            <span class="run-sep">·</span>
            <code class="run-sha">${sha}</code>
            <span class="run-sep">·</span>
            <span class="run-event">${event}</span>
            <span class="run-sep">·</span>
            <img src="${actor.avatar_url || ''}" class="run-avatar" title="${actor.login || ''}" />
            <span class="run-actor">${escapeHtml(actor.login || '')}</span>
            <span class="run-sep">·</span>
            <span class="run-time">${timeAgo(run.created_at)}</span>
            ${dur ? `<span class="run-sep">·</span><span class="run-duration">⏱ ${dur}</span>` : ''}
            <span class="run-sep">·</span>
            <span class="run-number">#${run.run_number}</span>
          </div>
        </div>

        <!-- Badge -->
        <div class="run-badge-wrap">${statusBadge(run.status, run.conclusion)}</div>

        <!-- Actions -->
        <div class="run-actions" id="run-actions-${run.id}">
          <a href="/repo/${owner}/${repo}/actions/runs/${run.id}" class="run-action-btn" title="View detail">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </a>
          ${run.status === 'in_progress' || run.status === 'queued' || run.status === 'waiting' ? `
            <button class="run-action-btn text-red-300" onclick="cancelRun(${run.id})" title="Cancel">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            </button>
          ` : run.status === 'completed' ? `
            <button class="run-action-btn text-blue-300" onclick="rerunWorkflow(${run.id})" title="Re-run all jobs">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.47"/></svg>
            </button>
            ${run.conclusion === 'failure' || run.conclusion === 'timed_out' ? `
              <button class="run-action-btn text-orange-300" onclick="rerunFailed(${run.id})" title="Re-run failed jobs">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              </button>
            ` : ''}
            <button class="run-action-btn text-red-300" onclick="deleteRun(${run.id})" title="Delete run">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `
}

function runDetailPage(user: any, owner: string, repo: string, run: any, jobsData: any, repoData: any) {
  const jobs = jobsData?.jobs || []

  const statusIcon = (status: string, conclusion: string) => {
    if (status === 'in_progress') return '<span class="job-icon spin" style="color:#f59e0b">◌</span>'
    if (status === 'queued' || status === 'waiting') return '<span class="job-icon" style="color:#6b7280">◎</span>'
    if (status === 'completed') {
      if (conclusion === 'success') return '<span class="job-icon" style="color:#22c55e">✓</span>'
      if (conclusion === 'failure') return '<span class="job-icon" style="color:#ef4444">✗</span>'
      if (conclusion === 'skipped') return '<span class="job-icon" style="color:#6b7280">⊝</span>'
      if (conclusion === 'cancelled') return '<span class="job-icon" style="color:#6b7280">⊘</span>'
    }
    return '<span class="job-icon" style="color:#6b7280">○</span>'
  }

  const stepIcon = (status: string, conclusion: string) => {
    if (status === 'in_progress') return '<span class="step-icon spin" style="color:#f59e0b">◌</span>'
    if (status === 'queued') return '<span class="step-icon" style="color:#6b7280">◎</span>'
    if (status === 'completed') {
      if (conclusion === 'success') return '<span class="step-icon" style="color:#22c55e">✓</span>'
      if (conclusion === 'failure') return '<span class="step-icon" style="color:#ef4444">✗</span>'
      if (conclusion === 'skipped') return '<span class="step-icon" style="color:#6b7280">⊝</span>'
    }
    return '<span class="step-icon" style="color:#6b7280">○</span>'
  }

  const runBadge = () => {
    if (run?.status === 'in_progress') return '<span class="run-badge run-running"><span class="pulse-dot"></span>in progress</span>'
    if (run?.status === 'queued') return '<span class="run-badge run-queued">⏳ queued</span>'
    if (run?.conclusion === 'success') return '<span class="run-badge run-success">✓ success</span>'
    if (run?.conclusion === 'failure') return '<span class="run-badge run-failure">✗ failure</span>'
    if (run?.conclusion === 'cancelled') return '<span class="run-badge run-cancelled">⊘ cancelled</span>'
    return `<span class="run-badge run-neutral">${run?.status || ''}</span>`
  }

  const dur = () => {
    if (!run?.run_started_at) return ''
    const s = Math.floor((new Date(run.updated_at||Date.now()).getTime() - new Date(run.run_started_at).getTime())/1000)
    return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`
  }

  const isActive = run?.status === 'in_progress' || run?.status === 'queued'

  const content = `
    ${repoNav(owner, repo, 'actions', repoData)}
    <div id="detail-toast" class="toast hidden"></div>

    <!-- Run Header -->
    <div class="glass-card mb-4 run-detail-header">
      <div class="p-5">
        <div class="flex items-start justify-between gap-3 flex-wrap mb-3">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-1 flex-wrap">
              <a href="/repo/${owner}/${repo}/actions" class="text-white/40 text-sm hover:text-white/70">← Actions</a>
              <span class="text-white/20">/</span>
              <span class="text-white/60 text-sm">${escapeHtml(run?.name || '')}</span>
            </div>
            <h2 class="text-xl font-semibold text-white" id="runTitle">${escapeHtml(run?.display_title || run?.head_commit?.message?.split('\n')[0] || '')}</h2>
          </div>
          <div class="flex items-center gap-2 flex-wrap" id="runBadgeWrap">
            ${runBadge()}
          </div>
        </div>

        <!-- Meta row -->
        <div class="flex flex-wrap gap-4 text-sm text-white/50 mb-4">
          <span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;vertical-align:-1px"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
            <span class="text-white/70">${escapeHtml(run?.head_branch || '')}</span>
          </span>
          <span>
            <code class="text-blue-300">${run?.head_sha?.substring(0, 7)}</code>
          </span>
          <span>Triggered by <strong class="text-white/70">${escapeHtml(run?.actor?.login || '')}</strong></span>
          <span>Event: <strong class="text-white/70">${run?.event || ''}</strong></span>
          <span>Run <strong class="text-white/70">#${run?.run_number}</strong></span>
          <span id="runDuration">${dur() ? `⏱ ${dur()}` : ''}</span>
          <span>${timeAgo(run?.created_at)}</span>
        </div>

        <!-- Action buttons -->
        <div class="flex gap-2 flex-wrap" id="runButtons">
          ${isActive ? `
            <button class="btn-danger" style="padding:7px 14px;font-size:13px" onclick="cancelRun(${run?.id})">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              Cancel Run
            </button>
          ` : `
            <button class="glass-btn-sm text-blue-300" onclick="rerunAll()">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.47"/></svg>
              Re-run all jobs
            </button>
            ${run?.conclusion === 'failure' || run?.conclusion === 'timed_out' ? `
              <button class="glass-btn-sm text-orange-300" onclick="rerunFailed()">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                Re-run failed jobs
              </button>
            ` : ''}
          `}
          ${run?.html_url ? `<a href="${run.html_url}" target="_blank" class="glass-btn-sm">View on GitHub ↗</a>` : ''}
        </div>
      </div>
    </div>

    <!-- Jobs + Logs layout -->
    <div class="run-layout" id="runLayout">
      <!-- Jobs sidebar -->
      <div class="jobs-sidebar glass-card" id="jobsSidebar">
        <div class="jobs-sidebar-header">
          <span class="font-semibold text-white text-sm">Jobs</span>
          <span class="count-badge">${jobs.length}</span>
        </div>
        <div class="jobs-list" id="jobsList">
          ${jobs.map((job: any, i: number) => `
            <button class="job-btn ${i === 0 ? 'active' : ''}" id="jobbtn-${job.id}" onclick="selectJob(${job.id}, '${escapeHtml(job.name)}')">
              ${statusIcon(job.status, job.conclusion)}
              <div class="job-btn-info">
                <div class="job-btn-name">${escapeHtml(job.name)}</div>
                <div class="job-btn-meta">
                  ${job.runner_name ? `<span>${escapeHtml(job.runner_name)}</span>` : ''}
                  ${job.started_at ? `<span>${timeAgo(job.started_at)}</span>` : ''}
                </div>
              </div>
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Steps + Log panel -->
      <div class="log-panel glass-card" id="logPanel">
        ${jobs.length === 0 ? '<div class="empty-state">No jobs found</div>' : (() => {
          const firstJob = jobs[0]
          return `
            <div class="log-panel-header" id="logPanelHeader">
              <div class="flex items-center gap-2">
                ${statusIcon(firstJob.status, firstJob.conclusion)}
                <span class="text-white font-medium" id="logJobName">${escapeHtml(firstJob.name)}</span>
              </div>
              <div class="flex gap-2">
                <button class="glass-btn-sm" id="autoScrollBtn" onclick="toggleAutoScroll()">⬇ Auto-scroll</button>
                <button class="glass-btn-sm" onclick="loadJobLog(${firstJob.id})" id="loadLogBtn">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  Load Full Log
                </button>
              </div>
            </div>

            <!-- Steps accordion -->
            <div class="steps-list" id="stepsList">
              ${(firstJob.steps || []).map((step: any, si: number) => `
                <div class="step-item ${step.conclusion === 'failure' ? 'step-failed' : ''}" id="step-${si}">
                  <div class="step-header" onclick="toggleStep(${si})">
                    ${stepIcon(step.status, step.conclusion)}
                    <span class="step-name">${escapeHtml(step.name)}</span>
                    <span class="step-num">${step.number}</span>
                    ${step.started_at && step.completed_at ? `<span class="step-dur">⏱ ${Math.floor((new Date(step.completed_at).getTime()-new Date(step.started_at).getTime())/1000)}s</span>` : ''}
                    <svg class="step-chevron" id="step-chevron-${si}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                  </div>
                  <div class="step-body hidden" id="step-body-${si}">
                    <div class="step-log-placeholder text-white/30 text-xs p-3">Klik "Load Full Log" untuk melihat output log lengkap</div>
                  </div>
                </div>
              `).join('')}
            </div>

            <!-- Full log output -->
            <div id="fullLogContainer" class="hidden">
              <div class="log-toolbar">
                <span class="text-white/50 text-xs" id="logStatus">Loading...</span>
                <div class="flex gap-2">
                  <input type="text" id="logSearch" class="log-search" placeholder="Search log..." oninput="searchLog(this.value)" />
                  <button class="glass-btn-sm" onclick="clearLog()">✕ Close</button>
                </div>
              </div>
              <div class="log-output" id="logOutput"></div>
            </div>
          `
        })()}
      </div>
    </div>

    <script>
    const OWNER='${owner}', REPO='${repo}', RUN_ID=${run?.id || 0};
    const IS_ACTIVE=${isActive};
    let currentJobId=${jobs[0]?.id || 0};
    let autoScroll=true, pollTimer=null, logLines=[];

    function showToast(msg,type='success'){
      const t=document.getElementById('detail-toast');
      t.textContent=msg;t.className='toast '+(type==='success'?'toast-success':'toast-error');
      t.classList.remove('hidden');setTimeout(()=>t.classList.add('hidden'),4000);
    }

    // ── Job selection ──
    function selectJob(jobId, jobName) {
      document.querySelectorAll('.job-btn').forEach(b=>b.classList.remove('active'));
      document.getElementById('jobbtn-'+jobId)?.classList.add('active');
      document.getElementById('logJobName').textContent=jobName;
      currentJobId=jobId;
      clearLog();
      loadJobLog(jobId);
    }

    // ── Steps toggle ──
    function toggleStep(idx) {
      const body=document.getElementById('step-body-'+idx);
      const chev=document.getElementById('step-chevron-'+idx);
      const open=!body.classList.contains('hidden');
      body.classList.toggle('hidden',open);
      chev.style.transform=open?'rotate(-90deg)':'rotate(0)';
    }

    // ── Load full log ──
    async function loadJobLog(jobId) {
      jobId = jobId || currentJobId;
      currentJobId = jobId;
      const container = document.getElementById('fullLogContainer');
      const stepsList = document.getElementById('stepsList');
      const loadBtn = document.getElementById('loadLogBtn');
      const statusEl = document.getElementById('logStatus');
      const out = document.getElementById('logOutput');

      container.classList.remove('hidden');
      stepsList.style.display = 'none';
      if(loadBtn) loadBtn.disabled = true;
      statusEl.textContent = 'Loading log...';
      out.innerHTML = '<div class="log-line"><span class="log-linenum">     </span><span class="log-timestamp">⟳ Fetching log from GitHub...</span></div>';

      try {
        const res = await fetch(\`/repo/\${OWNER}/\${REPO}/actions/jobs/\${jobId}/logs\`);
        const contentType = res.headers.get('content-type') || '';

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          let msg = '';
          if (res.status === 403)
            msg = '🔒 Token tidak punya izin membaca logs. Tambahkan scope: repo atau actions:read pada Personal Access Token Anda.';
          else if (res.status === 404)
            msg = '📭 Log belum tersedia — job mungkin masih berjalan, belum pernah dijalankan, atau log sudah terhapus. Coba lagi setelah job selesai.';
          else if (res.status === 410)
            msg = '🗑 Log sudah kadaluarsa atau dihapus oleh GitHub (biasanya setelah 90 hari).';
          else
            msg = 'Gagal memuat log (' + res.status + ')' + (errText ? ': ' + errText.substring(0, 300) : '');

          out.innerHTML = \`<div class="log-line log-error"><span class="log-linenum">  ERR</span><span class="log-content">\${escHtml(msg)}</span></div>\`;
          statusEl.textContent = 'Error';
          return;
        }

        const text = await res.text();
        if (!text || text.trim() === '') {
          out.innerHTML = '<div class="log-line log-timestamp"><span class="log-linenum">     </span><span>Log kosong — job mungkin belum menghasilkan output</span></div>';
          statusEl.textContent = '0 lines';
          return;
        }

        logLines = text.split('\\n');
        renderLog(logLines);
        statusEl.textContent = logLines.length + ' lines';
        if (autoScroll) setTimeout(() => { out.scrollTop = out.scrollHeight; }, 50);

      } catch(e) {
        out.innerHTML = \`<div class="log-line log-error"><span class="log-linenum">  ERR</span><span>Network error: \${escHtml(e.message)}</span></div>\`;
        statusEl.textContent = 'Error';
      } finally {
        if(loadBtn) loadBtn.disabled = false;
      }
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ── Log parsing helpers ──────────────────────────────────────────────────

    // Parse a raw GitHub Actions log line into timestamp + content
    function parseLogLine(rawLine) {
      // Format: "2026-07-10T23:35:09.7839592Z <content>"
      // Subseconds can be 1–7 digits (Windows high-res timer)
      const m = rawLine.match(/^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2}))\.\d+Z (.*)/);
      if (m) return { timeStr: m[2], content: m[3] };
      // Fallback: no timestamp prefix (rare — treat whole line as content)
      return { timeStr: '', content: rawLine };
    }

    // How many leading spaces does the content have?
    function leadingSpaces(s) {
      const m = s.match(/^(\s+)/);
      return m ? m[1].length : 0;
    }

    // Classify content → { cls, icon, cmd, indentPx }
    function classifyLine(content) {
      const spaces = leadingSpaces(content);
      const trimmed = content.trimStart();
      const tl = trimmed.toLowerCase();

      // ── GitHub workflow commands (##[…]) ──────────────────────────────────
      if (/^##\[error\]/i.test(trimmed))    return { cls:'log-error',    icon:'✖', cmd:true,  indentPx:0 };
      if (/^##\[warning\]/i.test(trimmed))  return { cls:'log-warn',     icon:'⚠', cmd:true,  indentPx:0 };
      if (/^##\[group\]/i.test(trimmed))    return { cls:'log-group',    icon:'▶', cmd:true,  indentPx:0 };
      if (/^##\[endgroup\]/i.test(trimmed)) return { cls:'log-endgroup', icon:'◀', cmd:true,  indentPx:0 };
      if (/^##\[section\]/i.test(trimmed))  return { cls:'log-section',  icon:'§', cmd:true,  indentPx:0 };
      if (/^##\[debug\]/i.test(trimmed))    return { cls:'log-debug',    icon:'·', cmd:true,  indentPx:0 };
      if (/^##\[command\]/i.test(trimmed))  return { cls:'log-command',  icon:'$', cmd:true,  indentPx:0 };
      if (/^##\[notice\]/i.test(trimmed))   return { cls:'log-notice',   icon:'ℹ', cmd:true,  indentPx:0 };

      // ── Indented key: value lines (e.g. "  image: ***/vas") ──────────────
      // These appear under "with:", "env:", "env:" blocks — indent ≥ 2 spaces
      if (spaces >= 2 && /^[\w.-]+\s*:\s/.test(trimmed)) {
        return { cls:'log-kv', icon:'', cmd:false, indentPx: spaces * 7 };
      }

      // ── Section-header keywords (bare words ending in colon) ─────────────
      // e.g. "with:", "env:", "Run build-push@v4"
      if (/^(with|env|run|uses|if|needs|outputs?|steps?|jobs?)\s*:?\s*$/i.test(trimmed)) {
        return { cls:'log-header', icon:'', cmd:false, indentPx:0 };
      }

      // ── Content-based colours ─────────────────────────────────────────────
      if (/error\b/i.test(tl) && !/no.?error/i.test(tl))          return { cls:'log-error',   icon:'', cmd:false, indentPx:0 };
      if (/\b(warn(ing)?)\b/i.test(tl))                            return { cls:'log-warn',    icon:'', cmd:false, indentPx:0 };
      if (/\b(success(fully)?|passed|complete[d]?|done)\b/i.test(tl)) return { cls:'log-success', icon:'', cmd:false, indentPx:0 };

      return { cls:'log-normal', icon:'', cmd:false, indentPx:0 };
    }

    function renderLog(lines) {
      const out = document.getElementById('logOutput');
      out.innerHTML = '';
      const frag = document.createDocumentFragment();

      let groupDepth = 0;   // nesting from ##[group] / ##[endgroup]

      lines.forEach((rawLine, i) => {
        // Skip completely empty lines — add a thin spacer instead
        if (rawLine.trim() === '') {
          const blank = document.createElement('div');
          blank.className = 'log-line log-blank';
          frag.appendChild(blank);
          return;
        }

        const { timeStr, content } = parseLogLine(rawLine);
        const { cls, icon, cmd, indentPx } = classifyLine(content);

        // Decrement group depth BEFORE this line renders (endgroup line itself de-indents)
        if (/^##\[endgroup\]/i.test(content.trimStart())) groupDepth = Math.max(0, groupDepth - 1);

        const el = document.createElement('div');
        el.className = 'log-line ' + cls;
        el.id = 'logline-' + i;

        // ① Line number (right-aligned gutter)
        const numEl = document.createElement('span');
        numEl.className = 'log-linenum';
        numEl.textContent = String(i + 1).padStart(5);
        el.appendChild(numEl);

        // ② Timestamp — HH:MM:SS only (dimmed, fixed-width)
        const tsEl = document.createElement('span');
        tsEl.className = 'log-ts';
        tsEl.textContent = timeStr || '';
        el.appendChild(tsEl);

        // ③ Group-depth indent spacer (invisible, keeps content aligned)
        if (groupDepth > 0 || indentPx > 0) {
          const indent = document.createElement('span');
          indent.className = 'log-indent';
          indent.style.width = (groupDepth * 14 + indentPx) + 'px';
          el.appendChild(indent);
        }

        // ④ Icon badge
        if (icon) {
          const iconEl = document.createElement('span');
          iconEl.className = 'log-icon';
          iconEl.textContent = icon;
          el.appendChild(iconEl);
        }

        // ⑤ Content — strip ##[cmd] prefix; syntax-highlight key: value
        const trimmedContent = cmd ? content.trimStart().replace(/^##\[[^\]]+\]\s?/, '') : content.trimStart();
        const contentEl = document.createElement('span');
        contentEl.className = 'log-content';

        if (cls === 'log-kv') {
          // "image: ***/vas"  →  key + colon + value
          const kv = trimmedContent.match(/^([\w.-]+)(\s*:\s?)(.*)/s);
          if (kv) {
            contentEl.innerHTML =
              '<span class="log-kv-key">'  + escHtml(kv[1]) + '</span>' +
              '<span class="log-kv-sep">'  + escHtml(kv[2]) + '</span>' +
              '<span class="log-kv-val">'  + escHtml(kv[3]) + '</span>';
          } else {
            contentEl.textContent = trimmedContent;
          }
        } else if (cls === 'log-header') {
          // e.g. "with:" → bold section header
          contentEl.innerHTML = '<span class="log-header-text">' + escHtml(trimmedContent) + '</span>';
        } else {
          contentEl.textContent = trimmedContent;
        }
        el.appendChild(contentEl);

        frag.appendChild(el);

        // Increment group depth AFTER the group header line
        if (/^##\[group\]/i.test(content.trimStart())) groupDepth++;
      });

      out.appendChild(frag);
    }

    function searchLog(q) {
      const out=document.getElementById('logOutput');
      const lines=out.querySelectorAll('.log-line');
      const qLower=q.toLowerCase();
      let found=0;
      lines.forEach(el=>{
        const text=el.textContent.toLowerCase();
        if(!q||text.includes(qLower)){el.style.display='';found++;}
        else el.style.display='none';
      });
      document.getElementById('logStatus').textContent=q?found+' matches':logLines.length+' lines';
    }

    function clearLog() {
      document.getElementById('fullLogContainer').classList.add('hidden');
      document.getElementById('stepsList').style.display='';
      document.getElementById('logOutput').innerHTML='';
    }

    function toggleAutoScroll() {
      autoScroll=!autoScroll;
      document.getElementById('autoScrollBtn').textContent=autoScroll?'⬇ Auto-scroll':'⏸ Auto-scroll';
      document.getElementById('autoScrollBtn').classList.toggle('active',autoScroll);
    }

    // ── Run actions ──
    async function cancelRun(id) {
      id=id||RUN_ID;
      const res=await fetch(\`/repo/\${OWNER}/\${REPO}/actions/runs/\${id}/cancel\`,{method:'POST'});
      const d=await res.json();
      if(d.success){showToast('Run dibatalkan!');setTimeout(()=>location.reload(),2000);}
      else showToast('Gagal: '+(d.error||'unknown'),'error');
    }
    async function rerunAll() {
      const res=await fetch(\`/repo/\${OWNER}/\${REPO}/actions/runs/\${RUN_ID}/rerun\`,{method:'POST'});
      const d=await res.json();
      if(d.success){showToast('Re-run dimulai!');setTimeout(()=>location.reload(),2000);}
      else showToast('Gagal: '+(d.detail?.message||d.error||'unknown'),'error');
    }
    async function rerunFailed() {
      const res=await fetch(\`/repo/\${OWNER}/\${REPO}/actions/runs/\${RUN_ID}/rerun-failed\`,{method:'POST'});
      const d=await res.json();
      if(d.success){showToast('Re-run failed jobs dimulai!');setTimeout(()=>location.reload(),2000);}
      else showToast('Gagal: '+(d.detail?.message||d.error||'unknown'),'error');
    }

    // ── Live polling for active runs ──
    async function pollStatus() {
      try {
        const res=await fetch(\`/repo/\${OWNER}/\${REPO}/actions/runs/\${RUN_ID}/status\`);
        const data=await res.json();
        const run=data.run; const jobs=data.jobs?.jobs||[];
        // Update badge
        const bwrap=document.getElementById('runBadgeWrap');
        if(bwrap && run) {
          if(run.status==='in_progress') bwrap.innerHTML='<span class="run-badge run-running"><span class="pulse-dot"></span>in progress</span>';
          else if(run.conclusion==='success'){bwrap.innerHTML='<span class="run-badge run-success">✓ success</span>';stopPoll();}
          else if(run.conclusion==='failure'){bwrap.innerHTML='<span class="run-badge run-failure">✗ failure</span>';stopPoll();}
          else if(run.conclusion==='cancelled'){bwrap.innerHTML='<span class="run-badge run-cancelled">⊘ cancelled</span>';stopPoll();}
        }
        // Update job statuses in sidebar
        jobs.forEach(job=>{
          const btn=document.getElementById('jobbtn-'+job.id);
          if(btn){
            const icon=btn.querySelector('.job-icon,.spin');
            if(icon) icon.outerHTML=getJobIcon(job.status,job.conclusion);
          }
        });
        // Duration
        if(run?.run_started_at){
          const s=Math.floor((new Date().getTime()-new Date(run.run_started_at).getTime())/1000);
          const durEl=document.getElementById('runDuration');
          if(durEl) durEl.textContent='⏱ '+(s<60?s+'s':Math.floor(s/60)+'m '+(s%60)+'s');
        }
        // Reload log if viewing
        if(document.getElementById('fullLogContainer') && !document.getElementById('fullLogContainer').classList.contains('hidden')){
          loadJobLog(currentJobId);
        }
      } catch(e){}
    }

    function getJobIcon(status,conclusion){
      if(status==='in_progress') return '<span class="job-icon spin" style="color:#f59e0b">◌</span>';
      if(status==='completed'){
        if(conclusion==='success') return '<span class="job-icon" style="color:#22c55e">✓</span>';
        if(conclusion==='failure') return '<span class="job-icon" style="color:#ef4444">✗</span>';
        if(conclusion==='skipped') return '<span class="job-icon" style="color:#6b7280">⊝</span>';
      }
      return '<span class="job-icon" style="color:#6b7280">○</span>';
    }

    function stopPoll(){clearInterval(pollTimer);pollTimer=null;}

    if(IS_ACTIVE){
      pollTimer=setInterval(pollStatus,4000);
      // Auto-load log of first in-progress job
      const firstJob=${jobs[0]?.id || 0};
      if(firstJob) setTimeout(()=>loadJobLog(firstJob),800);
    }
    </script>
  `
  return glassLayout(`Run #${run?.run_number} - ${run?.name} - ${repo}`, user, content)
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
  const isError = secretsData?.message

  const content = `
    ${repoNav(owner, repo, 'secrets', repoData)}

    <!-- Toast notification -->
    <div id="toast" class="toast hidden"></div>

    <!-- Header -->
    <div class="section-header">
      <h3 class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;vertical-align:-2px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Actions Secrets <span class="count-badge">${items.length}</span>
      </h3>
      <button class="btn-primary" onclick="openModal()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Secret
      </button>
    </div>

    <!-- Info banner -->
    <div class="glass-card mb-4 p-3" style="border-color:rgba(234,179,8,0.2);background:rgba(234,179,8,0.05)">
      <div class="flex items-center gap-2 text-sm" style="color:rgba(253,224,71,0.9)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <strong>Catatan:</strong> Nilai secret dienkripsi oleh GitHub dan <strong>tidak bisa dibaca kembali</strong> melalui API — ini adalah batasan keamanan GitHub. Anda bisa menambah, update, atau hapus secret di bawah.
      </div>
    </div>

    ${isError ? `<div class="alert-error">Error: ${escapeHtml(secretsData.message)} — Pastikan token memiliki scope <code>repo</code> atau <code>secrets</code></div>` : ''}

    <!-- Secrets list -->
    ${items.length === 0 && !isError ? '<div class="empty-state">Belum ada secrets. Klik <strong>New Secret</strong> untuk menambah.</div>' : `
      <div class="space-y-2" id="secretsList">
        ${items.map((s: any) => `
          <div class="glass-card secret-item" id="secret-${escapeHtml(s.name)}" data-name="${escapeHtml(s.name)}">
            <div class="secret-row">
              <div class="secret-left">
                <div class="secret-icon">🔑</div>
                <div class="secret-info">
                  <div class="secret-name">${escapeHtml(s.name)}</div>
                  <div class="secret-meta">
                    <span class="badge-encrypted">🔒 Encrypted</span>
                    <span class="text-white/40 text-xs">Diperbarui ${timeAgo(s.updated_at)}</span>
                    ${s.visibility ? `<span class="badge-neutral text-xs">${s.visibility}</span>` : ''}
                  </div>
                </div>
              </div>
              <div class="secret-actions">
                <button class="glass-btn-sm text-blue-300" onclick="openEditModal('${escapeHtml(s.name)}')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  Update Value
                </button>
                <button class="glass-btn-sm text-red-300" onclick="deleteSecret('${escapeHtml(s.name)}')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                  Delete
                </button>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `}

    <!-- Modal backdrop -->
    <div id="modalBackdrop" class="modal-backdrop hidden" onclick="closeModal()"></div>

    <!-- Create/Update Modal -->
    <div id="secretModal" class="secret-modal hidden">
      <div class="modal-header">
        <h3 class="modal-title" id="modalTitle">New Secret</h3>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Secret Name <span style="color:#f87171">*</span></label>
          <input type="text" id="secretName" class="form-input font-mono" placeholder="MY_SECRET_KEY" autocomplete="off" spellcheck="false"
            oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9_]/g,'')" />
          <div class="text-white/30 text-xs mt-1">Hanya huruf besar, angka, dan underscore</div>
        </div>
        <div class="form-group">
          <label class="form-label" id="valueLabel">Secret Value <span style="color:#f87171">*</span></label>
          <div class="secret-value-wrapper">
            <textarea id="secretValue" class="form-input font-mono secret-textarea" 
              placeholder="Masukkan nilai secret..."
              autocomplete="off" spellcheck="false" rows="4"></textarea>
            <button type="button" class="toggle-visibility" id="toggleBtn" onclick="toggleVisibility()" title="Toggle visibility">
              <svg id="eyeIcon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <div class="text-white/30 text-xs mt-1" id="valueHint">Nilai akan dienkripsi dengan kunci publik repo sebelum dikirim ke GitHub</div>
        </div>
        <div id="modalError" class="alert-error hidden"></div>
      </div>
      <div class="modal-footer">
        <button class="glass-btn-sm" onclick="closeModal()">Batal</button>
        <button class="btn-primary" id="saveBtn" onclick="saveSecret()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Simpan Secret
        </button>
      </div>
    </div>

    <!-- Confirm Delete Modal -->
    <div id="deleteModal" class="secret-modal hidden" style="max-width:420px">
      <div class="modal-header">
        <h3 class="modal-title" style="color:#f87171">⚠️ Hapus Secret</h3>
        <button class="modal-close" onclick="closeDeleteModal()">✕</button>
      </div>
      <div class="modal-body">
        <p class="text-white/80 mb-3">Apakah Anda yakin ingin menghapus secret:</p>
        <div class="glass-inner p-3 font-mono text-yellow-300 text-sm" id="deleteSecretName"></div>
        <p class="text-white/50 text-sm mt-3">Tindakan ini tidak dapat dibatalkan. Workflow yang menggunakan secret ini akan gagal.</p>
        <div id="deleteError" class="alert-error hidden mt-3"></div>
      </div>
      <div class="modal-footer">
        <button class="glass-btn-sm" onclick="closeDeleteModal()">Batal</button>
        <button class="btn-danger" id="confirmDeleteBtn" onclick="confirmDelete()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          Ya, Hapus
        </button>
      </div>
    </div>

    <script>
    const OWNER = '${owner}';
    const REPO = '${repo}';
    let currentDeleteName = '';
    let isEditing = false;
    let isValueHidden = true;

    function showToast(msg, type='success') {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast ' + (type === 'success' ? 'toast-success' : 'toast-error');
      t.classList.remove('hidden');
      setTimeout(() => t.classList.add('hidden'), 3500);
    }

    function openModal() {
      isEditing = false;
      document.getElementById('modalTitle').textContent = 'New Secret';
      document.getElementById('saveBtn').innerHTML = \`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Simpan Secret\`;
      document.getElementById('secretName').value = '';
      document.getElementById('secretName').readOnly = false;
      document.getElementById('secretName').style.opacity = '1';
      document.getElementById('secretValue').value = '';
      document.getElementById('secretValue').type = 'password';
      document.getElementById('valueLabel').innerHTML = 'Secret Value <span style="color:#f87171">*</span>';
      document.getElementById('valueHint').textContent = 'Nilai akan dienkripsi dengan kunci publik repo sebelum dikirim ke GitHub';
      document.getElementById('modalError').classList.add('hidden');
      isValueHidden = true;
      updateEyeIcon();
      document.getElementById('modalBackdrop').classList.remove('hidden');
      document.getElementById('secretModal').classList.remove('hidden');
      setTimeout(() => document.getElementById('secretName').focus(), 50);
    }

    function openEditModal(name) {
      isEditing = true;
      document.getElementById('modalTitle').textContent = 'Update Secret: ' + name;
      document.getElementById('saveBtn').innerHTML = \`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Update Secret\`;
      document.getElementById('secretName').value = name;
      document.getElementById('secretName').readOnly = true;
      document.getElementById('secretName').style.opacity = '0.7';
      document.getElementById('secretValue').value = '';
      document.getElementById('secretValue').type = 'password';
      document.getElementById('valueLabel').innerHTML = 'New Secret Value <span style="color:#f87171">*</span>';
      document.getElementById('valueHint').textContent = 'Masukkan nilai baru. Nilai lama akan digantikan sepenuhnya.';
      document.getElementById('modalError').classList.add('hidden');
      isValueHidden = true;
      updateEyeIcon();
      document.getElementById('modalBackdrop').classList.remove('hidden');
      document.getElementById('secretModal').classList.remove('hidden');
      setTimeout(() => document.getElementById('secretValue').focus(), 50);
    }

    function closeModal() {
      document.getElementById('modalBackdrop').classList.add('hidden');
      document.getElementById('secretModal').classList.add('hidden');
    }

    function toggleVisibility() {
      isValueHidden = !isValueHidden;
      const ta = document.getElementById('secretValue');
      // textarea doesn't support type, use -webkit-text-security
      ta.style.webkitTextSecurity = isValueHidden ? 'disc' : 'none';
      updateEyeIcon();
    }

    function updateEyeIcon() {
      const icon = document.getElementById('eyeIcon');
      if (isValueHidden) {
        icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
      } else {
        icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>';
      }
    }

    async function saveSecret() {
      const name = document.getElementById('secretName').value.trim();
      const value = document.getElementById('secretValue').value;
      const errEl = document.getElementById('modalError');
      errEl.classList.add('hidden');

      if (!name) { errEl.textContent = 'Nama secret tidak boleh kosong'; errEl.classList.remove('hidden'); return; }
      if (!value) { errEl.textContent = 'Nilai secret tidak boleh kosong'; errEl.classList.remove('hidden'); return; }

      const btn = document.getElementById('saveBtn');
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Menyimpan...';

      try {
        const res = await fetch(\`/repo/\${OWNER}/\${REPO}/settings/secrets/upsert\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, value })
        });
        const data = await res.json();
        if (data.success) {
          closeModal();
          showToast(isEditing ? \`Secret "\${name}" berhasil diupdate!\` : \`Secret "\${name}" berhasil dibuat!\`);
          setTimeout(() => location.reload(), 1000);
        } else {
          errEl.textContent = 'Error: ' + (data.error || 'Unknown error') + (data.detail?.message ? ' — ' + data.detail.message : '');
          errEl.classList.remove('hidden');
        }
      } catch(e) {
        errEl.textContent = 'Network error: ' + e.message;
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    }

    function deleteSecret(name) {
      currentDeleteName = name;
      document.getElementById('deleteSecretName').textContent = name;
      document.getElementById('deleteError').classList.add('hidden');
      document.getElementById('modalBackdrop').classList.remove('hidden');
      document.getElementById('deleteModal').classList.remove('hidden');
    }

    function closeDeleteModal() {
      document.getElementById('modalBackdrop').classList.add('hidden');
      document.getElementById('deleteModal').classList.add('hidden');
    }

    async function confirmDelete() {
      const btn = document.getElementById('confirmDeleteBtn');
      const errEl = document.getElementById('deleteError');
      errEl.classList.add('hidden');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Menghapus...';

      try {
        const res = await fetch(\`/repo/\${OWNER}/\${REPO}/settings/secrets/\${encodeURIComponent(currentDeleteName)}\`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
          closeDeleteModal();
          showToast(\`Secret "\${currentDeleteName}" berhasil dihapus.\`, 'success');
          const el = document.getElementById('secret-' + currentDeleteName);
          if (el) { el.style.opacity='0'; el.style.transform='translateX(20px)'; el.style.transition='all 0.3s'; setTimeout(() => el.remove(), 300); }
          // Update count
          const badge = document.querySelector('.count-badge');
          if (badge) badge.textContent = String(parseInt(badge.textContent) - 1);
        } else {
          errEl.textContent = 'Error: ' + (data.error || 'Unknown') + (data.detail?.message ? ' — ' + data.detail.message : '');
          errEl.classList.remove('hidden');
        }
      } catch(e) {
        errEl.textContent = 'Network error: ' + e.message;
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.innerHTML = \`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg> Ya, Hapus\`;
      }
    }

    // Apply masking on load
    document.querySelectorAll('.secret-textarea').forEach(el => {
      el.style.webkitTextSecurity = 'disc';
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeModal(); closeDeleteModal(); }
    });
    </script>
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

function collaboratorsPage(user: any, owner: string, repo: string, collabs: any[], repoData: any, invites: any[]) {
  const isError   = !Array.isArray(collabs)
  const items     = isError ? [] : collabs
  const pendingInvites = Array.isArray(invites) ? invites : []

  const permLabels: Record<string, string> = {
    pull:     'Read',
    triage:   'Triage',
    push:     'Write',
    maintain: 'Maintain',
    admin:    'Admin'
  }
  const permColors: Record<string, string> = {
    pull: 'badge-neutral', triage: 'badge-neutral',
    push: 'badge-public',  maintain: 'badge-fork', admin: 'badge-private'
  }

  function permBadge(perm: string) {
    return `<span class="${permColors[perm] || 'badge-neutral'}">${permLabels[perm] || perm}</span>`
  }

  const collabCards = items.map((c: any) => {
    const perm = c.role_name || (c.permissions
      ? (c.permissions.admin ? 'admin' : c.permissions.maintain ? 'maintain' : c.permissions.push ? 'push' : c.permissions.triage ? 'triage' : 'pull')
      : 'push')
    return `
    <div class="collab-card glass-card" id="collab-${c.login}">
      <div class="collab-avatar-wrap">
        <img src="${c.avatar_url}" class="collab-avatar" />
        <span class="collab-type-dot ${c.type === 'Organization' ? 'dot-org' : 'dot-user'}" title="${c.type}"></span>
      </div>
      <div class="collab-info">
        <div class="collab-login">${escapeHtml(c.login)}</div>
        <div class="collab-type">${c.type || 'User'}</div>
        <div class="collab-perm-row">
          ${permBadge(perm)}
          <select class="perm-select" onchange="updatePermission('${escapeHtml(c.login)}', this.value)">
            <option value="pull"     ${perm==='pull'?'selected':''}>Read</option>
            <option value="triage"   ${perm==='triage'?'selected':''}>Triage</option>
            <option value="push"     ${perm==='push'?'selected':''}>Write</option>
            <option value="maintain" ${perm==='maintain'?'selected':''}>Maintain</option>
            <option value="admin"    ${perm==='admin'?'selected':''}>Admin</option>
          </select>
        </div>
      </div>
      <div class="collab-actions">
        <a href="https://github.com/${escapeHtml(c.login)}" target="_blank" class="glass-btn-sm">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
          Profile
        </a>
        <button class="glass-btn-sm btn-danger" onclick="removeCollab('${escapeHtml(c.login)}')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Remove
        </button>
      </div>
    </div>`
  }).join('')

  const inviteCards = pendingInvites.map((inv: any) => `
    <div class="collab-card glass-card invite-pending" id="invite-${inv.id}">
      <div class="collab-avatar-wrap">
        <img src="${inv.invitee?.avatar_url || ''}" class="collab-avatar" style="opacity:.6" />
        <span class="collab-type-dot dot-pending" title="Pending"></span>
      </div>
      <div class="collab-info">
        <div class="collab-login">${escapeHtml(inv.invitee?.login || '—')}</div>
        <div class="collab-type" style="color:#fde047">⏳ Pending invitation</div>
        <div class="collab-perm-row">${permBadge(inv.permissions || 'push')}</div>
      </div>
      <div class="collab-actions">
        <a href="https://github.com/${escapeHtml(inv.invitee?.login || '')}" target="_blank" class="glass-btn-sm">Profile</a>
        <button class="glass-btn-sm btn-danger" onclick="cancelInvite(${inv.id}, '${escapeHtml(inv.invitee?.login || '')}')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Cancel
        </button>
      </div>
    </div>`
  ).join('')

  const content = `
    ${repoNav(owner, repo, 'collaborators', repoData)}

    <!-- Toast -->
    <div id="collab-toast" class="toast hidden"></div>

    <!-- ── Invite Form ─────────────────────────────────────────────────── -->
    <div class="invite-box glass-card">
      <h3 class="invite-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
        Invite Collaborator
      </h3>
      <p class="invite-hint">Cari username GitHub dan tentukan level akses. Mereka akan menerima email undangan.</p>

      <div class="invite-form-row">
        <!-- Username search -->
        <div class="invite-search-wrap" style="position:relative;flex:1">
          <input type="text" id="inviteInput" class="invite-input" placeholder="Cari username GitHub…"
            autocomplete="off"
            oninput="searchUsers(this.value)"
            onkeydown="if(event.key==='Enter'){event.preventDefault();doInvite()}" />
          <div id="userSuggest" class="user-suggest hidden"></div>
        </div>

        <!-- Permission selector -->
        <select id="invitePermission" class="invite-perm-select">
          <option value="pull">Read — dapat clone & pull</option>
          <option value="triage">Triage — kelola issues/PR</option>
          <option value="push" selected>Write — push code</option>
          <option value="maintain">Maintain — kelola repo</option>
          <option value="admin">Admin — full access</option>
        </select>

        <button class="glass-btn invite-btn" onclick="doInvite()" id="inviteBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Invite
        </button>
      </div>

      <!-- Permission description -->
      <div class="perm-legend">
        <span class="perm-pill perm-read">Read</span> clone & lihat kode &nbsp;|&nbsp;
        <span class="perm-pill perm-triage">Triage</span> kelola issues &nbsp;|&nbsp;
        <span class="perm-pill perm-write">Write</span> push &amp; merge &nbsp;|&nbsp;
        <span class="perm-pill perm-maintain">Maintain</span> kelola repo &nbsp;|&nbsp;
        <span class="perm-pill perm-admin">Admin</span> full control
      </div>
    </div>

    <!-- ── Pending Invitations ─────────────────────────────────────────── -->
    ${pendingInvites.length > 0 ? `
    <div class="section-header" style="margin-top:24px">
      <h3 class="section-title">
        Pending Invitations
        <span class="count-badge" style="background:rgba(234,179,8,.15);color:#fde047;border-color:rgba(234,179,8,.3)">${pendingInvites.length}</span>
      </h3>
    </div>
    <div class="collab-grid" id="invitesGrid">${inviteCards}</div>
    ` : ''}

    <!-- ── Active Collaborators ────────────────────────────────────────── -->
    <div class="section-header" style="margin-top:${pendingInvites.length ? '24px' : '24px'}">
      <h3 class="section-title">
        Collaborators
        <span class="count-badge">${items.length}</span>
      </h3>
      <input type="text" class="search-input" placeholder="🔍 Filter…" oninput="filterCollabs(this.value)" style="width:180px">
    </div>

    ${isError
      ? `<div class="alert-error">⚠ Gagal memuat collaborators — token perlu scope <code>repo</code> dan akses admin ke repo ini.</div>`
      : items.length === 0
        ? `<div class="empty-state" style="padding:40px 0">
             <div style="font-size:40px;margin-bottom:12px">👥</div>
             <div style="color:rgba(255,255,255,0.5)">Belum ada collaborator. Gunakan form di atas untuk mengundang.</div>
           </div>`
        : `<div class="collab-grid" id="collabGrid">${collabCards}</div>`
    }

    <script>
    const OWNER = '${escapeHtml(owner)}', REPO = '${escapeHtml(repo)}';
    let suggestTimeout = null;

    // ── Toast helper ─────────────────────────────────────────────────────
    function showToast(msg, type='success') {
      const t = document.getElementById('collab-toast');
      t.textContent = msg;
      t.className = 'toast ' + (type === 'success' ? 'toast-success' : 'toast-error');
      t.classList.remove('hidden');
      setTimeout(() => t.classList.add('hidden'), 4000);
    }

    // ── User autocomplete ─────────────────────────────────────────────────
    function searchUsers(q) {
      clearTimeout(suggestTimeout);
      const box = document.getElementById('userSuggest');
      if (!q || q.length < 2) { box.classList.add('hidden'); return; }
      suggestTimeout = setTimeout(async () => {
        try {
          const res = await fetch('/api/users/search?q=' + encodeURIComponent(q));
          const data = await res.json();
          if (!data.items || data.items.length === 0) { box.classList.add('hidden'); return; }
          box.innerHTML = data.items.map(u => \`
            <div class="suggest-item" onclick="selectUser('\${u.login}')">
              <img src="\${u.avatar_url}" class="suggest-avatar" />
              <div>
                <div class="suggest-login">\${u.login}</div>
                <div class="suggest-type">\${u.type}</div>
              </div>
            </div>
          \`).join('');
          box.classList.remove('hidden');
        } catch(e) { box.classList.add('hidden'); }
      }, 300);
    }

    function selectUser(login) {
      document.getElementById('inviteInput').value = login;
      document.getElementById('userSuggest').classList.add('hidden');
    }

    // Close suggestions on outside click
    document.addEventListener('click', e => {
      if (!e.target.closest('.invite-search-wrap'))
        document.getElementById('userSuggest').classList.add('hidden');
    });

    // ── Invite collaborator ───────────────────────────────────────────────
    async function doInvite() {
      const username   = document.getElementById('inviteInput').value.trim();
      const permission = document.getElementById('invitePermission').value;
      const btn = document.getElementById('inviteBtn');
      if (!username) { showToast('Masukkan username GitHub terlebih dahulu', 'error'); return; }

      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const res = await fetch(\`/repo/\${OWNER}/\${REPO}/settings/collaborators/\${encodeURIComponent(username)}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permission })
        });
        const d = await res.json();
        if (d.success) {
          if (d.status === 'already_collab') {
            showToast(\`✓ \${username} sudah menjadi collaborator\`);
          } else {
            showToast(\`✉ Undangan dikirim ke \${username}!\`);
            document.getElementById('inviteInput').value = '';
            setTimeout(() => location.reload(), 1500);
          }
        } else {
          showToast('Gagal: ' + (d.error || 'unknown error'), 'error');
        }
      } catch(e) {
        showToast('Network error: ' + e.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Invite';
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Invite';
      }
    }

    // ── Update permission ─────────────────────────────────────────────────
    async function updatePermission(username, permission) {
      try {
        const res = await fetch(\`/repo/\${OWNER}/\${REPO}/settings/collaborators/\${encodeURIComponent(username)}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permission })
        });
        const d = await res.json();
        if (d.success) showToast(\`✓ Permission \${username} diperbarui\`);
        else showToast('Gagal: ' + (d.error || ''), 'error');
      } catch(e) { showToast('Network error', 'error'); }
    }

    // ── Remove collaborator ───────────────────────────────────────────────
    async function removeCollab(username) {
      if (!confirm(\`Hapus \${username} dari collaborator repo ini?\`)) return;
      try {
        const res = await fetch(\`/repo/\${OWNER}/\${REPO}/settings/collaborators/\${encodeURIComponent(username)}\`, { method: 'DELETE' });
        const d = await res.json();
        if (d.success) {
          showToast(\`✓ \${username} dihapus dari collaborator\`);
          document.getElementById('collab-' + username)?.remove();
        } else showToast('Gagal: ' + (d.error || ''), 'error');
      } catch(e) { showToast('Network error', 'error'); }
    }

    // ── Cancel invitation ─────────────────────────────────────────────────
    async function cancelInvite(invId, login) {
      if (!confirm(\`Batalkan undangan untuk \${login}?\`)) return;
      try {
        const res = await fetch(\`/repo/\${OWNER}/\${REPO}/settings/invitations/\${invId}\`, { method: 'DELETE' });
        const d = await res.json();
        if (d.success) {
          showToast(\`✓ Undangan \${login} dibatalkan\`);
          document.getElementById('invite-' + invId)?.remove();
        } else showToast('Gagal: ' + (d.error || ''), 'error');
      } catch(e) { showToast('Network error', 'error'); }
    }

    // ── Filter collabs ────────────────────────────────────────────────────
    function filterCollabs(q) {
      const ql = q.toLowerCase();
      document.querySelectorAll('#collabGrid .collab-card').forEach(el => {
        const login = el.querySelector('.collab-login')?.textContent.toLowerCase() || '';
        el.style.display = !q || login.includes(ql) ? '' : 'none';
      });
    }
    </script>
  `

  return glassLayout(`Collaborators — ${repo}`, user, content)
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

// libsodium crypto_box_seal implementation using tweetnacl
// Spec: https://libsodium.gitbook.io/doc/public-key_cryptography/sealed_boxes
// nonce = SHA-512(ephemeralPub || recipientPub)[0..23]  (approximation of BLAKE2b)
async function sealedBoxAsync(message: Uint8Array, recipientPublicKey: Uint8Array): Promise<Uint8Array> {
  // 1. Generate ephemeral X25519 keypair
  const ephemeralKeypair = nacl.box.keyPair()

  // 2. Derive nonce: first 24 bytes of SHA-512(ephemeralPub || recipientPub)
  const nonceInput = new Uint8Array(64)
  nonceInput.set(ephemeralKeypair.publicKey, 0)
  nonceInput.set(recipientPublicKey, 32)
  const hashBuf = await crypto.subtle.digest('SHA-512', nonceInput)
  const nonce = new Uint8Array(hashBuf, 0, nacl.box.nonceLength) // first 24 bytes

  // 3. Compute shared key and encrypt
  const sharedKey = nacl.box.before(recipientPublicKey, ephemeralKeypair.secretKey)
  const ciphertext = nacl.box.after(message, nonce, sharedKey)
  if (!ciphertext) throw new Error('Encryption failed')

  // 4. Output = ephemeralPub (32) + ciphertext
  const result = new Uint8Array(32 + ciphertext.length)
  result.set(ephemeralKeypair.publicKey, 0)
  result.set(ciphertext, 32)
  return result
}

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
